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

    /* ---------- Verkehrsmittel ---------- */

    const MODES = ['foot', 'bike', 'car'];
    const MODE_COLORS = {foot: '#e8590c', bike: '#1a7f37', car: '#2271b1'};
    const speedFor = (mode) => Number((defaultSettings.speeds || {})[mode]) || ({foot: 5, bike: 15, car: 30})[mode];

    /* ---------- State ---------- */

    const state = {
        addresses: [],
        route: null, // {distance_meters, duration_seconds, geometry}
        routeLayer: null,
        standardSeconds: Number(defaultSettings.standard_seconds ?? 8),
        additionalMinutes: 0,
        travelMode: 'foot',
        travelSpeed: speedFor('foot'),
        calculationId: 0,
        title: ''
    };

    let routeTimer = null;
    let routeAbort = null;
    let routeSeq = 0;
    let routePending = false;
    let routeRunning = false;
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

    function compute() {
        const house = state.addresses.reduce((sum, a) => sum + Math.max(0, Number(a.seconds) || 0), 0);
        const distance = state.route ? Number(state.route.distance_meters || 0) : 0;
        // Gleiche Formel wie auf dem Server (MRS_DTC_Calculator::calculate)
        const travel = state.travelSpeed > 0 ? Math.round(distance / 1000 / state.travelSpeed * 3600) : 0;
        const additional = Math.round(Math.max(0, Number(state.additionalMinutes) || 0) * 60);
        return {house, distance, travel, additional, total: house + travel + additional};
    }

    function recalculate() {
        const {house, distance, travel, additional, total} = compute();

        $('[data-summary-label="travel"]').textContent = S['travel_' + state.travelMode] || '';

        $('[data-summary="houses"]').textContent = state.addresses.length;
        $('[data-summary="house"]').textContent = formatTime(house);
        $('[data-summary="additional"]').textContent = formatTime(additional);

        if (routePending) {
            $('[data-summary="distance"]').textContent = S.pending;
            $('[data-summary="travel"]').textContent = S.pending;
            $('[data-summary="routing"]').textContent = S.pending;
            $('[data-summary="total"]').textContent = formatTime(house + additional) + ' +';
            return;
        }

        $('[data-summary="distance"]').textContent = state.route ? formatDistance(distance) : '0,00 km';
        $('[data-summary="travel"]').textContent = formatTime(travel);
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
                const handle = readonly ? '' : `<span class="mrs-dtc-handle" data-drag="${escapeHtml(a.address_key)}" title="${escapeHtml(S.drag)}" aria-hidden="true">⠿</span>`;
                return `
                <div class="mrs-dtc-address-item" data-key="${escapeHtml(a.address_key)}">
                    ${handle}
                    <div class="mrs-dtc-address-number">${i + 1}</div>
                    <div class="mrs-dtc-address-main">
                        <strong>${escapeHtml(title)}${(a.quantity || 1) > 1 ? ` <span class="mrs-dtc-qty" title="${escapeHtml(S.quantity)}">×${Number(a.quantity)}</span>` : ''}</strong>
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

        updateModeButtons();
        $('[data-action="save"]').disabled = readonly || state.addresses.length < 1;
        recalculate();
    }

    // Die drei Verkehrsmittel-Buttons: aktiver Zustand + Sperre während der Berechnung.
    function updateModeButtons() {
        root.querySelectorAll('[data-mode-btn]').forEach(btn => {
            const active = btn.dataset.modeBtn === state.travelMode;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            btn.disabled = readonly || routeRunning;
        });
    }

    function setTravelMode(mode) {
        if (!MODES.includes(mode) || importing()) return;
        if (mode !== state.travelMode) {
            state.travelMode = mode;
            state.travelSpeed = speedFor(mode);
            markDirty();
        }
        // Ein Klick berechnet die Route immer neu (auch beim bereits aktiven Verkehrsmittel).
        invalidateRoute(true);
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
            state.routeLayer = L.polyline(coords.map(c => [c[1], c[0]]), {color: MODE_COLORS[state.travelMode] || '#e8590c', weight: 5, opacity: 0.85}).addTo(map);
        }
    }

    /* ---------- Route (automatisch + per Button) ---------- */

    // Reihenfolge/Adressen geändert -> alte Route ist ungültig, neue wird (verzögert) berechnet.
    function invalidateRoute(immediate = false) {
        clearTimeout(routeTimer);
        routeTimer = null;
        routeSeq++;
        if (routeAbort) routeAbort.abort();
        routeRunning = false;
        state.route = null;
        drawRoute();
        updateModeButtons();

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
        routeRunning = true;
        updateModeButtons();
        setMessage(S.routeRunning);
        recalculate();

        try {
            const data = await api('route', {
                method: 'POST',
                signal: routeAbort.signal,
                body: {mode: state.travelMode, coordinates: state.addresses.map(a => ({lat: a.latitude, lon: a.longitude}))}
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
                routeRunning = false;
                updateModeButtons();
                recalculate();
            }
        }
    }

    /* ---------- Adresssuche ---------- */

    async function search() {
        if (searchBusy || readonly || importing()) return;
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
            seconds: state.standardSeconds,
            quantity: 1
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
            travel_mode: state.travelMode,
            travel_speed_kmh: state.travelSpeed,
            route_distance_meters: state.route?.distance_meters || 0,
            route_duration_seconds: state.route?.duration_seconds || 0,
            route: state.route ? {geometry: state.route.geometry} : null,
            addresses: state.addresses
        };
    }

    async function save() {
        if (readonly || importing() || !state.addresses.length) return;
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
            const savedText = `${updating ? S.updated : S.saved} (#${data.id})`;
            setMessage(savedText, 'success');

            // PDF nur beim Speichern im Frontend; im Dashboard (edit/view) wird kein PDF erstellt.
            const pdfBox = $('[data-pdf-on-save]');
            if (mode === 'new' && pdfBox && pdfBox.checked) {
                setMessage(`${savedText} ${S.pdfCreating}`);
                try {
                    const result = await createPdf(data.id);
                    const note = result.tilesFailed === -1 ? S.pdfNoMap : (result.tilesFailed > 0 ? S.pdfPartialMap : S.pdfCreated);
                    setMessage(`${savedText} ${note}`, result.tilesFailed === 0 ? 'success' : '');
                } catch (pdfError) {
                    console.error(pdfError);
                    setMessage(`${savedText} ${S.pdfFailed}`, 'error');
                }
            }
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
            seconds: a.seconds,
            quantity: a.quantity || 1
        }));
        state.standardSeconds = c.standard_seconds;
        state.additionalMinutes = c.additional_minutes;
        // Verkehrsmittel und Geschwindigkeit von damals wiederherstellen
        state.travelMode = MODES.includes(c.travel_mode) ? c.travel_mode : 'foot';
        state.travelSpeed = c.travel_speed_kmh || speedFor(state.travelMode);
        routeRunning = false;
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

    function resetCalculation() {
        clearTimeout(routeTimer);
        routeSeq++;
        if (routeAbort) routeAbort.abort();
        state.addresses = [];
        state.route = null;
        state.additionalMinutes = 0;
        state.standardSeconds = Number(defaultSettings.standard_seconds ?? 8);
        state.travelMode = 'foot';
        state.travelSpeed = speedFor('foot');
        routeRunning = false;
        state.calculationId = 0;
        state.title = '';
        routePending = false;
        dirty = false;

        $('#mrs-dtc-standard-seconds').value = state.standardSeconds;
        $('#mrs-dtc-additional-minutes').value = 0;
        $('[data-results]').innerHTML = '';
        setStatus('');
        setMessage('');
        drawRoute();
        renderAddresses();
        redrawMap();
    }


    /* ---------- Drag & Drop (Maus, Touch, Stift) ---------- */

    // Pointer-Events statt HTML5-Drag&Drop, damit es auch auf dem Smartphone funktioniert.
    // Gezogen wird am Griff (⠿); die Buttons ↑ ↓ bleiben für die Tastatur erhalten.
    const dragState = {active: null, raf: 0, lastY: 0};

    function dragTransforms() {
        const d = dragState.active;
        if (!d) return;
        const list = d.list;
        const delta = (dragState.lastY - d.startY) + (list.scrollTop - d.startScroll);
        d.item.style.transform = `translateY(${delta}px)`;

        // Ziel-Index anhand der Mitte der gezogenen Zeile bestimmen.
        const center = d.rects[d.from].top + d.rects[d.from].height / 2 + delta;
        let to = d.from;
        d.rects.forEach((r, j) => {
            const mid = r.top + r.height / 2;
            if (j < d.from && center < mid) to = Math.min(to, j);
            if (j > d.from && center > mid) to = Math.max(to, j);
        });
        d.to = to;

        // Die übrigen Zeilen weichen sichtbar aus.
        const shift = d.rects[d.from].height + d.gap;
        d.items.forEach((el, j) => {
            if (j === d.from) return;
            let offset = 0;
            if (d.from < d.to && j > d.from && j <= d.to) offset = -shift;
            if (d.to < d.from && j >= d.to && j < d.from) offset = shift;
            el.style.transform = offset ? `translateY(${offset}px)` : '';
        });
    }

    function dragAutoScroll() {
        const d = dragState.active;
        if (!d) return;
        const box = d.list.getBoundingClientRect();
        const edge = 40;
        let speed = 0;
        if (dragState.lastY < box.top + edge) speed = -Math.ceil((box.top + edge - dragState.lastY) / 4);
        if (dragState.lastY > box.bottom - edge) speed = Math.ceil((dragState.lastY - (box.bottom - edge)) / 4);
        if (speed) {
            d.list.scrollTop += speed;
            dragTransforms();
        }
        dragState.raf = requestAnimationFrame(dragAutoScroll);
    }

    function onDragMove(event) {
        if (!dragState.active || event.pointerId !== dragState.active.pointerId) return;
        dragState.lastY = event.clientY;
        dragTransforms();
    }

    function endDrag(commit) {
        const d = dragState.active;
        if (!d) return;
        dragState.active = null;
        cancelAnimationFrame(dragState.raf);
        window.removeEventListener('pointermove', onDragMove);
        window.removeEventListener('pointerup', onDragUp);
        window.removeEventListener('pointercancel', onDragCancel);
        document.removeEventListener('keydown', onDragKey);

        d.list.classList.remove('is-sorting');
        d.items.forEach(el => {
            el.style.transform = '';
            el.classList.remove('is-dragging');
        });

        if (commit && d.to !== d.from) {
            const [moved] = state.addresses.splice(d.from, 1);
            state.addresses.splice(d.to, 0, moved);
            markDirty();
            renderAddresses();
            redrawMap();
            invalidateRoute();
        }
    }

    function onDragUp(event) {
        if (dragState.active && event.pointerId === dragState.active.pointerId) endDrag(true);
    }
    function onDragCancel() { endDrag(false); }
    function onDragKey(event) { if (event.key === 'Escape') endDrag(false); }

    $('[data-address-list]').addEventListener('pointerdown', event => {
        const handle = event.target.closest('[data-drag]');
        if (!handle || readonly || importing() || dragState.active) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;

        const list = event.currentTarget;
        const items = [...list.querySelectorAll('.mrs-dtc-address-item')];
        if (items.length < 2) return;

        const item = handle.closest('.mrs-dtc-address-item');
        const from = items.indexOf(item);
        if (from < 0) return;

        event.preventDefault();
        const rects = items.map(el => el.getBoundingClientRect());
        dragState.lastY = event.clientY;
        dragState.active = {
            list, items, item, from, to: from, rects,
            pointerId: event.pointerId,
            startY: event.clientY,
            startScroll: list.scrollTop,
            gap: rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0
        };

        list.classList.add('is-sorting');
        item.classList.add('is-dragging');
        if (handle.setPointerCapture) {
            try { handle.setPointerCapture(event.pointerId); } catch (e) { /* ignorieren */ }
        }

        window.addEventListener('pointermove', onDragMove);
        window.addEventListener('pointerup', onDragUp);
        window.addEventListener('pointercancel', onDragCancel);
        document.addEventListener('keydown', onDragKey);
        dragState.raf = requestAnimationFrame(dragAutoScroll);
    });


    /* ---------- PDF: Import (Zustellbuch / eigenes PDF) und Export ---------- */

    const PDF = () => window.MRS_DTC_PDF;
    const libs = MRS_DTC.libs || {};
    const importState = {phase: 'idle', parsed: null, options: {skipU: true, includeLimited: true}, agg: null, done: 0, total: 0, abort: false, result: null};
    function importing() { return importState.phase === 'running'; }
    const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

    // Während des Imports ist der Rest der Oberfläche gesperrt (inert), damit nichts dazwischenfunkt.
    function setImportLock(on) {
        root.classList.toggle('is-importing', on);
        const targets = [
            $('[data-search-field]'), $('.mrs-dtc-list-panel'), $('.mrs-dtc-save-row'), $('.mrs-dtc-load'),
            $('#mrs-dtc-standard-seconds').closest('.mrs-dtc-field')
        ];
        targets.forEach(el => { if (el) { if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert'); } });
    }

    function etaText(count) {
        const seconds = Math.ceil(count * 1.3);
        return seconds < 90 ? `ca. ${seconds} Sekunden` : `ca. ${Math.ceil(seconds / 60)} Minuten`;
    }

    const addressText = (item) => `${PDF().expandStreet(item.street)} ${item.house}`.trim();

    function renderImportPanel(focusSelector) {
        const el = $('[data-import-panel]');
        if (importState.phase === 'idle') {
            el.hidden = true;
            el.innerHTML = '';
            return;
        }
        el.hidden = false;

        if (importState.phase === 'choose') {
            const st = importState.agg.stats;
            const o = importState.options;
            const skipped = [];
            if (st.bracket) skipped.push(`${st.bracket} Zeile(n) mit nicht belieferter Menge [n]`);
            if (st.skipU) skipped.push(`${st.skipU} Zeile(n) mit Status U`);
            if (st.limitedSkipped) skipped.push(`${st.limitedSkipped} Zeile(n) mit eingeschränkten Liefertagen`);
            el.innerHTML = `
                <strong>${escapeHtml(S.importTitle)}</strong>
                <p>${escapeHtml(importState.parsed.title || '')}</p>
                <p>${st.rows} Zeilen → <strong>${st.unique} Adressen</strong> (Menge gesamt ${st.totalQuantity}).${skipped.length ? `<br><small>Übersprungen: ${escapeHtml(skipped.join(', '))}.</small>` : ''}${st.unique > PDF().MAX_ADDRESSES ? `<br><small>${escapeHtml(S.importTooMany)}</small>` : ''}</p>
                <label class="mrs-dtc-check"><input type="checkbox" data-import-opt="skipU" ${o.skipU ? 'checked' : ''}> Status „U“ (Unterbrechung) überspringen</label>
                <label class="mrs-dtc-check"><input type="checkbox" data-import-opt="includeLimited" ${o.includeLimited ? 'checked' : ''}> Abos mit eingeschränkten Liefertagen (FR/SA, SAABO, FS/MI) mitzählen</label>
                <p><small>Zeit pro Adresse = Standardzeit (${state.standardSeconds} Sek.) × Menge. Die Adressen werden einzeln gesucht: ${etaText(Math.min(st.unique, PDF().MAX_ADDRESSES))}.</small></p>
                <div class="mrs-dtc-import-actions">
                    <button type="button" class="mrs-dtc-button mrs-dtc-primary" data-import-action="start" ${st.unique ? '' : 'disabled'}>${escapeHtml(S.importStart)}</button>
                    <button type="button" class="mrs-dtc-button" data-import-action="close">${escapeHtml(S.importCancel)}</button>
                </div>`;
        } else if (importState.phase === 'running') {
            el.innerHTML = `
                <strong>${escapeHtml(S.searching)}</strong>
                <progress max="${importState.total}" value="${importState.done}" data-import-progress></progress>
                <p data-import-count>${importState.done} / ${importState.total}</p>
                <button type="button" class="mrs-dtc-button" data-import-action="stop">${escapeHtml(S.importStop)}</button>`;
        } else if (importState.phase === 'done') {
            const r = importState.result;
            const list = (items) => `<ul>${items.slice(0, 25).map(t => `<li>${escapeHtml(t)}</li>`).join('')}${items.length > 25 ? `<li>… +${items.length - 25}</li>` : ''}</ul>`;
            el.innerHTML = `
                <strong>${r.aborted ? escapeHtml(S.importAborted) : 'Import abgeschlossen'}</strong>
                <p><strong>${r.added}</strong> von ${r.total} Adressen übernommen.${r.fatal ? `<br><small>${escapeHtml(r.fatal)}</small>` : ''}${r.truncated ? `<br><small>${escapeHtml(S.importTooMany)}</small>` : ''}</p>
                ${r.approx.length ? `<p><small>Nur die Straße wurde gefunden (Position ungefähr):</small></p>${list(r.approx)}` : ''}
                ${r.notFound.length ? `<p><small>Nicht gefunden – bitte manuell suchen:</small></p>${list(r.notFound)}` : ''}
                <div class="mrs-dtc-import-actions"><button type="button" class="mrs-dtc-button" data-import-action="close">${escapeHtml(S.importClose)}</button></div>`;
        }

        if (focusSelector) {
            const f = el.querySelector(focusSelector);
            if (f) f.focus();
        }
    }

    function updateImportProgress() {
        const bar = $('[data-import-progress]');
        if (bar) bar.value = importState.done;
        const count = $('[data-import-count]');
        if (count) count.textContent = `${importState.done} / ${importState.total}`;
    }

    function startBookPreview(parsed) {
        importState.phase = 'choose';
        importState.parsed = parsed;
        importState.options = {skipU: true, includeLimited: true};
        importState.agg = PDF().aggregateBook(parsed, importState.options);
        renderImportPanel();
    }

    // Eigenes PDF: Daten komplett wiederherstellen (inkl. Route und Verkehrsmittel).
    function restoreFromReport(r) {
        if (state.addresses.length && !window.confirm(S.confirmReplace)) return;

        clearTimeout(routeTimer);
        routeSeq++;
        if (routeAbort) routeAbort.abort();

        state.addresses = r.addresses.map(a => Object.assign({address_key: newKey()}, a));
        state.travelMode = r.travel_mode;
        state.travelSpeed = r.travel_speed_kmh;
        state.standardSeconds = r.standard_seconds;
        state.additionalMinutes = r.additional_minutes;
        state.title = r.title || '';
        state.route = r.route ? {
            distance_meters: r.distance_meters,
            duration_seconds: r.routing_duration_seconds,
            geometry: {type: 'LineString', coordinates: r.route.coordinates}
        } : null;
        routePending = false;
        routeRunning = false;

        $('#mrs-dtc-standard-seconds').value = state.standardSeconds;
        $('#mrs-dtc-additional-minutes').value = state.additionalMinutes;
        renderAddresses();
        redrawMap();
        drawRoute();
        fitMap();
        markDirty();
        setMessage(S.pdfRestored, 'success');
    }

    async function handleImportFile(file) {
        if (!file || importing()) return;
        if (file.size > 20 * 1024 * 1024) {
            setMessage(S.pdfTooLarge, 'error');
            return;
        }
        setMessage(S.pdfReading);
        try {
            const result = await PDF().readFile(file, libs);
            setMessage('');
            if (result.kind === 'restore') restoreFromReport(result.report);
            else if (result.kind === 'book') startBookPreview(result.parsed);
            else setMessage(S.pdfUnknown, 'error');
        } catch (error) {
            console.error(error);
            setMessage(S.pdfReadError, 'error');
        }
    }

    // Beste Übereinstimmung: gleiche Straße + gleiche Hausnummer. Sonst nur die Straße (ungefähr).
    function pickResult(results, item) {
        const P = PDF();
        const wantStreet = P.normStreet(item.street);
        const wantHouse = P.normHouse(item.house);
        let approx = null;
        for (const r of results) {
            if (P.normStreet(r.street) !== wantStreet) continue;
            const house = P.normHouse(r.house_number);
            if (house === wantHouse) return {exact: true, result: r};
            if (!approx && house === '') approx = {exact: false, result: r};
        }
        return approx;
    }

    async function geocodeImportItem(item, anchor) {
        const street = PDF().expandStreet(item.street);
        const bias = anchor ? {lat: anchor[0], lon: anchor[1]} : {};
        const attempts = [
            {street: `${item.house} ${street}`, city: item.city}, // strukturierte Suche
            {query: `${street} ${item.house}, ${item.city}`}      // Rückfall: freie Suche
        ];
        let best = null;
        for (const attempt of attempts) {
            const data = await api('geocode', {method: 'POST', body: Object.assign({}, attempt, bias)});
            const hit = pickResult(data.results || [], item);
            if (hit && hit.exact) return hit;
            if (hit && !best) best = hit;
        }
        return best;
    }

    function addressFromHit(item, hit, standardSeconds) {
        const r = hit.result;
        const quantity = item.quantity;
        const base = {
            address_key: newKey(),
            latitude: Number(r.lat),
            longitude: Number(r.lon),
            seconds: Math.min(3600, standardSeconds * quantity), // Zeit = Standardzeit × Menge
            quantity
        };
        if (hit.exact) {
            return Object.assign(base, {street: r.street, house_number: r.house_number, full_address: r.display_name});
        }
        const rest = String(r.display_name || '').split(',').slice(1).join(',').trim();
        return Object.assign(base, {
            street: r.street,
            house_number: item.house,
            full_address: `${r.street} ${item.house}${rest ? ', ' + rest : ''} ${S.approxSuffix}`
        });
    }

    async function runImport() {
        let list = importState.agg.addresses;
        if (!list.length || importing()) return;
        if (state.addresses.length && !window.confirm(S.confirmReplace)) return;

        const truncated = list.length > PDF().MAX_ADDRESSES;
        if (truncated) list = list.slice(0, PDF().MAX_ADDRESSES);

        importState.phase = 'running';
        importState.abort = false;
        importState.done = 0;
        importState.total = list.length;
        setImportLock(true);
        renderImportPanel('[data-import-action="stop"]');

        const standard = state.standardSeconds;
        const resolved = [];
        const notFound = [];
        const approx = [];
        let anchor = null; // Erster genauer Treffer: weitere Suchen bevorzugen die Umgebung
        let failures = 0;
        let fatal = '';

        for (let i = 0; i < list.length; i++) {
            if (importState.abort) break;
            const item = list[i];
            try {
                const hit = await geocodeImportItem(item, anchor);
                failures = 0;
                if (!hit) {
                    notFound.push(addressText(item));
                } else {
                    if (!anchor && hit.exact) anchor = [Number(hit.result.lat), Number(hit.result.lon)];
                    resolved.push(addressFromHit(item, hit, standard));
                    if (!hit.exact) approx.push(addressText(item));
                }
            } catch (error) {
                failures++;
                notFound.push(addressText(item));
                if (failures >= 3) { // Server/Netz dauerhaft gestört: sauber beenden statt alles durchzuprobieren
                    fatal = error.message || S.importServerError;
                    break;
                }
            }
            importState.done = i + 1;
            updateImportProgress();
        }

        if (resolved.length) {
            clearTimeout(routeTimer);
            state.addresses = resolved;
            if (importState.parsed.title) state.title = importState.parsed.title;
            markDirty();
            renderAddresses();
            redrawMap(true);
            invalidateRoute();
        }

        importState.result = {added: resolved.length, total: list.length, notFound, approx, aborted: importState.abort, fatal, truncated};
        importState.phase = 'done';
        setImportLock(false);
        renderImportPanel('[data-import-action="close"]');
    }

    function reportData(calculationId) {
        const c = compute();
        return {
            created_at: new Date().toISOString(),
            calculation_id: calculationId || 0,
            title: state.title,
            travel_mode: state.travelMode,
            travel_speed_kmh: state.travelSpeed,
            standard_seconds: state.standardSeconds,
            additional_minutes: Math.round(state.additionalMinutes),
            route: state.route && state.route.geometry && state.route.geometry.coordinates ? {coordinates: state.route.geometry.coordinates} : null,
            addresses: state.addresses.map(a => ({
                street: a.street, house_number: a.house_number, full_address: a.full_address,
                latitude: a.latitude, longitude: a.longitude, seconds: a.seconds, quantity: a.quantity || 1
            })),
            totals: {
                houses: state.addresses.length,
                distance_meters: c.distance,
                routing_duration_seconds: state.route ? state.route.duration_seconds : 0,
                house_seconds: c.house,
                travel_seconds: c.travel,
                additional_seconds: c.additional,
                total_seconds: c.total
            }
        };
    }

    function downloadBytes(bytes, filename) {
        const url = URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    async function createPdf(calculationId) {
        const result = await PDF().exportReport(reportData(calculationId), libs, S.pdf);
        downloadBytes(result.bytes, result.filename);
        return result;
    }

    root.addEventListener('click', event => {
        const importAction = event.target.closest('[data-import-action]')?.dataset.importAction;
        if (importAction === 'start') runImport();
        if (importAction === 'stop') importState.abort = true;
        if (importAction === 'close') {
            importState.phase = 'idle';
            renderImportPanel();
        }
        if (event.target.closest('[data-action="import-pdf"]') && !readonly && !importing()) $('[data-import-file]').click();
    });

    root.addEventListener('change', event => {
        if (event.target.matches('[data-import-file]')) {
            const file = event.target.files && event.target.files[0];
            event.target.value = '';
            handleImportFile(file);
        }
        if (event.target.matches('[data-import-opt]')) {
            const key = event.target.dataset.importOpt;
            importState.options[key] = event.target.checked;
            importState.agg = PDF().aggregateBook(importState.parsed, importState.options);
            renderImportPanel(`[data-import-opt="${key}"]`);
        }
    });

    /* ---------- Events ---------- */

    root.addEventListener('click', event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'search') search();
        const modeBtn = event.target.closest('[data-mode-btn]');
        if (modeBtn && !readonly && !modeBtn.disabled) setTravelMode(modeBtn.dataset.modeBtn);
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
        root.querySelectorAll('[data-search-field] input, [data-search-field] button, #mrs-dtc-standard-seconds, #mrs-dtc-additional-minutes, [data-action="save"], [data-action="import-pdf"], [data-mode-btn]')
            .forEach(el => el.setAttribute('disabled', ''));
    }

    // Im Dashboard (Anzeigen/Bearbeiten) wird die gespeicherte Berechnung direkt geladen.
    if (mode !== 'new') {
        $('[data-load-wrap]').hidden = true;
        const id = parseInt(root.dataset.id, 10);
        if (id) loadCalculation(id);
    }
})();
