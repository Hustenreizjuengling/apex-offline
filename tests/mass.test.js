/*
 * Massentest: ein Arbeitstag mit vielen Entwürfen auf einmal übertragen (Playwright, Chromium).
 *
 *   OE_URL=... OE_USER=... OE_PASSWORD=... [OE_MASS=30] npm run test:mass
 *
 * Offline entstehen OE_MASS Fotos (je eigenes Bild, ~300 KB als Data-URL) an einem Testauftrag und eine Änderung
 * an jedem Beispielauftrag. Dann kommt die Verbindung zurück. Gemessen werden Gesamtdauer, Dauer je Entwurf
 * (Seite laden / absenden) und der Spitzen-Heap der Seite; geprüft wird, dass jedes Foto genau einmal und jede
 * Änderung auf dem Server ankommt und kein Entwurf übrig bleibt.
 */
const { chromium } = require("playwright");
const path = require("path");
const { URL_, state, check, login, pill, noneOpen, gotoList, openOrder, drafts, rawDrafts, putRaw, cachedOf, waitFor, serverValues, sweep } = require("./lib");

const N = Math.max(2, parseInt(process.env.OE_MASS || "30", 10));
const RUN = "T" + Date.now().toString(36) + "M";
const ORDERS = ["A-1001", "A-1002", "A-1003", "A-1004", "A-1005"];

