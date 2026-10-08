/**
 * PDF-Funktionen. Alles läuft im Browser, es werden keine PDFs an den Server gesendet.
 *
 *  1. Zustellbuch-PDF lesen  -> Adressen (Straße, Hausnummer, Ort, Menge). Namen werden nicht ausgelesen.
 *  2. Berechnung als PDF erstellen (Zusammenfassung, Kartenübersicht, Adressliste).
 *  3. Eigene PDFs wieder einlesen: die Berechnungsdaten stecken als JSON-Anhang im PDF.
 *
 * Die schweren Bibliotheken (pdf.js zum Lesen, pdf-lib zum Erstellen) werden erst bei Bedarf geladen.
 */
(function (root) {
    'use strict';

    const ATTACHMENT_NAME = 'mrs-dtc-berechnung.json';
    const FORMAT = 'mrs-dtc';
    const FORMAT_VERSION = 1;
    const LIMITED_STATUS = ['FR/SA', 'SAABO', 'FS/MI']; // Abos mit eingeschränkten Liefertagen
    const MAX_ADDRESSES = 300;
    const MAX_ROUTE_POINTS = 60000;
    const MAX_PAGES = 200;
    const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    const MODES = ['foot', 'bike', 'car'];
    const MODE_COLORS = {foot: '#e8590c', bike: '#1a7f37', car: '#2271b1'};

    /* ====================================================================
     * Hilfsfunktionen für Adressen
     * ================================================================== */

    // "Andelsbachstr." -> "Andelsbachstraße", "Säckinger Str." -> "Säckinger Straße"
    function expandStreet(street) {
        return String(street || '')
            .replace(/(\S*?)([Ss])tr\.(?=\s|,|$)/g, (m, pre, s) => (pre ? pre + 'straße' : (s === 'S' ? 'Straße' : 'straße')))
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Vergleichsform: ohne Umlaute/Sonderzeichen, "straße/strasse/str" vereinheitlicht
    function normStreet(street) {
        return expandStreet(street)
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/ß/g, 'ss')
            .replace(/[^a-z0-9]/g, '')
            .replace(/(strasse|str)$/, 'str');
    }

    const normHouse = (h) => String(h || '').toLowerCase().replace(/\s+/g, '');

    // "Andelsbachstr. 16" -> {street, house, stock}
    function splitStreetCell(text) {
        const t = String(text || '').replace(/\s+/g, ' ').trim();
        const letter = '(?:\\s?[a-zA-Z](?![a-zA-Z]))?';
        const re = new RegExp('^(.+?)\\s+(\\d+' + letter + '(?:\\s?[-/]\\s?\\d+' + letter + ')?)(?:\\s+(.*))?$');
        const m = t.match(re);
        if (!m) return null;
        return {street: m[1].trim(), house: m[2].replace(/\s+/g, ''), stock: (m[3] || '').trim()};
    }

    /* ====================================================================
     * Zustellbuch lesen
     * ================================================================== */

    // Textstücke zu Zeilen bündeln. u = Position entlang der Schrift, v = Position quer dazu.
    function clusterLines(items, tolerance) {
        const sorted = items.slice().sort((a, b) => a.v - b.v || a.u - b.u);
        const lines = [];
        let cur = null;
        sorted.forEach((it) => {
            if (!cur || it.v - cur.anchor > tolerance) {
                cur = {anchor: it.v, items: []};
                lines.push(cur);
            }
            cur.items.push(it);
        });
        lines.forEach((l) => l.items.sort((a, b) => a.u - b.u));
        return lines;
    }

    const lineText = (line) => line.items.map((i) => i.str.trim()).join(' ').replace(/\s+/g, ' ');

    // Spaltenanfänge aus der Kopfzeile der Tabelle bestimmen
    function detectColumns(line) {
        const find = (re) => line.items.find((i) => re.test(i.str.trim()));
        const street = find(/^stra(ß|ss)e\s*\/\s*hsnr/i);
        const count = find(/^anzahl$/i);
        if (!street || !count) return null;
        return [
            ['status', find(/^status$/i)],
            ['street', street],
            ['name', find(/^name$/i)],
            ['city', find(/^ort$/i)],
            ['edition', find(/^ausgabe$/i)],
            ['count', count],
            ['note', find(/^zustellbesonderheit$/i)],
        ].filter((c) => c[1]).map((c) => ({key: c[0], start: c[1].u})).sort((a, b) => a.start - b.start);
    }

    function columnOf(cols, u) {
        let key = null;
        cols.forEach((c) => { if (u >= c.start - 2) key = c.key; });
        return key;
    }

    /**
     * @param {Array<Array<{str:string,u:number,v:number}>>} pages Textstücke pro Seite.
     */
    function parseDeliveryBook(pages) {
        const result = {title: '', bezirk: '', stichtag: '', rows: []};
        let cols = null;
        let stop = false;

        pages.forEach((items) => {
            if (stop) return;
            const lines = clusterLines(items, 5.5);

            let headerIndex = -1;
            lines.forEach((line, idx) => {
                if (headerIndex < 0) {
                    const c = detectColumns(line);
                    if (c) { cols = c; headerIndex = idx; }
                }
            });

            if (!result.bezirk) {
                for (let i = 0; i < lines.length; i++) {
                    const text = lineText(lines[i]);
                    const m = text.match(/Bezirk\s+(\S+)/);
                    if (m) {
                        result.bezirk = m[1];
                        const d = text.match(/Stichtag\s+(\d{2}\.\d{2}\.\d{4})/);
                        if (d) result.stichtag = d[1];
                        break;
                    }
                }
            }

            if (!cols) return;

            for (let i = headerIndex >= 0 ? headerIndex + 1 : 0; i < lines.length; i++) {
                const line = lines[i];
                // Ab der Zusammenfassungstabelle ("Titel Ausgabe Anzahl Teilabo ...") folgen keine Adressen mehr.
                if (line.items.some((it) => /^titel$/i.test(it.str.trim())) && /teilabo|gesamt/i.test(lineText(line))) {
                    stop = true;
                    break;
                }

                const cells = {};
                line.items.forEach((it) => {
                    const key = columnOf(cols, it.u);
                    if (key) cells[key] = (cells[key] ? cells[key] + ' ' : '') + it.str.trim();
                });
                if (!cells.street) continue; // Fortsetzungszeilen (z. B. Besonderheit über zwei Zeilen)

                const addr = splitStreetCell(cells.street);
                if (!addr) continue;

                const count = String(cells.count || '1').trim();
                const bracket = /^\[\s*\d+\s*\]$/.test(count); // [n] = Menge, die NICHT beliefert wird
                const qty = parseInt(count.replace(/[^\d]/g, ''), 10);

                result.rows.push({
                    street: addr.street,
                    house: addr.house,
                    city: (cells.city || '').trim(),
                    status: (cells.status || '').trim().toUpperCase(),
                    qty: Number.isFinite(qty) && qty > 0 ? qty : (bracket ? 0 : 1),
                    bracket,
                });
            }
        });

        const parts = [];
        if (result.bezirk) parts.push('Zustellbuch Bezirk ' + result.bezirk);
        if (result.stichtag) parts.push('Stichtag ' + result.stichtag);
        result.title = parts.join(' – ');
        return result;
    }

    /**
     * Gleiche Adressen zusammenfassen: die Menge (Spalte "Anzahl") wird addiert.
     * Zeilen mit [n] (nicht beliefert) und optional Status U werden übersprungen.
     */
    function aggregateBook(parsed, options) {
        const o = Object.assign({skipU: true, includeLimited: true}, options || {});
        const stats = {rows: parsed.rows.length, bracket: 0, skipU: 0, limitedSkipped: 0, limitedCounted: 0};
        const map = new Map();
        const list = [];

        parsed.rows.forEach((r) => {
            if (r.bracket || r.qty < 1) { stats.bracket++; return; }
            if (r.status === 'U' && o.skipU) { stats.skipU++; return; }
            if (LIMITED_STATUS.indexOf(r.status) !== -1) {
                if (!o.includeLimited) { stats.limitedSkipped++; return; }
                stats.limitedCounted++;
            }
            const key = normStreet(r.street) + '|' + normHouse(r.house) + '|' + normStreet(r.city);
            let entry = map.get(key);
            if (!entry) {
                entry = {key, street: r.street, house: r.house, city: r.city, quantity: 0, rows: 0};
                map.set(key, entry);
                list.push(entry); // Reihenfolge des Zustellbuchs bleibt erhalten
            }
            entry.quantity += r.qty;
            entry.rows++;
        });

        stats.unique = list.length;
        stats.totalQuantity = list.reduce((s, a) => s + a.quantity, 0);
        return {addresses: list, stats};
    }

    /* ====================================================================
     * pdf.js / pdf-lib laden
     * ================================================================== */

    let pdfjsPromise = null;
    let pdfLibPromise = null;

    function loadPdfjs(libs) {
        if (libs && libs.pdfjsLib) return Promise.resolve(libs.pdfjsLib);
        if (!pdfjsPromise) {
            pdfjsPromise = import(libs.pdfjs).then((mod) => {
                mod.GlobalWorkerOptions.workerSrc = libs.pdfjsWorker;
                return mod;
            });
            pdfjsPromise.catch(() => { pdfjsPromise = null; });
        }
        return pdfjsPromise;
    }

    function loadPdfLib(libs) {
        if (libs && libs.PDFLib) return Promise.resolve(libs.PDFLib);
        if (root.PDFLib) return Promise.resolve(root.PDFLib);
        if (!pdfLibPromise) {
            pdfLibPromise = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = libs.pdflib;
                s.onload = () => (root.PDFLib ? resolve(root.PDFLib) : reject(new Error('pdf-lib fehlt')));
                s.onerror = () => reject(new Error('pdf-lib konnte nicht geladen werden'));
                document.head.appendChild(s);
            });
            pdfLibPromise.catch(() => { pdfLibPromise = null; });
        }
        return pdfLibPromise;
    }

    // Textstücke jeder Seite mit Position. Funktioniert auch bei gedrehten Seiten.
    async function extractPages(pdfDoc, pdfjsLib) {
        const pages = [];
        const total = Math.min(pdfDoc.numPages, MAX_PAGES);
        for (let n = 1; n <= total; n++) {
            const page = await pdfDoc.getPage(n);
            const vp = page.getViewport({scale: 1});
            const content = await page.getTextContent();
            const items = [];
            content.items.forEach((it) => {
                if (typeof it.str !== 'string' || it.str.trim() === '') return;
                const t = pdfjsLib.Util.transform(vp.transform, it.transform);
                const len = Math.hypot(t[0], t[1]) || 1;
                const dx = t[0] / len;
                const dy = t[1] / len;
                items.push({str: it.str, u: t[4] * dx + t[5] * dy, v: -t[4] * dy + t[5] * dx, w: it.width});
            });
            pages.push(items);
            if (page.cleanup) page.cleanup();
        }
        return pages;
    }

    /* ====================================================================
     * Eigene PDFs (Berechnungsdaten als Anhang)
     * ================================================================== */

    const num = (v, min, max, fallback) => {
        const n = typeof v === 'number' ? v : parseFloat(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

    // Prüft und bereinigt die Daten aus dem PDF (das PDF könnte manipuliert sein).
    function validateReport(raw) {
        if (!raw || typeof raw !== 'object' || raw.format !== FORMAT || !(raw.version <= FORMAT_VERSION)) return null;
        if (!Array.isArray(raw.addresses) || raw.addresses.length < 1 || raw.addresses.length > MAX_ADDRESSES) return null;

        const addresses = [];
        for (const a of raw.addresses) {
            if (!a || typeof a !== 'object') return null;
            const lat = Number(a.latitude);
            const lon = Number(a.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
            addresses.push({
                street: str(a.street, 191),
                house_number: str(a.house_number, 100),
                full_address: str(a.full_address, 500),
                latitude: lat,
                longitude: lon,
                seconds: Math.round(num(a.seconds, 0, 3600, 0)),
                quantity: Math.round(num(a.quantity, 1, 999, 1)),
            });
        }

        let route = null;
        const coords = raw.route && Array.isArray(raw.route.coordinates) ? raw.route.coordinates : null;
        if (coords && coords.length >= 2 && coords.length <= MAX_ROUTE_POINTS) {
            const clean = [];
            for (const c of coords) {
                if (!Array.isArray(c)) continue;
                const lon = Number(c[0]);
                const lat = Number(c[1]);
                if (Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90) clean.push([lon, lat]);
            }
            if (clean.length >= 2) route = {coordinates: clean};
        }

        const totals = raw.totals || {};
        const mode = MODES.indexOf(raw.travel_mode) !== -1 ? raw.travel_mode : 'foot';
        return {
            format: FORMAT,
            version: FORMAT_VERSION,
            title: str(raw.title, 191),
            travel_mode: mode,
            travel_speed_kmh: num(raw.travel_speed_kmh, 1, 150, mode === 'car' ? 30 : (mode === 'bike' ? 15 : 5)),
            standard_seconds: Math.round(num(raw.standard_seconds, 0, 3600, 8)),
            additional_minutes: Math.round(num(raw.additional_minutes, 0, 1440, 0)),
            distance_meters: route ? num(totals.distance_meters, 0, 5000000, 0) : 0,
            routing_duration_seconds: route ? Math.round(num(totals.routing_duration_seconds, 0, 10000000, 0)) : 0,
            route,
            addresses,
        };
    }

    /**
     * Liest ein PDF und erkennt, was es ist.
     * @return {Promise<{kind:'restore',report:Object}|{kind:'book',parsed:Object}|{kind:'unknown'}>}
     */
    async function readFile(file, libs) {
        const pdfjsLib = await loadPdfjs(libs);
        const data = new Uint8Array(await file.arrayBuffer());
        // isEvalSupported=false: pdf.js führt dadurch keinen dynamisch erzeugten Code aus (Sicherheit bei fremden PDFs).
        const doc = await pdfjsLib.getDocument({data, isEvalSupported: false, enableXfa: false, verbosity: 0}).promise;
        try {
            const attachments = await doc.getAttachments();
            if (attachments) {
                const att = attachments[ATTACHMENT_NAME] || Object.values(attachments).find((a) => a && a.filename === ATTACHMENT_NAME);
                if (att && att.content) {
                    let report = null;
                    try { report = validateReport(JSON.parse(new TextDecoder().decode(att.content))); } catch (e) { report = null; }
                    if (report) return {kind: 'restore', report};
                }
            }
            const parsed = parseDeliveryBook(await extractPages(doc, pdfjsLib));
            if (parsed.rows.length) return {kind: 'book', parsed};
            return {kind: 'unknown'};
        } finally {
            if (doc.destroy) doc.destroy();
        }
    }

    /* ====================================================================
     * Kartenübersicht als Bild (eigene Kachel-Zusammensetzung, ohne Screenshot-Bibliothek)
     * ================================================================== */

    function project(lat, lon, z) {
        const size = 256 * Math.pow(2, z);
        const sin = Math.sin((lat * Math.PI) / 180);
        return [((lon + 180) / 360) * size, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size];
    }

    // Größtmöglichen Zoom wählen, bei dem alle Punkte ins Bild passen.
    function planMap(points, W, H) {
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        points.forEach((p) => {
            minLat = Math.min(minLat, p[0]); maxLat = Math.max(maxLat, p[0]);
            minLon = Math.min(minLon, p[1]); maxLon = Math.max(maxLon, p[1]);
        });
        let zoom = 3;
        for (let z = 17; z >= 3; z--) {
            const a = project(maxLat, minLon, z);
            const b = project(minLat, maxLon, z);
            if (b[0] - a[0] <= W * 0.86 && b[1] - a[1] <= H * 0.86) { zoom = z; break; }
        }
        const c = project((minLat + maxLat) / 2, (minLon + maxLon) / 2, zoom);
        const left = c[0] - W / 2;
        const top = c[1] - H / 2;
        const max = Math.pow(2, zoom);
        const tiles = [];
        for (let tx = Math.floor(left / 256); tx <= Math.floor((left + W) / 256); tx++) {
            for (let ty = Math.floor(top / 256); ty <= Math.floor((top + H) / 256); ty++) {
                if (ty < 0 || ty >= max) continue;
                tiles.push({z: zoom, x: ((tx % max) + max) % max, y: ty, dx: tx * 256 - left, dy: ty * 256 - top});
            }
        }
        return {zoom, left, top, tiles};
    }

    function defaultDeps() {
        return {
            createCanvas: (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
            loadImage: (url) => new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = 'anonymous'; // OSM-Kacheln erlauben CORS, so bleibt das Bild exportierbar
                const timer = setTimeout(() => reject(new Error('Zeitüberschreitung')), 8000);
                img.onload = () => { clearTimeout(timer); resolve(img); };
                img.onerror = () => { clearTimeout(timer); reject(new Error('Kachel nicht geladen')); };
                img.src = url;
            }),
            toJpegBytes: (canvas) => {
                const b64 = canvas.toDataURL('image/jpeg', 0.88).split(',')[1];
                const bin = atob(b64);
                const out = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
                return out;
            },
        };
    }

    /**
     * @param {{addresses:Array,route:Array<[number,number]>,mode:string,width?:number,height?:number,attribution?:string}} opts route = [[lat,lon],...]
     */
    async function renderMapImage(opts, depsOverride) {
        const deps = Object.assign(defaultDeps(), depsOverride || {});
        const W = opts.width || 1100;
        const H = opts.height || 700;
        const points = opts.addresses.map((a) => [a.latitude, a.longitude]).concat(opts.route || []);
        if (!points.length) throw new Error('Keine Punkte');

        const plan = planMap(points, W, H);
        const canvas = deps.createCanvas(W, H);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#e6ebee';
        ctx.fillRect(0, 0, W, H);

        let failed = 0;
        await Promise.all(plan.tiles.map(async (t) => {
            try {
                const img = await deps.loadImage(TILE_URL.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y));
                ctx.drawImage(img, Math.round(t.dx), Math.round(t.dy), 256, 256);
            } catch (e) {
                failed++;
            }
        }));

        const toPx = (lat, lon) => {
            const p = project(lat, lon, plan.zoom);
            return [p[0] - plan.left, p[1] - plan.top];
        };

        if (opts.route && opts.route.length > 1) {
            const color = MODE_COLORS[opts.mode] || '#e8590c';
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 9;
            ctx.beginPath();
            opts.route.forEach((p, i) => { const q = toPx(p[0], p[1]); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
            ctx.stroke();
            ctx.strokeStyle = color;
            ctx.lineWidth = 5;
            ctx.stroke();
        }

        const many = opts.addresses.length > 120;
        const radius = many ? 9 : 13;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold ' + (many ? 10 : 13) + 'px Arial, Helvetica, sans-serif';
        opts.addresses.forEach((a, i) => {
            const q = toPx(a.latitude, a.longitude);
            ctx.beginPath();
            ctx.arc(q[0], q[1], radius, 0, Math.PI * 2);
            ctx.fillStyle = '#17232b';
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
            ctx.fillStyle = '#ffffff';
            ctx.fillText(String(i + 1), q[0], q[1] + 0.5);
        });

        const attribution = opts.attribution || '© OpenStreetMap-Mitwirkende';
        ctx.font = '12px Arial, Helvetica, sans-serif';
        const tw = ctx.measureText(attribution).width;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(W - tw - 16, H - 22, tw + 16, 22);
        ctx.fillStyle = '#333333';
        ctx.textAlign = 'right';
        ctx.fillText(attribution, W - 8, H - 11);

        return {bytes: deps.toJpegBytes(canvas), width: W, height: H, tilesFailed: failed, tilesTotal: plan.tiles.length, zoom: plan.zoom};
    }

    /* ====================================================================
     * Bericht als PDF
     * ================================================================== */

    const fmtTime = (total) => {
        total = Math.max(0, Math.round(total || 0));
        const p = (n) => String(n).padStart(2, '0');
        return p(Math.floor(total / 3600)) + ':' + p(Math.floor((total % 3600) / 60)) + ':' + p(total % 60);
    };
    const fmtKm = (m) => ((m || 0) / 1000).toLocaleString('de-DE', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' km';
    const fmtDate = (d) => d.toLocaleDateString('de-DE') + ' ' + d.toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'});

    function addressLabel(a) {
        const t = [a.street, a.house_number].filter(Boolean).join(' ');
        return t || String(a.full_address || '').split(',')[0] || '';
    }

    /**
     * @param {Object} report Daten wie in validateReport() plus totals
     * @param {Uint8Array|null} mapJpeg
     * @param {Object} L Beschriftungen (deutsch, kommen aus PHP)
     */
    async function buildReportPdf(PDFLib, report, mapJpeg, L) {
        const {PDFDocument, StandardFonts, rgb} = PDFLib;
        const doc = await PDFDocument.create();
        const created = new Date(report.created_at || Date.now());

        doc.setTitle(L.title + (report.title ? ' – ' + report.title : ''));
        doc.setSubject('MRS Delivery Time Calculator');
        doc.setKeywords(['mrs-dtc', 'mrs-delivery-time']);
        doc.setProducer('MRS Delivery Time Calculator');
        doc.setCreator('MRS Delivery Time Calculator');
        doc.setCreationDate(created);
        doc.setModificationDate(created);

        const font = await doc.embedFont(StandardFonts.Helvetica);
        const bold = await doc.embedFont(StandardFonts.HelveticaBold);
        const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
        const charset = new Set(font.getCharacterSet());
        // Standardschriften kennen nur Latin-1/WinAnsi; alles andere wird zu "?".
        const safe = (t) => Array.from(String(t == null ? '' : t))
            .map((ch) => (charset.has(ch.codePointAt(0)) ? ch : (/\s/.test(ch) ? ' ' : '?')))
            .join('');

        const PW = 595.28, PH = 841.89, M = 40, CW = PW - 2 * M;
        const ink = rgb(0.09, 0.14, 0.17), gray = rgb(0.4, 0.45, 0.48), line = rgb(0.83, 0.86, 0.88);
        const accent = rgb(0.043, 0.431, 0.31);

        let page = doc.addPage([PW, PH]);
        let y = PH - M;

        const draw = (t, x, yy, o) => {
            const opt = Object.assign({size: 10, f: font, color: ink}, o || {});
            page.drawText(safe(t), {x, y: yy, size: opt.size, font: opt.f, color: opt.color});
        };
        const width = (t, f, size) => f.widthOfTextAtSize(safe(t), size);
        const fit = (t, f, size, max) => {
            let s = safe(t);
            if (f.widthOfTextAtSize(s, size) <= max) return s;
            while (s.length > 1 && f.widthOfTextAtSize(s + '…', size) > max) s = s.slice(0, -1);
            return s + '…';
        };
        const wrap = (t, f, size, max) => {
            const words = safe(t).split(' ');
            const lines = [];
            let cur = '';
            words.forEach((w) => {
                const test = cur ? cur + ' ' + w : w;
                if (f.widthOfTextAtSize(test, size) > max && cur) { lines.push(cur); cur = w; } else { cur = test; }
            });
            if (cur) lines.push(cur);
            return lines;
        };

        // ---- Kopf ----
        draw(L.title, M, y - 18, {size: 20, f: bold});
        y -= 30;
        if (report.title) { draw(report.title, M, y - 12, {size: 11, f: bold, color: gray}); y -= 16; }
        draw(L.created + ' ' + fmtDate(created) + (report.calculation_id ? '  ·  ' + L.calcId + ' ' + report.calculation_id : ''), M, y - 10, {size: 9, color: gray});
        y -= 24;

        // ---- Zusammenfassung ----
        const t = report.totals;
        const boxH = 92;
        page.drawRectangle({x: M, y: y - boxH, width: CW, height: boxH, color: rgb(0.95, 0.96, 0.97), borderColor: line, borderWidth: 0.8});
        const cells = [
            [L.houses, String(t.houses)],
            [L.distance, fmtKm(t.distance_meters)],
            [L.mode, L.modes[report.travel_mode] || ''],
            [L.houseTime, fmtTime(t.house_seconds)],
            [L.travel[report.travel_mode] || L.travel.foot, fmtTime(t.travel_seconds)],
            [L.additional, fmtTime(t.additional_seconds)],
        ];
        cells.forEach((c, i) => {
            const cx = M + 14 + (i % 3) * 112;
            const cy = y - 26 - Math.floor(i / 3) * 36;
            draw(c[0], cx, cy, {size: 8.5, color: gray});
            draw(c[1], cx, cy - 15, {size: 13, f: bold});
        });
        const tx = M + 14 + 3 * 112 + 4;
        page.drawRectangle({x: tx, y: y - boxH + 10, width: M + CW - tx - 10, height: boxH - 20, color: accent});
        draw(L.total, tx + 10, y - 34, {size: 9, f: bold, color: rgb(1, 1, 1)});
        draw(fmtTime(t.total_seconds), tx + 10, y - 62, {size: 22, f: bold, color: rgb(1, 1, 1)});
        y -= boxH + 12;

        const note = L.note + ' ' + L.routingDuration + ' ' + fmtTime(t.routing_duration_seconds) + '.';
        wrap(note, italic, 8.5, CW).forEach((ln) => { draw(ln, M, y - 8, {size: 8.5, f: italic, color: gray}); y -= 11; });
        y -= 8;

        // ---- Karte ----
        if (mapJpeg) {
            const img = await doc.embedJpg(mapJpeg);
            const h = CW * (img.height / img.width);
            if (y - h - 20 < M + 60) { page = doc.addPage([PW, PH]); y = PH - M; }
            page.drawImage(img, {x: M, y: y - h, width: CW, height: h});
            page.drawRectangle({x: M, y: y - h, width: CW, height: h, borderColor: line, borderWidth: 0.8});
            y -= h + 12;
            draw(L.mapCaption, M, y - 6, {size: 8, color: gray});
            y -= 22;
        } else {
            draw(L.mapMissing, M, y - 8, {size: 9, f: italic, color: gray});
            y -= 24;
        }

        // ---- Adressliste ----
        const colNr = M, colAddr = M + 34, colQty = M + CW - 90, colSec = M + CW;
        const header = () => {
            page.drawRectangle({x: M, y: y - 18, width: CW, height: 18, color: ink});
            const hc = rgb(1, 1, 1);
            draw(L.nr, colNr + 6, y - 12.5, {size: 8.5, f: bold, color: hc});
            draw(L.address, colAddr, y - 12.5, {size: 8.5, f: bold, color: hc});
            draw(L.quantity, colQty - width(L.quantity, bold, 8.5), y - 12.5, {size: 8.5, f: bold, color: hc});
            draw(L.seconds, colSec - 6 - width(L.seconds, bold, 8.5), y - 12.5, {size: 8.5, f: bold, color: hc});
            y -= 18;
        };

        if (y < M + 80) { page = doc.addPage([PW, PH]); y = PH - M; }
        draw(L.addresses, M, y - 12, {size: 12, f: bold});
        y -= 22;
        header();

        report.addresses.forEach((a, i) => {
            if (y - 17 < M + 24) { page = doc.addPage([PW, PH]); y = PH - M; header(); }
            if (i % 2 === 0) page.drawRectangle({x: M, y: y - 17, width: CW, height: 17, color: rgb(0.965, 0.972, 0.978)});
            draw(String(i + 1), colNr + 6, y - 12, {size: 9, color: gray});
            const label = addressLabel(a);
            const rest = String(a.full_address || '').split(',').slice(1).join(',').trim();
            const maxW = colQty - colAddr - 40;
            const main = fit(label, bold, 9, maxW);
            draw(main, colAddr, y - 12, {size: 9, f: bold});
            const used = width(main, bold, 9);
            if (rest && maxW - used > 40) draw(fit('  ' + rest, font, 8, maxW - used), colAddr + used, y - 12, {size: 8, color: gray});
            const q = a.quantity > 1 ? '× ' + a.quantity : '1';
            draw(q, colQty - width(q, font, 9), y - 12, {size: 9});
            const s = String(a.seconds);
            draw(s, colSec - 6 - width(s, font, 9), y - 12, {size: 9});
            y -= 17;
        });

        if (y - 24 < M + 24) { page = doc.addPage([PW, PH]); y = PH - M; }
        page.drawLine({start: {x: M, y: y - 4}, end: {x: M + CW, y: y - 4}, thickness: 0.8, color: ink});
        draw(L.sum, colAddr, y - 18, {size: 9.5, f: bold});
        const sum = String(t.house_seconds);
        draw(sum, colSec - 6 - width(sum, bold, 9.5), y - 18, {size: 9.5, f: bold});

        // ---- Fußzeile ----
        const pages = doc.getPages();
        pages.forEach((p, i) => {
            const txt = safe(L.footer + '  ·  ' + L.page + ' ' + (i + 1) + ' / ' + pages.length);
            p.drawText(txt, {x: M, y: 22, size: 8, font, color: gray});
        });

        // ---- Berechnungsdaten als Anhang (zum Wiedereinlesen) ----
        const data = {
            format: FORMAT,
            version: FORMAT_VERSION,
            created_at: created.toISOString(),
            title: report.title || '',
            travel_mode: report.travel_mode,
            travel_speed_kmh: report.travel_speed_kmh,
            standard_seconds: report.standard_seconds,
            additional_minutes: report.additional_minutes,
            totals: t,
            route: report.route ? {coordinates: report.route.coordinates.map((c) => [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5])} : null,
            addresses: report.addresses.map((a) => ({
                street: a.street, house_number: a.house_number, full_address: a.full_address,
                latitude: a.latitude, longitude: a.longitude, seconds: a.seconds, quantity: a.quantity || 1,
            })),
        };
        await doc.attach(new TextEncoder().encode(JSON.stringify(data)), ATTACHMENT_NAME, {
            mimeType: 'application/json',
            description: 'MRS Delivery Time Calculator – Berechnungsdaten',
            creationDate: created,
            modificationDate: created,
        });

        return doc.save();
    }

    function makeFilename(report) {
        const d = new Date(report.created_at || Date.now());
        const p = (n) => String(n).padStart(2, '0');
        const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
        const slug = String(report.title || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
        return 'zustellzeit-' + (slug ? slug + '-' : '') + stamp + '.pdf';
    }

    /**
     * Erstellt das komplette PDF (Karte + Bericht).
     * @return {Promise<{bytes:Uint8Array,filename:string,tilesFailed:number}>}
     */
    async function exportReport(report, libs, labels, depsOverride) {
        const PDFLib = await loadPdfLib(libs);
        let map = null;
        try {
            map = await renderMapImage({
                addresses: report.addresses,
                route: report.route ? report.route.coordinates.map((c) => [c[1], c[0]]) : null,
                mode: report.travel_mode,
                attribution: labels.attribution,
            }, depsOverride);
        } catch (e) {
            map = null; // Das PDF wird trotzdem erstellt, nur ohne Karte.
        }
        const bytes = await buildReportPdf(PDFLib, report, map ? map.bytes : null, labels);
        return {bytes, filename: makeFilename(report), tilesFailed: map ? map.tilesFailed : -1};
    }

    const api = {
        ATTACHMENT_NAME, LIMITED_STATUS, MAX_ADDRESSES,
        expandStreet, normStreet, normHouse, splitStreetCell,
        parseDeliveryBook, aggregateBook, extractPages, validateReport,
        planMap, renderMapImage, buildReportPdf, exportReport, readFile, makeFilename,
    };

    root.MRS_DTC_PDF = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
