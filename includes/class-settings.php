<?php
defined('ABSPATH') || exit;

class MRS_DTC_Settings {
    const OPTION = 'mrs_dtc_settings';
    const MODES = ['foot', 'bike', 'car'];
    // Alter Standardwert: der öffentliche OSRM-Demo-Server rechnet trotz "foot" mit dem Auto-Profil.
    const OLD_ROUTING_URL = 'https://router.project-osrm.org/route/v1/foot';

    public static function defaults(): array {
        return [
            'standard_seconds'    => 8,
            'walking_speed_kmh'   => 5,
            'bike_speed_kmh'      => 15,
            'car_speed_kmh'       => 30,
            'nominatim_url'       => 'https://nominatim.openstreetmap.org/search',
            // FOSSGIS-Server: pro Verkehrsmittel ein eigener Pfad (routed-foot / routed-bike / routed-car).
            'routing_url_foot'    => 'https://routing.openstreetmap.de/routed-foot/route/v1/foot',
            'routing_url_bike'    => 'https://routing.openstreetmap.de/routed-bike/route/v1/bike',
            'routing_url_car'     => 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
            'map_zoom'            => 15,
            'country_codes'       => '',
            'delete_on_uninstall' => 0,
        ];
    }

    public static function all(): array {
        $saved = get_option(self::OPTION, []);
        return wp_parse_args(is_array($saved) ? $saved : [], self::defaults());
    }

    public static function get(string $key) {
        $all = self::all();
        return $all[$key] ?? null;
    }

    public static function normalize_mode($mode): string {
        $mode = sanitize_key((string) $mode);
        return in_array($mode, self::MODES, true) ? $mode : 'foot';
    }

    /**
     * Durchschnittsgeschwindigkeit (km/h) des Verkehrsmittels.
     */
    public static function speed(string $mode): float {
        $keys = ['foot' => 'walking_speed_kmh', 'bike' => 'bike_speed_kmh', 'car' => 'car_speed_kmh'];
        return (float) self::get($keys[self::normalize_mode($mode)]);
    }

    public static function routing_url(string $mode): string {
        return untrailingslashit((string) self::get('routing_url_' . self::normalize_mode($mode)));
    }

    private static function clean_url($value, string $fallback, string $must_end_with = ''): string {
        $url = untrailingslashit(esc_url_raw(trim((string) $value), ['http', 'https']));
        if ($url === '') {
            return $fallback;
        }
        if ($must_end_with !== '' && substr($url, -strlen($must_end_with)) !== $must_end_with) {
            $url .= $must_end_with;
        }
        return $url;
    }

    private static function clean_speed($value, float $min, float $max, float $fallback): float {
        $n = (float) str_replace(',', '.', (string) $value);
        return ($n >= $min && $n <= $max) ? round($n, 2) : $fallback;
    }

    public static function sanitize($input): array {
        $d = self::defaults();
        $input = is_array($input) ? $input : [];
        $codes = strtolower((string) preg_replace('/[^a-zA-Z,]/', '', (string) ($input['country_codes'] ?? '')));

        return [
            'standard_seconds'    => min(3600, max(0, absint($input['standard_seconds'] ?? $d['standard_seconds']))),
            'walking_speed_kmh'   => self::clean_speed($input['walking_speed_kmh'] ?? '', 1, 15, $d['walking_speed_kmh']),
            'bike_speed_kmh'      => self::clean_speed($input['bike_speed_kmh'] ?? '', 3, 60, $d['bike_speed_kmh']),
            'car_speed_kmh'       => self::clean_speed($input['car_speed_kmh'] ?? '', 5, 150, $d['car_speed_kmh']),
            'nominatim_url'       => self::clean_url($input['nominatim_url'] ?? '', $d['nominatim_url'], '/search'),
            'routing_url_foot'    => self::clean_url($input['routing_url_foot'] ?? '', $d['routing_url_foot']),
            'routing_url_bike'    => self::clean_url($input['routing_url_bike'] ?? '', $d['routing_url_bike']),
            'routing_url_car'     => self::clean_url($input['routing_url_car'] ?? '', $d['routing_url_car']),
            'map_zoom'            => min(19, max(3, absint($input['map_zoom'] ?? $d['map_zoom']))),
            'country_codes'       => trim($codes, ','),
            'delete_on_uninstall' => empty($input['delete_on_uninstall']) ? 0 : 1,
        ];
    }

    /**
     * Ergänzt neue Schlüssel und übernimmt die frühere einzelne Routing-URL als "Zu Fuß"-URL.
     */
    public static function migrate(): void {
        $saved = get_option(self::OPTION, null);
        if (!is_array($saved)) {
            add_option(self::OPTION, self::defaults());
            return;
        }

        $new = $saved;
        if (isset($saved['routing_url']) && !isset($saved['routing_url_foot'])) {
            $old = untrailingslashit((string) $saved['routing_url']);
            if ($old !== '' && $old !== self::OLD_ROUTING_URL) {
                $new['routing_url_foot'] = $old;
            }
        }
        unset($new['routing_url']);
        $new = wp_parse_args($new, self::defaults());

        if ($new !== $saved) {
            update_option(self::OPTION, $new);
        }
    }
}
