/*
 * offline.js - Offline-Erfassung für native APEX-Seiten (APEX 26.1)
 *
 * Die App wird ganz normal im APEX Builder gebaut. Diese Datei (app-weit eingebunden) ergänzt:
 *   1. Absenden ohne Verbindung: Auf Seiten mit der CSS-Klasse offline-form werden die geänderten
 *      Seitenelemente als Entwurf im Browser gespeichert (IndexedDB), statt verloren zu gehen.
 *      Mit der zusätzlichen Klasse offline-queue legt Speichern immer erst einen Entwurf an, auch online,
 *      und überträgt ihn im Hintergrund (für Seiten, deren Prozess doppelt Gesendetes erkennt, z. B. Fotos).
 *   2. Übertragen: Sobald der Server erreichbar ist, wird jeder Entwurf durch DIESELBE Seite
 *      abgesendet - unsichtbar geladen, Werte gesetzt, apex.page.submit. Es laufen also genau die
 *      Validierungen und Prozesse aus dem Builder. Kein eigenes Server-API, kein Feldvertrag.
 *   3. Bedienelemente per CSS-Klasse an normalen Items (Builder: Advanced > CSS Classes):
 *        offline-signature   Textarea wird zum Unterschriftenfeld (Wert: Bild als Data-URL)
 *        offline-photo       Textarea wird zum Fotofeld: Kamera oder Galerie, verkleinert (Wert: Bild als Data-URL)
 *        offline-scan        Textfeld bekommt eine Kamera-Taste für Barcode und QR-Code
 *        offline-prefetch    (Region) Ziele ihrer Links und Buttons werden im Hintergrund offline verfügbar
 *                            gemacht - zusammen mit allen Seiten des Navigationsmenüs (Offline-Vorrat)
 *        offline-drafts      (Region) zeigt die noch nicht übertragenen Neuanlagen der Seiten, auf die ihre Links
 *                            und Buttons zeigen - z. B. am Auftrag die Fotos hinter "Foto hinzufügen"
 *        offline-lightbox    (Region) Klick auf ein Bild zeigt es groß
 *   4. Seiten nur für online (Page > Appearance > CSS Classes: online-only): ohne Verbindung zeigen sie
 *      statt des Inhalts einen Hinweis (offline.css), mit Verbindung wieder den aktuellen Inhalt.
 * Die Seiten selbst speichert offline-sw.js (Service Worker) bei jedem Online-Aufruf.
 */
