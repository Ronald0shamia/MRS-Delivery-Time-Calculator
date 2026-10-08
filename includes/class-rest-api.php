<?php
defined('ABSPATH') || exit;

class MRS_DTC_REST_API {
    const NS = 'mrs-dtc/v1';
    const MAX_ADDRESSES = 300;
    const ROUTE_CHUNK = 100; // Wegpunkte pro Routing-Anfrage

    public static function init(): void {
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
    }

    /**
     * Wer den Rechner benutzen darf (per Filter 'mrs_dtc_capability' änderbar).
     */
    public static function capability(): string {
        return (string) apply_filters('mrs_dtc_capability', 'edit_posts');
    }

    public static function register_routes(): void {
        $perm = [__CLASS__, 'can_use'];

        register_rest_route(self::NS, '/geocode', [
            'methods' => WP_REST_Server::CREATABLE,
            'callback' => [__CLASS__, 'geocode'],
            'permission_callback' => $perm,
        ]);

        register_rest_route(self::NS, '/route', [
            'methods' => WP_REST_Server::CREATABLE,
            'callback' => [__CLASS__, 'route'],
            'permission_callback' => $perm,
        ]);

        register_rest_route(self::NS, '/calculations', [
            [
                'methods' => WP_REST_Server::READABLE,
                'callback' => [__CLASS__, 'list_calculations'],
                'permission_callback' => $perm,
            ],
            [
                'methods' => WP_REST_Server::CREATABLE,
                'callback' => [__CLASS__, 'save_calculation'],
                'permission_callback' => $perm,
            ],
        ]);

        register_rest_route(self::NS, '/calculations/(?P<id>\d+)', [
            [
                'methods' => WP_REST_Server::READABLE,
                'callback' => [__CLASS__, 'get_calculation'],
                'permission_callback' => $perm,
            ],
            [
                'methods' => WP_REST_Server::EDITABLE,
                'callback' => [__CLASS__, 'update_calculation'],
                'permission_callback' => $perm,
            ],
            [
                'methods' => WP_REST_Server::DELETABLE,
                'callback' => [__CLASS__, 'delete_calculation'],
                'permission_callback' => $perm,
            ],
        ]);
    }

    public static function can_use() {
        if (current_user_can(self::capability())) {
            return true;
        }
        return new WP_Error('forbidden', 'Bitte melden Sie sich an, um diese Funktion zu nutzen.', ['status' => rest_authorization_required_code()]);
    }

    /* ---------------- Hilfsfunktionen ---------------- */

    private static function user_agent(): string {
        return (string) apply_filters('mrs_dtc_user_agent', 'MRS-Delivery-Time-Calculator/' . MRS_DTC_VERSION . ' (' . home_url('/') . ')');
    }

    // Mindestabstand zwischen zwei Anfragen (Nominatim: max. 1 Anfrage pro Sekunde).
    private static function throttle(string $key, float $gap): void {
        $last = (float) get_transient($key);
        $now = microtime(true);
        if ($last > 0 && ($now - $last) < $gap) {
            usleep((int) (($gap - ($now - $last)) * 1000000));
        }
        set_transient($key, microtime(true), 30);
    }

    /**
     * @return array{status:int,data:mixed}|WP_Error
     */
    private static function remote_json(string $url) {
        $response = wp_remote_get($url, [
            'timeout' => 12,
            'redirection' => 2,
            'headers' => [
                'Accept' => 'application/json',
                'Accept-Language' => 'de',
                'User-Agent' => self::user_agent(),
            ],
        ]);

        if (is_wp_error($response)) {
            $msg = strtolower($response->get_error_message());
            $timeout = strpos($msg, 'timed out') !== false || strpos($msg, 'timeout') !== false;
            return new WP_Error(
                'upstream_unreachable',
                $timeout
                    ? 'Der Server antwortet nicht rechtzeitig. Bitte versuchen Sie es später erneut.'
                    : 'Der Server ist momentan nicht erreichbar. Bitte versuchen Sie es später erneut.',
                ['status' => $timeout ? 504 : 502]
            );
        }

        $status = (int) wp_remote_retrieve_response_code($response);
        if ($status === 429) {
            return new WP_Error('rate_limited', 'Zu viele Anfragen. Bitte warten Sie einen Moment und versuchen Sie es erneut.', ['status' => 429]);
        }
        if ($status >= 500) {
            return new WP_Error('upstream_error', 'Der Server ist momentan nicht erreichbar. Bitte versuchen Sie es später erneut.', ['status' => 502]);
        }

        $data = json_decode(wp_remote_retrieve_body($response), true);
        if ($status >= 200 && $status < 300 && $data === null && json_last_error() !== JSON_ERROR_NONE) {
            return new WP_Error('upstream_invalid', 'Die Antwort des Servers war ungültig. Bitte versuchen Sie es später erneut.', ['status' => 502]);
        }

        return ['status' => $status, 'data' => $data];
    }

