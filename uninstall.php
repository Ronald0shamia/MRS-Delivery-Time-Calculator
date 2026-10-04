<?php
defined('WP_UNINSTALL_PLUGIN') || exit;

global $wpdb;

// Zwischengespeicherte Suchergebnisse/Routen immer entfernen.
$wpdb->query($wpdb->prepare(
    "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
    $wpdb->esc_like('_transient_mrs_dtc_') . '%',
    $wpdb->esc_like('_transient_timeout_mrs_dtc_') . '%'
));

// Tabellen und Einstellungen nur löschen, wenn es in den Einstellungen aktiviert wurde.
$settings = get_option('mrs_dtc_settings', []);
if (is_array($settings) && !empty($settings['delete_on_uninstall'])) {
    $wpdb->query("DROP TABLE IF EXISTS {$wpdb->prefix}mrs_dtc_addresses");
    $wpdb->query("DROP TABLE IF EXISTS {$wpdb->prefix}mrs_dtc_calculations");
    delete_option('mrs_dtc_settings');
    delete_option('mrs_dtc_db_version');
}
