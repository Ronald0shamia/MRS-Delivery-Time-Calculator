(() => {
    'use strict';

    const root = document.querySelector('[data-mrs-dtc]');
    if (!root || typeof L === 'undefined' || typeof MRS_DTC === 'undefined') return;

    const S = MRS_DTC.strings;
    const defaultSettings = MRS_DTC.settings || {};
    const mode = root.dataset.mode || 'new'; // new | edit | view
    const readonly = mode === 'view';
    const $ = (selector) => root.querySelector(selector);

    /* ---------- REST ---------- */

    // Bei "einfachen" Permalinks steckt die Route in ?rest_route=, daher ggf. mit & anhängen.
    function buildUrl(path, params) {
        let url = MRS_DTC.restUrl + path;
        if (params) {
            const qs = new URLSearchParams(params).toString();
            if (qs) url += (url.includes('?') ? '&' : '?') + qs;
        }
        return url;
    }

    async function api(path, {method = 'GET', body, signal, params} = {}) {
        const headers = {'Accept': 'application/json', 'X-WP-Nonce': MRS_DTC.nonce};
        const init = {method, headers, signal, credentials: 'same-origin'};
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }

        let response;
        try {
            response = await fetch(buildUrl(path, params), init);
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            throw new Error(S.serverError);
        }
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error((data && data.message) || S.serverError);
        return data;
    }

    /* ---------- State ---------- */

    const state = {
        addresses: [],
        route: null, // {distance_meters, duration_seconds, geometry}
        routeLayer: null,
        standardSeconds: Number(defaultSettings.standard_seconds ?? 8),
        additionalMinutes: 0,
        walkingSpeed: Number(defaultSettings.walking_speed_kmh || 5),
        calculationId: 0,
        title: ''
    };

    let routeTimer = null;
    let routeAbort = null;
    let routeSeq = 0;
    let routePending = false;
    let searchBusy = false;
    let messageTimer = null;
    let dirty = false;

    /* ---------- Karte ---------- */

    // Startansicht Deutschland, bis die erste Adresse da ist.
    const map = L.map($('#mrs-dtc-map'), {scrollWheelZoom: false}).setView([51.1657, 10.4515], 6);
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende'
    }).addTo(map);

    let tileWarned = false;
    tiles.on('tileerror', () => {
        if (tileWarned) return;
        tileWarned = true;
        setMessage(S.tileError, 'error');
    });

    // Mausrad-Zoom erst nach Klick in die Karte, damit das Scrollen der Seite nicht blockiert wird.
    map.on('click', () => map.scrollWheelZoom.enable());
    map.on('mouseout', () => map.scrollWheelZoom.disable());
    setTimeout(() => map.invalidateSize(), 250);
    window.addEventListener('resize', () => map.invalidateSize());

    const markerLayer = L.layerGroup().addTo(map);

    /* ---------- Hilfsfunktionen ---------- */

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        }[ch]));
    }

    function setStatus(message, type = '') {
        const el = $('[data-status]');
        el.textContent = message || '';
        el.className = 'mrs-dtc-status' + (type ? ' ' + type : '');
    }

    function setMessage(message, type = '') {
        clearTimeout(messageTimer);
        const el = $('[data-message]');
        el.textContent = message || '';
        el.className = 'mrs-dtc-message' + (type ? ' ' + type : '');
        if (type === 'success') messageTimer = setTimeout(() => setMessage(''), 6000);
    }

    function formatTime(total) {
        total = Math.max(0, Math.round(Number(total) || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
    }

    function formatDistance(meters) {
        return ((Number(meters) || 0) / 1000).toLocaleString('de-DE', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' km';
    }

    function clampNumber(value, min, max, fallback) {
        const n = parseFloat(String(value).replace(',', '.'));
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    }

    function addressTitle(a) {
        return (a.street ? `${a.street} ${a.house_number}`.trim() : '') || (a.full_address || '').split(',')[0] || '';
    }

    function markDirty() {
        if (!readonly) dirty = true;
    }

    /* ---------- Berechnung ---------- */

    function recalculate() {
        const house = state.addresses.reduce((sum, a) => sum + Math.max(0, Number(a.seconds) || 0), 0);
        const distance = state.route ? Number(state.route.distance_meters || 0) : 0;
        // Gleiche Formel wie auf dem Server (MRS_DTC_Calculator::calculate)
        const walking = state.walkingSpeed > 0 ? Math.round(distance / 1000 / state.walkingSpeed * 3600) : 0;
        const additional = Math.round(Math.max(0, Number(state.additionalMinutes) || 0) * 60);
        const total = house + walking + additional;

        $('[data-summary="houses"]').textContent = state.addresses.length;
        $('[data-summary="house"]').textContent = formatTime(house);
        $('[data-summary="additional"]').textContent = formatTime(additional);

        if (routePending) {
            $('[data-summary="distance"]').textContent = S.pending;
            $('[data-summary="walking"]').textContent = S.pending;
            $('[data-summary="routing"]').textContent = S.pending;
            $('[data-summary="total"]').textContent = formatTime(house + additional) + ' +';
            return;
        }

        $('[data-summary="distance"]').textContent = state.route ? formatDistance(distance) : '0,00 km';
        $('[data-summary="walking"]').textContent = formatTime(walking);
        $('[data-summary="routing"]').textContent = state.route ? formatTime(state.route.duration_seconds) : '–';
        $('[data-summary="total"]').textContent = formatTime(total);
    }

    /* ---------- Adressliste ---------- */

    function renderAddresses() {
        const list = $('[data-address-list]');
        $('[data-address-count]').textContent = state.addresses.length;

        if (!state.addresses.length) {
            list.innerHTML = '<div class="mrs-dtc-empty">Noch keine Adressen hinzugefügt.</div>';
        } else {
            list.innerHTML = state.addresses.map((a, i) => {
                const title = addressTitle(a);
                const sub = (a.full_address || '').split(',').slice(1).join(',').trim();
                const actions = readonly ? '' : `
                    <div class="mrs-dtc-item-actions">
                        <button type="button" title="${escapeHtml(S.up)}" aria-label="${escapeHtml(S.up)}" data-up="${escapeHtml(a.address_key)}" ${i === 0 ? 'disabled' : ''}>↑</button>
                        <button type="button" title="${escapeHtml(S.down)}" aria-label="${escapeHtml(S.down)}" data-down="${escapeHtml(a.address_key)}" ${i === state.addresses.length - 1 ? 'disabled' : ''}>↓</button>
                        <button type="button" title="${escapeHtml(S.remove)}" aria-label="${escapeHtml(S.remove)}" data-delete="${escapeHtml(a.address_key)}">🗑</button>
                    </div>`;
                return `
                <div class="mrs-dtc-address-item" data-key="${escapeHtml(a.address_key)}">
                    <div class="mrs-dtc-address-number">${i + 1}</div>
                    <div class="mrs-dtc-address-main">
                        <strong>${escapeHtml(title)}</strong>
                        <small>${escapeHtml(sub)}</small>
                    </div>
                    <div class="mrs-dtc-seconds">
                        <input type="number" min="0" max="3600" step="1" inputmode="numeric" value="${Number(a.seconds) || 0}" data-seconds="${escapeHtml(a.address_key)}" aria-label="${escapeHtml(S.seconds)}: ${escapeHtml(title)}" ${readonly ? 'disabled' : ''}>
                        <span>${escapeHtml(S.secondsShort)}</span>
                    </div>
                    ${actions}
                </div>`;
            }).join('');
        }

        $('[data-action="route"]').disabled = readonly || state.addresses.length < 2;
        $('[data-action="save"]').disabled = readonly || state.addresses.length < 1;
        recalculate();
    }

    function redrawMap(fit = false) {
        markerLayer.clearLayers();

        state.addresses.forEach((a, index) => {
            const icon = L.divIcon({
                className: 'mrs-dtc-number-marker-wrapper',
                html: `<div class="mrs-dtc-number-marker">${index + 1}</div>`,
                iconSize: [34, 34],
                iconAnchor: [17, 17],
                popupAnchor: [0, -16]
            });
            L.marker([a.latitude, a.longitude], {icon})
                .addTo(markerLayer)
                .bindPopup(`<strong>${escapeHtml(addressTitle(a) || a.full_address)}</strong><br>${escapeHtml(S.popupTime)}: ${Number(a.seconds) || 0} ${escapeHtml(S.secondsLong)}<br>${escapeHtml(S.popupPosition)}: ${index + 1}`);
        });

        if (fit) fitMap();
    }

    function fitMap() {
        const points = state.addresses.map(a => [a.latitude, a.longitude]);
        if (state.routeLayer) {
            points.push(...state.routeLayer.getLatLngs().map(p => [p.lat, p.lng]));
        }
        if (!points.length) return;
        if (points.length === 1) {
            map.setView(points[0], Number(defaultSettings.map_zoom || 16));
            return;
        }
        map.fitBounds(L.latLngBounds(points).pad(0.1), {maxZoom: 18});
    }

    function drawRoute() {
        if (state.routeLayer) {
            map.removeLayer(state.routeLayer);
            state.routeLayer = null;
        }
        const coords = state.route?.geometry?.coordinates;
        if (coords && coords.length > 1) {
            state.routeLayer = L.polyline(coords.map(c => [c[1], c[0]]), {color: '#e8590c', weight: 5, opacity: 0.85}).addTo(map);
        }
    }

    /* ---------- Route (automatisch + per Button) ---------- */

    // Reihenfolge/Adressen geändert -> alte Route ist ungültig, neue wird (verzögert) berechnet.
    function invalidateRoute(immediate = false) {
        clearTimeout(routeTimer);
        routeTimer = null;
        routeSeq++;
        if (routeAbort) routeAbort.abort();
        state.route = null;
        drawRoute();

        if (state.addresses.length < 2 || readonly) {
            routePending = false;
            recalculate();
            return Promise.resolve();
        }
        routePending = true;
        recalculate();
        if (immediate) return calculateRoute();
        // Entprellt: mehrere schnelle Änderungen lösen nur eine Anfrage aus.
        routeTimer = setTimeout(calculateRoute, 900);
        return Promise.resolve();
    }

    async function calculateRoute() {
        clearTimeout(routeTimer);
        routeTimer = null;
        if (state.addresses.length < 2) return;

        const mine = ++routeSeq;
        if (routeAbort) routeAbort.abort();
        routeAbort = new AbortController();
        routePending = true;
        $('[data-action="route"]').disabled = true;
        setMessage(S.routeRunning);
        recalculate();

        try {
            const data = await api('route', {
                method: 'POST',
                signal: routeAbort.signal,
                body: {coordinates: state.addresses.map(a => ({lat: a.latitude, lon: a.longitude}))}
            });
            if (mine !== routeSeq) return;
            state.route = data;
            drawRoute();
            fitMap();
            setMessage(S.routeDone, 'success');
        } catch (error) {
            if (error.name === 'AbortError' || mine !== routeSeq) return;
            state.route = null;
            drawRoute();
            setMessage(error.message || S.routeError, 'error');
        } finally {
            if (mine === routeSeq) {
                routePending = false;
                $('[data-action="route"]').disabled = readonly || state.addresses.length < 2;
                recalculate();
            }
        }
    }

    /* ---------- Adresssuche ---------- */

    async function search() {
        if (searchBusy || readonly) return;
        const input = $('#mrs-dtc-address-search');
        const query = input.value.trim();
        if (query.length < 3) {
            setStatus(S.searchTooShort, 'error');
            return;
        }

        searchBusy = true;
        const button = $('[data-action="search"]');
        button.disabled = true;
        setStatus(S.searching);
        $('[data-results]').innerHTML = '';

        try {
            const data = await api('geocode', {method: 'POST', body: {query}});
            if (!data.results?.length) {
                setStatus(S.noResults, 'error');
                return;
            }
            setStatus('');

            $('[data-results]').innerHTML = data.results.map((r, i) => `
                <button type="button" class="mrs-dtc-result" data-result-index="${i}">
                    ${escapeHtml(r.display_name)}
                </button>
            `).join('');

            $('[data-results]').querySelectorAll('[data-result-index]').forEach(btn => {
                btn.addEventListener('click', () => addAddress(data.results[Number(btn.dataset.resultIndex)]));
            });
        } catch (error) {
            setStatus(error.message || S.searchError, 'error');
        } finally {
            searchBusy = false;
            button.disabled = false;
        }
    }

    function addAddress(result) {
        const lat = Number(result.lat);
        const lon = Number(result.lon);
        const exists = state.addresses.some(a =>
            Math.abs(a.latitude - lat) < 1e-6 && Math.abs(a.longitude - lon) < 1e-6 && a.house_number === (result.house_number || '')
        );
        if (exists) {
            setStatus(S.duplicate, 'error');
            return;
        }

        const key = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        state.addresses.push({
            address_key: key,
            street: result.street || '',
            house_number: result.house_number || '',
            full_address: result.display_name || '',
            latitude: lat,
            longitude: lon,
            seconds: state.standardSeconds
        });

        $('[data-results]').innerHTML = '';
        setStatus('');
        const input = $('#mrs-dtc-address-search');
        input.value = '';
        input.focus();

        markDirty();
        renderAddresses();
        redrawMap(true);
        invalidateRoute();
    }

    function move(key, direction) {
        const index = state.addresses.findIndex(a => a.address_key === key);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= state.addresses.length) return;
        [state.addresses[index], state.addresses[target]] = [state.addresses[target], state.addresses[index]];
        markDirty();
        renderAddresses();
        redrawMap();
        invalidateRoute();
    }

    function removeAddress(key) {
        state.addresses = state.addresses.filter(a => a.address_key !== key);
        markDirty();
        renderAddresses();
        redrawMap(state.addresses.length > 0);
        invalidateRoute();
    }

    /* ---------- Speichern / Laden ---------- */

    function buildPayload() {
        return {
            title: state.title,
            standard_seconds: state.standardSeconds,
            additional_minutes: Math.round(state.additionalMinutes),
            walking_speed_kmh: state.walkingSpeed,
            route_distance_meters: state.route?.distance_meters || 0,
            route_duration_seconds: state.route?.duration_seconds || 0,
            route: state.route ? {geometry: state.route.geometry} : null,
            addresses: state.addresses
        };
    }

    async function save() {
        if (readonly || !state.addresses.length) return;
        const button = $('[data-action="save"]');
        button.disabled = true;

        try {
            // Gespeicherte Strecke muss zur aktuellen Reihenfolge passen.
            if (routeTimer || routePending) await calculateRoute();
            if (state.addresses.length > 1 && !state.route && !window.confirm(S.confirmNoRoute)) return;

            const updating = state.calculationId > 0;
            const data = updating
                ? await api('calculations/' + state.calculationId, {method: 'PUT', body: buildPayload()})
                : await api('calculations', {method: 'POST', body: buildPayload()});

            state.calculationId = data.id;
            dirty = false;
            setMessage(`${updating ? S.updated : S.saved} (#${data.id})`, 'success');
            if (mode === 'new') refreshSavedList(data.id);
        } catch (error) {
            setMessage(error.message || S.saveError, 'error');
        } finally {
            button.disabled = readonly || state.addresses.length < 1;
        }
    }

    function applyCalculation(c) {
        clearTimeout(routeTimer);
        routeSeq++;
        if (routeAbort) routeAbort.abort();

        state.addresses = c.addresses.map(a => ({
            address_key: a.address_key,
            street: a.street,
            house_number: a.house_number,
            full_address: a.full_address,
            latitude: a.latitude,
            longitude: a.longitude,
            seconds: a.seconds
        }));
        state.standardSeconds = c.standard_seconds;
        state.additionalMinutes = c.additional_minutes;
        state.walkingSpeed = c.walking_speed_kmh || state.walkingSpeed; // Gehgeschwindigkeit von damals
        state.title = c.title || '';
        state.calculationId = c.id;
        state.route = c.route ? {
            distance_meters: c.route_distance_meters,
            duration_seconds: c.route_duration_seconds,
            geometry: c.route
        } : null;
        routePending = false;

        $('#mrs-dtc-standard-seconds').value = state.standardSeconds;
        $('#mrs-dtc-additional-minutes').value = state.additionalMinutes;

        renderAddresses();
        redrawMap();
        drawRoute();
        fitMap();
        dirty = false;
    }

    async function loadCalculation(id) {
        setMessage('…');
        try {
            applyCalculation(await api('calculations/' + id));
            setMessage('');
        } catch (error) {
            setMessage(error.message || S.loadError, 'error');
        }
    }

    async function refreshSavedList(selectedId = 0) {
        const select = $('[data-load]');
        try {
            const items = await api('calculations');
            select.innerHTML = `<option value="">${escapeHtml(S.openPlaceholder)}</option>` + items.map(item =>
                `<option value="${item.id}" ${item.id === selectedId ? 'selected' : ''}>${escapeHtml(`${item.created_at_local} – ${item.address_count} ${S.addresses} – ${formatTime(item.calculated_total_seconds)}`)}</option>`
            ).join('');
        } catch (error) {
            // Die Liste ist nur eine Komfortfunktion.
        }
    }

    function resetCalculation() {
        clearTimeout(routeTimer);
        routeSeq++;
        if (routeAbort) routeAbort.abort();
        state.addresses = [];
        state.route = null;
        state.additionalMinutes = 0;
        state.standardSeconds = Number(defaultSettings.standard_seconds ?? 8);
        state.walkingSpeed = Number(defaultSettings.walking_speed_kmh || 5);
        state.calculationId = 0;
        state.title = '';
        routePending = false;
        dirty = false;

        $('#mrs-dtc-standard-seconds').value = state.standardSeconds;
        $('#mrs-dtc-additional-minutes').value = 0;
        $('[data-load]').value = '';
        $('[data-results]').innerHTML = '';
        setStatus('');
        setMessage('');
        drawRoute();
        renderAddresses();
        redrawMap();
    }

    /* ---------- Events ---------- */

    root.addEventListener('click', event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'search') search();
        if (action === 'route') invalidateRoute(true);
        if (action === 'save') save();
        if (action === 'new') {
            if (dirty && !window.confirm(S.confirmDiscard)) return;
            resetCalculation();
        }
        if (readonly) return;

        const del = event.target.closest('[data-delete]')?.dataset.delete;
        if (del) removeAddress(del);
        const up = event.target.closest('[data-up]')?.dataset.up;
        if (up) move(up, -1);
        const down = event.target.closest('[data-down]')?.dataset.down;
        if (down) move(down, 1);
    });

    root.addEventListener('input', event => {
        if (event.target.matches('[data-seconds]')) {
            const address = state.addresses.find(a => a.address_key === event.target.dataset.seconds);
            if (address) {
                // Sekunden ändern die Strecke nicht: Route bleibt, nur Summen und Popups werden aktualisiert.
                address.seconds = Math.round(clampNumber(event.target.value, 0, 3600, 0));
                markDirty();
                recalculate();
                redrawMap();
            }
        }
        if (event.target.id === 'mrs-dtc-additional-minutes') {
            state.additionalMinutes = Math.round(clampNumber(event.target.value, 0, 1440, 0));
            markDirty();
            recalculate();
        }
    });

    root.addEventListener('change', event => {
        if (event.target.id === 'mrs-dtc-standard-seconds') {
            state.standardSeconds = Math.round(clampNumber(event.target.value, 0, 3600, 8));
            event.target.value = state.standardSeconds;
            markDirty();
        }
        if (event.target.matches('[data-seconds]')) {
            const address = state.addresses.find(a => a.address_key === event.target.dataset.seconds);
            if (address) event.target.value = address.seconds;
        }
        if (event.target.matches('[data-load]')) {
            const id = parseInt(event.target.value, 10);
            if (!id) return;
            if (dirty && !window.confirm(S.confirmDiscard)) {
                event.target.value = state.calculationId ? String(state.calculationId) : '';
                return;
            }
            loadCalculation(id);
        }
    });

    $('#mrs-dtc-address-search').addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            search();
        }
    });

    window.addEventListener('beforeunload', event => {
        if (dirty) {
            event.preventDefault();
            event.returnValue = '';
        }
    });

    /* ---------- Start ---------- */

    $('#mrs-dtc-standard-seconds').value = state.standardSeconds;
    renderAddresses();

    if (readonly) {
        root.classList.add('is-readonly');
        root.querySelectorAll('[data-search-field] input, [data-search-field] button, #mrs-dtc-standard-seconds, #mrs-dtc-additional-minutes, [data-action="save"], [data-action="route"]')
            .forEach(el => el.setAttribute('disabled', ''));
    }

    if (mode === 'new') {
        refreshSavedList();
    } else {
        $('[data-load-wrap]').hidden = true;
        const id = parseInt(root.dataset.id, 10);
        if (id) loadCalculation(id);
    }
})();
