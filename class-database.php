<?php
defined('ABSPATH') || exit;

class MRS_DTC_Frontend {
    public static function init(): void {
        add_shortcode('mrs_delivery_time_calculator', [__CLASS__, 'shortcode']);
        add_action('wp_enqueue_scripts', [__CLASS__, 'assets']);
    }

    public static function assets(): void {
        if (!is_singular()) return;
        global $post;
        if (!$post || !has_shortcode((string) $post->post_content, 'mrs_delivery_time_calculator')) return;

        wp_enqueue_style('leaflet', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', [], '1.9.4');
        wp_enqueue_script('leaflet', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', [], '1.9.4', true);
        wp_enqueue_style('mrs-dtc-frontend', MRS_DTC_URL . 'assets/css/frontend.css', [], MRS_DTC_VERSION);
        wp_enqueue_script('mrs-dtc-frontend', MRS_DTC_URL . 'assets/js/frontend.js', ['leaflet'], MRS_DTC_VERSION, true);

        wp_localize_script('mrs-dtc-frontend', 'MRS_DTC', [
            'restUrl' => esc_url_raw(rest_url('mrs-dtc/v1/')),
            'nonce' => wp_create_nonce('wp_rest'),
            'settings' => get_option('mrs_dtc_settings', []),
            'strings' => [
                'searching' => 'Suche läuft …',
                'noResults' => 'Keine Adresse gefunden.',
                'searchError' => 'Die Adresssuche ist momentan nicht erreichbar.',
                'routeError' => 'Die Route konnte nicht berechnet werden.',
                'saveError' => 'Die Berechnung konnte nicht gespeichert werden.',
                'saved' => 'Berechnung gespeichert.',
            ],
        ]);
    }

    public static function shortcode(): string {
        ob_start(); ?>
        <div class="mrs-dtc" data-mrs-dtc>
            <div class="mrs-dtc-header">
                <h2>Zustellzeit berechnen</h2>
                <p>Adressen hinzufügen, Route berechnen und die berechnete Zustellzeit dokumentieren.</p>
            </div>

            <div class="mrs-dtc-grid">
                <section class="mrs-dtc-panel mrs-dtc-controls">
                    <div class="mrs-dtc-field">
                        <label for="mrs-dtc-address-search">Adresse suchen</label>
                        <div class="mrs-dtc-search-row">
                            <input id="mrs-dtc-address-search" type="text" autocomplete="off" placeholder="z. B. Hauptstraße 25, 79725 Laufenburg">
                            <button type="button" class="mrs-dtc-button" data-action="search">Suchen</button>
                        </div>
                        <div class="mrs-dtc-status" data-status aria-live="polite"></div>
                        <div class="mrs-dtc-results" data-results></div>
                    </div>

                    <div class="mrs-dtc-field">
                        <label for="mrs-dtc-standard-seconds">Standardzeit pro Haus</label>
                        <div class="mrs-dtc-input-unit">
                            <input id="mrs-dtc-standard-seconds" type="number" min="0" step="1" value="8">
                            <span>Sekunden</span>
                        </div>
                    </div>

                    <div class="mrs-dtc-field">
                        <label for="mrs-dtc-additional-minutes">Zusätzliche Zeit</label>
                        <div class="mrs-dtc-input-unit">
                            <input id="mrs-dtc-additional-minutes" type="number" min="0" step="1" value="0">
                            <span>Minuten</span>
                        </div>
                    </div>

                    <div class="mrs-dtc-addresses">
                        <div class="mrs-dtc-section-title">
                            <h3>Adressen</h3>
                            <span data-address-count>0</span>
                        </div>
                        <div data-address-list class="mrs-dtc-address-list">
                            <div class="mrs-dtc-empty">Noch keine Adressen hinzugefügt.</div>
                        </div>
                    </div>

                    <div class="mrs-dtc-actions">
                        <button type="button" class="mrs-dtc-button mrs-dtc-primary" data-action="route" disabled>Route berechnen</button>
                        <button type="button" class="mrs-dtc-button" data-action="save" disabled>Berechnung speichern</button>
                    </div>
                </section>

                <section class="mrs-dtc-map-panel">
                    <div id="mrs-dtc-map" class="mrs-dtc-map"></div>
                </section>
            </div>

            <section class="mrs-dtc-summary">
                <div><span>Gesamt Häuser</span><strong data-summary="houses">0</strong></div>
                <div><span>Strecke</span><strong data-summary="distance">0,00 km</strong></div>
                <div><span>Hauszustellzeit</span><strong data-summary="house">00:00:00</strong></div>
                <div><span>Gehzeit</span><strong data-summary="walking">00:00:00</strong></div>
                <div><span>Zusatzzeit</span><strong data-summary="additional">00:00:00</strong></div>
                <div class="mrs-dtc-total"><span>Berechnete Zustellzeit</span><strong data-summary="total">00:00:00</strong></div>
            </section>

            <div class="mrs-dtc-notice">
                <strong>Hinweis:</strong> Die angezeigte Gesamtzeit ist eine <strong>berechnete Zustellzeit</strong>.
                Die Routing-/Gehzeit ist nicht automatisch mit der tatsächlichen Arbeitszeit gleichzusetzen.
            </div>

            <div class="mrs-dtc-message" data-message role="status" aria-live="polite"></div>
        </div>
        <?php
        return (string) ob_get_clean();
    }
}
