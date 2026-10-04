<?php
defined('ABSPATH') || exit;

class MRS_DTC_Settings {
    const OPTION = 'mrs_dtc_settings';
    // Alter Standardwert: der öffentliche OSRM-Demo-Server rechnet trotz "foot" mit dem Auto-Profil.
    const OLD_ROUTING_URL = 'https://router.project-osrm.org/route/v1/foot';

    public static function defaults(): array {
        return [
            'standard_seconds'    => 8,
            'walking_speed_kmh'   => 5,
            'nominatim_url'       => 'https://nominatim.openstreetmap.org/search',
            'routing_url'         => 'https://routing.openstreetmap.de/routed-foot/route/v1/foot',
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

    public static function sanitize($input): array {
        $d = self::defaults();
        $input = is_array($input) ? $input : [];

        $speed = (float) str_replace(',', '.', (string) ($input['walking_speed_kmh'] ?? $d['walking_speed_kmh']));

        $nominatim = untrailingslashit(esc_url_raw(trim((string) ($input['nominatim_url'] ?? '')), ['http', 'https']));
        if ($nominatim === '') {
            $nominatim = $d['nominatim_url'];
        } elseif (substr($nominatim, -7) !== '/search') {
            $nominatim .= '/search';
        }

        $routing = untrailingslashit(esc_url_raw(trim((string) ($input['routing_url'] ?? '')), ['http', 'https']));
        if ($routing === '') {
            $routing = $d['routing_url'];
        }

        $codes = strtolower((string) preg_replace('/[^a-zA-Z,]/', '', (string) ($input['country_codes'] ?? '')));

        return [
            'standard_seconds'    => min(3600, max(0, absint($input['standard_seconds'] ?? $d['standard_seconds']))),
            'walking_speed_kmh'   => ($speed >= 1 && $speed <= 15) ? round($speed, 2) : $d['walking_speed_kmh'],
            'nominatim_url'       => $nominatim,
            'routing_url'         => $routing,
            'map_zoom'            => min(19, max(3, absint($input['map_zoom'] ?? $d['map_zoom']))),
            'country_codes'       => trim($codes, ','),
            'delete_on_uninstall' => empty($input['delete_on_uninstall']) ? 0 : 1,
        ];
    }

    /**
     * Ergänzt fehlende Schlüssel und ersetzt den alten Demo-Routing-Standard.
     */
    public static function migrate(): void {
        $saved = get_option(self::OPTION, null);
        if (!is_array($saved)) {
            add_option(self::OPTION, self::defaults());
            return;
        }
        $new = wp_parse_args($saved, self::defaults());
        if (untrailingslashit((string) $new['routing_url']) === self::OLD_ROUTING_URL) {
            $new['routing_url'] = self::defaults()['routing_url'];
        }
        if ($new !== $saved) {
            update_option(self::OPTION, $new);
        }
    }
}
