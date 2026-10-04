<?php
/**
 * Plugin Name: MRS Delivery Time Calculator
 * Description: Berechnet und dokumentiert Zeitung-Zustelltouren mit OpenStreetMap, Nominatim und OSRM.
 * Version: 1.1.0
 * Author: MRS Dev
 * Text Domain: mrs-delivery-time
 * Requires at least: 6.0
 * Requires PHP: 8.1
 */

defined('ABSPATH') || exit;

define('MRS_DTC_VERSION', '1.1.0');
define('MRS_DTC_FILE', __FILE__);
define('MRS_DTC_DIR', plugin_dir_path(__FILE__));
define('MRS_DTC_URL', plugin_dir_url(__FILE__));

require_once MRS_DTC_DIR . 'includes/class-settings.php';
require_once MRS_DTC_DIR . 'includes/class-database.php';
require_once MRS_DTC_DIR . 'includes/class-calculator.php';
require_once MRS_DTC_DIR . 'includes/class-rest-api.php';
require_once MRS_DTC_DIR . 'includes/class-frontend.php';
require_once MRS_DTC_DIR . 'admin/class-admin.php';

register_activation_hook(__FILE__, ['MRS_DTC_Database', 'activate']);
register_deactivation_hook(__FILE__, ['MRS_DTC_Database', 'deactivate']);

function mrs_dtc_init(): void {
    // Aktualisiert Tabellen/Einstellungen automatisch, wenn eine neue Plugin-Version hochgeladen wurde.
    MRS_DTC_Database::maybe_upgrade();

    MRS_DTC_REST_API::init();
    MRS_DTC_Frontend::init();
    if (is_admin()) {
        MRS_DTC_Admin::init();
    }
}
add_action('plugins_loaded', 'mrs_dtc_init');
