/*
 * offline-sw.js - Service-Worker-Hooks für die Offline-Erfassung (APEX 26.1)
 *
 * Einbindung: App-Definition > Progressive Web App > Service Worker Hooks: File URL
 * #APP_FILES#offline-sw.js. APEX lädt die Datei in seine sw.js und ruft die Hooks des Objekts swHooks auf.
 * Genutzt werden nur EVENT_INSTALL, EVENT_ACTIVATE und EVENT_FETCH: ohne _BEFORE/_AFTER ersetzen sie das
 * Verhalten von APEX für dieses Ereignis ganz (APEX PWA Reference). Nichts hier greift auf apex.sw.* oder
 * den Aufbau der generierten sw.js zu.
 *
 * Aufgabe: jede aufgerufene Seite der App speichern und ohne Verbindung (oder wenn der Server nicht
 * antwortet) die zuletzt gespeicherte Fassung liefern; Skripte, Styles und statische Dateien vorhalten,
 * damit gespeicherte Seiten offline vollständig sind. Nur Webstandards (Fetch, Cache API).
 */
const SCOPE = new URL(self.registration.scope);
const PAGES = "offline-pages:" + SCOPE.pathname;                          // gleicher Name in offline.js
const FILES = "offline-files:" + SCOPE.pathname;                          // gleicher Name in offline.js
const CONFIG = SCOPE.href + "offline-config";                            // Pfade der statischen Dateien (schreibt offline.js)
const PROBE = SCOPE.href + "offline-probe";                              // Selbstprüfung: beantwortet nur dieser Hook
const VOLATILE = ["session", "cs", "clear", "success_msg", "tz", "debug"]; // gleiche Liste in offline.js
const MARK = 'id="offline-page"';                                        // Seitenkennung (Region auf Seite 0)
const TIMEOUT = 4000;                                                    // danach die gespeicherte Fassung
const PATIENT = 30000;     // Übertragungsseite und Dialoge (iframe) warten länger auf einen langsamen Server
const STORABLE = ["script", "style", "font", "manifest"];                // Teile einer Seite, die offline nötig sind

const OFFLINE_PAGE = '<!doctype html><html lang="de"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Keine Verbindung</title>'
    + '<body style="font:16px system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem">'
    + '<h1>Keine Verbindung</h1><p>Diese Seite wurde noch nicht online aufgerufen und ist deshalb offline nicht verfügbar.</p>'
    + '<p><button onclick="history.back()">Zurück</button> <button onclick="location.reload()">Erneut versuchen</button></p>';

const HTML = { "Content-Type": "text/html; charset=utf-8" };

function pageKey(href) {                          // eine Seite = Pfad + fachliche Parameter
    const url = new URL(href);
    VOLATILE.forEach(p => url.searchParams.delete(p));
    url.searchParams.sort();
    url.hash = "";
    return url.href;
}

// Pfade der statischen Dateien (apex.env.APEX_FILES, APP_FILES, WORKSPACE_FILES) und APEX-Version, von
// offline.js im Cache abgelegt. Nach jedem Seitenaufruf neu gelesen: ein Release bringt neue Versionspfade.
let statics = null;
const settings = () => statics || (statics = caches.open(FILES).then(c => c.match(CONFIG))
    .then(r => (r ? r.json() : {})).catch(() => ({}))
    .then(j => ({ paths: Array.isArray(j.paths) ? j.paths : [], cache: FILES + ":" + (j.version || "") })));

const later = (event, promise) => event.waitUntil(promise.catch(() => {}));
const race = (network, wait) => Promise.race([network, new Promise(r => setTimeout(r, wait))]).catch(() => null);

/* ---------- Seiten ---------- */

async function remember(key, response) {
    if (!response.ok || response.type !== "basic") { return; }
    const html = await response.text();          // nur angemeldete Seiten der App: keine Anmelde-, Fehler- oder Zeitzonenseite
    if (!html.includes(MARK)) { return; }
    await (await caches.open(PAGES)).put(key, new Response(html, { headers: { ...HTML, "x-offline-stored": String(Date.now()) } }));
}

async function fromCache(key) {
    const hit = await caches.match(key, { cacheName: PAGES });
    if (!hit) { return null; }
    // Markierung für offline.js: Sitzung und Prüfsummen dieser Fassung sind veraltet; content = gespeichert um
    const stored = hit.headers.get("x-offline-stored") || "";
    const html = (await hit.text()).replace(/<head[^>]*>/i, head => head + '<meta name="offline-copy" content="' + stored + '">');
    return new Response(html, { headers: HTML });
}

function page(event) {
    const request = event.request;
    const key = pageKey(request.url);
    const network = fetch(request);
    statics = null;
    later(event, network.then(r => remember(key, r.clone())));
    // Vorrat: nur frisch vom Server - nie eine alte Fassung oder die Seite "Keine Verbindung" als geladen melden
    if (request.headers.has("x-offline-prefetch")) { event.respondWith(network); return; }
    event.respondWith((async () => {
        const response = await race(network, request.destination === "iframe" ? PATIENT : TIMEOUT);
        if (response && response.status < 500) { return response; }
        return (await fromCache(key)) || response
            || network.catch(() => new Response(OFFLINE_PAGE, { headers: HTML }));
    })());
}

/* ---------- Skripte, Styles, statische Dateien ---------- */

function keep(event, cache, request, response) {  // Antwort für offline speichern
    if (!response || !response.ok || response.type !== "basic") { return; }
    const copy = response.clone();
    later(event, caches.open(cache).then(c => c.put(request, copy)));
}

async function resource(event) {
    const request = event.request;
    const { paths, cache } = await settings();     // ein Cache je APEX-Version
    // Statische Dateien: Speicher zuerst. Fehlt das Netz, auch aus älteren Caches (frühere APEX-Version,
    // Caches, die APEX vor dieser Fassung selbst angelegt hat): gespeicherte Seiten verweisen noch darauf.
    if (paths.some(p => request.url.startsWith(p))) {
        const hit = await caches.match(request, { cacheName: cache });
        if (hit) { return hit; }
        try {
            const response = await fetch(request);
            keep(event, cache, request, response);
            return response;
        } catch (e) {
            return (await caches.match(request)) || Response.error();
        }
    }
    // Übrige Skripte und Styles (z. B. die Textdateien von APEX): Netz zuerst, offline aus dem Speicher
    if (STORABLE.includes(request.destination)) {
        const network = fetch(request);
        const response = await race(network, TIMEOUT);
        if (response && response.ok) { keep(event, cache, request, response); return response; }
        return (await caches.match(request)) || response || network;
    }
    // Alles andere (Bilder vom Server, Ajax): ins Netz; offline nur, was ohnehin gespeichert ist
    return fetch(request).catch(async () => (await caches.match(request)) || Response.error());
}

function onFetch(event) {
    const request = event.request;
    if (request.method !== "GET") { return; }                         // Absenden, Ajax, HEAD: direkt ins Netz
    if (request.url === PROBE) { event.respondWith(new Response("ok", { headers: { "x-offline-sw": "1" } })); return; }
    if (request.mode === "navigate" || request.headers.has("x-offline-prefetch")) { page(event); return; }
    if (new URL(request.url).origin !== SCOPE.origin) { return; }       // fremde Server: Browser-Standard
    event.respondWith(resource(event));
}

const swHooks = {
    EVENT_INSTALL: ({ event }) => event.waitUntil(self.skipWaiting()),
    EVENT_ACTIVATE: ({ event }) => event.waitUntil(self.clients.claim()),
    EVENT_FETCH: ({ event }) => onFetch(event)
};
