<?php
defined('ABSPATH') || exit;

class MRS_DTC_REST_API {
    public static function init(): void {
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
    }

    public static function register_routes(): void {
        register_rest_route('mrs-dtc/v1', '/geocode', [
            'methods' => WP_REST_Server::CREATABLE,
            'callback' => [__CLASS__, 'geocode'],
            'permission_callback' => '__return_true',
            'args' => [
                'query' => ['required' => true, 'sanitize_callback' => 'sanitize_text_field'],
            ],
        ]);

        register_rest_route('mrs-dtc/v1', '/route', [
            'methods' => WP_REST_Server::CREATABLE,
            'callback' => [__CLASS__, 'route'],
            'permission_callback' => '__return_true',
            'args' => [
                'coordinates' => ['required' => true],
            ],
        ]);

        register_rest_route('mrs-dtc/v1', '/calculations', [
            [
                'methods' => WP_REST_Server::READABLE,
                'callback' => [__CLASS__, 'list_calculations'],
                'permission_callback' => [__CLASS__, 'can_manage'],
            ],
            [
                'methods' => WP_REST_Server::CREATABLE,
                'callback' => [__CLASS__, 'save_calculation'],
                'permission_callback' => [__CLASS__, 'can_manage'],
            ],
        ]);

        register_rest_route('mrs-dtc/v1', '/calculations/(?P<id>\d+)', [
            [
                'methods' => WP_REST_Server::READABLE,
                'callback' => [__CLASS__, 'get_calculation'],
                'permission_callback' => [__CLASS__, 'can_manage'],
            ],
            [
                'methods' => WP_REST_Server::DELETABLE,
                'callback' => [__CLASS__, 'delete_calculation'],
                'permission_callback' => [__CLASS__, 'can_manage'],
            ],
        ]);
    }

    public static function can_manage(): bool {
        return current_user_can('manage_options');
    }

    public static function geocode(WP_REST_Request $request) {
        $query = sanitize_text_field((string) $request->get_param('query'));
        if ($query === '') {
            return new WP_Error('invalid_query', 'Bitte geben Sie eine Adresse ein.', ['status' => 400]);
        }

        $settings = get_option('mrs_dtc_settings', []);
        $url = esc_url_raw($settings['nominatim_url'] ?? 'https://nominatim.openstreetmap.org/search');
        $url = add_query_arg([
            'q' => $query,
            'format' => 'jsonv2',
            'addressdetails' => 1,
            'limit' => 5,
            'countrycodes' => 'de',
        ], $url);

        $response = wp_remote_get($url, [
            'timeout' => 10,
            'headers' => [
                'Accept' => 'application/json',
                'User-Agent' => 'MRS Delivery Time Calculator/1.0; ' . home_url('/'),
            ],
        ]);

        if (is_wp_error($response)) {
            return new WP_Error('geocode_failed', 'Die Adresssuche ist momentan nicht erreichbar.', ['status' => 502]);
        }

        $code = wp_remote_retrieve_response_code($response);
        if ($code < 200 || $code >= 300) {
            return new WP_Error('geocode_http', 'Die Kartendaten konnten nicht geladen werden.', ['status' => 502]);
        }

        $data = json_decode(wp_remote_retrieve_body($response), true);
        if (!is_array($data)) {
            return new WP_Error('geocode_invalid', 'Ungültige Antwort der Adresssuche.', ['status' => 502]);
        }

        $results = [];
        foreach ($data as $item) {
            if (!isset($item['lat'], $item['lon'], $item['display_name'])) {
                continue;
            }
            $address = $item['address'] ?? [];
            $results[] = [
                'lat' => (float) $item['lat'],
                'lon' => (float) $item['lon'],
                'display_name' => sanitize_text_field($item['display_name']),
                'street' => sanitize_text_field($address['road'] ?? ''),
                'house_number' => sanitize_text_field($address['house_number'] ?? ''),
            ];
        }

        return rest_ensure_response(['results' => $results]);
    }

    public static function route(WP_REST_Request $request) {
        $coordinates = $request->get_param('coordinates');
        if (is_string($coordinates)) {
            $coordinates = json_decode($coordinates, true);
        }
        if (!is_array($coordinates) || count($coordinates) < 2) {
            return new WP_Error('invalid_coordinates', 'Mindestens zwei Adressen sind für eine Route erforderlich.', ['status' => 400]);
        }

        $parts = [];
        foreach ($coordinates as $point) {
            if (!is_array($point) || !isset($point['lat'], $point['lon'])) {
                return new WP_Error('invalid_point', 'Ungültige Koordinaten.', ['status' => 400]);
            }
            $parts[] = rawurlencode((float) $point['lon'] . ',' . (float) $point['lat']);
        }

        $settings = get_option('mrs_dtc_settings', []);
        $base = esc_url_raw($settings['routing_url'] ?? 'https://router.project-osrm.org/route/v1/foot');
        $url = trailingslashit($base) . implode(';', $parts);
        $url = add_query_arg([
            'overview' => 'full',
            'geometries' => 'geojson',
            'steps' => 'false',
        ], $url);

        $response = wp_remote_get($url, [
            'timeout' => 15,
            'headers' => [
                'Accept' => 'application/json',
                'User-Agent' => 'MRS Delivery Time Calculator/1.0; ' . home_url('/'),
            ],
        ]);

        if (is_wp_error($response)) {
            return new WP_Error('route_failed', 'Die Route konnte nicht berechnet werden.', ['status' => 502]);
        }

        $data = json_decode(wp_remote_retrieve_body($response), true);
        if (!is_array($data) || ($data['code'] ?? '') !== 'Ok' || empty($data['routes'][0])) {
            return new WP_Error('route_invalid', 'Für diese Adressen konnte keine Route berechnet werden.', ['status' => 422]);
        }

        $route = $data['routes'][0];
        return rest_ensure_response([
            'distance_meters' => (float) ($route['distance'] ?? 0),
            'duration_seconds' => (int) round($route['duration'] ?? 0),
            'geometry' => $route['geometry'] ?? null,
        ]);
    }