(function (apex, $) {
    "use strict";
    if (!apex || !apex.env || !window.indexedDB) { return; }

    const env = apex.env;
    const BASE = location.pathname.replace(/[^/]*$/, "");                 // /ords/r/<workspace>/<app>/
    const CACHE = "offline-pages:" + BASE;                                // gleicher Name in offline-sw.js
    const VOLATILE = ["session", "cs", "clear", "success_msg", "tz", "debug"]; // gleiche Liste in offline-sw.js
    const COPY = document.querySelector('meta[name="offline-copy"]');    // Seite kam offline aus dem Cache
    const IS_COPY = !!COPY;
    const COPY_AT = COPY && Number(COPY.content) > 1e12 ? Number(COPY.content) : 0;   // gespeichert um (ab 1.9.0)
    const IN_FRAME = window !== window.top;                              // Dialogseite oder Übertragungsseite
    const CONTROLLED = !!(navigator.serviceWorker && navigator.serviceWorker.controller); // Seite lief schon über den Service Worker
    const VENDOR = (document.currentScript ? document.currentScript.src : "").replace(/[^/]*$/, "vendor/barcode-detector/");

    // Die unsichtbare Übertragungsseite meldet nur "bereit"; alles andere steuert das Hauptfenster.
    if (window.name === "offline-sync") {
        $(document).one("apexreadyend", () => { window.offlineReady = IS_COPY ? "copy" : "live"; });
        return;
    }

    let online = navigator.onLine;
    let snapshot = {};       // Werte der Seitenelemente beim Laden
    let draft = null;        // Entwurf, der auf dieser Seite angewendet wurde
    let lastRequest = "";
    let capturing = false;
    let syncing = false;
    let transmitting = false; // ein Entwurf ist gerade unterwegs (Anzeige "sendet")
    let stocking = false;
    let needLogin = false;   // Übertragung traf auf die Anmeldeseite: erst nach der Anmeldung erneut versuchen
    let nextTry = 0;         // frühester nächster Versuch der 30-Sekunden-Prüfung für wartende Entwürfe
    let bypass = false;      // einmal ohne Entwurf absenden (Entwurf ließ sich nicht speichern)
    let bypassed = false;
    let pickedAt = 0;        // zuletzt Kamera, Galerie oder Scanner geöffnet
    let reloading = false;   // Seite lädt gleich neu: nichts mehr anstoßen
    let leaving = false;     // Seite wird verlassen: abgebrochene Anfragen sind dann kein Fehler
    window.addEventListener("pagehide", () => { leaving = true; });
    window.addEventListener("pageshow", () => { leaving = false; });
    const STOCK_LIMIT = 300;                      // Offline-Vorrat: Seiten je Sitzung
    const STOCK_LAST = "offline-stock-last:" + env.APP_ID;   // Ergebnis des letzten Vorrats, auch für gespeicherte Seiten
    let stockState = null;                        // { at: zuletzt vollständig, complete, limit }
    try { stockState = JSON.parse(localStorage.getItem(STOCK_LAST) || "null"); } catch (e) { stockState = null; }
    const stockIncomplete = () => !!stockState && !stockState.complete;

    /* ---------- Hilfen ---------- */

    const same = (a, b) => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");
    const picture = d => Object.values(d.items).map(i => i.val)    // Foto im Entwurf (offline-photo), nicht die Unterschrift
        .find(v => typeof v === "string" && /^data:image\/(jpeg|webp);base64,/.test(v));
    const when = t => new Date(t).toDateString() === new Date().toDateString()      // heute "07:42", sonst "02.10., 16:10"
        ? new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
        : new Date(t).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const say = text => apex.message.showPageSuccess(text);   // Aussehen: messages.css, Ausblenden: APEX (Auto-Dismiss)
    const isDelete = request => /DELETE/i.test(request || "");
    const saves = request => !!request && !apex.item(request).node;         // Enter- oder Auswahllisten-Submit speichert nicht
    const isForm = () => document.body.classList.contains("offline-form");   // Page > Appearance > CSS Classes
    const queued = () => document.body.classList.contains("offline-queue");  // Speichern legt immer erst einen Entwurf an
    const unsure = d => d.create && !d.resend ? "unklar" : "wartet";        // resend: die Seite erkennt doppelt Gesendetes
    const allowance = chars => 30000 + chars / 4;                           // Zeitlimit wächst mit der Datenmenge (ab ca. 32 kbit/s)
    // Neu laden nur, wenn dabei nichts verloren geht: nichts geändert, kein Dialog, Kamera oder Scanner, sichtbar
    const canReload = () => !apex.page.isChanged() && !document.querySelector(".ui-dialog--apex, .offline-scan-overlay")
        && document.visibilityState === "visible" && Date.now() - pickedAt > 120000;

    function pageKey(href) {                      // eine Seite = Pfad + fachliche Parameter
        const url = new URL(href, location.href);
        VOLATILE.forEach(p => url.searchParams.delete(p));
        url.searchParams.sort();
        url.hash = "";
        return url.href;
    }

    function liveUrl(href) {                      // gespeicherte URL mit der Sitzung dieser Seite aufrufen
        const url = new URL(href, location.href);
        url.searchParams.delete("success_msg");
        url.searchParams.set("session", env.APP_SESSION); // abgelaufen? Dann liefert APEX die Anmeldeseite
        url.hash = "";
        return url.href;
    }

    function labels(names, doc = document) {
        return names.map(n => (doc.querySelector(`label[for="${n}"]`) || { textContent: n }).textContent.trim()).join(", ");
    }

    /* ---------- Entwürfe: IndexedDB, eine Datenbank je App ---------- */

    const db = new Promise((resolve, reject) => {
        const open = indexedDB.open("offline-" + env.APP_ID, 1);
        open.onupgradeneeded = () => open.result.createObjectStore("drafts", { keyPath: "id" });
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
    });

    async function store(mode, fn) {
        const tx = (await db).transaction("drafts", mode);
        const req = fn(tx.objectStore("drafts"));
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve(req.result);
            tx.onerror = tx.onabort = () => reject(tx.error);
        });
    }
    const allDrafts = () => store("readonly", s => s.getAll())
        .then(list => list.filter(d => d.user === env.APP_USER).sort((a, b) => a.ts - b.ts));
    const putDraft = d => store("readwrite", s => s.put(d));
    const deleteDraft = id => store("readwrite", s => s.delete(id));
    // Entwurf nach dem Senden ändern (change) oder löschen - aber nur, wenn er inzwischen nicht neu gespeichert wurde
    // (zweiter Tab, erneut geöffnet): dann gewinnt die neuere Fassung und geht beim nächsten Mal raus. Liefert true/false.
    const settle = (d, change) => store("readwrite", s => {
        const req = s.get(d.id);
        req.onsuccess = () => {
            const cur = req.result;
            if (!cur || cur.ts !== d.ts) { return; }
            if (change) { s.put({ ...cur, ...change }); } else { s.delete(d.id); }
        };
        return { get result() { return !!req.result && req.result.ts === d.ts; } };
    });

    /* ---------- Seitenelemente lesen und setzen ---------- */

    function readItems(w = window) {              // genau die Elemente, die APEX beim Absenden überträgt
        const values = {};
        if (!w.document.getElementById("wwvFlowForm")) { return values; }   // APEX-Fehlerseite
        w.apex.page.forEachPageItem(w.apex.jQuery("#wwvFlowForm"), (el, name, type) => {
            // nie: Dateien, Kennwörter, geschützte Items (mit Prüfsumme, z. B. der Primärschlüssel)
            if (type === "file" || type === "password" || w.document.querySelector(`[data-for="${name}"]`)) { return; }
            values[name] = w.apex.item(name).getValue();
        });
        return values;
    }

    // Setzt einen Entwurf in eine Seite (Hauptfenster oder Übertragungsseite) und prüft das Ergebnis:
    //   conflicts  Feld wurde inzwischen auf dem Server geändert (weder alter noch neuer Wert)
    //   lost       Wert ließ sich nicht setzen (Feld fehlt, Wert nicht in der Auswahlliste ...)
    //   already    alle Werte stehen bereits so auf dem Server
    function applyDraft(w, d, quiet) {
        const conflicts = [];
        let already = !d.create && !isDelete(d.request);
        for (const [name, it] of Object.entries(d.items)) {
            const item = w.apex.item(name);
            const current = item.node ? item.getValue() : undefined;
            if (item.node && !same(current, it.old) && !same(current, it.val)) { conflicts.push([name, current]); }
            if (!same(current, it.val)) { already = false; }
            if (item.node && !same(current, it.val)) { item.setValue(it.val, null, quiet); }
        }
        const now = readItems(w);
        const lost = Object.keys(d.items).filter(name => !(name in now) || !same(now[name], d.items[name].val));
        return { conflicts, lost, already };
    }

    /* ---------- 1. Offline speichern ---------- */

    async function saveOffline(request, uncertain) {
        const items = draft ? { ...draft.items } : {};
        const now = readItems();
        for (const [name, val] of Object.entries(now)) {
            const old = snapshot[name];               // Stand, den der Anwender beim Öffnen gesehen hat
            if (same(val, old)) { delete items[name]; } else { items[name] = { old, val }; }
        }
        if (!Object.keys(items).length && !isDelete(request)) { say("Keine Änderungen."); return; }
        const create = draft ? draft.create : /^CREATE/i.test(request);
        const first = Object.values(now).find(v => typeof v === "string" && v && !v.startsWith("data:"));
        capturing = true;
        try {
            await putDraft({
                id: draft ? draft.id : Date.now() + "-" + Math.random().toString(36).slice(2),
                key: pageKey(location.href),
                url: location.href.split("#")[0],
                page: String(env.APP_PAGE_ID),
                user: env.APP_USER,
                title: document.title + (first ? ": " + first.slice(0, 40) : ""),   // z. B. "Auftrag: A-1005"
                request,
                create,
                items,
                ts: Date.now(),
                // Verbindung brach beim Speichern ab: vielleicht ist der Datensatz schon angelegt. Seiten mit
                // offline-queue erkennen doppelt Gesendetes - dort wird einfach erneut gesendet.
                status: queued() ? "wartet" : (uncertain && create) || (draft && draft.status === "unklar") ? "unklar" : "wartet",
                resend: queued() || !!(draft && draft.resend),
                info: ""
            });
        } catch (e) {
            capturing = false;
            if (online && !IS_COPY && queued() && !bypassed) {   // Warteschlange nicht nutzbar: direkt senden wie sonst auch
                bypass = bypassed = true;
                apex.page.submit({ request, reloadOnSubmit: "S" });
                return;
            }
            apex.message.alert("Nicht lokal gespeichert (" + (e && e.name) + "). Bitte die Seite offen lassen.");
            return;
        }
        if (navigator.storage && navigator.storage.persist) { navigator.storage.persist(); }
        apex.page.cancelWarnOnUnsavedChanges();
        leave(online && !IS_COPY ? "Gespeichert – wird im Hintergrund übertragen." : "Offline gespeichert – wird automatisch übertragen.");
    }

    function leave(text) {                        // wie der übliche Verzweig nach dem Speichern
        const dialog = window.frameElement && /^apex_dialog_/.test((window.frameElement.parentElement || {}).id || "");
        if (dialog) {
            window.parent.apex.message.showPageSuccess(text);
            window.parent.dispatchEvent(new Event("offline-drafts"));   // Hauptseite überträgt
            apex.navigation.dialog.close(true);
            return;
        }
        sessionStorage.setItem("offline-flash", text);
        if (history.length > 1) { history.back(); } else { location.reload(); }
    }

    function onBeforeSubmit(event, request) {
        if (apex.event.gCancelFlag || !isForm()) { return; }   // von einer Dynamic Action abgebrochen / keine Erfassungsseite
        if (capturing) { apex.event.gCancelFlag = true; return; } // doppelt getippt
        lastRequest = request || "";
        const reload = document.getElementById("pReloadOnSubmit");
        if (reload) { reload.value = "S"; }       // Ergebnis per Ajax, damit ein Abbruch erkannt wird
        if (bypass) { bypass = false; return; }   // Entwurf ließ sich nicht speichern: APEX sendet selbst
        if (online && !IS_COPY && !(queued() && saves(lastRequest))) { return; }   // normaler Weg: APEX sendet selbst
        apex.event.gCancelFlag = true;            // Absenden abbrechen (einziger APEX-Mechanismus)
        if (!saves(lastRequest)) { say("Ohne Verbindung nicht möglich."); return; }
        if (isDelete(lastRequest) || apex.page.validate()) { saveOffline(lastRequest, false); }
    }

    // Reißt die Verbindung beim Absenden ab, zeigt APEX nichts an (Status 0, ohne Zeitlimit sogar erst
    // nach Minuten). Dann als Entwurf sichern; ist der Server erreichbar, einfach erneut speichern.
    // 502-504: Proxy oder ORDS erreichbar, Datenbank nicht - ebenfalls als Entwurf sichern.
    const unreachable = xhr => xhr.status === 0 || xhr.status >= 502;
    apex.jQuery.ajaxPrefilter(o => {              // o.data ist hier schon der fertige Text
        if (isForm() && /wwv_flow\.accept/.test(o.url || "") && !o.timeout) { o.timeout = allowance(String(o.data || "").length); }
    });

    async function onSubmitLost(status, timedOut) {
        // Server erreichbar und Anfrage nicht angekommen: einfach erneut speichern. Nach einer Zeitüberschreitung
        // kann er aber schon gespeichert haben - dann als Entwurf sichern (Neuanlage ohne offline-queue: "unklar").
        if (!status && !timedOut && await check()) { say("Übertragung unterbrochen – bitte erneut speichern."); return; }
        if (isDelete(lastRequest) || apex.page.validate()) { saveOffline(lastRequest, true); }
    }

    $(document).on("ajaxComplete", (event, xhr, settings) => {
        if (!/wwv_flow\.accept/.test(settings.url || "") || !isForm()) { return; }
        if (unreachable(xhr)) { onSubmitLost(xhr.status, xhr.statusText === "timeout"); return; }
        // Online erfolgreich gespeichert: angewendeten Entwurf beim nächsten Seitenaufbau löschen
        if (draft && saves(lastRequest) && xhr.responseJSON && xhr.responseJSON.redirectURL) { sessionStorage.setItem("offline-done", draft.id); }
        // gespeicherte Fassung dieser Seite auffrischen, sonst zeigt sie offline den Stand vor dem Speichern
        if (saves(lastRequest) && !isDelete(lastRequest) && xhr.responseJSON && xhr.responseJSON.redirectURL) {
            sessionStorage.setItem("offline-refetch", location.href.split("#")[0]);
        }
    });

    /* ---------- Entwurf beim Öffnen einer Seite wieder einsetzen ---------- */

    async function restore() {
        const wanted = new URLSearchParams(location.hash.slice(1)).get("offline-draft");
        const key = pageKey(location.href);
        const list = await allDrafts();
        draft = list.find(d => d.id === wanted) || list.find(d => !d.create && d.key === key && d.status !== "sendet") || null;
        if (!draft) { return; }
        const result = applyDraft(window, draft, false);
        if (result.already && !IS_COPY) {         // steht bereits so auf dem Server
            await deleteDraft(draft.id);
            draft = null;
            return;
        }
        say(IS_COPY ? "Offline-Entwurf geladen." : "Offline-Werte eingesetzt – bitte prüfen und speichern.");
        const problems = [                        // ohne "unsafe: false" maskiert APEX den Text (Server-Wert!)
            ...result.conflicts.map(([name, current]) => ({ type: "error", location: ["inline", "page"], pageItem: name,
                message: "Auf dem Server inzwischen: " + (current || "(leer)") })),
            ...result.lost.map(name => ({ type: "error", location: "page",
                message: "Offline-Wert nicht übernommen: " + labels([name]) }))
        ];
        if (problems.length) { apex.message.showErrors(problems); }
    }

    /* ---------- 2. Übertragen: jeden Entwurf durch seine eigene Seite absenden ---------- */

    async function sync() {
        if (syncing || !online || IN_FRAME || reloading) { return; }
        syncing = true;
        let sent = 0;
        const run = async () => {
            for (const { id } of await allDrafts()) {
                const d = await store("readonly", s => s.get(id));   // frisch lesen: inzwischen verworfen?
                if (!d) { continue; }
                if (d.status === "sendet") {      // beim letzten Mal mitten im Absenden abgebrochen: Ausgang unbekannt
                    d.status = unsure(d);
                    await settle(d, { status: d.status });
                }
                if (d.status !== "wartet" || (draft && d.id === draft.id)) { continue; }
                transmitting = true;
                refresh();
                const result = await replay(d);
                if (result.status === "neu") { continue; }   // inzwischen neu gespeichert: nächste Runde
                if (result.status === "ok") {
                    await settle(d);
                    sent++;
                    // gespeicherte Fassungen auffrischen: die Seite selbst und das Ziel nach dem Speichern
                    [liveUrl(d.url), result.info].filter(u => u && new URL(u, document.baseURI).href.startsWith(location.origin + BASE))
                        .forEach(u => fetch(new URL(u, document.baseURI).href, { headers: { "x-offline-prefetch": "1" } }).catch(() => {}));
                } else {
                    await settle(d, { status: result.status, info: result.info, resend: result.resend });
                    if (result.info === "Anmeldung erforderlich") { needLogin = true; }
                    if (result.status === "wartet") { break; } // Anmeldung oder Verbindung fehlt: später erneut
                }
                refresh();                        // die Zahl offener Entwürfe sinkt sichtbar
            }
        };
        try {
            if (navigator.locks) {
                await navigator.locks.request("offline-sync-" + env.APP_ID, { ifAvailable: true }, lock => lock && run());
            } else {
                await run();
            }
        } finally {
            syncing = transmitting = false;
            refresh();
        }
        if (sent) {
            const text = sent === 1 ? "1 Erfassung übertragen." : sent + " Erfassungen übertragen.";
            // neu laden zeigt den aktuellen Stand - nicht, wenn dabei etwas verloren ginge
            if (canReload()) {
                sessionStorage.setItem("offline-flash", text);
                reloading = true;
                location.reload();
            } else {
                say(text);
            }
        }
    }

    function resume() {                           // wartende Entwürfe senden, dann einen unterbrochenen Vorrat fortsetzen
        if (needLogin || reloading) { return; }
        sync().then(() => { if (stockIncomplete() && !stockState.limit && !reloading) { whenControlled(() => stock()); } });
    }

    function replay(d) {
        return new Promise(resolve => {
            const frame = document.createElement("iframe");
            let done = false, submitted = false, loadedAt = 0, sending = d, timer = 0;
            const finish = (status, info = "") => {
                if (done) { return; }
                done = true;
                clearTimeout(timer);
                frame.remove();
                resolve({ status, info, resend: !!sending.resend });
            };
            timer = setTimeout(() => finish("wartet", "Keine Antwort vom Server"), 60000);   // Seite lädt nicht
            const poll = () => {
                if (done) { return; }
                let w;
                try { w = frame.contentWindow; w.document.title; } catch (e) { return finish("fehler", "Seite nicht erreichbar"); }
                if (!w.offlineReady) {            // Fehlerseite ohne APEX: nach 15 s aufgeben
                    return loadedAt && Date.now() - loadedAt > 15000
                        ? finish("fehler", "Seite nicht aufrufbar (" + (w.document.title || "Fehler") + ")")
                        : setTimeout(poll, 200);
                }
                if (w.offlineReady === "copy") { return finish("wartet", "Server antwortet nicht"); }
                if (String(w.apex.env.APP_PAGE_ID) !== d.page) {
                    return w.document.querySelector("input[type=password]")
                        ? finish("wartet", "Anmeldung erforderlich")
                        : finish("fehler", "Seite nicht aufrufbar (" + w.document.title + ")");
                }
                // "sendet" erst unmittelbar vor dem Absenden: nur dieser Moment macht den Ausgang unklar.
                // Die aktuelle Seite entscheidet, ob sie doppelt Gesendetes erkennt (auch für ältere Entwürfe).
                sending = { ...d, status: "sendet", resend: !!d.resend || w.document.body.classList.contains("offline-queue") };
                return settle(d, { status: "sendet", resend: sending.resend }).then(current => {
                    if (!current) { return finish("neu"); }
                    if (done) { return; }
                    clearTimeout(timer);          // ab jetzt zählt die Zeit fürs Absenden, je nach Datenmenge
                    timer = setTimeout(() => finish(unsure(sending), "Keine Antwort vom Server"), allowance(JSON.stringify(d.items).length));
                    submitted = submitIn(w, sending, finish);
                });
            };
            frame.name = "offline-sync";
            frame.style.display = "none";
            frame.addEventListener("load", () => { loadedAt = Date.now(); });
            frame.src = liveUrl(d.url);
            document.body.append(frame);
            setTimeout(poll, 200);
        });
    }

    function submitIn(w, d, finish) {
        const a = w.apex;
        const result = applyDraft(w, d, true);
        if (result.conflicts.length) {
            finish("konflikt", "Auf dem Server inzwischen geändert: " + labels(result.conflicts.map(c => c[0]), w.document));
        } else if (!w.document.getElementById("wwvFlowForm") || (result.lost.length && result.lost.length === Object.keys(d.items).length)) {
            // APEX-Fehlerseite statt Formular, z. B. Prüfsummenfehler
            finish("fehler", "Seite nicht aufrufbar: " + w.document.body.innerText.trim().slice(0, 150));
        } else if (result.lost.length) {
            finish("fehler", "Nicht übernommen: " + labels(result.lost, w.document));
        } else if (result.already) {
            finish("ok");
        } else {
            // Ergebnis abfangen: Erfolg = Weiterleitung, Fehler = Meldungen, Status 0/502-504 = Server weg.
            // APEX meldet auch Übertragungsfehler über showErrors - daher erst nach ajaxComplete entscheiden.
            a.navigation.redirect = url => finish("ok", url);
            a.message.showErrors = errors => {
                const text = [].concat(errors).map(e => a.util.stripHTML(String(e.message || e))).join(" ");
                setTimeout(() => finish("fehler", text));
            };
            a.jQuery(w.document).on("ajaxComplete", (event, xhr) => {
                if (unreachable(xhr)) { finish(unsure(d), "Server nicht erreichbar (" + xhr.status + ")"); }
            });
            a.page.submit({ request: d.request, reloadOnSubmit: "S" });
            return true;
        }
        return false;
    }

    /* ---------- Erreichbarkeit: navigator.onLine erkennt keinen VPN-Ausfall, daher kurz nachfragen ---------- */

    async function check() {
        let ok = navigator.onLine;
        if (ok) {
            try {
                await fetch(env.APEX_FILES + "apex_version.txt", {
                    method: "HEAD", cache: "no-store", signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
                });
            } catch (e) {
                ok = false;
            }
        }
        if (ok !== online) {
            online = ok;
            refresh();
            // Verbindung zurück auf einer gespeicherten Fassung: aktuellen Stand laden - bei Seiten nur für online
            // immer, sonst nur, wenn dabei nichts verloren geht (nie auf Erfassungsseiten, z. B. mitten im Foto)
            if (ok && IS_COPY && (document.body.classList.contains("online-only") || (!isForm() && canReload()))) {
                reloading = true;
                location.reload();
                return ok;
            }
            if (ok) { resume(); }
        }
        return ok;
    }

    /* ---------- Anzeige: Verbindungsstatus, offene Entwürfe, Markierung in Listen ---------- */

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "offline-status";
    pill.addEventListener("click", openPanel);

    async function refresh() {
        document.documentElement.classList.toggle("offline-mode", !online);   // für Seiten mit online-only
        const list = await allDrafts();
        const keys = new Set(list.filter(d => !d.create).map(d => d.key));
        const parts = [online ? "Online" : "Offline"];
        if (IS_COPY) { parts.push(COPY_AT ? "Stand " + when(COPY_AT) : "gespeicherte Seite"); }
        if (list.length) { parts.push(list.length + " offen"); }
        if (online && transmitting) { parts.push("sendet"); } else if (online && stocking) { parts.push("lädt"); }
        const warn = (stockIncomplete() && !stocking) || (online && needLogin);
        if (stockIncomplete() && !stocking) { parts.push(stockState.limit ? "Vorrat begrenzt" : "Vorrat unvollständig"); }
        if (online && needLogin) { parts.push("Anmeldung nötig"); }
        pill.classList.toggle("is-offline", !online);
        pill.classList.toggle("has-drafts", list.length > 0);
        pill.classList.toggle("has-warning", warn);
        pill.textContent = parts.join(" · ");
        pill.title = pill.textContent;
        document.querySelectorAll("a[href]").forEach(a => {
            let key = null;
            try { key = pageKey(a.href); } catch (e) { /* kein Seitenlink */ }
            a.classList.toggle("offline-pending", keys.has(key));
        });
        showDrafts(list);
    }

    async function openPanel() {
        const list = await allDrafts();
        const esc = apex.util.escapeHTML;
        const stored = (await (await caches.open(CACHE)).keys()).filter(r => r.url.startsWith(location.origin + BASE)).length;
        const dialog = document.createElement("dialog");
        dialog.className = "offline-panel";
        dialog.innerHTML = "<h2>Offline erfasst</h2>"
            + `<p class="offline-stock">Offline verfügbar: ${stored} Seiten`
            + (stockState && stockState.at ? `, vollständig geladen ${when(stockState.at)}` : "")
            + (stockState && stockState.dropped ? `, ${stockState.dropped} nicht abrufbar` : "")
            + (stocking ? " (wird geladen …)" : !stockIncomplete() ? ""
                : stockState.limit ? " – Grenze von " + STOCK_LIMIT + " Seiten erreicht" : " – Vorrat unvollständig, wird fortgesetzt")
            + (!IS_COPY && online && !stocking ? ' <button type="button" class="t-Button t-Button--small" data-act="restock">Vorrat neu laden</button>' : "")
            + "</p>"
            + (online && needLogin ? '<p class="offline-login">Die Sitzung ist abgelaufen. '
                + '<button type="button" class="t-Button t-Button--hot t-Button--small" data-act="login">Anmelden und übertragen</button></p>' : "")
            + (list.length ? "<ul>" + list.map(d =>
                `<li data-id="${esc(d.id)}"><img class="offline-thumb" alt="" hidden><strong>${esc(d.title)}</strong> <small>${new Date(d.ts).toLocaleString()}</small>`
                + `<div class="is-${esc(d.status)}">${esc(d.status)}${d.info ? ": " + esc(d.info) : ""}`
                + (d.status === "unklar" ? " - bitte prüfen, ob er schon angelegt ist" : "") + "</div>"
                + '<button type="button" class="t-Button t-Button--small" data-act="open">Öffnen</button> '
                + '<button type="button" class="t-Button t-Button--small t-Button--danger" data-act="drop">Verwerfen</button></li>').join("") + "</ul>"
              : "<p>Keine offenen Erfassungen.</p>")
            + '<p><button type="button" class="t-Button t-Button--hot" data-act="sync">Jetzt übertragen</button> '
            + '<button type="button" class="t-Button" data-act="close">Schließen</button></p>';
        dialog.querySelectorAll("li[data-id]").forEach(li => {
            const src = picture(list.find(x => x.id === li.dataset.id));
            if (src) { const img = li.querySelector(".offline-thumb"); img.src = src; img.hidden = false; }
        });
        dialog.addEventListener("click", async event => {
            const act = (event.target.closest("[data-act]") || { dataset: {} }).dataset.act;
            const d = list.find(x => x.id === (event.target.closest("li") || { dataset: {} }).dataset.id);
            if (act === "login") {                // APEX zeigt die Anmeldung und kehrt danach hierher zurück
                location.href = liveUrl(location.href);
            }
            if (act === "open") {
                const url = liveUrl(d.url) + "#offline-draft=" + encodeURIComponent(d.id);
                location.href = url;
                if (location.href === url) { location.reload(); }   // gleiche Seite: nur der Anker hat sich geändert
            }
            if (act === "drop") {                 // erst schließen: der modale Dialog würde die Rückfrage verdecken
                dialog.close();
                apex.message.confirm("Diese Erfassung verwerfen? Die Eingaben gehen verloren.", async ok => {
                    if (ok) { await deleteDraft(d.id); refresh(); }
                });
            }
            if (act === "sync") {                 // Fehler und Konflikte erneut versuchen, "unklar" nie automatisch
                dialog.close();
                await Promise.all(list.filter(x => x.status === "fehler" || x.status === "konflikt")
                    .map(x => putDraft({ ...x, status: "wartet", info: "" })));
                needLogin = false;
                if (await check()) { sync(); } else { say("Server nicht erreichbar."); }
            }
            if (act === "restock") {              // alles neu vom Server, z. B. nach Änderungen der Disposition
                dialog.close();
                if (await check()) { whenControlled(() => stock(true)); } else { say("Server nicht erreichbar."); }
            }
            if (act === "close") { dialog.close(); }
        });
        dialog.addEventListener("close", () => dialog.remove());
        document.body.append(dialog);
        dialog.showModal();
    }

    /* ---------- 3a. Unterschrift: CSS-Klasse offline-signature an einer Textarea ---------- */

    function signaturePad(node) {
        const input = node.matches("textarea, input") ? node : node.querySelector("textarea, input");
        if (!input || !input.id) { return; }
        const box = document.createElement("div");
        box.className = "offline-signature-pad";
        box.innerHTML = '<canvas width="600" height="200"></canvas>'
            + '<button type="button" class="t-Button t-Button--small">Unterschrift löschen</button>';
        input.style.display = "none";
        input.after(box);
        const canvas = box.firstChild, ctx = canvas.getContext("2d");
        let last = null, own = false;
        const blank = () => { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); };
        const show = value => {
            blank();
            if (/^data:image\//.test(value || "")) {
                const img = new Image();
                img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                img.src = value;
            }
        };
        const save = value => { own = true; apex.item(input.id).setValue(value); own = false; };
        const point = ev => {
            const r = canvas.getBoundingClientRect();
            return [(ev.clientX - r.left) * canvas.width / r.width, (ev.clientY - r.top) * canvas.height / r.height];
        };
        canvas.addEventListener("pointerdown", ev => { last = point(ev); canvas.setPointerCapture(ev.pointerId); });
        canvas.addEventListener("pointermove", ev => {
            if (!last) { return; }
            const p = point(ev);
            ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.strokeStyle = "#000";
            ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke();
            last = p;
        });
        canvas.addEventListener("pointerup", () => {
            if (!last) { return; }
            last = null;
            save(canvas.toDataURL("image/png"));
        });
        box.lastChild.addEventListener("click", () => { blank(); save(""); });
        $(input).on("change", () => { if (!own) { show(input.value); } });
        show(input.value);
    }

    /* ---------- 3b. Foto: CSS-Klasse offline-photo an einer Textarea ----------
     * Kamera oder Galerie; das Bild wird im Browser auf höchstens 1600 Pixel verkleinert und als JPEG-Data-URL
     * zum Wert des Items (Session State CLOB). APEX überträgt auch Werte mit mehreren 100 000 Zeichen; die Seite
     * speichert sie per Prozess als Bild (Beispiel: pck_oe_auftrag_foto_dml). */

    const PHOTO_MAX = 1600, PHOTO_QUALITY = 0.8;

    function photoField(node) {
        const input = node.matches("textarea, input") ? node : node.querySelector("textarea, input");
        if (!input || !input.id) { return; }
        const box = document.createElement("div");
        box.className = "offline-photo-box";
        box.innerHTML = '<img alt="Foto" hidden>'
            + '<label class="t-Button t-Button--iconLeft"><span class="t-Icon t-Icon--left fa fa-camera" aria-hidden="true"></span>'
            + '<span class="t-Button-label">Foto aufnehmen oder auswählen</span><input type="file" accept="image/*" hidden></label>';
        input.style.display = "none";
        input.after(box);
        const img = box.querySelector("img"), file = box.querySelector("input");
        let own = false;
        const show = value => {
            img.hidden = !/^data:image\//.test(value || "");
            if (!img.hidden) { img.src = value; }
        };
        file.addEventListener("click", () => { pickedAt = Date.now(); });   // Kamera offen: nicht neu laden
        file.addEventListener("change", async () => {   // das Datei-Feld hat keinen Namen: APEX überträgt es nie selbst
            pickedAt = Date.now();
            const chosen = file.files[0];
            file.value = "";
            if (!chosen) { return; }
            try {
                const url = await shrink(chosen);
                own = true; apex.item(input.id).setValue(url); own = false;
                show(url);
            } catch (e) {
                apex.message.alert("Das Bild konnte nicht gelesen werden.");
            }
        });
        $(input).on("change", () => { if (!own) { show(input.value); } });
        show(input.value);
    }

    async function shrink(blob) {                 // längste Seite höchstens PHOTO_MAX Pixel, JPEG
        const source = new Image();
        source.src = URL.createObjectURL(blob);
        try { await source.decode(); } finally { URL.revokeObjectURL(source.src); }
        const scale = Math.min(1, PHOTO_MAX / Math.max(source.naturalWidth, source.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(source.naturalWidth * scale);
        canvas.height = Math.round(source.naturalHeight * scale);
        canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", PHOTO_QUALITY);
    }

    /* ---------- 3c. Barcode/QR: CSS-Klasse offline-scan an einem Textfeld ---------- */

    function scanButton(node) {
        const input = node.matches("input") ? node : node.querySelector("input");
        if (!input || !input.id || !navigator.mediaDevices) { return; }
        const button = document.createElement("button");
        button.type = "button";
        button.className = "t-Button t-Button--icon offline-scan-button";
        button.title = "Scannen";
        button.innerHTML = '<span class="fa fa-barcode" aria-hidden="true"></span>';
        input.after(button);
        button.addEventListener("click", () => (pickedAt = Date.now(), scan()).then(
            value => { if (value) { apex.item(input.id).setValue(value); } },
            e => apex.message.alert(e && e.name === "NotAllowedError" ? "Kein Zugriff auf die Kamera." : "Scannen nicht möglich: " + e.message)
        ));
    }

    async function detector() {
        if (!window.BarcodeDetector) {            // iOS, Windows, Firefox: mitgelieferter Decoder
            const mod = await import(VENDOR + "ponyfill.js");
            mod.setZXingModuleOverrides({ locateFile: file => VENDOR + file }); // WebAssembly aus den App-Dateien, nie vom CDN
            window.BarcodeDetector = mod.BarcodeDetector;
        }
        return new window.BarcodeDetector();
    }

    async function scan() {
        const reader = await detector();
        const overlay = document.createElement("div");
        overlay.className = "offline-scan-overlay";
        overlay.innerHTML = '<video playsinline muted></video><button type="button" class="t-Button">Abbrechen</button>';
        document.body.append(overlay);
        const video = overlay.firstChild;
        let stream = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
            video.srcObject = stream;
            await video.play();
            return await new Promise(resolve => {
                overlay.lastChild.addEventListener("click", () => resolve(null));
                (async function look() {
                    if (!overlay.isConnected) { return; }
                    const codes = await reader.detect(video).catch(() => []);
                    if (codes.length) { resolve(codes[0].rawValue); } else { requestAnimationFrame(look); }
                })();
            });
        } finally {
            if (stream) { stream.getTracks().forEach(t => t.stop()); }
            overlay.remove();
        }
    }

    /* ---------- 3d. Offline-Vorrat: alle offline benötigten Seiten im Hintergrund laden ----------
     * Je Sitzung: alle Seiten des Navigationsmenüs und von dort aus (auch mehrstufig) alle Ziele von Links und
     * Buttons in Regionen mit der CSS-Klasse offline-prefetch - z. B. jeder Auftrag der Liste und die Seite
     * hinter "Neuer Auftrag". Der Service Worker speichert jede geladene Seite. Ein unterbrochener Vorrat merkt
     * sich, wo er stand, und macht dort weiter; Seiten, die nicht kamen, versucht er erneut. */

    function isLogin(res, html, href) {           // gleiche Regel in offline-sw.js
        return html.includes('type="password"') && (html.includes("t-PageBody--login")
            || (res.redirected && new URL(res.url).pathname !== new URL(href).pathname));
    }

    function targetsIn(roots, doc) {              // Ziele der Links und Buttons in diesen Elementen
        const urls = roots.flatMap(r => [...r.querySelectorAll("a[href]")].map(a => a.getAttribute("href")));
        const scripts = [...doc.querySelectorAll("script:not([src])")].map(s => s.textContent).join("\n");
        roots.forEach(r => r.querySelectorAll("button[id]").forEach(b => {
            // APEX bindet das Ziel eines Buttons per Skript: apex.jQuery("#B123").on("click", ... redirect('...'))
            const m = scripts.match(new RegExp('"#' + b.id + '"[^]{0,120}?navigation\\.redirect\\(\'([^\']+)\''));
            if (m) { try { urls.push(JSON.parse('"' + m[1] + '"')); } catch (e) { /* anderes Format: überspringen */ } }
        }));
        return urls;
    }
    const targets = doc => targetsIn([...doc.querySelectorAll(".offline-prefetch")], doc);   // für den Vorrat

    async function stock(fresh) {                 // fresh: alles neu laden ("Vorrat neu laden")
        if (stocking || needLogin || IS_COPY || env.APP_USER === "nobody") { return; }
        stocking = true;
        refresh();
        const key = "offline-stock:" + env.APP_SESSION;           // Stand des Vorrats in dieser Sitzung
        let saved = {};
        try { saved = fresh ? {} : JSON.parse(sessionStorage.getItem(key) || "{}"); } catch (e) { saved = {}; }
        if (Array.isArray(saved)) { saved = { seen: saved }; }    // Format bis 1.8
        const seen = new Set(saved.seen || []);
        if (CONTROLLED && !fresh) { seen.add(pageKey(location.href)); }   // diese Seite hat der Service Worker schon gespeichert
        const queue = [...(saved.rest || []), location.href, ...[...document.querySelectorAll("#t_TreeNav a[href], .t-Header-nav a[href]")]
            .map(a => a.getAttribute("href")), ...targets(document)];
        const failed = new Set();                 // in diesem Durchlauf nicht gekommen: beim nächsten Mal erneut
        const tries = saved.tries || {};          // Fehlversuche je Seite in dieser Sitzung
        const dropped = new Set(saved.dropped || []);   // nach 3 Fehlversuchen: nicht abrufbar, kein weiterer Versuch
        const fail = href => {
            tries[href] = (tries[href] || 0) + 1;
            if (tries[href] >= 3) { dropped.add(href); } else { failed.add(href); }
        };
        let decoder = !!saved.decoder || !!document.querySelector(".offline-scan");
        let decoderOk = !!saved.decoderOk;        // Decoder in dieser Sitzung schon geholt
        let stopped = false, limit = false;
        const keep = () => {
            try { sessionStorage.setItem(key, JSON.stringify({ seen: [...seen], rest: [...failed, ...queue], decoder, decoderOk, tries, dropped: [...dropped] })); } catch (e) { /* voll: weiter ohne */ }
        };
        while (queue.length) {
            let url;
            try { url = new URL(queue[0], document.baseURI); } catch (e) { queue.shift(); continue; }
            // nur Seiten dieser App (keine Downloads wie apex_util.get_blob - Bilder vom Server lädt der Vorrat nie)
            // und nie Links mit Request (die könnten auf der Zielseite etwas auslösen)
            if (!url.href.startsWith(location.origin + BASE) || url.pathname.slice(BASE.length).includes(".")
                || url.searchParams.has("request")
                || seen.has(pageKey(url.href)) || failed.has(url.href) || dropped.has(url.href)) { queue.shift(); continue; }
            if (seen.size >= STOCK_LIMIT) { limit = true; break; }
            let res, html;
            try {
                res = await fetch(url.href, { headers: { "x-offline-prefetch": "1" }, signal: AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined });
                html = await res.text();
            } catch (e) {
                if (leaving) { break; }           // Seite gewechselt: der nächste Aufruf macht hier weiter
                // nur diese Seite zu langsam oder fehlerhaft: später erneut; Verbindung weg: hier später weitermachen
                if ((e && e.name === "TimeoutError") || await check()) { queue.shift(); fail(url.href); keep(); continue; }
                stopped = true;
                break;
            }
            if (isLogin(res, html, url.href)) { needLogin = true; stopped = true; break; }   // Sitzung abgelaufen
            queue.shift();
            if (!res.ok || !html.includes('id="wwvFlowForm"')) { fail(url.href); keep(); continue; }   // Fehlerseite
            seen.add(pageKey(url.href));
            decoder = decoder || html.includes("offline-scan");
            queue.push(...targets(new DOMParser().parseFromString(html, "text/html")));
            keep();
        }
        if (decoder && !decoderOk && !window.BarcodeDetector && !stopped && !leaving) {   // Barcode-Decoder für offline (iPhone, Windows, Firefox)
            decoderOk = (await Promise.all(["ponyfill.js", "zxing-exported.js", "zxing_reader.wasm"]
                .map(f => fetch(VENDOR + f).then(r => r.ok, () => false)))).every(Boolean);
        }
        if (leaving) { stocking = false; return; }   // kein Ergebnis melden: die Seite ist weg
        keep();
        const complete = !stopped && !limit && !failed.size && (decoderOk || !decoder || !!window.BarcodeDetector);
        stockState = { at: complete ? Date.now() : (stockState && stockState.at) || 0, complete, limit, dropped: dropped.size };
        try { localStorage.setItem(STOCK_LAST, JSON.stringify(stockState)); } catch (e) { /* ohne Anzeige weiter */ }
        stocking = false;
        refresh();
    }

    /* ---------- 3e. Offene Neuanlagen am Ort: Region mit der CSS-Klasse offline-drafts ----------
     * Zeigt die noch nicht übertragenen Neuanlagen der Seiten, auf die Links und Buttons der Region zeigen - am
     * Auftrag also die Fotos hinter "Foto hinzufügen", in der Liste die offline angelegten Aufträge. Sie liegen
     * ohnehin auf dem Gerät; nichts davon kommt vom Server. */

    const STATES = { wartet: "noch nicht übertragen", sendet: "wird übertragen", fehler: "abgelehnt", konflikt: "Konflikt", unklar: "unklar" };
    let shown = "";                               // zuletzt gezeigter Stand, damit nichts unnötig neu gezeichnet wird
    let pictureUrls = [];

    function blobUrl(dataUrl) {                   // Foto als Blob-Adresse statt als langer Data-URL-Text im DOM
        const comma = dataUrl.indexOf(",");
        const bytes = Uint8Array.from(atob(dataUrl.slice(comma + 1)), c => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: dataUrl.slice(5, dataUrl.indexOf(";")) }));
        pictureUrls.push(url);
        return url;
    }

    function showDrafts(list) {
        const regions = [...document.querySelectorAll(".offline-drafts")];
        const state = list.filter(d => d.create).map(d => d.id + d.status + d.ts).join();
        if (!regions.length || state === shown) { return; }
        shown = state;
        pictureUrls.forEach(u => URL.revokeObjectURL(u));
        pictureUrls = [];
        regions.forEach(region => {
            const keys = new Set(targetsIn([region], document).map(h => { try { return pageKey(h); } catch (e) { return ""; } }));
            const mine = list.filter(d => d.create && keys.has(d.key));
            const body = region.querySelector(".t-Region-body") || region;
            let box = [...body.children].find(e => e.classList.contains("offline-drafts-list"));
            if (!mine.length) { if (box) { box.remove(); } return; }
            if (!box) { box = document.createElement("ul"); box.className = "offline-drafts-list"; body.prepend(box); }
            box.replaceChildren(...mine.map(d => {
                const li = document.createElement("li");
                const src = picture(d);
                if (src) {
                    const img = document.createElement("img");
                    img.alt = d.title;
                    try { img.src = blobUrl(src); } catch (e) { img.src = src; }
                    li.append(img);
                }
                const title = document.createElement("span");
                title.textContent = d.title;
                const status = document.createElement("small");
                status.className = "is-" + d.status;
                status.textContent = STATES[d.status] || d.status;
                li.append(title, status);
                return li;
            }));
        });
    }

    /* ---------- 3f. Bilder groß ansehen: Region mit der CSS-Klasse offline-lightbox (und offene Fotos) ---------- */

    document.addEventListener("click", event => {
        const img = event.target.closest && event.target.closest(".offline-lightbox img, .offline-drafts-list img");
        if (!img || img.hidden || !img.naturalWidth) { return; }
        event.preventDefault();
        const viewer = document.createElement("dialog");
        viewer.className = "offline-viewer";
        const big = document.createElement("img");
        big.src = img.currentSrc || img.src;
        big.alt = img.alt;
        const caption = document.createElement("p");
        caption.textContent = ((img.closest("tr, li") || {}).innerText || img.alt || "").replace(/\s+/g, " ").trim();
        const close = document.createElement("button");
        close.type = "button";
        close.className = "t-Button t-Button--small";
        close.textContent = "Schließen";
        viewer.append(big, caption, close);
        viewer.addEventListener("click", () => viewer.close());   // Klick irgendwo schließt
        viewer.addEventListener("close", () => viewer.remove());
        document.body.append(viewer);
        viewer.showModal();
    });

    /* ---------- 3g. Bild nicht verfügbar: offline oder auf einer gespeicherten Seite Hinweis statt kaputtem Bild ---------- */

    function unavailable(img) {
        if ((online && !IS_COPY) || img.dataset.offlineMissing || /^(blob|data):/.test(img.getAttribute("src") || "")) { return; }
        img.dataset.offlineMissing = "1";
        img.hidden = true;
        const note = document.createElement("span");
        note.className = "offline-missing";
        note.textContent = "Bild nur online";
        img.after(note);
    }
    document.addEventListener("error", event => { if (event.target instanceof HTMLImageElement) { unavailable(event.target); } }, true);

    function whenControlled(fn) {                 // erst wenn der Service Worker die Seite kontrolliert, speichert er mit
        if (!navigator.serviceWorker) { return; }
        if (navigator.serviceWorker.controller) { fn(); } else { navigator.serviceWorker.addEventListener("controllerchange", () => fn(), { once: true }); }
    }

    /* ---------- Start ---------- */

    function flash() {
        const text = sessionStorage.getItem("offline-flash");
        if (text) { sessionStorage.removeItem("offline-flash"); say(text); }
    }

    $(document).one("apexreadyend", async () => {
        if (IS_COPY) { apex.message.hidePageSuccess(); }   // Erfolgsmeldung der gespeicherten Fassung ist veraltet
        $(document).on("apexbeforepagesubmit", onBeforeSubmit);   // nach den Dynamic Actions binden, sonst setzen sie das Abbrechen zurück
        document.querySelectorAll(".offline-signature").forEach(signaturePad);
        document.querySelectorAll(".offline-photo").forEach(photoField);
        document.querySelectorAll(".offline-scan").forEach(scanButton);
        document.querySelectorAll("img[src]").forEach(img => { if (img.complete && !img.naturalWidth) { unavailable(img); } });
        const done = sessionStorage.getItem("offline-done");
        if (done) { sessionStorage.removeItem("offline-done"); await deleteDraft(done); }
        if (isForm()) {
            snapshot = readItems();
            await restore();
        }
        flash();
        if (IN_FRAME) { return; }
        // Anderer Benutzer auf diesem Gerät: gespeicherte Seiten des Vorgängers verwerfen
        if (!IS_COPY && env.APP_USER !== "nobody") {
            const userKey = "offline-user-" + env.APP_ID;
            if (localStorage.getItem(userKey) && localStorage.getItem(userKey) !== env.APP_USER) {
                caches.delete(CACHE);
                localStorage.removeItem(STOCK_LAST);
                stockState = null;
            }
            localStorage.setItem(userKey, env.APP_USER);
        }
        const navBar = document.querySelector(".t-NavigationBar");   // Kopfleiste neben dem Benutzer
        if (navBar) {
            const entry = document.createElement("li");
            entry.className = "t-NavigationBar-item offline-status-item";
            entry.append(pill);
            navBar.prepend(entry);
        } else {
            document.body.append(pill);           // Seite ohne Navigationsleiste: unten links
        }
        if (document.body.classList.contains("online-only")) {   // Hinweis, der ohne Verbindung den Inhalt ersetzt
            const notice = document.createElement("div");
            notice.className = "online-only-notice";
            notice.innerHTML = "<h2>Nur online verfügbar</h2><p>Diese Seite braucht eine Verbindung zum Server. "
                + "Alle offline verfügbaren Seiten sind weiter über das Menü erreichbar.</p>"
                + '<button type="button" class="t-Button">Erneut versuchen</button>';
            notice.querySelector("button").addEventListener("click", () => location.reload());
            (document.getElementById("main") || document.body).prepend(notice);
        }
        await refresh();
        if (await check()) {
            if (IS_COPY && (document.body.classList.contains("online-only") || (!isForm() && canReload()))) {
                const retry = "offline-retry:" + pageKey(location.href);
                if (Date.now() - Number(sessionStorage.getItem(retry) || 0) > 60000) {
                    sessionStorage.setItem(retry, String(Date.now()));
                    reloading = true;
                    location.reload();
                    return;
                }
            }
            const again = sessionStorage.getItem("offline-refetch");   // online gespeichert: neuen Stand speichern
            if (again && !IS_COPY) {
                sessionStorage.removeItem("offline-refetch");
                whenControlled(() => fetch(liveUrl(again), { headers: { "x-offline-prefetch": "1" } }).catch(() => {}));
            }
            await sync();                         // erst Offline-Erfasstes übertragen, dann den Vorrat auffrischen
            whenControlled(() => stock());
        }
    });

    if (!IN_FRAME) {
        const again = () => check().then(ok => { if (ok) { resume(); } });
        window.addEventListener("online", check);
        window.addEventListener("offline", check);
        window.addEventListener("offline-drafts", again);        // Dialog hat einen Entwurf gespeichert
        document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { again(); } });
        // Zurück aus dem Back/Forward-Cache (z. B. nach dem Speichern): apexreadyend läuft dann nicht
        window.addEventListener("pageshow", event => { if (event.persisted) { flash(); refresh(); again(); } });
        setInterval(async () => {
            if (document.visibilityState !== "visible" || !(await check()) || syncing || stocking || needLogin || Date.now() < nextTry) { return; }
            const waiting = (await allDrafts()).some(d => d.status === "wartet");
            if (waiting || (stockIncomplete() && !stockState.limit && !IS_COPY)) { nextTry = Date.now() + 120000; resume(); }   // höchstens alle 2 Minuten
        }, 30000);
    }
})(window.apex, window.apex && window.apex.jQuery);
