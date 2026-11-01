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
const USER_KEY = SCOPE.href + "offline-user";                            // zuletzt angemeldeter Benutzer (aus der Seitenkennung)
const USER = /id="offline-page"[^>]*\bdata-user="([^"]*)"/i;              // Seitenkennung mit Benutzer (Region auf Seite 0)
const POST_PATIENCE = 60000;   // nach einem Absenden (POST) ist der Server da: so lange geduldig warten wie im Rahmen
let lastPost = 0;
// Dokumentierte Parameter der Friendly URLs, die nichts am Inhalt ändern; gleiche Liste in offline.js
const VOLATILE = ["session", "cs", "dialogcs", "clear", "debug", "trace", "timezone"];
const PAGE_LIMIT = 500;   // gespeicherte Seiten höchstens; die am längsten nicht gespeicherten fallen zuerst heraus
const MARK = 'id="offline-page"';                                        // Seitenkennung (Region auf Seite 0)
const TIMEOUT = 4000;                                                    // danach die gespeicherte Fassung
const PATIENT = 30000;     // Übertragungsseite und Dialoge (iframe) warten länger auf einen langsamen Server
const STORABLE = ["script", "style", "font", "manifest"];                // Teile einer Seite, die offline nötig sind

// Beide Hinweisseiten laden neu, sobald die Verbindung zurück ist - und solange der Browser online meldet, alle
// 15 s erneut: ein einzelner Versuch kann noch scheitern (Netz gerade erst da, Server langsamer als TIMEOUT).
const RETRY = '<script>addEventListener("online", () => location.reload());'
    + 'setInterval(() => { if (navigator.onLine) { location.reload(); } }, 15000);</script>';

const OFFLINE_PAGE = '<!doctype html><html lang="de"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Keine Verbindung</title>'
    + '<body style="font:16px system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem">'
    + '<h1>Keine Verbindung</h1><p>Diese Seite wurde noch nicht online aufgerufen und ist deshalb offline nicht verfügbar.</p>'
    + '<p><button onclick="history.back()">Zurück</button> <button onclick="location.reload()">Erneut versuchen</button></p>' + RETRY;

// Seiten mit der Page-CSS-Klasse online-only: offline nie die gespeicherte Fassung (veraltete Zahlen), sondern
// dieser Hinweis. Kommt die Verbindung zurück, lädt er die Seite neu.
const ONLINE_ONLY_PAGE = '<!doctype html><html lang="de"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Nur online verfügbar</title>'
    + '<body style="font:16px system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem">'
    + '<div class="online-only-notice"><h2>Nur online verfügbar</h2><p>Diese Seite braucht eine Verbindung zum Server. '
    + 'Die offline verfügbaren Seiten erreichen Sie mit „Zurück“.</p>'
    + '<p><button onclick="history.back()">Zurück</button> <button onclick="location.reload()">Erneut versuchen</button></p></div>' + RETRY;
const ONLINE_ONLY = /<body\b[^>]*\bclass="[^"]*\bonline-only\b/i;           // eigene Klasse am body (Page CSS Classes)

const HTML = { "Content-Type": "text/html; charset=utf-8" };

function pageKey(href) {                          // eine Seite = Pfad + fachliche Parameter
    const url = new URL(href);
    [...new Set(url.searchParams.keys())].filter(k => VOLATILE.includes(k.toLowerCase())).forEach(k => url.searchParams.delete(k));
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
    const user = (html.match(USER) || [])[1] || "";   // wem die Seite gehört; "" bei einer Seitenkennung ohne data-user
    const cache = await caches.open(PAGES);
    await cache.put(key, new Response(html, { headers: { ...HTML, "x-offline-stored": String(Date.now()), "x-offline-user": user } }));
    if (user) { await (await caches.open(FILES)).put(USER_KEY, new Response(user)); }
    if (++puts === 1 || puts % 25 === 0) { await trim(cache); }   // auch kurzlebige Service Worker räumen auf
}
let puts = 0;                                     // gespeicherte Seiten seit dem Start des Service Workers

async function trim(cache) {                      // Obergrenze: put hängt hinten an (Cache API), die ersten Einträge sind die ältesten
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - PAGE_LIMIT)).map(k => cache.delete(k)));
}

const lastUser = () => caches.open(FILES).then(c => c.match(USER_KEY)).then(r => (r ? r.text() : "")).catch(() => "");

async function fromCache(key) {
    const hit = await caches.match(key, { cacheName: PAGES });
    if (!hit) { return null; }
    // Seite eines anderen Benutzers (Gerät weitergegeben, Vorgänger noch nicht ausgeräumt): nie ausliefern
    const user = hit.headers.get("x-offline-user") || "";
    if (user && user !== await lastUser()) { return null; }
    // Markierung für offline.js: Sitzung und Prüfsummen dieser Fassung sind veraltet; content = gespeichert um
    const stored = hit.headers.get("x-offline-stored") || "";
    const text = await hit.text();
    if (ONLINE_ONLY.test(text)) { return new Response(ONLINE_ONLY_PAGE, { headers: HTML }); }
    const html = text.replace(/<head[^>]*>/i, head => head + '<meta name="offline-copy" content="' + stored + '">');
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
        // Rahmen (Übertragung, Dialoge) und die Seiten nach einem Absenden warten länger: der Server ist erreichbar,
        // eine gespeicherte Fassung wäre jetzt die falsche (alter Stand, oder die Seite des vorigen Benutzers)
        const patient = request.destination === "iframe" || Date.now() - lastPost < POST_PATIENCE;
        const response = await race(network, patient ? PATIENT : TIMEOUT);
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

// Dateien je APEX-Version: der Cache der aktuellen Version und der davor bleiben (gespeicherte Seiten eines früheren
// Release verweisen noch auf ihre Dateien), ältere werden beim Aktivieren eines neuen Service Workers entfernt.
async function pruneFiles() {
    const prefix = FILES + ":";
    const num = v => v.split(".").map(n => parseInt(n, 10) || 0);
    const newer = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((y[i] || 0) !== (x[i] || 0)) { return (y[i] || 0) - (x[i] || 0); } } return 0; };
    const versions = (await caches.keys()).filter(n => n.startsWith(prefix)).map(n => n.slice(prefix.length)).sort(newer);
    await Promise.all(versions.slice(2).map(v => caches.delete(prefix + v)));
}

function onFetch(event) {
    const request = event.request;
    if (request.method !== "GET") {                                   // Absenden, Ajax, HEAD: direkt ins Netz
        if (request.method === "POST" && new URL(request.url).origin === SCOPE.origin) { lastPost = Date.now(); }
        return;
    }
    if (request.url === PROBE) { event.respondWith(new Response("ok", { headers: { "x-offline-sw": "1" } })); return; }
    if (request.mode === "navigate" || request.headers.has("x-offline-prefetch")) { page(event); return; }
    if (new URL(request.url).origin !== SCOPE.origin) { return; }       // fremde Server: Browser-Standard
    event.respondWith(resource(event));
}

const swHooks = {
    EVENT_INSTALL: ({ event }) => event.waitUntil(self.skipWaiting()),
    EVENT_ACTIVATE: ({ event }) => event.waitUntil(Promise.all([self.clients.claim(),
        caches.open(PAGES).then(trim).catch(() => {}), pruneFiles().catch(() => {})])),
    EVENT_FETCH: ({ event }) => onFetch(event)
};
