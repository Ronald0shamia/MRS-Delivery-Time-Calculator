<?php
defined('ABSPATH') || exit;

class MRS_DTC_Admin {
    const PER_PAGE = 20;

    public static function init(): void {
        add_action('admin_menu', [__CLASS__, 'menu']);
        add_action('admin_init', [__CLASS__, 'register_settings']);
        add_action('admin_enqueue_scripts', [__CLASS__, 'assets']);
        add_action('admin_post_mrs_dtc_delete', [__CLASS__, 'handle_delete']);
    }

    public static function menu(): void {
        $cap = MRS_DTC_REST_API::capability();
        add_menu_page('Delivery Time', 'Delivery Time', $cap, 'mrs-dtc', [__CLASS__, 'dashboard'], 'dashicons-location-alt', 30);
        add_submenu_page('mrs-dtc', 'Übersicht', 'Übersicht', $cap, 'mrs-dtc', [__CLASS__, 'dashboard']);
        add_submenu_page('mrs-dtc', 'Berechnungen', 'Berechnungen', $cap, 'mrs-dtc-calculations', [__CLASS__, 'calculations']);
        add_submenu_page('mrs-dtc', 'Einstellungen', 'Einstellungen', 'manage_options', 'mrs-dtc-settings', [__CLASS__, 'settings']);
    }

    public static function assets(string $hook): void {
        if (strpos($hook, 'mrs-dtc') === false) return;
        wp_enqueue_style('mrs-dtc-admin', MRS_DTC_URL . 'assets/css/admin.css', [], MRS_DTC_VERSION);
        wp_enqueue_script('mrs-dtc-admin', MRS_DTC_URL . 'assets/js/admin.js', [], MRS_DTC_VERSION, true);

        // Anzeigen/Bearbeiten nutzt denselben Rechner wie das Frontend.
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        $action = isset($_GET['action']) ? sanitize_key(wp_unslash($_GET['action'])) : '';
        if (in_array($action, ['view', 'edit'], true)) {
            MRS_DTC_Frontend::enqueue_assets();
        }
    }

    public static function register_settings(): void {
        register_setting('mrs_dtc_settings_group', MRS_DTC_Settings::OPTION, [
            'type' => 'array',
            'sanitize_callback' => ['MRS_DTC_Settings', 'sanitize'],
            'default' => MRS_DTC_Settings::defaults(),
        ]);
    }

    // Administratoren sehen alle Berechnungen, andere Benutzer nur ihre eigenen.
    private static function scope(): ?int {
        return current_user_can('manage_options') ? null : get_current_user_id();
    }

    private static function deny(): void {
        wp_die(esc_html__('Sie haben keine Berechtigung für diese Seite.', 'mrs-delivery-time'));
    }

    /* ---------------- Übersicht ---------------- */

    public static function dashboard(): void {
        if (!current_user_can(MRS_DTC_REST_API::capability())) self::deny();
        $stats = MRS_DTC_Database::stats(self::scope()); ?>
        <div class="wrap mrs-dtc-admin">
            <h1>Delivery Time</h1>
            <div class="mrs-dtc-cards">
                <div><span>Gespeicherte Berechnungen</span><strong><?php echo esc_html(number_format_i18n($stats['count'])); ?></strong></div>
                <div><span>Adressen insgesamt</span><strong><?php echo esc_html(number_format_i18n($stats['addresses'])); ?></strong></div>
                <div><span>Durchschnittliche Häuser/Tour</span><strong><?php echo esc_html(number_format_i18n($stats['avg_addresses'], 1)); ?></strong></div>
                <div><span>Durchschnittliche berechnete Zeit</span><strong><?php echo esc_html(MRS_DTC_Calculator::format_seconds($stats['avg_time'])); ?></strong></div>
                <div><span>Durchschnittliche Strecke</span><strong><?php echo esc_html(number_format_i18n($stats['avg_distance'] / 1000, 2)); ?> km</strong></div>
            </div>
            <div class="mrs-dtc-admin-box">
                <h2>Frontend verwenden</h2>
                <p>Füge den folgenden Shortcode in eine WordPress-Seite ein (sichtbar für angemeldete Benutzer mit Schreibrechten):</p>
                <code>[mrs_delivery_time_calculator]</code>
            </div>
        </div>
        <?php
    }