(async () => {
    const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"] });
    const field = await browser.newContext({ ignoreHTTPSErrors: true, locale: "de-DE" });
    const office = await browser.newContext({ ignoreHTTPSErrors: true, locale: "de-DE" });
    const page = await field.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("dialog", d => d.accept());
    // Zeiten der Übertragungsseite: Start der Navigation und "bereit" (apexreadyend) je geladener Seite
    await page.addInitScript(() => {                               // offlineReady setzt offline.js dort bei apexreadyend
        if (window.name !== "offline-sync") { return; }
        const started = performance.timeOrigin;
        const timer = setInterval(() => {
            if (!window.offlineReady) { return; }
            clearInterval(timer);
            const all = JSON.parse(top.sessionStorage.getItem("oeTimes") || "[]");
            all.push({ url: location.pathname.replace(/.*\//, "") + location.search.slice(0, 20), started, ready: Date.now() });
            top.sessionStorage.setItem("oeTimes", JSON.stringify(all));
        }, 50);
    });

    try {
        console.log(`1. Vorbereitung: Testauftrag ${RUN} online anlegen, Vorrat abwarten`);
        await login(page);
        await Promise.all([page.waitForURL(/auftrag/), page.getByRole("link", { name: "Neuer Auftrag" }).click()]);
        await page.waitForSelector("#P2_NR");
        await page.fill("#P2_NR", RUN);
        await page.fill("#P2_TITEL", "Massentest " + RUN);
        await Promise.all([page.waitForURL(/auftraege/), page.getByRole("button", { name: "Anlegen" }).click()]);
        await waitFor(async () => !/offen|sendet/.test(await pill(page)), 60000, "Neuanlage übertragen");
        await gotoList(page);
        const runId = new URL(await page.locator("td a", { hasText: RUN }).first().getAttribute("href"), URL_).searchParams.get("p2_id");
        await waitFor(async () => { const c = await cachedOf(page); return c.some(u => u.includes("p4_auftrag_id=" + runId)) && ORDERS.every(nr => c.some(u => /auftrag\?p2_id=\d/.test(u))) && !/lädt/.test(await pill(page)); },
            90000, "Vorrat mit Foto-Seite des Testauftrags");
        check(true, "Testauftrag angelegt und im Vorrat (p2_id=" + runId + ")");

        console.log(`2. Offline: ein Foto aufnehmen, daraus ${N} verschiedene Fotos als Entwürfe; je eine Änderung an ${ORDERS.length} Aufträgen`);
        await field.setOffline(true);
        await page.reload();
        await openOrder(page, RUN);
        await Promise.all([page.waitForURL(/foto\?/), page.getByRole("link", { name: "Foto hinzufügen" }).click()]);
        await page.setInputFiles(".offline-photo-box input[type=file]", path.join(__dirname, "fixtures", "foto.jpg"));
        await waitFor(async () => (await page.inputValue("#P4_FOTO")).startsWith("data:image/jpeg"), 10000, "Foto verkleinert");
        await page.fill("#P4_BEMERKUNG", "Masse 1 " + RUN);
        await Promise.all([page.waitForURL(/auftrag\?/), page.getByRole("button", { name: "Speichern" }).click()]);
        await waitFor(async () => /1 offen/.test(await pill(page)), 10000, "1 offen");
        const template = (await rawDrafts(page)).find(d => d.page === "4");
        const sizeKb = Math.round(template.items.P4_FOTO.val.length / 1024);
        // jedes weitere Foto: dasselbe Bild mit einer anderen Beschriftung - andere Bytes, der Server legt es einzeln ab
        const variants = await page.evaluate(async ({ src, from, to, run }) => {
            const img = new Image(); img.src = src; await img.decode();
            const canvas = document.createElement("canvas"); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d"), out = [];
            for (let i = from; i <= to; i++) {
                ctx.drawImage(img, 0, 0);
                ctx.fillStyle = "#ff0"; ctx.font = "bold 120px sans-serif"; ctx.fillText(run + " #" + i, 60, 180);
                out.push(canvas.toDataURL("image/jpeg", 0.8));
            }
            return out;
        }, { src: template.items.P4_FOTO.val, from: 2, to: N, run: RUN });
        for (let i = 2; i <= N; i++) {
            const d = { ...template, id: template.id + "-" + i, ts: template.ts + i, items: { ...template.items,
                P4_FOTO: { ...template.items.P4_FOTO, val: variants[i - 2] }, P4_BEMERKUNG: { old: "", val: "Masse " + i + " " + RUN } } };
            await putRaw(page, d);
        }
        for (const nr of ORDERS) {
            await gotoList(page);
            await openOrder(page, nr);
            await page.fill("#P2_BEFUND", "Masse " + RUN + " " + nr);
            await Promise.all([page.waitForURL(/auftraege/), page.getByRole("button", { name: "Speichern" }).click()]);
        }
        await page.reload();
        await page.waitForSelector(".offline-status");
        const total = N + ORDERS.length;
        await waitFor(async () => new RegExp(total + " offen").test(await pill(page)), 10000, total + " offen");
        check(true, `${total} Entwürfe auf dem Gerät (${N} Fotos à ${sizeKb} KB, ${ORDERS.length} Änderungen): ${await pill(page)}`);

        console.log("3. Verbindung zurück: alles überträgt sich, gemessen");
        const cdp = await field.newCDPSession(page);
        await cdp.send("Performance.enable");
        let peakHeap = 0;
        const sampler = setInterval(async () => {
            try { const m = (await cdp.send("Performance.getMetrics")).metrics.find(x => x.name === "JSHeapUsedSize"); peakHeap = Math.max(peakHeap, m ? m.value : 0); } catch (e) { /* Seite lädt gerade neu */ }
        }, 1000);
        const started = Date.now();
        await field.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await waitFor(() => noneOpen(page), Math.max(300000, total * 15000), "Übertragung").catch(() => {});
        const seconds = (Date.now() - started) / 1000;
        clearInterval(sampler);
        const times = await page.evaluate(() => JSON.parse(sessionStorage.getItem("oeTimes") || "[]")).catch(() => []);
        const loads = times.map(t => t.ready - t.started).filter(ms => ms > 0 && ms < 120000);
        const gaps = times.slice(1).map((t, i) => t.started - times[i].ready).filter(ms => ms > 0 && ms < 120000);   // bereit bis nächste Seite: Absenden + Abschluss
        const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
        const left = await drafts(page);
        check(left === "", `alle Entwürfe übertragen in ${seconds.toFixed(0)} s (${(seconds / total).toFixed(1)} s je Entwurf)` + (left ? " – übrig: " + left : ""));
        console.log(`           Seiten im Rahmen: ${times.length}, laden ⌀ ${avg(loads)} ms, absenden+abschließen ⌀ ${avg(gaps)} ms, Spitzen-Heap ${(peakHeap / 1048576).toFixed(0)} MB`);
        check(peakHeap < 400 * 1048576, "Heap der Seite bleibt unter 400 MB");

        console.log("4. Server: jedes Foto genau einmal, jede Änderung angekommen");
        const desk = await office.newPage();
        desk.on("dialog", d => d.accept());
        await login(desk);
        const values = await serverValues(desk, RUN);
        const mine = values.fotos.filter(f => f.text.includes(RUN));
        const notes = new Set(mine.map(f => f.text.replace(/^\[Bild \d+\] /, "")));
        check(mine.length === N && notes.size === N && mine.every(f => f.text.startsWith("[Bild 1600]")), `${mine.length} von ${N} Fotos im Protokoll, ${notes.size} verschiedene Bemerkungen, alle 1600 px`);
        let changed = 0;
        for (const nr of ORDERS) { if ((await serverValues(desk, nr)).befund === "Masse " + RUN + " " + nr) { changed++; } }
        check(changed === ORDERS.length, `${changed} von ${ORDERS.length} Änderungen auf dem Server`);
        check(errors.length === 0, "keine JavaScript-Fehler" + (errors.length ? ": " + errors.join(" | ") : ""));
    } catch (e) {
        check(false, "Abbruch: " + e.message);
        console.log("           Entwürfe: " + await drafts(page) + " | Seite: " + page.url().replace(URL_, ""));
    } finally {
        try { await sweep(office, RUN); } catch (e) { console.log("           Aufräumen nicht möglich: " + e.message); }
        await browser.close();
    }
    console.log(state.failed ? `\n${state.failed} Prüfung(en) fehlgeschlagen.` : "\nAlle Prüfungen bestanden.");
    process.exit(state.failed ? 1 : 0);
})();
