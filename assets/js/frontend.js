(() => {
    'use strict';

    const root = document.querySelector('[data-mrs-dtc]');
    if (!root || typeof L === 'undefined') return;

    const $ = (selector) => root.querySelector(selector);
    const api = (path, options = {}) => fetch(MRS_DTC.restUrl + path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'X-WP-Nonce': MRS_DTC.nonce,
            ...(options.headers || {})
        }
    }).then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || 'Serverfehler');
        return data;
    });

    const defaultSettings = MRS_DTC.settings || {};
    const state = {
        addresses: [],
        route: null,
        routeLayer: null,
        markers: [],
        standardSeconds: Number(defaultSettings.standard_seconds || 8),
        additionalMinutes: 0
    };

    const map = L.map($('#mrs-dtc-map')).setView([51.1657, 10.4515], Number(defaultSettings.map_zoom || 15));
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    const markerLayer = L.layerGroup().addTo(map);

    function setStatus(message, type = '') {
        const el = $('[data-status]');
        el.textContent = message || '';
        el.className = 'mrs-dtc-status' + (type ? ' ' + type : '');
    }

    function setMessage(message, type = '') {
        const el = $('[data-message]');
        el.textContent = message || '';
        el.className = 'mrs-dtc-message' + (type ? ' ' + type : '');
    }

    function formatTime(total) {
        total = Math.max(0, Math.round(Number(total) || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return [h, m, s].map((v, i) => String(v).padStart(2, '0')).join(':');
    }

    function formatDistance(meters) {
        return ((Number(meters) || 0) / 1000).toLocaleString('de-DE', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' km';
    }

    function recalculate() {
        const house = state.addresses.reduce((sum, a) => sum + Math.max(0, Number(a.seconds) || 0), 0);
        const walking = state.route ? Number(state.route.duration_seconds || 0) : 0;
        const additional = Math.max(0, Number(state.additionalMinutes) || 0) * 60;
        const total = house + walking + additional;

        $('[data-summary="houses"]').textContent = state.addresses.length;
        $('[data-summary="distance"]').textContent = state.route ? formatDistance(state.route.distance_meters) : '0,00 km';
        $('[data-summary="house"]').textContent = formatTime(house);
        $('[data-summary="walking"]').textContent = formatTime(walking);
        $('[data-summary="additional"]').textContent = formatTime(additional);
        $('[data-summary="total"]').textContent = formatTime(total);
    }

    function renderAddresses() {
        const list = $('[data-address-list]');
        $('[data-address-count]').textContent = state.addresses.length;

        if (!state.addresses.length) {
            list.innerHTML = '<div class="mrs-dtc-empty">Noch keine Adressen hinzugefügt.</div>';
        } else {
            list.innerHTML = state.addresses.map((a, i) => `
                <div class="mrs-dtc-address-item" data-key="${escapeHtml(a.address_key)}">
                    <div class="mrs-dtc-address-number">${i + 1}</div>
                    <div class="mrs-dtc-address-main">
                        <strong>${escapeHtml(a.street ? `${a.street} ${a.house_number}`.trim() : a.full_address)}</strong>
                        <small>${escapeHtml(a.full_address)}</small>
                    </div>
                    <div class="mrs-dtc-seconds">
                        <input type="number" min="0" step="1" value="${Number(a.seconds) || 0}" data-seconds="${escapeHtml(a.address_key)}" aria-label="Sekunden">
                        <span>Sek.</span>
                    </div>
                    <div class="mrs-dtc-item-actions">
                        <button type="button" title="Nach oben" data-up="${escapeHtml(a.address_key)}" ${i === 0 ? 'disabled' : ''}>↑</button>
                        <button type="button" title="Nach unten" data-down="${escapeHtml(a.address_key)}" ${i === state.addresses.length - 1 ? 'disabled' : ''}>↓</button>
                        <button type="button" title="Löschen" data-delete="${escapeHtml(a.address_key)}">×</button>
                    </div>
                </div>
            `).join('');
        }

        $('[data-action="route"]').disabled = state.addresses.length < 2;
        $('[data-action="save"]').disabled = state.addresses.length < 1;
        recalculate();
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;'
        }[ch]));
    }

    function redrawMap() {
        markerLayer.clearLayers();
        state.markers = [];

        state.addresses.forEach((a, index) => {
            const icon = L.divIcon({
                className: 'mrs-dtc-number-marker-wrapper',
                html: `<div class="mrs-dtc-number-marker">${index + 1}</div>`,
                iconSize: [34, 34],
                iconAnchor: [17, 17]
            });

            const marker = L.marker([a.latitude, a.longitude], {icon}).addTo(markerLayer);
            marker.bindPopup(`<strong>${escapeHtml(a.full_address)}</strong><br>Zustellzeit: ${Number(a.seconds) || 0} Sekunden<br>Position: ${index + 1}`);
            state.markers.push(marker);
        });

        if (state.addresses.length) {
            const bounds = L.latLngBounds(state.addresses.map(a => [a.latitude, a.longitude]));
            map.fitBounds(bounds.pad(0.15), {maxZoom: 18});
        }
    }

    function invalidateRoute() {
        state.route = null;
        if (state.routeLayer) {
            map.removeLayer(state.routeLayer);
            state.routeLayer = null;
        }
        recalculate();
    }

    async function search() {
        const input = $('#mrs-dtc-address-search');
        const query = input.value.trim();
        if (!query) return;

        setStatus(MRS_DTC.strings.searching);
        $('[data-results]').innerHTML = '';

        try {
            const data = await api('geocode', {
                method: 'POST',
                body: JSON.stringify({query})
            });

            if (!data.results?.length) {
                setStatus(MRS_DTC.strings.noResults, 'error');
                return;
            }

            $('[data-results]').innerHTML = data.results.map((r, i) => `
                <button type="button" class="mrs-dtc-result" data-result-index="${i}">
                    ${escapeHtml(r.display_name)}
                </button>
            `).join('');

            $('[data-results]').querySelectorAll('[data-result-index]').forEach(button => {
                button.addEventListener('click', () => {
                    const result = data.results[Number(button.dataset.resultIndex)];
                    addAddress(result);
                    $('[data-results]').innerHTML = '';
                    setStatus('');
                    input.value = '';
                });
            });
        } catch (error) {
            setStatus(error.message || MRS_DTC.strings.searchError, 'error');
        }
    }

    function addAddress(result) {
        const key = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
        state.addresses.push({
            address_key: key,
            street: result.street || '',
            house_number: result.house_number || '',
            full_address: result.display_name || '',
            latitude: Number(result.lat),
            longitude: Number(result.lon),
            seconds: state.standardSeconds
        });
        invalidateRoute();
        renderAddresses();
        redrawMap();
    }

    async function calculateRoute() {
        if (state.addresses.length < 2) return;
        setMessage('Route wird berechnet …');

        try {
            const data = await api('route', {
                method: 'POST',
                body: JSON.stringify({
                    coordinates: state.addresses.map(a => ({lat: a.latitude, lon: a.longitude}))
                })
            });

            state.route = data;
            if (state.routeLayer) map.removeLayer(state.routeLayer);
            if (data.geometry?.coordinates?.length) {
                const latLngs = data.geometry.coordinates.map(c => [c[1], c[0]]);
                state.routeLayer = L.polyline(latLngs, {weight: 5}).addTo(map);
                map.fitBounds(state.routeLayer.getBounds().pad(0.08));
            }
            recalculate();
            setMessage('Route erfolgreich berechnet.', 'success');
        } catch (error) {
            setMessage(error.message || MRS_DTC.strings.routeError, 'error');
        }
    }

    async function save() {
        if (!state.addresses.length) return;
        const payload = {
            standard_seconds: state.standardSeconds,
            additional_minutes: state.additionalMinutes,
            addresses: state.addresses,
            route_duration_seconds: state.route?.duration_seconds || 0,
            route_distance_meters: state.route?.distance_meters || 0,
            route: state.route || null
        };

        try {
            const data = await api('calculations', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            setMessage(`${MRS_DTC.strings.saved} (#${data.id})`, 'success');
        } catch (error) {
            setMessage(error.message || MRS_DTC.strings.saveError, 'error');
        }
    }

    function move(key, direction) {
        const index = state.addresses.findIndex(a => a.address_key === key);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= state.addresses.length) return;
        [state.addresses[index], state.addresses[target]] = [state.addresses[target], state.addresses[index]];
        invalidateRoute();
        renderAddresses();
        redrawMap();
    }

    root.addEventListener('click', event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'search') search();
        if (action === 'route') calculateRoute();
        if (action === 'save') save();

        const del = event.target.closest('[data-delete]')?.dataset.delete;
        if (del) {
            state.addresses = state.addresses.filter(a => a.address_key !== del);
            invalidateRoute();
            renderAddresses();
            redrawMap();
        }

        const up = event.target.closest('[data-up]')?.dataset.up;
        if (up) move(up, -1);

        const down = event.target.closest('[data-down]')?.dataset.down;
        if (down) move(down, 1);
    });

    root.addEventListener('input', event => {
        if (event.target.matches('[data-seconds]')) {
            const key = event.target.dataset.seconds;
            const address = state.addresses.find(a => a.address_key === key);
            if (address) {
                address.seconds = Math.max(0, Number(event.target.value) || 0);
                invalidateRoute();
                redrawMap();
            }
        }
        if (event.target.id === 'mrs-dtc-standard-seconds') {
            state.standardSeconds = Math.max(0, Number(event.target.value) || 0);
        }
        if (event.target.id === 'mrs-dtc-additional-minutes') {
            state.additionalMinutes = Math.max(0, Number(event.target.value) || 0);
            recalculate();
        }
    });

    $('#mrs-dtc-address-search').addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            search();
        }
    });

    $('#mrs-dtc-standard-seconds').value = state.standardSeconds;
    renderAddresses();
})();
