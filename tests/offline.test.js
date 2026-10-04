/*
 * Browsertest der Offline-Erfassung gegen eine laufende Instanz (Playwright, Chromium).
 *
 *   OE_URL=https://host:8443/ords/r/hr_dev/erfassung OE_USER=... OE_PASSWORD=... npm test
 *
 * Ablauf wie im Außendienst: online anmelden und die Liste öffnen, Verbindung trennen, Aufträge
 * bearbeiten, unterschreiben, neuen Auftrag anlegen, wieder verbinden - dann prüfen, dass alles
 * über die normalen APEX-Seiten auf dem Server angekommen ist. Dazu Konflikt und abgelaufene Sitzung.
 */
const { chromium } = require("playwright");

const URL_ = (process.env.OE_URL || "").replace(/\/$/, "");
const USER = process.env.OE_USER, PASSWORD = process.env.OE_PASSWORD;
if (!URL_ || !USER || !PASSWORD) { console.error("OE_URL, OE_USER und OE_PASSWORD setzen."); process.exit(2); }

const RUN = "T" + Date.now().toString(36);                 // Kennung dieses Laufs in den Testdaten
const OFFICE = "Büro <b>" + RUN + "</b>";                     // Büro-Wert mit HTML: muss überall als Text erscheinen
let failed = 0;
function check(ok, text) { console.log((ok ? "  [OK]   " : "  [FEHLER] ") + text); if (!ok) { failed++; } }

async function login(page) {
    await page.goto(URL_ + "/auftraege");
    if (await page.locator("#P9999_USERNAME").count()) { await fillLogin(page); }
    await page.waitForSelector(".offline-status");
}
async function fillLogin(page) {                    // APEX-Anmeldeseite; danach zurück zur aufgerufenen Seite
    await page.waitForSelector("#P9999_USERNAME");
    await page.fill("#P9999_USERNAME", USER);
    await page.fill("#P9999_PASSWORD", PASSWORD);
    await Promise.all([page.waitForURL(url => !/\/login/.test(String(url))), page.getByRole("button", { name: "Anmelden" }).click()]);
    await page.waitForSelector(".offline-status");
}
const settled = text => !/sendet|lädt/.test(text);   // Übertragung und Vorrat sind durch

const pill = page => page.locator(".offline-status").innerText();
// Ohne ?session= schickt APEX zur Anmeldung (Rejoin Sessions ist auf der Instanz nicht aktiv)
async function sessionOf(page) {                    // lädt die Seite gerade neu (z. B. nach dem Übertragen): abwarten
    for (let i = 0; ; i++) {
        try { await page.waitForLoadState("load"); return await page.evaluate(() => apex.env.APP_SESSION); } catch (e) {
            if (i >= 20) { throw e; }
            await new Promise(r => setTimeout(r, 500));
        }
    }
}
const gotoList = async page => page.goto(URL_ + "/auftraege?session=" + await sessionOf(page));
async function openOrder(page, nr) {
    await Promise.all([page.waitForURL(/auftrag\?/), page.locator("td a", { hasText: nr }).first().click()]);
    await page.waitForSelector(".offline-signature-pad canvas");
}
async function sign(page) {
    const box = await page.locator(".offline-signature-pad canvas").boundingBox();
    await page.mouse.move(box.x + 30, box.y + box.height * 0.7);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) { await page.mouse.move(box.x + 30 + i * 18, box.y + box.height * (0.7 - 0.4 * Math.sin(i / 3))); }
    await page.mouse.up();
}
async function drafts(page) {                   // Entwürfe dieses Benutzers aus IndexedDB (Diagnose)
    return page.evaluate(async () => {
        const db = await new Promise(r => { const o = indexedDB.open("offline-" + apex.env.APP_ID); o.onsuccess = () => r(o.result); });
        const all = await new Promise(r => { const q = db.transaction("drafts").objectStore("drafts").getAll(); q.onsuccess = () => r(q.result); });
        return all.map(d => d.title + " " + d.request + ": " + d.status + (d.info ? " (" + d.info + ")" : "")
            + (window.oeDebug ? " " + JSON.stringify(Object.fromEntries(Object.entries(d.items).map(([k, v]) => [k, [String(v.old).slice(0, 20), String(v.val).slice(0, 20)]]))) : "")).join("; ");
    }).catch(e => "?" + e.message);
}
const IS_COPY_PAGE = html => html.includes('name="offline-copy"');
const cachedOf = page => page.evaluate(async () => {         // Adressen der gespeicherten Seiten
    const name = (await caches.keys()).find(n => n.startsWith("offline-pages:"));
    return name ? (await (await caches.open(name)).keys()).map(r => r.url) : [];
}).catch(() => []);
async function waitFor(fn, ms = 30000, what = "Bedingung") {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) { return true; } await new Promise(r => setTimeout(r, 500)); }
    throw new Error("Zeitüberschreitung: " + what);
}
async function serverValues(page, nr) {             // Werte so, wie das Protokoll (Seite 3) sie vom Server zeigt
    await gotoList(page);
    await Promise.all([page.waitForURL(/protokoll/), page.locator("tr", { hasText: nr }).first().getByRole("link", { name: "Protokoll" }).click()]);
    return page.evaluate(async () => {
        const text = id => document.getElementById(id + "_DISPLAY").innerText.trim();
        const fotos = [];
        for (const row of document.querySelectorAll(".oe-fotos tbody tr")) {
            const img = row.querySelector("img"), note = row.querySelector('td[headers="BEMERKUNG"]');
            if (!note) { continue; }
            if (img) { await img.decode().catch(() => {}); }   // kaputtes Bild: Breite 0, Prüfung schlägt fehl
            fotos.push({ text: (img ? "[Bild " + img.naturalWidth + "] " : "") + note.innerText.trim(), src: img ? img.src : "" });
        }
        return {
            status: text("P3_STATUS"), befund: text("P3_BEFUND"), messwert: text("P3_MESSWERT"), asset: text("P3_ASSET_CODE"),
            signer: text("P3_UNTERZEICHNER"), erledigt: text("P3_ERLEDIGT_AM"), fotos,
            signature: (document.querySelector("#P3_UNTERSCHRIFT_DISPLAY img") || {}).src || ""
        };
    });
}
const bytesOf = (page, src) => page.evaluate(async url => (await (await fetch(url)).arrayBuffer()).byteLength, src);
const photoBytes = page => page.evaluate(() => atob(apex.item("P4_FOTO").getValue().split(",")[1]).length);

