/*
 * Diagnose nach einem fehlgeschlagenen CI-Lauf: Was liefert die Instanz für die Startseite? Druckt Adresse, Titel,
 * Benutzer und die ersten Zeilen des Seitentexts - vor und nach der Anmeldung. Läuft wie der Test mit OE_URL, OE_USER, OE_PASSWORD.
 */
const { chromium } = require("playwright");
const URL_ = (process.env.OE_URL || "").replace(/\/$/, "");

(async () => {
    const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"] });
    const page = await (await browser.newContext({ ignoreHTTPSErrors: true, locale: "de-DE" })).newPage();
    page.on("pageerror", e => console.log("  pageerror: " + e.message));
    page.on("console", m => { if (m.type() === "error") { console.log("  console: " + m.text().slice(0, 200)); } });
    const show = async label => {
        await page.waitForTimeout(1500);
        const info = await page.evaluate(() => ({
            title: document.title,
            user: window.apex && window.apex.env ? window.apex.env.APP_USER + " / Seite " + window.apex.env.APP_PAGE_ID : "(kein apex)",
            mark: !!document.getElementById("offline-page"),
            pill: (document.querySelector(".offline-status") || { textContent: "-" }).textContent,
            body: document.body.className,
            text: document.body.innerText.replace(/\s+/g, " ").slice(0, 700)
        })).catch(e => ({ text: "evaluate: " + e.message }));
        console.log(`== ${label}: ${page.url()}`);
        for (const [k, v] of Object.entries(info)) { console.log(`  ${k}: ${v}`); }
    };
    await page.goto(URL_ + "/auftraege").catch(e => console.log("  goto: " + e.message));
    await show("Startseite");
    if (await page.locator("#P9999_USERNAME").count()) {
        await page.fill("#P9999_USERNAME", process.env.OE_USER || "");
        await page.fill("#P9999_PASSWORD", process.env.OE_PASSWORD || "");
        await Promise.all([page.waitForLoadState("load"), page.locator("#P9999_PASSWORD").press("Enter")]);
        await show("nach der Anmeldung");
    }
    await browser.close();
})();