    /* ---------------- Berechnungen ---------------- */

    public static function calculations(): void {
        if (!current_user_can(MRS_DTC_REST_API::capability())) self::deny();

        // phpcs:disable WordPress.Security.NonceVerification.Recommended -- nur Anzeige.
        $action = isset($_GET['action']) ? sanitize_key(wp_unslash($_GET['action'])) : '';
        $id = isset($_GET['id']) ? absint($_GET['id']) : 0;
        // phpcs:enable

        if ($id && in_array($action, ['view', 'edit'], true)) {
            self::render_single($action, $id);
            return;
        }
        self::render_list();
    }

    private static function render_single(string $mode, int $id): void {
        $calc = MRS_DTC_Database::get_calculation($id);
        if (!$calc || !MRS_DTC_Database::user_can_access($calc)) {
            wp_die(esc_html__('Berechnung nicht gefunden.', 'mrs-delivery-time'), '', ['back_link' => true]);
        }
        $base = admin_url('admin.php?page=mrs-dtc-calculations'); ?>
        <div class="wrap mrs-dtc-admin">
            <h1>Berechnung #<?php echo esc_html((string) $id); ?> vom <?php echo esc_html(mysql2date('d.m.Y H:i', $calc['created_at'])); ?></h1>
            <p>
                <a href="<?php echo esc_url($base); ?>">&larr; Zurück zu den Berechnungen</a> |
                <?php if ($mode === 'view') : ?>
                    <a href="<?php echo esc_url(add_query_arg(['action' => 'edit', 'id' => $id], $base)); ?>">Bearbeiten</a>
                <?php else : ?>
                    <a href="<?php echo esc_url(add_query_arg(['action' => 'view', 'id' => $id], $base)); ?>">Nur ansehen</a>
                <?php endif; ?>
            </p>
            <?php echo MRS_DTC_Frontend::render($mode, $id); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- Markup wird in render() escaped. ?>
        </div>
        <?php
    }

    private static function render_list(): void {
        // phpcs:disable WordPress.Security.NonceVerification.Recommended -- nur Anzeige.
        $paged = isset($_GET['paged']) ? max(1, absint($_GET['paged'])) : 1;
        $deleted = isset($_GET['deleted']);
        // phpcs:enable

        $scope = self::scope();
        $total = MRS_DTC_Database::count_calculations($scope);
        $rows = MRS_DTC_Database::list_calculations($scope, self::PER_PAGE, ($paged - 1) * self::PER_PAGE);
        $base = admin_url('admin.php?page=mrs-dtc-calculations'); ?>
        <div class="wrap mrs-dtc-admin">
            <h1>Berechnungen</h1>
            <?php if ($deleted) : ?>
                <div class="notice notice-success is-dismissible"><p>Die Berechnung wurde gelöscht.</p></div>
            <?php endif; ?>
            <table class="widefat striped">
                <thead><tr><th>Datum</th><th>Titel</th><th>Adressen</th><th>Verkehrsmittel</th><th>Strecke</th><th>Hauszeit</th><th>Gesamtzeit</th><th>Aktionen</th></tr></thead>
                <tbody>
                <?php if (!$rows) : ?>
                    <tr><td colspan="8">Noch keine Berechnungen gespeichert.</td></tr>
                <?php else : foreach ($rows as $row) : $rid = (int) $row['id']; ?>
                    <tr>
                        <td><?php echo esc_html(mysql2date(get_option('date_format') . ' ' . get_option('time_format'), $row['created_at'])); ?></td>
                        <td><?php echo esc_html($row['title'] !== '' ? $row['title'] : '–'); ?></td>
                        <td><?php echo esc_html($row['address_count']); ?></td>
                        <td><?php echo esc_html(['foot' => 'Zu Fuß', 'bike' => 'Fahrrad', 'car' => 'Auto'][MRS_DTC_Settings::normalize_mode($row['travel_mode'] ?? 'foot')]); ?></td>
                        <td><?php echo esc_html(number_format_i18n(((float) $row['route_distance_meters']) / 1000, 2)); ?> km</td>
                        <td><?php echo esc_html(MRS_DTC_Calculator::format_seconds((int) $row['house_seconds'])); ?></td>
                        <td><strong><?php echo esc_html(MRS_DTC_Calculator::format_seconds((int) $row['calculated_total_seconds'])); ?></strong></td>
                        <td>
                            <a href="<?php echo esc_url(add_query_arg(['action' => 'view', 'id' => $rid], $base)); ?>">Anzeigen</a> |
                            <a href="<?php echo esc_url(add_query_arg(['action' => 'edit', 'id' => $rid], $base)); ?>">Bearbeiten</a> |
                            <button type="button" class="button-link button-link-delete mrs-dtc-delete" data-id="<?php echo esc_attr((string) $rid); ?>">Löschen</button>
                        </td>
                    </tr>
                <?php endforeach; endif; ?>
                </tbody>
            </table>

            <?php
            $pages = (int) ceil($total / self::PER_PAGE);
            if ($pages > 1) {
                echo '<div class="tablenav"><div class="tablenav-pages">';
                echo wp_kses_post(paginate_links(['base' => add_query_arg('paged', '%#%', $base), 'format' => '', 'current' => $paged, 'total' => $pages]));
                echo '</div></div>';
            } ?>

            <dialog id="mrs-dtc-delete-dialog" class="mrs-dtc-dialog">
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                    <input type="hidden" name="action" value="mrs_dtc_delete">
                    <input type="hidden" name="id" id="mrs-dtc-delete-id" value="">
                    <?php wp_nonce_field('mrs_dtc_delete', 'mrs_dtc_nonce'); ?>
                    <p>Möchten Sie diese Berechnung wirklich löschen?</p>
                    <p class="description">Alle zugehörigen Adressen werden ebenfalls gelöscht.</p>
                    <p class="mrs-dtc-dialog-actions">
                        <button type="button" class="button" id="mrs-dtc-delete-cancel">Abbrechen</button>
                        <button type="submit" class="button mrs-dtc-danger">Löschen</button>
                    </p>
                </form>
            </dialog>
        </div>
        <?php
    }

