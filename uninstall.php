<?php
defined('WP_UNINSTALL_PLUGIN') || exit;

global $wpdb;

$calculations = $wpdb->prefix . 'mrs_dtc_calculations';
$addresses = $wpdb->prefix . 'mrs_dtc_addresses';

$wpdb->query("DROP TABLE IF EXISTS {$addresses}");
$wpdb->query("DROP TABLE IF EXISTS {$calculations}");
delete_option('mrs_dtc_settings');
delete_option('mrs_dtc_db_version');
