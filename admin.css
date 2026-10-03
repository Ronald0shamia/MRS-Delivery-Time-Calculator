<?php
defined('ABSPATH') || exit;

class MRS_DTC_Admin {
    public static function init(): void {
        add_action('admin_menu', [__CLASS__, 'menu']);
        add_action('admin_init', [__CLASS__, 'register_settings']);
        add_action('admin_enqueue_scripts', [__CLASS__, 'assets']);
    }

    public static function menu(): void {
        add_menu_page(
            'Delivery Time',
            'Delivery Time',
            'manage_options',
            'mrs-dtc',
            [__CLASS__, 'dashboard'],
            'dashicons-location-alt',
            30
        );
        add_submenu_page('mrs-dtc', 'Übersicht', 'Übersicht', 'manage_options', 'mrs-dtc', [__CLASS__, 'dashboard']);
        add_submenu_page('mrs-dtc', 'Berechnungen', 'Berechnungen', 'manage_options', 'mrs-dtc-calculations', [__CLASS__, 'calculations']);
        add_submenu_page('mrs-dtc', 'Einstellungen', 'Einstellungen', 'manage_options', 'mrs-dtc-settings', [__CLASS__, 'settings']);
    }

    public static function assets(string $hook): void {
        if (strpos($hook, 'mrs-dtc') === false) return;
        wp_enqueue_style('mrs-dtc-admin', MRS_DTC_URL . 'assets/css/admin.css', [], MRS_DTC_VERSION);
    }

    public static function register_settings(): void {
        register_setting('mrs_dtc_settings_group', 'mrs_dtc_settings', [
            'sanitize_callback' => [__CLASS__, 'sanitize_settings'],
        ]);
    }

    public static function sanitize_settings(array $input): array {
        return [
            'standard_seconds' => max(0, absint($input['standard_seconds'] ?? 8)),
            'walking_speed_kmh' => max(0.1, (float) ($input['walking_speed_kmh'] ?? 5)),
            'nominatim_url' => esc_url_raw($input['nominatim_url'] ?? 'https://nominatim.openstreetmap.org/search'),
            'routing_url' => esc_url_raw($input['routing_url'] ?? 'https://router.project-osrm.org/route/v1/foot'),
            'map_zoom' => min(20, max(1, absint($input['map_zoom'] ?? 15))),
        ];
    }

    private static function stats(): array {
        global $wpdb;
        $table = MRS_DTC_Database::calculations_table();
        $row = $wpdb->get_row("SELECT COUNT(*) count, COALESCE(SUM(address_count),0) addresses, COALESCE(AVG(address_count),0) avg_addresses, COALESCE(AVG(calculated_total_seconds),0) avg_time FROM {$table}", ARRAY_A);
        return $row ?: ['count'=>0,'addresses'=>0,'avg_addresses'=>0,'avg_time'=>0];
    }

    public static function dashboard(): void {
        $stats = self::stats(); ?>
        <div class="wrap mrs-dtc-admin">
            <h1>Delivery Time</h1>
            <div class="mrs-dtc-cards">
                <div><span>Gespeicherte Berechnungen</span><strong><?php echo esc_html($stats['count']); ?></strong></div>
                <div><span>Adressen insgesamt</span><strong><?php echo esc_html($stats['addresses']); ?></strong></div>
                <div><span>Durchschnittliche Häuser/Tour</span><strong><?php echo esc_html(number_format_i18n((float)$stats['avg_addresses'], 1)); ?></strong></div>
                <div><span>Durchschnittliche berechnete Zeit</span><strong><?php echo esc_html(MRS_DTC_Calculator::format_seconds((int) round($stats['avg_time']))); ?></strong></div>
            </div>
            <div class="mrs-dtc-admin-box">
                <h2>Frontend verwenden</h2>
                <p>Füge den folgenden Shortcode in eine WordPress-Seite ein:</p>
                <code>[mrs_delivery_time_calculator]</code>
            </div>
        </div>
        <?php
    }