    private static function valid_point($lat, $lon): bool {
        return is_numeric($lat) && is_numeric($lon) && abs((float) $lat) <= 90 && abs((float) $lon) <= 180;
    }

    private static function clamp_int($value, int $min, int $max): int {
        return max($min, min($max, is_numeric($value) ? (int) round((float) $value) : 0));
    }

    /* ---------------- Geocoding ---------------- */

    public static function geocode(WP_REST_Request $request) {
        $clean = static fn($v) => trim((string) preg_replace('/\s+/', ' ', sanitize_text_field((string) $v)));

        // Zwei Arten der Suche: freier Text (Adressfeld) oder strukturiert (PDF-Import: Straße + Ort).
        $street = $clean($request->get_param('street'));
        $city = $clean($request->get_param('city'));
        $query = $clean($request->get_param('query'));

        if ($street !== '') {
            $len = mb_strlen($street);
            if ($len < 2 || $len > 150 || mb_strlen($city) > 100) {
                return new WP_Error('invalid_query', 'Ungültige Adresse.', ['status' => 400]);
            }
        } else {
            $len = mb_strlen($query);
            if ($len < 3 || $len > 200) {
                return new WP_Error('invalid_query', 'Bitte geben Sie mindestens 3 Zeichen ein.', ['status' => 400]);
            }
        }

        // Optional: Suchergebnisse in der Nähe dieses Punktes bevorzugen (Laufenburg/Baden vs. Laufenburg/AG).
        $bias = null;
        $lat = $request->get_param('lat');
        $lon = $request->get_param('lon');
        if (self::valid_point($lat, $lon)) {
            $bias = [round((float) $lat, 1), round((float) $lon, 1)];
        }

        $codes = (string) MRS_DTC_Settings::get('country_codes');
        $cache_key = 'mrs_dtc_geo_' . md5(strtolower($street . '|' . $city . '|' . $query) . '|' . $codes . '|' . wp_json_encode($bias));
        $cached = get_transient($cache_key);
        if (is_array($cached)) {
            return rest_ensure_response(['results' => $cached]);
        }

        $args = ['format' => 'jsonv2', 'addressdetails' => 1, 'limit' => 8, 'accept-language' => 'de'];
        if ($street !== '') {
            $args['street'] = $street; // Nominatim: "<Hausnummer> <Straße>"
            if ($city !== '') {
                $args['city'] = $city;
            }
        } else {
            $args['q'] = $query;
        }
        if ($codes !== '') {
            $args['countrycodes'] = $codes;
        }
        if ($bias) {
            // viewbox = links, oben, rechts, unten (bounded=0: nur Bevorzugung, kein harter Filter)
            $args['viewbox'] = ($bias[1] - 0.25) . ',' . ($bias[0] + 0.2) . ',' . ($bias[1] + 0.25) . ',' . ($bias[0] - 0.2);
        }

        self::throttle('mrs_dtc_nominatim_last', 1.1);

        $base = (string) MRS_DTC_Settings::get('nominatim_url');
        $result = self::remote_json($base . '?' . http_build_query($args, '', '&', PHP_QUERY_RFC3986));
        if (is_wp_error($result)) {
            return $result;
        }
        if ($result['status'] !== 200 || !is_array($result['data'])) {
            return new WP_Error('geocode_failed', 'Die Adresssuche ist momentan nicht verfügbar. Bitte versuchen Sie es später erneut.', ['status' => 502]);
        }

        $results = [];
        $seen = [];
        foreach ($result['data'] as $item) {
            if (!is_array($item) || !isset($item['lat'], $item['lon']) || !self::valid_point($item['lat'], $item['lon'])) {
                continue;
            }
            $a = (isset($item['address']) && is_array($item['address'])) ? $item['address'] : [];

            $street = '';
            foreach (['road', 'pedestrian', 'footway', 'path', 'residential', 'cycleway', 'square'] as $k) {
                if (!empty($a[$k]) && is_string($a[$k])) { $street = $a[$k]; break; }
            }
            $number = (isset($a['house_number']) && is_string($a['house_number'])) ? $a['house_number'] : '';
            $place = '';
            foreach (['city', 'town', 'village', 'municipality', 'hamlet', 'suburb'] as $k) {
                if (!empty($a[$k]) && is_string($a[$k])) { $place = $a[$k]; break; }
            }
            $postcode = (isset($a['postcode']) && is_string($a['postcode'])) ? $a['postcode'] : '';
            $country = (isset($a['country']) && is_string($a['country'])) ? $a['country'] : '';

            // Lesbares Label: "Hauptstraße 25, 79725 Laufenburg, Deutschland"
            $parts = array_filter([trim($street . ' ' . $number), trim($postcode . ' ' . $place), $country], static fn($v) => $v !== '');
            $label = $parts ? implode(', ', $parts) : (is_string($item['display_name'] ?? null) ? $item['display_name'] : '');

            $lat = round((float) $item['lat'], 7);
            $lon = round((float) $item['lon'], 7);
            $dedupe = $label . '|' . $lat . '|' . $lon;
            if ($label === '' || isset($seen[$dedupe])) {
                continue;
            }
            $seen[$dedupe] = true;

            $results[] = [
                'lat' => $lat,
                'lon' => $lon,
                'display_name' => sanitize_text_field($label),
                'street' => sanitize_text_field($street),
                'house_number' => sanitize_text_field($number),
            ];
        }

        set_transient($cache_key, $results, 12 * HOUR_IN_SECONDS);
        return rest_ensure_response(['results' => $results]);
    }

