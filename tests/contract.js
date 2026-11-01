/*
 * Vertrag (README): die Offline-Schicht nutzt nur diese dokumentierte APEX-API und liest nie APEX- oder
 * Theme-Markup. Geprüft wird der Quelltext von offline.js, offline-sw.js und offline.css (ohne Kommentare).
 * Läuft ohne Instanz: node tests/contract.js (npm run lint); Testschritt 0 von offline.test.js nutzt dasselbe.
 */
const fs = require("fs"), path = require("path");

const CONTRACT = ["apex.env", "apex.items", "apex.item", "apex.jQuery", "apex.page.submit", "apex.page.validate",
    "apex.page.isChanged", "apex.page.cancelWarnOnUnsavedChanges", "apex.message.showPageSuccess", "apex.message.hidePageSuccess",
    "apex.message.showErrors", "apex.message.clearErrors", "apex.message.alert", "apex.message.confirm",
    "apex.message.setThemeHooks", "apex.message.TYPE", "apex.util.escapeHTML", "apex.util.showSpinner"];

const DIR = path.join(__dirname, "..", "apex_toolkit", "shared-components", "static-files");

function contractLint() {
    const read = f => fs.readFileSync(path.join(DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const code = ["offline.js", "offline-sw.js"].map(f => read(f).replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")).join("\n");
    const problems = [];
    for (const [full] of code.matchAll(/\bapex\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
        if (!CONTRACT.some(c => full === c || full.startsWith(c + "."))) { problems.push(full); }
    }
    const markup = /(querySelector(?:All)?|closest|matches|getElementById)\(\s*["'`][^"'`]*(\.t-|#t_|\.ui-|#APEX_|#?main["'`]|wwv)/g;
    for (const [bad] of code.matchAll(markup)) { problems.push(bad); }
    for (const [bad] of code.matchAll(/wwv_flow|gCancelFlag|forEachPageItem|pReloadOnSubmit|apex\.sw\b|apex_dialog_|classList\.contains\(["']t-/g)) { problems.push(bad); }
    for (const [, sel] of read("offline.css").matchAll(/([^{}]+)\{/g)) {
        if (/(\.t-|#t_|\.ui-|#APEX_|#main\b)/.test(sel)) { problems.push("offline.css: " + sel.trim()); }
    }
    return [...new Set(problems)];
}

// Versionsnummer: application.apx, CHANGELOG und Kommentar in offline.js müssen denselben Stand nennen
function versionLint() {
    const root = path.join(__dirname, "..");
    const app = (fs.readFileSync(path.join(root, "apex_toolkit", "application.apx"), "utf8").match(/^\s*version:\s*(\S+)/m) || [])[1];
    const log = (fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8").match(/^## (\d+\.\d+\.\d+)/m) || [])[1];
    const problems = [];
    if (!app) { problems.push("application.apx: keine Version"); }
    if (!log) { problems.push("CHANGELOG.md: kein Eintrag"); }
    if (app && log && app !== log) { problems.push(`Version ${app} (application.apx) ≠ ${log} (CHANGELOG.md)`); }
    return problems;
}

function syntaxLint() {
    const { execFileSync } = require("child_process");
    const problems = [];
    for (const f of ["offline.js", "offline-sw.js"]) {
        try { execFileSync(process.execPath, ["--check", path.join(DIR, f)], { stdio: "pipe" }); }
        catch (e) { problems.push(f + ": " + String(e.stderr || e.message).trim().split("\n").slice(-1)[0]); }
    }
    return problems;
}

module.exports = { CONTRACT, contractLint, versionLint, syntaxLint };

if (require.main === module) {
    const all = [["Vertrag", contractLint()], ["Syntax", syntaxLint()], ["Version", versionLint()]];
    let failed = 0;
    for (const [name, problems] of all) {
        console.log((problems.length ? "  [FEHLER] " : "  [OK]     ") + name + (problems.length ? ": " + problems.join(" | ") : ""));
        failed += problems.length;
    }
    process.exit(failed ? 1 : 0);
}
