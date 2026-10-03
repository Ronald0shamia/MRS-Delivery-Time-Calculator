<?php
defined('ABSPATH') || exit;

class MRS_DTC_Database {
    public static function calculations_table(): string {
        global $wpdb;
        return $wpdb->prefix . 'mrs_dtc_calculations';
    }

    public static function addresses_table(): string {
        global $wpdb;
        return $wpdb->prefix . 'mrs_dtc_addresses';
    }

    public static function activate(): void {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';

        $charset = $wpdb->get_charset_collate();
        $calculations = self::calculations_table();
        $addresses = self::addresses_table();

        $sql1 = "CREATE TABLE {$calculations} (
            id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
            created_at datetime NOT NULL,
            updated_at datetime NOT NULL,
            address_count int(10) unsigned NOT NULL DEFAULT 0,
            standard_seconds int(10) unsigned NOT NULL DEFAULT 8,
            additional_minutes int(10) unsigned NOT NULL DEFAULT 0,
            house_seconds int(10) unsigned NOT NULL DEFAULT 0,
            route_distance_meters decimal(12,2) NOT NULL DEFAULT 0,
            route_duration_seconds int(10) unsigned NOT NULL DEFAULT 0,
            calculated_total_seconds int(10) unsigned NOT NULL DEFAULT 0,
            route_json longtext NULL,
            PRIMARY KEY  (id),
            KEY created_at (created_at)
        ) {$charset};";

        $sql2 = "CREATE TABLE {$addresses} (
            id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
            calculation_id bigint(20) unsigned NOT NULL,
            address_key varchar(64) NOT NULL,
            street text NOT NULL,
            house_number varchar(100) NOT NULL DEFAULT '',
            full_address text NOT NULL,
            latitude decimal(10,7) NOT NULL,
            longitude decimal(10,7) NOT NULL,
            seconds int(10) unsigned NOT NULL DEFAULT 8,
            address_order int(10) unsigned NOT NULL DEFAULT 0,
            PRIMARY KEY (id),
            KEY calculation_id (calculation_id),
            KEY address_key (address_key)
        ) {$charset};";

        dbDelta($sql1);
        dbDelta($sql2);

        if (get_option('mrs_dtc_settings') === false) {
            add_option('mrs_dtc_settings', [
                'standard_seconds' => 8,
                'walking_speed_kmh' => 5,
                'nominatim_url' => 'https://nominatim.openstreetmap.org/search',
                'routing_url' => 'https://router.project-osrm.org/route/v1/foot',
                'map_zoom' => 15,
            ]);
        }
        update_option('mrs_dtc_db_version', MRS_DTC_VERSION);
    }

    public static function deactivate(): void {}

    public static function delete_calculation(int $id): bool {
        global $wpdb;
        $addresses = self::addresses_table();
        $calculations = self::calculations_table();

        $wpdb->delete($addresses, ['calculation_id' => $id], ['%d']);
        $deleted = $wpdb->delete($calculations, ['id' => $id], ['%d']);
        return $deleted !== false;
    }
}
