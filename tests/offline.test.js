/*
 * Browsertest der Offline-Erfassung gegen eine laufende Instanz (Playwright, Chromium).
 *
 *   OE_URL=https://host:8443/ords/r/hr_dev/erfassung OE_USER=... OE_PASSWORD=... \
 *   PLAYWRIGHT=<Pfad zu node_modules/playwright> node tests/offline.test.js
 *
 * Ablauf wie im Außendienst: online anmelden und die Liste öffnen, Verbindung trennen, Aufträge
 * bearbeiten, unterschreiben, neuen Auftrag anlegen, wieder verbinden - dann prüfen, dass alles
 * über die normalen APEX-Seiten auf dem Server angekommen ist. Dazu Konflikt und abgelaufene Sitzung.
 */
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");

const URL_ = (process.env.OE_URL || "").replace(/\/$/, "");
const USER = process.env.OE_USER, PASSWORD = process.env.OE_PASSWORD;
if (!URL_ || !USER || !PASSWORD) { console.error("OE_URL, OE_USER und OE_PASSWORD setzen."); process.exit(2); }

const RUN = "T" + Date.now().toString(36);                 // Kennung dieses Laufs in den Testdaten
const OFFICE = "Büro <b>" + RUN + "</b>";                     // Büro-Wert mit HTML: muss überall als Text erscheinen
let failed = 0;
function check(ok, text) { console.log((ok ? "  [OK]   " : "  [FEHLER] ") + text); if (!ok) { failed++; } }

async function login(page) {
    await page.goto(URL_ + "/auftraege");
    if (await page.locator("#P9999_USERNAME").count()) {
        await page.fill("#P9999_USERNAME", USER);
        await page.fill("#P9999_PASSWORD", PASSWORD);
        await Promise.all([page.waitForURL(/auftraege/), page.getByRole("button", { name: "Anmelden" }).click()]);
    }
    await page.waitForSelector(".offline-status");
}

const pill = page => page.locator(".offline-status").innerText();
// Ohne ?session= schickt APEX zur Anmeldung (Rejoin Sessions ist auf der Instanz nicht aktiv)
const gotoList = async page => page.goto(URL_ + "/auftraege?session=" + await page.evaluate(() => apex.env.APP_SESSION));
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
async function waitFor(fn, ms = 30000, what = "Bedingung") {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) { return true; } await new Promise(r => setTimeout(r, 500)); }
    throw new Error("Zeitüberschreitung: " + what);
}
async function serverValues(page, nr) {             // Werte so, wie das Protokoll (Seite 3) sie vom Server zeigt
    await gotoList(page);
    await Promise.all([page.waitForURL(/protokoll/), page.locator("tr", { hasText: nr }).getByRole("link", { name: "Protokoll" }).click()]);
    return page.evaluate(() => {
        const text = id => document.getElementById(id + "_DISPLAY").innerText.trim();
        return {
            status: text("P3_STATUS"), befund: text("P3_BEFUND"), messwert: text("P3_MESSWERT"), asset: text("P3_ASSET_CODE"),
            signer: text("P3_UNTERZEICHNER"), erledigt: text("P3_ERLEDIGT_AM"),
            signature: (document.querySelector("#P3_UNTERSCHRIFT_DISPLAY img") || {}).src || ""
        };
    });
}

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
        console.log("1. Online: anmelden, Liste öffnen (Service Worker, Vorab-Laden)");
        await login(page);
        await page.reload();                                        // jetzt vom Service Worker kontrolliert
        await page.waitForSelector(".offline-status");
        check(await page.evaluate(() => !!navigator.serviceWorker.controller), "Seite wird vom Service Worker kontrolliert");
        await Promise.all([page.waitForURL(/auftrag/), page.getByRole("button", { name: "Neuer Auftrag" }).click()]);
        await page.waitForSelector("#P2_NR");                       // Anlegeseite einmal online öffnen
        await gotoList(page);
        const cachedPages = () => page.evaluate(async () => {
            const name = (await caches.keys()).find(n => n.startsWith("offline-pages:"));
            return name ? (await (await caches.open(name)).keys()).map(r => r.url) : [];
        });
        await waitFor(async () => (await cachedPages()).filter(u => /\/auftrag\?p2_id=\d/.test(u)).length >= 5, 30000, "Vorab-Laden")
            .catch(() => false);                                    // Vorab-Laden der Auftragsseiten
        const cached = await cachedPages();
        check(cached.filter(u => /\/auftrag\?p2_id=\d/.test(u)).length >= 5 && cached.some(u => /\/auftraege$/.test(u)),
            "Liste und alle Auftragsseiten gespeichert: " + cached.map(u => u.replace(URL_, "")).join(" "));
        console.log("           aktuelle URL: " + page.url().replace(URL_, ""));

        console.log("2. Offline: Liste und nie geöffneter Auftrag kommen aus dem Cache");
        await field.setOffline(true);
        await page.reload();
        await page.waitForSelector(".offline-status");
        check(await page.locator('meta[name="offline-copy"]').count() === 1, "Liste offline aus dem Cache");
        await waitFor(async () => /Offline/.test(await pill(page)), 10000, "Anzeige Offline");
        check(/Offline/.test(await pill(page)), "Statusanzeige: " + await pill(page));
        await openOrder(page, "A-1001");
        check(await page.inputValue("#P2_TITEL") === "Wartung Heizungsanlage", "Auftrag A-1001 offline geöffnet (vorab geladen)");

        console.log("3. Offline erfassen: Status, Befund, Messwert, Scan-Feld, Unterschrift");
        await page.selectOption("#P2_STATUS", "ERLEDIGT");
        await page.fill("#P2_BEFUND", "Filter getauscht " + RUN);
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
        await waitFor(async () => /1 offen/.test(await pill(page).catch(() => "")), 60000, "Übertragung");
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
        await waitFor(async () => /Online$/.test((await pill(page)).trim()), 15000, "keine offenen Entwürfe");
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
        await field.clearCookies();                                 // Sitzung weg
        await field.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await waitFor(async () => /Anmeldung erforderlich/.test(await drafts(page)), 30000, "Hinweis Anmeldung");
        check(true, "Übertragung wartet auf Anmeldung");
        await login(page);
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
        await field.setOffline(true);
        await page.reload();
        await openOrder(page, "A-1005");
        await page.fill("#P2_BEFUND", "Wird verworfen " + RUN);
        await Promise.all([page.waitForURL(/auftraege/), page.getByRole("button", { name: "Speichern" }).click()]);
        await waitFor(async () => /1 offen/.test(await pill(page)), 10000, "1 offen");
        await page.locator(".offline-status").click();
        await page.locator(".offline-panel [data-act=drop]").click();
        await page.locator(".ui-dialog").getByRole("button", { name: "OK" }).click();
        await waitFor(async () => (await pill(page)).trim() === "Offline", 10000, "keine Entwürfe");
        check(true, "Entwurf nach Rückfrage verworfen");
        await field.setOffline(false);

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
