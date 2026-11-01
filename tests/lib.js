/*
 * Gemeinsame Hilfen der Browsertests (offline.test.js, mass.test.js): Anmelden, Seiten der Beispiel-App,
 * Entwürfe in IndexedDB, Werte vom Server. Verbindung und Zugang kommen aus OE_URL, OE_USER, OE_PASSWORD.
 */
const URL_ = (process.env.OE_URL || "").replace(/\/$/, "");
const USER = process.env.OE_USER, PASSWORD = process.env.OE_PASSWORD;
if (!URL_ || !USER || !PASSWORD) { console.error("OE_URL, OE_USER und OE_PASSWORD setzen."); process.exit(2); }

const state = { failed: 0, loginPill: 0 };   // loginPill: Anmeldeseiten mit Statusanzeige (soll 0 sein)
function check(ok, text) { console.log((ok ? "  [OK]   " : "  [FEHLER] ") + text); if (!ok) { state.failed++; } }

async function login(page) {
    await page.goto(URL_ + "/auftraege");
    if (await page.locator("#P9999_USERNAME").count()) {
        await page.waitForLoadState("load");
        await page.waitForTimeout(500);                             // offline.js fügt die Anzeige nach dem Laden ein
        if (await page.locator(".offline-status").count()) {                       // Anmeldeseite: keine Statusanzeige
            state.loginPill++;
            console.log("           Statusanzeige auf der Anmeldeseite: " + page.url().replace(URL_, "") + " „" + await page.locator(".offline-status").first().innerText().catch(() => "?") + "“");
        }
        await fillLogin(page);
    }
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
// Keine offenen Entwürfe mehr: Anzeige ohne "offen" und ruhig, und der Browser-Speicher ist wirklich leer - die Anzeige allein
// trügt kurz nach einem Neuladen (leer oder "Online", bevor die Seite ihre Entwürfe gelesen und gesendet hat)
const noneOpen = async pg => {
    const t = await pill(pg).catch(() => "offen");
    return !!t && !/offen/.test(t) && settled(t) && await drafts(pg) === "";
};

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
const rawDrafts = page => page.evaluate(async () => {            // alle Entwürfe mit Werten (Diagnose, Vorlage für putRaw)
    const db = await new Promise(r => { const o = indexedDB.open("offline-" + apex.env.APP_ID); o.onsuccess = () => r(o.result); });
    return new Promise(r => { const q = db.transaction("drafts").objectStore("drafts").getAll(); q.onsuccess = () => r(q.result); });
});
const putRaw = (pg, draft) => pg.evaluate(async d => {           // Entwurf samt Indexeintrag ablegen, wie offline.js es täte
    const db = await new Promise(r => { const o = indexedDB.open("offline-" + apex.env.APP_ID); o.onsuccess = () => r(o.result); });
    const { items, ...meta } = d;
    await new Promise(r => { const t = db.transaction(["drafts", "meta"], "readwrite"); t.objectStore("drafts").put(d); t.objectStore("meta").put({ ...meta, hasPicture: true }); t.oncomplete = r; });
}, draft);
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
// Testaufträge eines Laufs (Kennung im Auftragsnamen) im Büro löschen - auch nach einem Abbruch
async function sweep(context, run) {
    const sweeper = await context.newPage();
    sweeper.on("dialog", d => d.accept());
    await login(sweeper);
    for (let guard = 0; guard < 10; guard++) {
        await gotoList(sweeper);
        const link = sweeper.locator("td a", { hasText: run }).first();
        if (!await link.count()) { break; }
        await Promise.all([sweeper.waitForURL(/auftrag\?/), link.click()]);
        await sweeper.getByRole("button", { name: "Löschen", exact: true }).click();
        await Promise.all([sweeper.waitForURL(/auftraege/), sweeper.locator(".ui-dialog").getByRole("button", { name: "Löschen", exact: true }).click()]);
    }
    await sweeper.close();
}

module.exports = { URL_, USER, PASSWORD, state, check, login, fillLogin, settled, noneOpen, pill, sessionOf, gotoList, openOrder, sign,
    drafts, rawDrafts, putRaw, IS_COPY_PAGE, cachedOf, waitFor, serverValues, sweep };
