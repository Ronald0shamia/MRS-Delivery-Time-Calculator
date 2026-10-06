<?php
defined('ABSPATH') || exit;

class MRS_DTC_Frontend {
    public static function init(): void {
        add_shortcode('mrs_delivery_time_calculator', [__CLASS__, 'shortcode']);
    }

    /**
     * Lädt CSS/JS. Wird nur aufgerufen, wenn der Rechner wirklich ausgegeben wird
     * (funktioniert dadurch auch mit Page-Buildern und Widgets) oder im Dashboard.
     */
    public static function enqueue_assets(): void {
        static $done = false;
        if ($done) return;
        $done = true;

        wp_enqueue_style('mrs-dtc-leaflet', MRS_DTC_URL . 'assets/vendor/leaflet/leaflet.css', [], '1.9.4');
        wp_enqueue_script('mrs-dtc-leaflet', MRS_DTC_URL . 'assets/vendor/leaflet/leaflet.js', [], '1.9.4', true);
        wp_enqueue_style('mrs-dtc-frontend', MRS_DTC_URL . 'assets/css/frontend.css', ['mrs-dtc-leaflet'], MRS_DTC_VERSION);
        wp_enqueue_script('mrs-dtc-frontend', MRS_DTC_URL . 'assets/js/frontend.js', ['mrs-dtc-leaflet'], MRS_DTC_VERSION, true);

        $s = MRS_DTC_Settings::all();
        wp_localize_script('mrs-dtc-frontend', 'MRS_DTC', [
            'restUrl' => esc_url_raw(rest_url(MRS_DTC_REST_API::NS . '/')),
            'nonce' => wp_create_nonce('wp_rest'),
            'settings' => [
                'standard_seconds' => (int) $s['standard_seconds'],
                'speeds' => [
                    'foot' => (float) $s['walking_speed_kmh'],
                    'bike' => (float) $s['bike_speed_kmh'],
                    'car' => (float) $s['car_speed_kmh'],
                ],
                'map_zoom' => (int) $s['map_zoom'],
            ],
            'strings' => [
                'serverError' => 'Der Server ist momentan nicht erreichbar. Bitte versuchen Sie es später erneut.',
                'searching' => 'Suche läuft …',
                'searchTooShort' => 'Bitte geben Sie mindestens 3 Zeichen ein.',
                'noResults' => 'Adresse konnte nicht gefunden werden. Prüfen Sie die Schreibweise oder ergänzen Sie den Ort.',
                'searchError' => 'Die Adresssuche ist momentan nicht erreichbar.',
                'duplicate' => 'Diese Adresse ist bereits in der Liste.',
                'routeRunning' => 'Route wird berechnet …',
                'routeError' => 'Die Route konnte nicht berechnet werden.',
                'routeDone' => 'Route erfolgreich berechnet.',
                'tileError' => 'Die Kartendaten konnten nicht geladen werden.',
                'saveError' => 'Die Berechnung konnte nicht gespeichert werden.',
                'saved' => 'Berechnung gespeichert.',
                'updated' => 'Berechnung aktualisiert.',
                'loadError' => 'Die Berechnung konnte nicht geladen werden.',
                'confirmNoRoute' => 'Die Route konnte nicht berechnet werden. Trotzdem ohne Strecke speichern?',
                'confirmDiscard' => 'Nicht gespeicherte Änderungen gehen verloren. Fortfahren?',
                'pending' => 'wird berechnet …',
                'secondsShort' => 'Sek.',
                'secondsLong' => 'Sekunden',
                'seconds' => 'Sekunden',
                'popupTime' => 'Zustellzeit',
                'popupPosition' => 'Position',
                'up' => 'Nach oben',
                'down' => 'Nach unten',
                'remove' => 'Adresse löschen',
                'drag' => 'Zum Umsortieren ziehen',
                'travel_foot' => 'Gehzeit',
                'travel_bike' => 'Fahrradzeit',
                'travel_car' => 'Fahrzeit',
            ],
        ]);
    }

    /**
     * Inline-SVG-Icons (statisch, kein externer Request).
     */
    private static function icon(string $mode): string {
        $icons = [
            'foot' => '<circle cx="13.5" cy="4.5" r="1.8"/><path d="M12.5 8.5l-2.5 3.5 3 2.5.5 5.5"/><path d="M10 12l-2.5 8"/><path d="M12.5 8.5l3 2.5 2.5-.5"/><path d="M12.5 8.5L9 10"/>',
            'bike' => '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
            'car' => '<path d="M5 17H4a1 1 0 0 1-1-1v-4l2-5.1a1 1 0 0 1 .93-.63h12.14a1 1 0 0 1 .93.63L21 12v4a1 1 0 0 1-1 1h-1"/><path d="M3 12h18"/><circle cx="7.5" cy="17" r="2"/><circle cx="16.5" cy="17" r="2"/><path d="M9.5 17h5"/>',
        ];
        return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' . ($icons[$mode] ?? '') . '</svg>';
    }

    public static function shortcode(): string {
        return self::render('new', 0);
    }