    /* ---------------- Routing ---------------- */

    public static function route(WP_REST_Request $request) {
        $coordinates = $request->get_param('coordinates');
        if (is_string($coordinates)) {
            $coordinates = json_decode($coordinates, true);
        }
        if (!is_array($coordinates) || count($coordinates) < 2) {
            return new WP_Error('invalid_coordinates', 'Mindestens zwei Adressen sind für eine Route erforderlich.', ['status' => 400]);
        }
        if (count($coordinates) > self::MAX_ADDRESSES) {
            return new WP_Error('too_many', 'Es sind maximal 300 Adressen pro Route möglich.', ['status' => 400]);
        }

        $points = [];
        foreach ($coordinates as $point) {
            if (!is_array($point) || !isset($point['lat'], $point['lon']) || !self::valid_point($point['lat'], $point['lon'])) {
                return new WP_Error('invalid_point', 'Ungültige Koordinaten.', ['status' => 400]);
            }
            $points[] = [round((float) $point['lat'], 7), round((float) $point['lon'], 7)];
        }

        $mode = MRS_DTC_Settings::normalize_mode($request->get_param('mode'));
        $base = MRS_DTC_Settings::routing_url($mode);
        $cache_key = 'mrs_dtc_route_' . md5(wp_json_encode($points) . $base . $mode);
        $cached = get_transient($cache_key);
        if (is_array($cached)) {
            return rest_ensure_response($cached);
        }

        $distance = 0.0;
        $duration = 0.0;
        $coords = [];
        $step = self::ROUTE_CHUNK - 1; // Blöcke überlappen um einen Punkt, damit die Linie durchgehend ist
        $total = count($points);

        for ($i = 0; $i < $total - 1; $i += $step) {
            $chunk = array_slice($points, $i, self::ROUTE_CHUNK);
            if (count($chunk) < 2) {
                break;
            }
            // OSRM erwartet "lon,lat;lon,lat"
            $pairs = array_map(static fn($p) => $p[1] . ',' . $p[0], $chunk);
            $url = $base . '/' . implode(';', $pairs) . '?overview=full&geometries=geojson&steps=false&alternatives=false';

            $result = self::remote_json($url);
            if (is_wp_error($result)) {
                return $result;
            }
            $data = $result['data'];
            if (!is_array($data) || ($data['code'] ?? '') !== 'Ok' || empty($data['routes'][0]['geometry']['coordinates'])) {
                return new WP_Error('route_invalid', 'Für diese Adressen konnte keine Route berechnet werden.', ['status' => 422]);
            }

            $route = $data['routes'][0];
            $distance += (float) ($route['distance'] ?? 0);
            $duration += (float) ($route['duration'] ?? 0);
            foreach ($route['geometry']['coordinates'] as $idx => $pt) {
                if (!is_array($pt) || count($pt) < 2) {
                    continue;
                }
                if ($i > 0 && $idx === 0 && $coords) {
                    continue; // Doppelter Punkt am Blockübergang
                }
                $coords[] = [round((float) $pt[0], 6), round((float) $pt[1], 6)];
            }
        }

        $response = [
            'mode' => $mode,
            'distance_meters' => round($distance, 1),
            'duration_seconds' => (int) round($duration),
            'geometry' => ['type' => 'LineString', 'coordinates' => $coords],
        ];
        set_transient($cache_key, $response, 6 * HOUR_IN_SECONDS);
        return rest_ensure_response($response);
    }

