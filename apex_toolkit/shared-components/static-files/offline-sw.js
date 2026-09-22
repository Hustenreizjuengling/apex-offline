/*
 * offline-sw.js - Service-Worker-Erweiterung für die Offline-Erfassung (APEX 26.1)
 *
 * Einbindung: App-Definition > Progressive Web App > Service Worker Hooks: File URL
 * #APP_FILES#offline-sw.js. APEX lädt die Datei per importScripts() in seine eigene sw.js.
 *
 * Aufgabe: jede aufgerufene Seite der App speichern und ohne Verbindung (oder wenn der Server
 * nicht antwortet) die zuletzt gespeicherte Fassung liefern. Statische Dateien (/i/, #APP_FILES#)
 * cacht APEX weiterhin selbst - dafür bleibt der APEX-Standard zuständig.
 */
const SCOPE = new URL(self.registration.scope);
const CACHE = "offline-pages:" + SCOPE.pathname;                          // gleicher Name in offline.js
const VOLATILE = ["session", "cs", "clear", "success_msg", "tz", "debug"]; // gleiche Liste in offline.js
const TIMEOUT = 4000;                                                    // danach die gespeicherte Fassung

const OFFLINE_PAGE = '<!doctype html><html lang="de"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Keine Verbindung</title>'
    + '<body style="font:16px system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem">'
    + '<h1>Keine Verbindung</h1><p>Diese Seite wurde noch nicht online aufgerufen und ist deshalb offline nicht verfügbar.</p>'
    + '<p><button onclick="history.back()">Zurück</button> <button onclick="location.reload()">Erneut versuchen</button></p>';

function pageKey(href) {                          // eine Seite = Pfad + fachliche Parameter
    const url = new URL(href);
    VOLATILE.forEach(p => url.searchParams.delete(p));
    url.searchParams.sort();
    url.hash = "";
    return url.href;
}

async function remember(key, response, isPage) {
    if (!response.ok || response.type !== "basic") { return; }
    if (isPage) {                                 // nur echte App-Seiten, keine Fehler-, Zeitzonen- oder Anmeldeseiten
        const html = await response.clone().text();
        if (!html.includes('id="wwvFlowForm"') || html.includes('type="password"')) { return; }
    }
    await (await caches.open(CACHE)).put(key, response);
}

async function fromCache(key, isPage) {
    const hit = await caches.match(key, { cacheName: CACHE });
    if (!hit || !isPage) { return hit; }
    // Markierung für offline.js: Sitzung und Prüfsummen dieser Fassung sind veraltet
    const html = (await hit.text()).replace(/<head[^>]*>/i, head => head + '<meta name="offline-copy" content="1">');
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function networkFirst(key, network, isPage) {
    const response = await Promise.race([network, new Promise(r => setTimeout(r, TIMEOUT))]).catch(() => null);
    if (response && response.status < 500) { return response; }
    return (await fromCache(key, isPage)) || response || network.catch(() =>
        isPage ? new Response(OFFLINE_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } }) : Response.error());
}

// Eigener Listener vor dem von APEX: Seiten (Navigation, Vorab-Laden) und die APEX-Textdateien
// (wwv_flow.js_messages/js_dialogs), ohne die eine gespeicherte Seite offline unvollständig wäre.
self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET") { return; }
    const isPage = request.mode === "navigate" || request.headers.has("x-offline-prefetch");
    if (!isPage && !request.url.includes("wwv_flow.js_")) { return; } // alles andere: APEX-Standard
    event.stopImmediatePropagation();
    const key = pageKey(request.url);
    const network = fetch(request);
    event.waitUntil(network.then(r => remember(key, r.clone(), isPage)).catch(() => {}));
    event.respondWith(networkFirst(key, network, isPage));
});

const swHooks = {
    // Alte Versionen der App- und APEX-Dateien behalten: gespeicherte Seiten verweisen noch auf sie.
    FUNCTION_VARIABLE_DECLARATION: ({ apex }) => {
        apex.sw.cleanAppCaches = () => {};
        apex.sw.cleanAPEXCaches = () => Promise.resolve();
    },
    EVENT_INSTALL_AFTER: () => self.skipWaiting(),
    EVENT_ACTIVATE_AFTER: ({ event }) => event.waitUntil(self.clients.claim())
};