    /**
     * @param string $mode new|edit|view
     */
    public static function render(string $mode = 'new', int $calculation_id = 0): string {
        if (!is_user_logged_in() || !current_user_can(MRS_DTC_REST_API::capability())) {
            return '<p class="mrs-dtc-notice-box">Bitte melden Sie sich an, um den Zustellzeit-Rechner zu verwenden.</p>';
        }
        $mode = in_array($mode, ['new', 'edit', 'view'], true) ? $mode : 'new';
        self::enqueue_assets();

        ob_start(); ?>
        <div class="mrs-dtc" data-mrs-dtc data-mode="<?php echo esc_attr($mode); ?>" data-id="<?php echo esc_attr((string) $calculation_id); ?>">
            <noscript><p class="mrs-dtc-notice-box">Für den Rechner wird JavaScript benötigt.</p></noscript>

            <div class="mrs-dtc-header">
                <h2>Zustellzeit berechnen</h2>
                <p>Adressen hinzufügen, Route berechnen und die berechnete Zustellzeit dokumentieren.</p>
                <div class="mrs-dtc-load" data-load-wrap>
                    <button type="button" class="mrs-dtc-button" data-action="new">Neue Berechnung</button>
                </div>
            </div>

            <div class="mrs-dtc-grid">
                <section class="mrs-dtc-panel mrs-dtc-search-panel">
                    <div class="mrs-dtc-field" data-search-field>
                        <label for="mrs-dtc-address-search">Adresse suchen</label>
                        <div class="mrs-dtc-search-row">
                            <input id="mrs-dtc-address-search" type="text" autocomplete="off" maxlength="200" placeholder="z. B. Hauptstraße 25, 79725 Laufenburg">
                            <button type="button" class="mrs-dtc-button" data-action="search">Suchen</button>
                        </div>
                        <div class="mrs-dtc-status" data-status aria-live="polite"></div>
                        <div class="mrs-dtc-results" data-results></div>
                    </div>

                    <div class="mrs-dtc-field">
                        <label for="mrs-dtc-standard-seconds">Standardzeit pro Haus</label>
                        <div class="mrs-dtc-input-unit">
                            <input id="mrs-dtc-standard-seconds" type="number" min="0" max="3600" step="1" value="8">
                            <span>Sekunden</span>
                        </div>
                    </div>
                </section>

                <section class="mrs-dtc-map-panel">
                    <div id="mrs-dtc-map" class="mrs-dtc-map"></div>
                </section>

                <section class="mrs-dtc-panel mrs-dtc-list-panel">
                    <div class="mrs-dtc-addresses">
                        <div class="mrs-dtc-section-title">
                            <h3>Adressen</h3>
                            <span data-address-count>0</span>
                        </div>
                        <div data-address-list class="mrs-dtc-address-list">
                            <div class="mrs-dtc-empty">Noch keine Adressen hinzugefügt.</div>
                        </div>
                    </div>

                    <div class="mrs-dtc-field mrs-dtc-extra">
                        <label for="mrs-dtc-additional-minutes">Zusätzliche Zeit</label>
                        <div class="mrs-dtc-input-unit">
                            <input id="mrs-dtc-additional-minutes" type="number" min="0" max="1440" step="1" value="0">
                            <span>Minuten</span>
                        </div>
                    </div>

                    <div class="mrs-dtc-route">
                        <span class="mrs-dtc-route-title" id="mrs-dtc-route-title">Route berechnen</span>
                        <div class="mrs-dtc-modes" role="group" aria-labelledby="mrs-dtc-route-title">
                            <?php foreach ([['foot', 'Zu Fuß', 'Route zu Fuß berechnen'], ['bike', 'Fahrrad', 'Route mit dem Fahrrad berechnen'], ['car', 'Auto', 'Route mit dem Auto berechnen']] as [$m, $label, $title]) : ?>
                                <button type="button" class="mrs-dtc-mode" data-mode-btn="<?php echo esc_attr($m); ?>" aria-pressed="<?php echo $m === 'foot' ? 'true' : 'false'; ?>" title="<?php echo esc_attr($title); ?>">
                                    <?php echo self::icon($m); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- statisches SVG ?>
                                    <span><?php echo esc_html($label); ?></span>
                                </button>
                            <?php endforeach; ?>
                        </div>
                    </div>
                </section>
            </div>

            <section class="mrs-dtc-summary">
                <div><span>Gesamt Häuser</span><strong data-summary="houses">0</strong></div>
                <div><span>Strecke</span><strong data-summary="distance">0,00 km</strong></div>
                <div><span>Hauszustellzeit</span><strong data-summary="house">00:00:00</strong></div>
                <div><span data-summary-label="travel">Gehzeit</span><strong data-summary="travel">00:00:00</strong></div>
                <div><span>Zusatzzeit</span><strong data-summary="additional">00:00:00</strong></div>
                <div class="mrs-dtc-total"><span>Berechnete Zustellzeit</span><strong data-summary="total">00:00:00</strong></div>
            </section>

            <div class="mrs-dtc-notice">
                <strong>Hinweis:</strong> Die angezeigte Gesamtzeit ist eine <strong>berechnete Zustellzeit</strong>.
                Die Geh- bzw. Fahrzeit wird aus der Strecke und der eingestellten Durchschnittsgeschwindigkeit des gewählten Verkehrsmittels berechnet und ist nicht automatisch mit der tatsächlichen Arbeitszeit gleichzusetzen.
                Routing-Dauer laut Routing-Dienst (nur zur Information): <strong data-summary="routing">–</strong>
            </div>

            <div class="mrs-dtc-actions mrs-dtc-save-row">
                <button type="button" class="mrs-dtc-button mrs-dtc-primary mrs-dtc-save" data-action="save" disabled>Berechnung speichern</button>
            </div>

            <div class="mrs-dtc-message" data-message role="status" aria-live="polite"></div>
        </div>
        <?php
        return (string) ob_get_clean();
    }
}