    /* ---------------- Berechnungen ---------------- */

    /**
     * Prüft und bereinigt die Eingabe. Summen werden hier immer neu berechnet.
     *
     * @return array{calc:array,addresses:array}|WP_Error
     */
    private static function prepare(WP_REST_Request $request) {
        $body = $request->get_json_params();
        if (!is_array($body)) {
            return new WP_Error('invalid_body', 'Ungültige Daten.', ['status' => 400]);
        }

        $raw = $body['addresses'] ?? null;
        if (!is_array($raw) || !$raw) {
            return new WP_Error('no_addresses', 'Bitte fügen Sie mindestens eine Adresse hinzu.', ['status' => 400]);
        }
        if (count($raw) > self::MAX_ADDRESSES) {
            return new WP_Error('too_many', 'Es sind maximal 300 Adressen pro Berechnung möglich.', ['status' => 400]);
        }

        $addresses = [];
        foreach (array_values($raw) as $row) {
            $lat = is_array($row) ? ($row['latitude'] ?? $row['lat'] ?? null) : null;
            $lon = is_array($row) ? ($row['longitude'] ?? $row['lon'] ?? null) : null;
            if (!self::valid_point($lat, $lon)) {
                return new WP_Error('invalid_address', 'Eine Adresse enthält ungültige Koordinaten.', ['status' => 400]);
            }
            $key = sanitize_key((string) ($row['address_key'] ?? ''));
            $addresses[] = [
                'address_key'  => $key !== '' ? mb_substr($key, 0, 64) : wp_generate_uuid4(),
                'street'       => mb_substr(sanitize_text_field((string) ($row['street'] ?? '')), 0, 191),
                'house_number' => mb_substr(sanitize_text_field((string) ($row['house_number'] ?? '')), 0, 100),
                'full_address' => mb_substr(sanitize_text_field((string) ($row['full_address'] ?? '')), 0, 500),
                'latitude'     => round((float) $lat, 7),
                'longitude'    => round((float) $lon, 7),
                'seconds'      => self::clamp_int($row['seconds'] ?? 0, 0, 3600),
                'quantity'     => max(1, self::clamp_int($row['quantity'] ?? 1, 1, 999)),
            ];
        }

        $standard = self::clamp_int($body['standard_seconds'] ?? MRS_DTC_Settings::get('standard_seconds'), 0, 3600);
        $additional = self::clamp_int($body['additional_minutes'] ?? 0, 0, 1440);
        $mode = MRS_DTC_Settings::normalize_mode($body['travel_mode'] ?? 'foot');
        $speed = max(1.0, min(150.0, (float) ($body['travel_speed_kmh'] ?? MRS_DTC_Settings::speed($mode))));
        $distance = max(0.0, min(5000000.0, (float) ($body['route_distance_meters'] ?? 0)));
        $route_duration = self::clamp_int($body['route_duration_seconds'] ?? 0, 0, 10000000);

        // Route nur übernehmen, wenn es eine gültige Linie ist.
        $route = null;
        $geo = $body['route']['geometry']['coordinates'] ?? null;
        if (is_array($geo) && count($addresses) > 1) {
            $clean = [];
            foreach ($geo as $pt) {
                if (count($clean) >= 60000) { break; }
                if (is_array($pt) && isset($pt[0], $pt[1]) && self::valid_point($pt[1], $pt[0])) {
                    $clean[] = [round((float) $pt[0], 6), round((float) $pt[1], 6)];
                }
            }
            if (count($clean) >= 2) {
                $route = ['type' => 'LineString', 'coordinates' => $clean];
            }
        }
        if (!$route) {
            $distance = 0.0;
            $route_duration = 0;
        }

        $calc = MRS_DTC_Calculator::calculate($addresses, $distance, $speed, (float) $additional);

        return [
            'calc' => [
                'title' => mb_substr(sanitize_text_field((string) ($body['title'] ?? '')), 0, 191),
                'address_count' => count($addresses),
                'standard_seconds' => $standard,
                'additional_minutes' => $additional,
                'house_seconds' => $calc['house_seconds'],
                'route_distance_meters' => $distance,
                'route_duration_seconds' => $route_duration,
                'travel_mode' => $mode,
                'walking_speed_kmh' => $speed, // Geschwindigkeit des gewählten Verkehrsmittels
                'walking_seconds' => $calc['travel_seconds'], // Weg-/Fahrzeit des gewählten Verkehrsmittels
                'calculated_total_seconds' => $calc['calculated_total_seconds'],
                'route_json' => $route ? wp_json_encode($route) : null,
            ],
            'addresses' => $addresses,
        ];
    }

