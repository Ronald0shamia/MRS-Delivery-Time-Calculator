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
        if (version_compare(PHP_VERSION, '8.1', '<')) {
            deactivate_plugins(plugin_basename(MRS_DTC_FILE));
            wp_die(esc_html__('MRS Delivery Time Calculator benötigt PHP 8.1 oder neuer.', 'mrs-delivery-time'), '', ['back_link' => true]);
        }
        self::install();
        MRS_DTC_Settings::migrate();
    }

    public static function deactivate(): void {}

    /**
     * Hinweis: Die Spalten walking_speed_kmh / walking_seconds speichern seit 1.3.0 Geschwindigkeit und Zeit
     * des gewählten Verkehrsmittels (travel_mode). Die Namen bleiben aus Kompatibilitätsgründen bestehen.
     */
    public static function install(): void {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';

        $charset = $wpdb->get_charset_collate();
        $calculations = self::calculations_table();
        $addresses = self::addresses_table();

        // Hinweis: dbDelta verlangt zwei Leerzeichen nach PRIMARY KEY.
        $sql1 = "CREATE TABLE {$calculations} (
            id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
            user_id bigint(20) unsigned NOT NULL DEFAULT 0,
            title varchar(191) NOT NULL DEFAULT '',
            status varchar(20) NOT NULL DEFAULT 'calculated',
            created_at datetime NOT NULL,
            updated_at datetime NOT NULL,
            address_count int(10) unsigned NOT NULL DEFAULT 0,
            standard_seconds int(10) unsigned NOT NULL DEFAULT 8,
            additional_minutes int(10) unsigned NOT NULL DEFAULT 0,
            house_seconds int(10) unsigned NOT NULL DEFAULT 0,
            route_distance_meters decimal(12,2) NOT NULL DEFAULT 0,
            route_duration_seconds int(10) unsigned NOT NULL DEFAULT 0,
            travel_mode varchar(10) NOT NULL DEFAULT 'foot',
            walking_speed_kmh decimal(5,2) NOT NULL DEFAULT 5,
            walking_seconds int(10) unsigned NOT NULL DEFAULT 0,
            calculated_total_seconds int(10) unsigned NOT NULL DEFAULT 0,
            measured_seconds int(10) unsigned DEFAULT NULL,
            route_json longtext NULL,
            PRIMARY KEY  (id),
            KEY user_id (user_id),
            KEY created_at (created_at)
        ) {$charset};";

        $sql2 = "CREATE TABLE {$addresses} (
            id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
            calculation_id bigint(20) unsigned NOT NULL,
            address_key varchar(64) NOT NULL,
            street varchar(191) NOT NULL DEFAULT '',
            house_number varchar(100) NOT NULL DEFAULT '',
            full_address text NOT NULL,
            latitude decimal(10,7) NOT NULL,
            longitude decimal(10,7) NOT NULL,
            seconds int(10) unsigned NOT NULL DEFAULT 8,
            quantity int(10) unsigned NOT NULL DEFAULT 1,
            address_order int(10) unsigned NOT NULL DEFAULT 0,
            PRIMARY KEY  (id),
            KEY calculation_id (calculation_id),
            KEY address_key (address_key)
        ) {$charset};";

        dbDelta($sql1);
        dbDelta($sql2);
        update_option('mrs_dtc_db_version', MRS_DTC_VERSION);
    }

    public static function maybe_upgrade(): void {
        if (get_option('mrs_dtc_db_version') !== MRS_DTC_VERSION) {
            self::install();
            MRS_DTC_Settings::migrate();
        }
    }

    public static function user_can_access(array $calc): bool {
        return current_user_can('manage_options') || (int) $calc['user_id'] === get_current_user_id();
    }

    private static function save_error(): WP_Error {
        return new WP_Error('save_failed', 'Die Berechnung konnte nicht gespeichert werden. Bitte versuchen Sie es später erneut.', ['status' => 500]);
    }

    private static function insert_addresses(int $calculation_id, array $addresses): bool {
        global $wpdb;
        foreach (array_values($addresses) as $index => $address) {
            $ok = $wpdb->insert(self::addresses_table(), [
                'calculation_id' => $calculation_id,
                'address_key'    => $address['address_key'],
                'street'         => $address['street'],
                'house_number'   => $address['house_number'],
                'full_address'   => $address['full_address'],
                'latitude'       => $address['latitude'],
                'longitude'      => $address['longitude'],
                'seconds'        => $address['seconds'],
                'quantity'       => $address['quantity'],
                'address_order'  => $index,
            ], ['%d', '%s', '%s', '%s', '%s', '%f', '%f', '%d', '%d', '%d']);
            if ($ok === false) {
                return false;
            }
        }
        return true;
    }

    /**
     * @return int|WP_Error neue ID
     */
    public static function insert_calculation(int $user_id, array $calc, array $addresses) {
        global $wpdb;
        $now = current_time('mysql');

        // Alles oder nichts: bei einem Fehler wird nichts halb gespeichert.
        $wpdb->query('START TRANSACTION');
        $ok = $wpdb->insert(self::calculations_table(), array_merge($calc, [
            'user_id'    => $user_id,
            'status'     => 'calculated',
            'created_at' => $now,
            'updated_at' => $now,
        ]));
        if ($ok === false) {
            $wpdb->query('ROLLBACK');
            return self::save_error();
        }
        $id = (int) $wpdb->insert_id;
        if (!self::insert_addresses($id, $addresses)) {
            $wpdb->query('ROLLBACK');
            return self::save_error();
        }
        $wpdb->query('COMMIT');
        return $id;
    }

    /**
     * @return true|WP_Error
     */
    public static function update_calculation(int $id, array $calc, array $addresses) {
        global $wpdb;

        $wpdb->query('START TRANSACTION');
        $ok = $wpdb->update(self::calculations_table(), array_merge($calc, ['updated_at' => current_time('mysql')]), ['id' => $id]);
        if ($ok === false) {
            $wpdb->query('ROLLBACK');
            return self::save_error();
        }
        $deleted = $wpdb->delete(self::addresses_table(), ['calculation_id' => $id], ['%d']);
        if ($deleted === false || !self::insert_addresses($id, $addresses)) {
            $wpdb->query('ROLLBACK');
            return self::save_error();
        }
        $wpdb->query('COMMIT');
        return true;
    }

    public static function get_calculation(int $id): ?array {
        global $wpdb;
        $ct = self::calculations_table();
        $at = self::addresses_table();

        $calc = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$ct} WHERE id = %d", $id), ARRAY_A);
        if (!$calc) {
            return null;
        }
        $calc['addresses'] = $wpdb->get_results(
            $wpdb->prepare("SELECT * FROM {$at} WHERE calculation_id = %d ORDER BY address_order ASC, id ASC", $id),
            ARRAY_A
        ) ?: [];
        return $calc;
    }

    public static function list_calculations(?int $user_id, int $limit, int $offset): array {
        global $wpdb;
        $ct = self::calculations_table();
        $where = $user_id ? $wpdb->prepare('WHERE user_id = %d', $user_id) : '';
        $sql = "SELECT id, user_id, title, created_at, address_count, route_distance_meters, house_seconds, travel_mode, walking_seconds, calculated_total_seconds FROM {$ct} {$where} ORDER BY created_at DESC, id DESC LIMIT %d OFFSET %d";
        return (array) $wpdb->get_results($wpdb->prepare($sql, $limit, $offset), ARRAY_A);
    }

    public static function count_calculations(?int $user_id): int {
        global $wpdb;
        $ct = self::calculations_table();
        $where = $user_id ? $wpdb->prepare('WHERE user_id = %d', $user_id) : '';
        return (int) $wpdb->get_var("SELECT COUNT(*) FROM {$ct} {$where}");
    }

    public static function stats(?int $user_id): array {
        global $wpdb;
        $ct = self::calculations_table();
        $where = $user_id ? $wpdb->prepare('WHERE user_id = %d', $user_id) : '';
        $row = $wpdb->get_row("SELECT COUNT(*) AS cnt, COALESCE(SUM(address_count),0) AS addresses, COALESCE(AVG(address_count),0) AS avg_addresses, COALESCE(AVG(calculated_total_seconds),0) AS avg_time, COALESCE(AVG(route_distance_meters),0) AS avg_distance FROM {$ct} {$where}", ARRAY_A);
        return [
            'count'         => (int) ($row['cnt'] ?? 0),
            'addresses'     => (int) ($row['addresses'] ?? 0),
            'avg_addresses' => (float) ($row['avg_addresses'] ?? 0),
            'avg_time'      => (int) round((float) ($row['avg_time'] ?? 0)),
            'avg_distance'  => (float) ($row['avg_distance'] ?? 0),
        ];
    }

    public static function delete_calculation(int $id): bool {
        global $wpdb;

        $wpdb->query('START TRANSACTION');
        $a = $wpdb->delete(self::addresses_table(), ['calculation_id' => $id], ['%d']);
        $c = $wpdb->delete(self::calculations_table(), ['id' => $id], ['%d']);
        if ($a === false || $c === false) {
            $wpdb->query('ROLLBACK');
            return false;
        }
        $wpdb->query('COMMIT');
        return true;
    }
}