    private static function normalize_addresses(array $addresses, int $standard): array {
        $out = [];
        foreach ($addresses as $index => $address) {
            if (!is_array($address)) continue;
            $lat = isset($address['latitude']) ? (float) $address['latitude'] : (float) ($address['lat'] ?? 0);
            $lon = isset($address['longitude']) ? (float) $address['longitude'] : (float) ($address['lon'] ?? 0);
            if ($lat < -90 || $lat > 90 || $lon < -180 || $lon > 180) continue;

            $out[] = [
                'address_key' => sanitize_text_field($address['address_key'] ?? wp_generate_uuid4()),
                'street' => sanitize_text_field($address['street'] ?? ''),
                'house_number' => sanitize_text_field($address['house_number'] ?? ''),
                'full_address' => sanitize_text_field($address['full_address'] ?? ''),
                'latitude' => $lat,
                'longitude' => $lon,
                'seconds' => max(0, (int) ($address['seconds'] ?? $standard)),
                'address_order' => $index,
            ];
        }
        return $out;
    }

    public static function save_calculation(WP_REST_Request $request) {
        global $wpdb;
        $body = $request->get_json_params();
        if (!is_array($body)) {
            return new WP_Error('invalid_body', 'Ungültige Daten.', ['status' => 400]);
        }

        $settings = get_option('mrs_dtc_settings', []);
        $standard = max(0, (int) ($body['standard_seconds'] ?? ($settings['standard_seconds'] ?? 8)));
        $additional = max(0, (int) ($body['additional_minutes'] ?? 0));
        $addresses = self::normalize_addresses($body['addresses'] ?? [], $standard);
        $route_duration = max(0, (int) ($body['route_duration_seconds'] ?? 0));
        $calc = MRS_DTC_Calculator::calculate($addresses, $route_duration, $additional);
        $now = current_time('mysql');

        $calculations = MRS_DTC_Database::calculations_table();
        $inserted = $wpdb->insert($calculations, [
            'created_at' => $now,
            'updated_at' => $now,
            'address_count' => count($addresses),
            'standard_seconds' => $standard,
            'additional_minutes' => $additional,
            'house_seconds' => $calc['house_seconds'],
            'route_distance_meters' => max(0, (float) ($body['route_distance_meters'] ?? 0)),
            'route_duration_seconds' => $route_duration,
            'calculated_total_seconds' => $calc['calculated_total_seconds'],
            'route_json' => wp_json_encode($body['route'] ?? null),
        ], ['%s','%s','%d','%d','%d','%d','%f','%d','%d','%s']);

        if ($inserted === false) {
            return new WP_Error('save_failed', 'Die Berechnung konnte nicht gespeichert werden.', ['status' => 500]);
        }

        $calculation_id = (int) $wpdb->insert_id;
        $addresses_table = MRS_DTC_Database::addresses_table();

        foreach ($addresses as $address) {
            $wpdb->insert($addresses_table, [
                'calculation_id' => $calculation_id,
                'address_key' => $address['address_key'],
                'street' => $address['street'],
                'house_number' => $address['house_number'],
                'full_address' => $address['full_address'],
                'latitude' => $address['latitude'],
                'longitude' => $address['longitude'],
                'seconds' => $address['seconds'],
                'address_order' => $address['address_order'],
            ], ['%d','%s','%s','%s','%s','%f','%f','%d','%d']);
        }

        return rest_ensure_response(['id' => $calculation_id]);
    }

    public static function list_calculations() {
        global $wpdb;
        $table = MRS_DTC_Database::calculations_table();
        $rows = $wpdb->get_results("SELECT * FROM {$table} ORDER BY created_at DESC", ARRAY_A);
        return rest_ensure_response($rows ?: []);
    }

    public static function get_calculation(WP_REST_Request $request) {
        global $wpdb;
        $id = absint($request['id']);
        $calc_table = MRS_DTC_Database::calculations_table();
        $addr_table = MRS_DTC_Database::addresses_table();

        $calculation = $wpdb->get_row(
            $wpdb->prepare("SELECT * FROM {$calc_table} WHERE id = %d", $id),
            ARRAY_A
        );
        if (!$calculation) {
            return new WP_Error('not_found', 'Berechnung nicht gefunden.', ['status' => 404]);
        }

        $addresses = $wpdb->get_results(
            $wpdb->prepare("SELECT * FROM {$addr_table} WHERE calculation_id = %d ORDER BY address_order ASC", $id),
            ARRAY_A
        );

        $calculation['route'] = json_decode((string) $calculation['route_json'], true);
        unset($calculation['route_json']);
        $calculation['addresses'] = $addresses ?: [];

        return rest_ensure_response($calculation);
    }

    public static function delete_calculation(WP_REST_Request $request) {
        $id = absint($request['id']);
        if (!MRS_DTC_Database::delete_calculation($id)) {
            return new WP_Error('delete_failed', 'Die Berechnung konnte nicht gelöscht werden.', ['status' => 500]);
        }
        return rest_ensure_response(['deleted' => true]);
    }
}
