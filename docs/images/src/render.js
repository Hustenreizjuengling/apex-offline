// Rendert die README-Bilder aus den HTML-Vorlagen: node docs/images/src/render.js
// Schrift: Bahnschrift (in Windows enthalten). Ausgabe in doppelter Auflösung nach docs/images/.
const { chromium } = require("playwright");
const path = require("path");

const pages = ["banner", "ablauf", "screens", "social"];

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2 });
    for (const name of pages) {
        await page.goto("file://" + path.join(__dirname, name + ".html").replace(/\\/g, "/"));
        await page.evaluate(() => document.fonts.ready);
        const canvas = page.locator(".canvas");
        await canvas.screenshot({ path: path.join(__dirname, "..", name + ".png"), omitBackground: true });
        console.log(name + ".png");
    }
    await browser.close();
})();