    private static function load_accessible(int $id) {
        $calc = MRS_DTC_Database::get_calculation($id);
        if (!$calc) {
            return new WP_Error('not_found', 'Berechnung nicht gefunden.', ['status' => 404]);
        }
        if (!MRS_DTC_Database::user_can_access($calc)) {
            return new WP_Error('forbidden', 'Sie haben keine Berechtigung für diese Berechnung.', ['status' => 403]);
        }
        return $calc;
    }

    private static function summary(array $row): array {
        return [
            'id' => (int) $row['id'],
            'title' => (string) ($row['title'] ?? ''),
            'created_at_local' => mysql2date('d.m.Y H:i', (string) $row['created_at']),
            'address_count' => (int) $row['address_count'],
            'route_distance_meters' => (float) $row['route_distance_meters'],
            'house_seconds' => (int) $row['house_seconds'],
            'travel_mode' => MRS_DTC_Settings::normalize_mode($row['travel_mode'] ?? 'foot'),
            'travel_seconds' => (int) $row['walking_seconds'],
            'calculated_total_seconds' => (int) $row['calculated_total_seconds'],
        ];
    }

    private static function detail(array $calc): array {
        $route = !empty($calc['route_json']) ? json_decode((string) $calc['route_json'], true) : null;
        $addresses = [];
        foreach ($calc['addresses'] as $a) {
            $addresses[] = [
                'address_key' => (string) $a['address_key'],
                'street' => (string) $a['street'],
                'house_number' => (string) $a['house_number'],
                'full_address' => (string) $a['full_address'],
                'latitude' => (float) $a['latitude'],
                'longitude' => (float) $a['longitude'],
                'seconds' => (int) $a['seconds'],
                'quantity' => max(1, (int) ($a['quantity'] ?? 1)),
                'address_order' => (int) $a['address_order'],
            ];
        }
        return array_merge(self::summary($calc), [
            'standard_seconds' => (int) $calc['standard_seconds'],
            'additional_minutes' => (int) $calc['additional_minutes'],
            'route_duration_seconds' => (int) $calc['route_duration_seconds'],
            'travel_speed_kmh' => (float) $calc['walking_speed_kmh'],
            'route' => is_array($route) ? $route : null,
            'addresses' => $addresses,
        ]);
    }

    public static function save_calculation(WP_REST_Request $request) {
        $data = self::prepare($request);
        if (is_wp_error($data)) {
            return $data;
        }
        $id = MRS_DTC_Database::insert_calculation(get_current_user_id(), $data['calc'], $data['addresses']);
        if (is_wp_error($id)) {
            return $id;
        }
        $response = rest_ensure_response(self::detail(MRS_DTC_Database::get_calculation($id)));
        $response->set_status(201);
        return $response;
    }

    public static function update_calculation(WP_REST_Request $request) {
        $id = absint($request['id']);
        $existing = self::load_accessible($id);
        if (is_wp_error($existing)) {
            return $existing;
        }
        $data = self::prepare($request);
        if (is_wp_error($data)) {
            return $data;
        }
        $result = MRS_DTC_Database::update_calculation($id, $data['calc'], $data['addresses']);
        if (is_wp_error($result)) {
            return $result;
        }
        return rest_ensure_response(self::detail(MRS_DTC_Database::get_calculation($id)));
    }

    public static function list_calculations() {
        $user_id = current_user_can('manage_options') ? null : get_current_user_id();
        $rows = MRS_DTC_Database::list_calculations($user_id, 100, 0);
        return rest_ensure_response(array_map([__CLASS__, 'summary'], $rows));
    }

    public static function get_calculation(WP_REST_Request $request) {
        $calc = self::load_accessible(absint($request['id']));
        if (is_wp_error($calc)) {
            return $calc;
        }
        return rest_ensure_response(self::detail($calc));
    }

    public static function delete_calculation(WP_REST_Request $request) {
        $id = absint($request['id']);
        $calc = self::load_accessible($id);
        if (is_wp_error($calc)) {
            return $calc;
        }
        if (!MRS_DTC_Database::delete_calculation($id)) {
            return new WP_Error('delete_failed', 'Die Berechnung konnte nicht gelöscht werden.', ['status' => 500]);
        }
        return rest_ensure_response(['deleted' => true, 'id' => $id]);
    }
}