    public static function handle_delete(): void {
        check_admin_referer('mrs_dtc_delete', 'mrs_dtc_nonce');
        if (!current_user_can(MRS_DTC_REST_API::capability())) {
            wp_die(esc_html__('Sie haben keine Berechtigung für diese Aktion.', 'mrs-delivery-time'), '', ['response' => 403]);
        }

        $id = isset($_POST['id']) ? absint($_POST['id']) : 0; // phpcs:ignore WordPress.Security.NonceVerification.Missing -- Nonce oben geprüft.
        $calc = $id ? MRS_DTC_Database::get_calculation($id) : null;
        if (!$calc || !MRS_DTC_Database::user_can_access($calc)) {
            wp_die(esc_html__('Berechnung nicht gefunden.', 'mrs-delivery-time'), '', ['response' => 404, 'back_link' => true]);
        }

        MRS_DTC_Database::delete_calculation($id);
        wp_safe_redirect(add_query_arg(['page' => 'mrs-dtc-calculations', 'deleted' => 1], admin_url('admin.php')));
        exit;
    }

    /* ---------------- Einstellungen ---------------- */

    public static function settings(): void {
        if (!current_user_can('manage_options')) self::deny();
        $s = MRS_DTC_Settings::all();
        $o = MRS_DTC_Settings::OPTION; ?>
        <div class="wrap mrs-dtc-admin">
            <h1>Delivery Time – Einstellungen</h1>

            <div class="notice notice-warning inline"><p>
                <strong>Hinweis:</strong> Gespeicherte Adressen können personenbezogene oder sensible Standortinformationen enthalten.
                Verwenden Sie das Plugin nur entsprechend den geltenden Datenschutzbestimmungen.
            </p></div>

            <form method="post" action="options.php">
                <?php settings_fields('mrs_dtc_settings_group'); ?>
                <table class="form-table" role="presentation">
                    <tr><th><label for="mrs-s1">Standardzeit pro Haus</label></th>
                        <td><input id="mrs-s1" type="number" min="0" max="3600" name="<?php echo esc_attr($o); ?>[standard_seconds]" value="<?php echo esc_attr((string) $s['standard_seconds']); ?>"> Sekunden</td></tr>
                    <tr><th><label for="mrs-s2">Gehgeschwindigkeit (zu Fuß)</label></th>
                        <td><input id="mrs-s2" type="number" min="1" max="15" step="0.1" name="<?php echo esc_attr($o); ?>[walking_speed_kmh]" value="<?php echo esc_attr((string) $s['walking_speed_kmh']); ?>"> km/h</td></tr>
                    <tr><th><label for="mrs-s2b">Durchschnittsgeschwindigkeit Fahrrad</label></th>
                        <td><input id="mrs-s2b" type="number" min="3" max="60" step="0.5" name="<?php echo esc_attr($o); ?>[bike_speed_kmh]" value="<?php echo esc_attr((string) $s['bike_speed_kmh']); ?>"> km/h</td></tr>
                    <tr><th><label for="mrs-s2c">Durchschnittsgeschwindigkeit Auto</label></th>
                        <td><input id="mrs-s2c" type="number" min="5" max="150" step="1" name="<?php echo esc_attr($o); ?>[car_speed_kmh]" value="<?php echo esc_attr((string) $s['car_speed_kmh']); ?>"> km/h
                            <p class="description">Die Geh-/Fahrzeit wird aus der Strecke und der Geschwindigkeit des gewählten Verkehrsmittels berechnet. Bei Fahrrad und Auto ist ein Durchschnitt inklusive Anfahren und Halten sinnvoll (Zustelltour, nicht Landstraße).</p></td></tr>
                    <tr><th><label for="mrs-s3">Nominatim URL</label></th>
                        <td><input id="mrs-s3" class="regular-text" type="url" name="<?php echo esc_attr($o); ?>[nominatim_url]" value="<?php echo esc_attr($s['nominatim_url']); ?>">
                            <p class="description">Der öffentliche Server erlaubt max. 1 Anfrage pro Sekunde. Das Plugin drosselt und cached automatisch.</p></td></tr>
                    <tr><th><label for="mrs-s4">Routing API URL – zu Fuß</label></th>
                        <td><input id="mrs-s4" class="large-text" type="url" name="<?php echo esc_attr($o); ?>[routing_url_foot]" value="<?php echo esc_attr($s['routing_url_foot']); ?>"></td></tr>
                    <tr><th><label for="mrs-s4b">Routing API URL – Fahrrad</label></th>
                        <td><input id="mrs-s4b" class="large-text" type="url" name="<?php echo esc_attr($o); ?>[routing_url_bike]" value="<?php echo esc_attr($s['routing_url_bike']); ?>"></td></tr>
                    <tr><th><label for="mrs-s4c">Routing API URL – Auto</label></th>
                        <td><input id="mrs-s4c" class="large-text" type="url" name="<?php echo esc_attr($o); ?>[routing_url_car]" value="<?php echo esc_attr($s['routing_url_car']); ?>">
                            <p class="description">OSRM-Basis-URLs ohne Koordinaten. Der öffentliche FOSSGIS-Server nutzt pro Verkehrsmittel einen eigenen Pfad (routed-foot, routed-bike, routed-car).</p></td></tr>
                    <tr><th><label for="mrs-s5">Karten-Zoom</label></th>
                        <td><input id="mrs-s5" type="number" min="3" max="19" name="<?php echo esc_attr($o); ?>[map_zoom]" value="<?php echo esc_attr((string) $s['map_zoom']); ?>">
                            <p class="description">Zoomstufe, wenn nur eine Adresse auf der Karte ist.</p></td></tr>
                    <tr><th><label for="mrs-s6">Länderfilter für die Suche</label></th>
                        <td><input id="mrs-s6" type="text" class="small-text" placeholder="de,ch" name="<?php echo esc_attr($o); ?>[country_codes]" value="<?php echo esc_attr($s['country_codes']); ?>">
                            <p class="description">Optional: ISO-Ländercodes, durch Komma getrennt (z. B. de,ch). Leer = alle Länder.</p></td></tr>
                    <tr><th>Deinstallation</th>
                        <td><label><input type="checkbox" value="1" name="<?php echo esc_attr($o); ?>[delete_on_uninstall]" <?php checked(1, (int) $s['delete_on_uninstall']); ?>> Alle Berechnungen und Einstellungen beim Löschen des Plugins entfernen</label></td></tr>
                </table>
                <?php submit_button(); ?>
            </form>
        </div>
        <?php
    }
}