(async () => {
    const camera = require("path").join(__dirname, "fixtures", "barcode.mjpeg");   // simulierte Kamera zeigt einen EAN-13
    const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors",
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-file-for-fake-video-capture=" + camera] });
    const field = await browser.newContext({ ignoreHTTPSErrors: true, locale: "de-DE", permissions: ["camera"] });   // Techniker
    const office = await browser.newContext({ ignoreHTTPSErrors: true, locale: "de-DE" });  // Büro, immer online
    const page = await field.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("dialog", d => d.accept());
    if (process.env.OE_DEBUG) { field.on("response", r => { if (r.status() >= 300 && r.status() < 400) { console.log("           " + r.status() + " " + r.url().replace(URL_, "") + " -> " + (r.headers().location || "")); } }); }
    if (process.env.OE_DEBUG) { page.on("framenavigated", f => { if (f !== page.mainFrame()) { console.log("           iframe: " + f.url().replace(URL_, "")); } }); }

    try {
        console.log("0. APEX-Interna, auf die offline.js sich verlässt (README: Woran die Schicht in APEX hängt)");
        await login(page);                                          // erster Aufruf überhaupt, nichts weiter öffnen
        const internals = await page.evaluate(async () => {
            const missing = [];
            const need = (ok, what) => { if (!ok) { missing.push(what); } };
            need(typeof apex.page.forEachPageItem === "function", "apex.page.forEachPageItem");
            need("gCancelFlag" in apex.event, "apex.event.gCancelFlag");
            need(typeof apex.navigation.redirect === "function", "apex.navigation.redirect");
            need(typeof apex.message.showErrors === "function", "apex.message.showErrors");
            need(!!document.getElementById("wwvFlowForm"), "#wwvFlowForm");
            need(!!document.getElementById("pReloadOnSubmit"), "#pReloadOnSubmit");
            need(!!document.querySelector(".t-NavigationBar"), "Universal Theme .t-NavigationBar");
            const sw = await navigator.serviceWorker.ready;
            const source = await (await fetch(sw.active.scriptURL)).text();
            const hook = source.indexOf("offline-sw.js"), listener = source.search(/addEventListener\(\s*["']fetch/);
            need(hook >= 0 && listener > hook, "sw.js lädt den Hook vor dem eigenen fetch-Listener");
            need(/FUNCTION_VARIABLE_DECLARATION/.test(source) && /cleanAppCaches/.test(source), "sw.js: Hook FUNCTION_VARIABLE_DECLARATION, apex.sw.cleanAppCaches");
            return missing;
        });
        check(internals.length === 0, "APEX-Interna vorhanden" + (internals.length ? " – geändert: " + internals.join(", ") : ""));

        console.log("1. Online nur anmelden: der Offline-Vorrat lädt alle Seiten im Hintergrund");
        const orders = await page.locator(".offline-prefetch td a", { hasText: /^A-\d+|^T/ }).count();
        const cachedPages = () => cachedOf(page);
        const complete = list => list.some(u => /\/auftraege$/.test(u)) && list.some(u => /\/auftrag\?p2_id=$/.test(u))
            && list.filter(u => /\/auftrag\?p2_id=\d/.test(u)).length >= orders && list.filter(u => /\/protokoll\?p3_id=\d/.test(u)).length >= orders
            && list.filter(u => /\/foto\?/.test(u)).length >= orders;
        await waitFor(async () => complete(await cachedPages()) && !/lädt/.test(await pill(page)), 60000, "Offline-Vorrat").catch(() => false);
        const cached = await cachedPages();
        check(await page.evaluate(() => !!navigator.serviceWorker.controller), "Seite wird vom Service Worker kontrolliert");
        check(complete(cached), `Vorrat ohne einen Klick: Liste, Anlegeseite, je ${orders} Aufträge, Protokolle und Foto-Seiten (`
            + cached.filter(u => u.startsWith(URL_)).length + " Seiten)");
        await page.locator(".offline-status").click();
        const stockLine = await page.locator(".offline-panel .offline-stock").innerText();
        await page.locator(".offline-panel [data-act=close]").click();
        check(!/unvollständig/.test(await pill(page)) && /vollständig geladen/.test(stockLine), "Vorrat als vollständig gemeldet: " + stockLine);

        console.log("1b. Vorrat unterbrochen: Verbindung weg mitten im Laden, danach ohne Klick vervollständigt");
        const cutCtx = await browser.newContext({ ignoreHTTPSErrors: true, locale: "de-DE" });
        const cut = await cutCtx.newPage();
        cut.on("pageerror", e => errors.push(e.message));
        cut.on("dialog", d => d.accept());
        await login(cut);
        let interrupted = false;
        for (let attempt = 0; attempt < 3 && !interrupted; attempt++) {
            if (attempt > 0) {                                      // war schon fertig: neu laden lassen und dabei trennen
                await waitFor(async () => { const t = await pill(cut).catch(() => ""); return /^Online/.test(t) && settled(t); }, 30000, "wieder online");
                await cut.locator(".offline-status").click();
                await cut.locator(".offline-panel [data-act=restock]").click();
            }
            await waitFor(async () => /lädt/.test(await pill(cut).catch(() => "")), 20000, "Vorrat lädt").catch(() => {});
            await cutCtx.setOffline(true);
            await cut.evaluate(() => window.dispatchEvent(new Event("offline")));
            interrupted = await waitFor(async () => /unvollständig/.test(await pill(cut).catch(() => "")), 15000, "unvollständig").catch(() => false);
            if (!interrupted) { await cutCtx.setOffline(false); await cut.evaluate(() => window.dispatchEvent(new Event("online"))); }
        }
        check(interrupted, "Verbindung weg mitten im Vorrat, Anzeige: " + await pill(cut));
        await cutCtx.setOffline(false);
        await cut.evaluate(() => window.dispatchEvent(new Event("online")));
        await waitFor(async () => { const t = await pill(cut).catch(() => "lädt"); return !/unvollständig|lädt/.test(t) && complete(await cachedOf(cut)); }, 60000, "Vorrat fortgesetzt").catch(() => {});
        check(complete(await cachedOf(cut)) && !/unvollständig/.test(await pill(cut)), "Vorrat nach der Unterbrechung selbstständig vervollständigt");
        await cut.locator(".offline-status").click();
        await cut.locator(".offline-panel [data-act=restock]").click();
        await waitFor(async () => /lädt/.test(await pill(cut).catch(() => "")), 10000, "neu laden").catch(() => {});
        await waitFor(async () => !/lädt|unvollständig/.test(await pill(cut).catch(() => "lädt")), 60000, "neu geladen");
        check(true, "„Vorrat neu laden“ lädt alles erneut, Anzeige: " + await pill(cut));
        await cutCtx.close();

        console.log("2. Offline: Liste und nie geöffneter Auftrag kommen aus dem Cache");
        await field.setOffline(true);
        await page.reload();
        await page.waitForSelector(".offline-status");
        check(await page.locator('meta[name="offline-copy"]').count() === 1, "Liste offline aus dem Cache");
        await waitFor(async () => /Offline/.test(await pill(page)), 10000, "Anzeige Offline");
        check(/^Offline · Stand \d\d:\d\d$/.test(await pill(page)), "Statusanzeige mit Stand der gespeicherten Fassung: " + await pill(page));
        const prefetchOffline = await page.evaluate(() => fetch(location.href, { headers: { "x-offline-prefetch": "1" } }).then(() => "geliefert", () => "abgelehnt"));
        check(prefetchOffline === "abgelehnt", "Vorrat bekommt offline keine gespeicherte Fassung untergeschoben");
        await openOrder(page, "A-1001");
        check(await page.inputValue("#P2_TITEL") === "Wartung Heizungsanlage", "Auftrag A-1001 offline geöffnet (vorab geladen)");

        console.log("3. Offline erfassen: Status, Befund, Messwert, Scan-Feld, Unterschrift");
        await page.selectOption("#P2_STATUS", "ERLEDIGT");
        await page.fill("#P2_BEFUND", "Filter getauscht " + RUN);
        await page.fill("#P2_MESSWERT", "150");                     // Regel am Item: 30 bis 90
        await page.getByRole("button", { name: "Speichern" }).click();
        await page.waitForSelector("#P2_MESSWERT_error:has-text('zwischen 30 und 90')");
        check(/auftrag\?/.test(page.url()) && !/offen/.test(await pill(page)), "Messwert 150 offline abgelehnt: "
            + await page.locator("#P2_MESSWERT_error").innerText());
        await page.fill("#P2_MESSWERT", "42,5");
        await page.fill("#P2_ASSET_CODE", "ANL-" + RUN);
        await page.fill("#P2_UNTERZEICHNER", "Erika Muster");
        await sign(page);
        check((await page.inputValue("#P2_UNTERSCHRIFT")).startsWith("data:image/"), "Unterschrift als Bild im Item");
        await Promise.all([page.waitForURL(/auftraege/), page.getByRole("button", { name: "Speichern" }).click()]);
        await waitFor(async () => /1 offen/.test(await pill(page)), 10000, "1 offen");
        check(/1 offen/.test(await pill(page)), "Entwurf gespeichert, Anzeige: " + await pill(page));
        check(await page.locator("a.offline-pending", { hasText: "A-1001" }).count() === 1, "A-1001 in der Liste markiert");

        await openOrder(page, "A-1001");
        check(await page.inputValue("#P2_BEFUND") === "Filter getauscht " + RUN, "Entwurf beim erneuten Öffnen eingesetzt");
        await page.goBack();

        console.log("4. Offline neuen Auftrag anlegen");
        await Promise.all([page.waitForURL(/auftrag/), page.getByRole("button", { name: "Neuer Auftrag" }).click()]);
        await page.waitForSelector("#P2_NR");
        await page.fill("#P2_NR", RUN);
        await page.fill("#P2_TITEL", "Offline angelegt " + RUN);
        await Promise.all([page.waitForURL(/auftraege/), page.getByRole("button", { name: "Anlegen" }).click()]);
        await waitFor(async () => /2 offen/.test(await pill(page)), 10000, "2 offen");
        check(/2 offen/.test(await pill(page)), "Neuanlage gespeichert, Anzeige: " + await pill(page));

        console.log("5. Konflikt vorbereiten: offline A-1002 ändern, im Büro gleichzeitig dasselbe Feld");
        await openOrder(page, "A-1002");
        await page.fill("#P2_BEFUND", "Techniker " + RUN);
        await Promise.all([page.waitForURL(/auftraege/), page.getByRole("button", { name: "Speichern" }).click()]);
        const desk = await office.newPage();
        await login(desk);
        await openOrder(desk, "A-1002");
        await desk.fill("#P2_BEFUND", OFFICE);
        await Promise.all([desk.waitForURL(/auftraege/), desk.getByRole("button", { name: "Speichern" }).click()]);

        if (process.env.OE_DEBUG) { await page.evaluate(() => { window.oeDebug = true; }); console.log("           Entwürfe: " + await drafts(page)); }
        console.log("6. Wieder online: automatische Übertragung durch die APEX-Seiten");
        await field.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await waitFor(async () => { const t = await pill(page).catch(() => "sendet"); return /1 offen/.test(t) && settled(t); }, 60000, "Übertragung");
        check(/1 offen/.test(await pill(page)), "zwei übertragen, einer offen (Konflikt): " + await pill(page));
        const a = await serverValues(desk, "A-1001");
        check(a.status === "Erledigt" && a.befund === "Filter getauscht " + RUN, "A-1001 auf dem Server: " + a.status + " / " + a.befund);
        check(/42[,.]5/.test(a.messwert) && a.asset === "ANL-" + RUN && a.signer === "Erika Muster", "Messwert, Anlage, Unterzeichner übertragen");
        check(a.signature.startsWith("data:image/"), "Unterschrift im Protokoll als Bild");
        check(a.erledigt === "", "nicht bearbeitetes Feld unverändert (Erledigt am: '" + a.erledigt + "')");
        await gotoList(desk);
        check(await desk.locator("td", { hasText: "Offline angelegt " + RUN }).count() === 1, "offline angelegter Auftrag genau einmal vorhanden");
        const b = await serverValues(desk, "A-1002");
        check(b.befund === OFFICE, "Konflikt: Büro-Wert nicht überschrieben");

        console.log("7. Konflikt lösen: Entwurf öffnen, Werte prüfen, speichern");
        await page.locator(".offline-status").click();
        const state = await page.locator(".offline-panel li").innerText();
        check(/konflikt/.test(state), "Liste zeigt Konflikt: " + state.replace(/\s+/g, " "));
        await Promise.all([page.waitForURL(/auftrag/), page.locator(".offline-panel [data-act=open]").click()]);
        await page.waitForSelector("#P2_BEFUND_error");
        check((await page.locator("#P2_BEFUND_error").innerText()).includes("Auf dem Server inzwischen: " + OFFICE)
            && await page.locator("#P2_BEFUND_error b").count() === 0, "Konflikt am Feld mit Server-Wert angezeigt (HTML als Text)");
        check(await page.inputValue("#P2_BEFUND") === "Techniker " + RUN, "Offline-Wert eingesetzt");
        await Promise.all([page.waitForURL(/auftraege/), page.getByRole("button", { name: "Speichern" }).click()]);
        await waitFor(async () => (await pill(page)).trim() === "Online", 15000, "keine offenen Entwürfe");
        check((await pill(page)).trim() === "Online", "nach dem Speichern keine Entwürfe mehr");

        console.log("8. Sitzung abgelaufen: offline erfassen, neu anmelden, dann Übertragung");
        await field.setOffline(true);
        await page.reload();
        await openOrder(page, "A-1003");
        await page.fill("#P2_BEFUND", "Nach Anmeldung " + RUN);
        await Promise.all([page.waitForURL(/auftraege/), page.getByRole("button", { name: "Speichern" }).click()]);
        await Promise.all([page.waitForURL(/auftrag/), page.getByRole("button", { name: "Neuer Auftrag" }).click()]);
        await page.waitForSelector("#P2_NR");
        await page.fill("#P2_NR", RUN + "B");
        await page.fill("#P2_TITEL", "Nach Anmeldung angelegt " + RUN);
        await Promise.all([page.waitForURL(/auftraege/), page.getByRole("button", { name: "Anlegen" }).click()]);
        await waitFor(async () => /2 offen/.test(await pill(page)), 10000, "2 offen");
        await openOrder(page, "A-1004");                            // Erfassungsseite: lädt bei Verbindung nicht selbst neu
        await field.clearCookies();                                 // Sitzung weg
        await field.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await waitFor(async () => /Anmeldung nötig/.test(await pill(page).catch(() => "")), 30000, "Hinweis Anmeldung");
        check(/Anmeldung erforderlich/.test(await drafts(page)), "Übertragung wartet auf Anmeldung, Anzeige: " + await pill(page));
        await page.locator(".offline-status").click();
        await page.locator(".offline-panel [data-act=login]").click();
        await fillLogin(page);
        await waitFor(async () => (await pill(page)).trim() === "Online", 60000, "Übertragung nach Anmeldung");
        const c = await serverValues(desk, "A-1003");
        check(c.befund === "Nach Anmeldung " + RUN, "Änderung nach neuer Anmeldung übertragen (Prüfsumme je Benutzer)");
        await gotoList(desk);
        check(await desk.locator("td", { hasText: "Nach Anmeldung angelegt " + RUN }).count() === 1, "Neuanlage nach neuer Anmeldung genau einmal übertragen");

        console.log("9. Offline scannen: nur die Liste online geöffnet, simulierte Kamera, Decoder aus den App-Dateien");
        const scanCtx = await browser.newContext({ ignoreHTTPSErrors: true, locale: "de-DE", permissions: ["camera"] });
        const scanner = await scanCtx.newPage();
        scanner.on("pageerror", e => errors.push(e.message));
        await login(scanner);
        await scanner.reload();                                     // vom Service Worker kontrolliert: Vorab-Laden läuft
        await scanner.waitForSelector(".offline-status");
        await waitFor(() => scanner.evaluate(async () => {
            const hit = await caches.match(document.querySelector("script[src*='offline.js']").src.replace(/offline\.js.*$/, "vendor/barcode-detector/zxing_reader.wasm"));
            const pages = await (await caches.open((await caches.keys()).find(n => n.startsWith("offline-pages:")))).keys();
            return !!hit && pages.filter(r => /auftrag\?p2_id=\d/.test(r.url)).length >= 5;
        }), 30000, "Vorab-Laden mit Decoder");
        await scanCtx.setOffline(true);
        await scanner.reload();
        await openOrder(scanner, "A-1004");                         // nie online geöffnet
        const foreign = [];
        scanCtx.on("request", r => { if (!r.url().startsWith(new URL(URL_).origin)) { foreign.push(r.url()); } });
        await scanner.click(".offline-scan-button");
        await waitFor(async () => await scanner.inputValue("#P2_ASSET_CODE") === "4006381333931", 30000, "Scan");
        check(true, "Barcode offline gelesen: " + await scanner.inputValue("#P2_ASSET_CODE"));
        check(foreign.length === 0, "keine Anfrage an fremde Server" + (foreign.length ? ": " + foreign.join(", ") : ""));

        console.log("10. Entwurf verwerfen");
        await gotoList(page);                                       // Schritt 8 endet auf einem Auftrag
        await field.setOffline(true);
        await page.reload();
        await openOrder(page, "A-1005");
        await page.fill("#P2_BEFUND", "Wird verworfen " + RUN);
        await Promise.all([page.waitForURL(/auftraege/), page.getByRole("button", { name: "Speichern" }).click()]);
        await waitFor(async () => /1 offen/.test(await pill(page)), 10000, "1 offen");
        await page.locator(".offline-status").click();
        await page.locator(".offline-panel [data-act=drop]").click();
        await page.locator(".ui-dialog").getByRole("button", { name: "OK" }).click();
        await waitFor(async () => /^Offline · Stand [^·]+$/.test((await pill(page)).trim()), 10000, "keine Entwürfe");
        check(true, "Entwurf nach Rückfrage verworfen");
        console.log("10b. Verbindung zurück auf der gespeicherten Liste: lädt den aktuellen Stand von selbst");
        await field.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await waitFor(async () => !IS_COPY_PAGE(await page.content().catch(() => 'name="offline-copy"')), 20000, "Liste neu geladen").catch(() => {});
        check(!IS_COPY_PAGE(await page.content()) && /^Online/.test(await pill(page)), "gespeicherte Liste durch die aktuelle ersetzt");

        console.log("11. Fotos am eigenen Testauftrag: offline aufnehmen, doppelt senden, beschädigtes Foto");
        await gotoList(page);                                       // online: Liste mit dem Testauftrag
        const runId = new URL(await page.locator("td a", { hasText: RUN }).first().getAttribute("href"), URL_).searchParams.get("p2_id");
        await waitFor(async () => { const c = await cachedPages(); return c.some(u => u.includes("p2_id=" + runId)) && c.some(u => u.includes("p4_auftrag_id=" + runId)); },
            30000, "Testauftrag und seine Foto-Seite im Vorrat");
        await field.setOffline(true);
        await page.reload();
        await openOrder(page, RUN);
        await Promise.all([page.waitForURL(/foto\?/), page.getByRole("button", { name: "Foto hinzufügen" }).click()]);
        await page.setInputFiles(".offline-photo-box input[type=file]", require("path").join(__dirname, "fixtures", "foto.jpg"));
        await waitFor(async () => (await page.inputValue("#P4_FOTO")).startsWith("data:image/jpeg"), 10000, "Foto verkleinert");
        const photo = await page.evaluate(async () => {
            const img = document.querySelector(".offline-photo-box img");
            await img.decode();
            return { w: img.naturalWidth, h: img.naturalHeight, kb: Math.round(apex.item("P4_FOTO").getValue().length / 1024) };
        });
        check(photo.w === 1600 && photo.h === 1200, `Foto im Browser verkleinert: 2400×1800 → ${photo.w}×${photo.h} (${photo.kb} KB)`);
        const expected = await photoBytes(page);
        const corrupt = await page.evaluate(() => apex.item("P4_FOTO").getValue().replace("data:image/jpeg", "data:image/png"));
        await page.fill("#P4_BEMERKUNG", "Typenschild " + RUN);
        await Promise.all([page.waitForURL(/auftrag\?/), page.getByRole("button", { name: "Speichern" }).click()]);
        await waitFor(async () => /1 offen/.test(await pill(page)), 10000, "1 offen");
        check(true, "Foto offline gespeichert, Anzeige: " + await pill(page));
        await page.evaluate(async () => {                           // derselbe Entwurf ein zweites Mal (wie nach abgebrochenem Senden)
            const db = await new Promise(r => { const o = indexedDB.open("offline-" + apex.env.APP_ID); o.onsuccess = () => r(o.result); });
            const all = await new Promise(r => { const q = db.transaction("drafts").objectStore("drafts").getAll(); q.onsuccess = () => r(q.result); });
            const d = all.find(x => x.page === "4");
            await new Promise(r => { const t = db.transaction("drafts", "readwrite"); t.objectStore("drafts").put({ ...d, id: d.id + "-kopie", ts: d.ts + 1 }); t.oncomplete = r; });
        });
        await Promise.all([page.waitForURL(/foto\?/), page.getByRole("button", { name: "Foto hinzufügen" }).click()]);
        await page.evaluate(value => apex.item("P4_FOTO").setValue(value), corrupt);   // PNG-Kopf über JPEG-Bytes
        await page.fill("#P4_BEMERKUNG", "Beschädigt " + RUN);
        await Promise.all([page.waitForURL(/auftrag\?/), page.getByRole("button", { name: "Speichern" }).click()]);
        await waitFor(async () => /3 offen/.test(await pill(page)), 10000, "3 offen");
        const savedDraft = await page.evaluate(async note => {     // für 11e: Entwurf, wie er auf dem Gerät lag
            const db = await new Promise(r => { const o = indexedDB.open("offline-" + apex.env.APP_ID); o.onsuccess = () => r(o.result); });
            const all = await new Promise(r => { const q = db.transaction("drafts").objectStore("drafts").getAll(); q.onsuccess = () => r(q.result); });
            return all.find(x => x.page === "4" && x.items.P4_BEMERKUNG && x.items.P4_BEMERKUNG.val === note && !/-kopie$/.test(x.id));
        }, "Typenschild " + RUN);
        check(!!savedDraft && savedDraft.resend === true, "Foto-Entwurf der Seite mit offline-queue darf erneut gesendet werden");
        await field.setOffline(false);                              // ohne "online"-Ereignis: die regelmäßige Prüfung merkt es
        await waitFor(async () => { const t = await pill(page).catch(() => "sendet"); return /1 offen/.test(t) && settled(t); }, 120000, "Übertragung Fotos");
        const withPhoto = await serverValues(desk, RUN);
        const typenschild = withPhoto.fotos.filter(f => f.text.endsWith("Typenschild " + RUN));
        check(typenschild.length === 1 && typenschild[0].text.startsWith("[Bild 1600]"),
            "Foto genau einmal im Protokoll, obwohl zweimal gesendet: " + withPhoto.fotos.map(f => f.text).join(" | "));
        const stored = typenschild.length ? await bytesOf(desk, typenschild[0].src) : 0;
        check(stored === expected, `Bild vollständig gespeichert: ${stored} von ${expected} Bytes`);
        await page.locator(".offline-status").click();
        const broken = await page.locator(".offline-panel li", { hasText: "Beschädigt " + RUN }).innerText().catch(() => "");
        check(/fehler/.test(broken) && /Das Foto ist beschädigt/.test(broken) && !/ORA-/.test(broken),
            "beschädigtes Foto abgelehnt, lesbare Meldung: " + broken.replace(/\s+/g, " "));
        await page.locator(".offline-panel li", { hasText: "Beschädigt " + RUN }).locator("[data-act=drop]").click();
        await page.locator(".ui-dialog").getByRole("button", { name: "OK" }).click();
        await waitFor(async () => !/offen/.test(await pill(page)), 10000, "keine Entwürfe");
        await gotoList(page);
        await openOrder(page, RUN);
        const listed = await page.locator(".oe-fotos").innerText();
        check(listed.includes("Typenschild " + RUN) && !(await page.content()).includes("data:image/jpeg"),
            "Foto am Auftrag als Liste, ohne Bilddaten in der Seite");

        console.log("11c. Großes Foto online (gut 1 MB als Data-URL): Grenze für Formular-POSTs");
        await Promise.all([page.waitForURL(/foto\?/), page.getByRole("button", { name: "Foto hinzufügen" }).click()]);
        const big = await page.evaluate(() => {
            const canvas = document.createElement("canvas");
            canvas.width = 1600; canvas.height = 1200;
            const ctx = canvas.getContext("2d"), data = ctx.createImageData(1600, 1200);
            for (let i = 0; i < data.data.length; i++) { data.data[i] = (i % 4 === 3) ? 255 : Math.random() * 256; }   // Rauschen: kaum komprimierbar
            ctx.putImageData(data, 0, 0);
            let url = "";
            for (let q = 0.95; q > 0.1; q -= 0.05) { url = canvas.toDataURL("image/jpeg", q); if (url.length < 1500000) { break; } }
            apex.item("P4_FOTO").setValue(url);
            return { chars: url.length, bytes: atob(url.split(",")[1]).length };
        });
        await page.fill("#P4_BEMERKUNG", "Groß " + RUN);
        const started = Date.now();
        await Promise.all([page.waitForURL(/auftrag\?/, { timeout: 10000 }), page.getByRole("button", { name: "Speichern" }).click()]);
        await page.waitForSelector("text=im Hintergrund übertragen", { timeout: 5000 }).catch(() => {});
        check(Date.now() - started < 10000, `online gespeichert und sofort zurück (${Date.now() - started} ms), Übertragung im Hintergrund`);
        await waitFor(async () => { const t = await pill(page).catch(() => "offen"); return !/offen/.test(t) && settled(t); }, 180000, "Übertragung großes Foto");
        const withBig = await serverValues(desk, RUN);
        const large = withBig.fotos.find(f => f.text.endsWith("Groß " + RUN));
        const largeBytes = large ? await bytesOf(desk, large.src) : 0;
        check(!!large && largeBytes === big.bytes, `großes Foto gespeichert: ${Math.round(big.chars / 1024)} KB Data-URL, ${largeBytes} von ${big.bytes} Bytes`);

        console.log("11e. Abgebrochenes Senden und alter unklar-Entwurf: erneut gesendet, trotzdem nur einmal gespeichert");
        const putBack = d => page.evaluate(async draft => {
            const db = await new Promise(r => { const o = indexedDB.open("offline-" + apex.env.APP_ID); o.onsuccess = () => r(o.result); });
            await new Promise(r => { const t = db.transaction("drafts", "readwrite"); t.objectStore("drafts").put(draft); t.oncomplete = r; });
        }, d);
        await gotoList(page);
        await openOrder(page, RUN);
        await putBack({ ...savedDraft, status: "sendet" });         // App mitten im Senden geschlossen
        await page.reload();
        await page.waitForSelector(".offline-status");
        await waitFor(async () => { const t = await pill(page).catch(() => "offen"); return !/offen/.test(t) && settled(t); }, 90000, "erneutes Senden");
        await putBack({ ...savedDraft, id: savedDraft.id + "-alt", status: "unklar", resend: false });   // Stand vor 1.8.0
        await page.reload();
        await page.waitForSelector(".offline-status");
        await page.locator(".offline-status").click();
        check(/unklar/.test(await page.locator(".offline-panel").innerText()), "alter Foto-Entwurf steht auf unklar");
        await Promise.all([page.waitForURL(/foto\?/), page.locator(".offline-panel li", { hasText: "unklar" }).locator("[data-act=open]").click()]);
        await waitFor(async () => (await page.inputValue("#P4_FOTO")).startsWith("data:image/jpeg"), 10000, "Entwurf eingesetzt");
        await Promise.all([page.waitForURL(/auftrag\?/), page.getByRole("button", { name: "Speichern" }).click()]);
        await waitFor(async () => { const t = await pill(page).catch(() => "offen"); return !/offen/.test(t) && settled(t); }, 90000, "unklar-Entwurf übertragen");
        const again = (await serverValues(desk, RUN)).fotos.filter(f => f.text.endsWith("Typenschild " + RUN));
        check(again.length === 1, "nach zweimal erneutem Senden weiterhin genau ein Foto „Typenschild“");

        console.log("12. Seite nur online (Auswertung): ohne Verbindung Hinweis statt Inhalt");
        const report = () => page.getByRole("heading", { name: "Aufträge je Status" });
        const notice = () => page.locator(".online-only-notice");
        await page.goto(URL_ + "/auswertung?session=" + await sessionOf(page));
        await page.waitForSelector(".offline-status");
        check(await report().isVisible() && await notice().isHidden(), "online: Auswertung sichtbar");
        await field.setOffline(true);
        await page.evaluate(() => window.dispatchEvent(new Event("offline")));
        await waitFor(() => notice().isVisible(), 10000, "Hinweis bei Verbindungsverlust");
        check(await report().isHidden(), "Verbindung weg: Hinweis „" + (await notice().locator("h2").innerText()) + "“ statt Inhalt");
        await page.reload();
        await page.waitForSelector(".offline-status");
        check(await notice().isVisible() && await report().isHidden(), "offline aufgerufen: Hinweis statt gespeicherter Zahlen");
        await field.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await waitFor(async () => await report().isVisible().catch(() => false) && !IS_COPY_PAGE(await page.content()), 20000, "Seite neu geladen");
        check(await notice().isHidden(), "wieder online: aktuelle Auswertung ohne Hinweis");

        console.log("13. Online gespeichert, danach offline geöffnet: die gespeicherte Fassung zeigt den neuen Stand");
        await gotoList(page);
        await openOrder(page, "A-1004");
        await page.fill("#P2_BEFUND", "Online " + RUN);
        await Promise.all([page.waitForURL(/auftraege/), page.getByRole("button", { name: "Speichern" }).click()]);
        await waitFor(() => page.evaluate(async text => {
            const c = await caches.open((await caches.keys()).find(n => n.startsWith("offline-pages:")));
            for (const r of await c.keys()) { if (/auftrag\?p2_id=\d/.test(r.url) && (await (await c.match(r)).text()).includes(text)) { return true; } }
            return false;
        }, "Online " + RUN), 15000, "neue Fassung gespeichert").catch(() => {});
        await field.setOffline(true);
        await page.reload();
        await openOrder(page, "A-1004");
        check(await page.inputValue("#P2_BEFUND") === "Online " + RUN, "offline geöffnet: Stand nach dem Online-Speichern");
        await field.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event("online")));

        console.log("14. Aufräumen: Testaufträge samt Fotos im Büro löschen");
        for (const nr of [RUN + "B", RUN]) {
            await gotoList(desk);
            await openOrder(desk, nr);
            await desk.getByRole("button", { name: "Löschen", exact: true }).click();
            await Promise.all([desk.waitForURL(/auftraege/), desk.locator(".ui-dialog").getByRole("button", { name: "Löschen", exact: true }).click()]);
        }
        await gotoList(desk);
        check(await desk.locator("td", { hasText: RUN }).count() === 0, "Testaufträge gelöscht");

        check(errors.length === 0, "keine JavaScript-Fehler" + (errors.length ? ": " + errors.join(" | ") : ""));
    } catch (e) {
        check(false, "Abbruch: " + e.message);
        console.log("           Entwürfe: " + await drafts(page) + " | Seite: " + page.url().replace(URL_, ""));
        await page.screenshot({ path: "tests/.state/abbruch.png", fullPage: true }).catch(() => {});
    } finally {
        await browser.close();
    }
    console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen.` : "\nAlle Prüfungen bestanden.");
    process.exit(failed ? 1 : 0);
})();