    public static function calculations(): void {
        global $wpdb;
        $table = MRS_DTC_Database::calculations_table();
        $rows = $wpdb->get_results("SELECT * FROM {$table} ORDER BY created_at DESC", ARRAY_A); ?>
        <div class="wrap mrs-dtc-admin">
            <h1>Berechnungen</h1>
            <table class="widefat striped">
                <thead><tr><th>Datum</th><th>Adressen</th><th>Strecke</th><th>Hauszeit</th><th>Gesamtzeit</th><th>Aktionen</th></tr></thead>
                <tbody>
                <?php if (!$rows): ?>
                    <tr><td colspan="6">Noch keine Berechnungen gespeichert.</td></tr>
                <?php else: foreach ($rows as $row): ?>
                    <tr>
                        <td><?php echo esc_html(mysql2date(get_option('date_format') . ' ' . get_option('time_format'), $row['created_at'])); ?></td>
                        <td><?php echo esc_html($row['address_count']); ?></td>
                        <td><?php echo esc_html(number_format_i18n(((float)$row['route_distance_meters']) / 1000, 2)); ?> km</td>
                        <td><?php echo esc_html(MRS_DTC_Calculator::format_seconds((int)$row['house_seconds'])); ?></td>
                        <td><?php echo esc_html(MRS_DTC_Calculator::format_seconds((int)$row['calculated_total_seconds'])); ?></td>
                        <td><a href="<?php echo esc_url(admin_url('admin.php?page=mrs-dtc-calculations&view=' . absint($row['id']))); ?>">Anzeigen</a></td>
                    </tr>
                <?php endforeach; endif; ?>
                </tbody>
            </table>
            <?php if (isset($_GET['view'])) self::render_view(absint($_GET['view'])); ?>
        </div>
        <?php
    }

    private static function render_view(int $id): void {
        global $wpdb;
        $ct = MRS_DTC_Database::calculations_table();
        $at = MRS_DTC_Database::addresses_table();
        $calc = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$ct} WHERE id=%d", $id), ARRAY_A);
        if (!$calc) return;
        $addresses = $wpdb->get_results($wpdb->prepare("SELECT * FROM {$at} WHERE calculation_id=%d ORDER BY address_order", $id), ARRAY_A); ?>
        <div class="mrs-dtc-admin-box">
            <h2>Berechnung #<?php echo esc_html($id); ?></h2>
            <p><strong>Strecke:</strong> <?php echo esc_html(number_format_i18n(((float)$calc['route_distance_meters'])/1000, 2)); ?> km</p>
            <p><strong>Hauszeit:</strong> <?php echo esc_html(MRS_DTC_Calculator::format_seconds((int)$calc['house_seconds'])); ?></p>
            <p><strong>Gehzeit:</strong> <?php echo esc_html(MRS_DTC_Calculator::format_seconds((int)$calc['route_duration_seconds'])); ?></p>
            <p><strong>Gesamt:</strong> <?php echo esc_html(MRS_DTC_Calculator::format_seconds((int)$calc['calculated_total_seconds'])); ?></p>
            <ol><?php foreach ($addresses as $a): ?><li><?php echo esc_html($a['full_address']); ?> — <?php echo esc_html($a['seconds']); ?> Sek.</li><?php endforeach; ?></ol>
        </div>
        <?php
    }

    public static function settings(): void {
        $s = get_option('mrs_dtc_settings', [
            'standard_seconds'=>8,'walking_speed_kmh'=>5,
            'nominatim_url'=>'https://nominatim.openstreetmap.org/search',
            'routing_url'=>'https://router.project-osrm.org/route/v1/foot','map_zoom'=>15
        ]); ?>
        <div class="wrap mrs-dtc-admin">
            <h1>Delivery Time – Einstellungen</h1>
            <form method="post" action="options.php">
                <?php settings_fields('mrs_dtc_settings_group'); ?>
                <table class="form-table">
                    <tr><th>Standardzeit pro Haus</th><td><input type="number" min="0" name="mrs_dtc_settings[standard_seconds]" value="<?php echo esc_attr($s['standard_seconds']); ?>"> Sekunden</td></tr>
                    <tr><th>Standard-Gehgeschwindigkeit</th><td><input type="number" min="0.1" step="0.1" name="mrs_dtc_settings[walking_speed_kmh]" value="<?php echo esc_attr($s['walking_speed_kmh']); ?>"> km/h</td></tr>
                    <tr><th>Nominatim URL</th><td><input class="regular-text" type="url" name="mrs_dtc_settings[nominatim_url]" value="<?php echo esc_attr($s['nominatim_url']); ?>"></td></tr>
                    <tr><th>Routing API URL</th><td><input class="regular-text" type="url" name="mrs_dtc_settings[routing_url]" value="<?php echo esc_attr($s['routing_url']); ?>"></td></tr>
                    <tr><th>Karten-Zoom</th><td><input type="number" min="1" max="20" name="mrs_dtc_settings[map_zoom]" value="<?php echo esc_attr($s['map_zoom']); ?>"></td></tr>
                </table>
                <p><strong>Datenschutz:</strong> Gespeicherte Adressen können personenbezogene oder sensible Standortinformationen enthalten. Verwenden Sie das Plugin entsprechend den geltenden Datenschutzbestimmungen.</p>
                <?php submit_button(); ?>
            </form>
        </div>
        <?php
    }
}
