# Änderungen

Versionsnummer wie im README „Release und Update“: Fehlerkorrektur erhöht die dritte Stelle (1.14.1), neues
Verhalten die zweite (1.15.0). Die Version steht in `apex_toolkit/application.apx` und in der Fußzeile der App.

## 1.14.1 – 2026-11-01

Fehlerkorrekturen, geprüft mit APEX 26.2 (Oracle AI Database 26ai Free, ORDS 26.3).

- **Anzeige sprang nach Verbindungsverlust auf „Online“ zurück:** Mehrere Erreichbarkeitsprüfungen liefen
  parallel, und eine Antwort, die vor dem Verbindungsverlust unterwegs war, überschrieb das neuere Ergebnis.
  Bis zur nächsten Prüfung (30 s) war die Anzeige falsch, und Seiten mit `online-only` zeigten alte Zahlen
  statt des Hinweises. Jetzt entscheidet nur die zuletzt gestartete Prüfung. Daten gingen nicht verloren.
- **Versionshinweis** in der Liste der Entwürfe hat eine eigene CSS-Klasse (`offline-version`); er teilte
  sich die Klasse mit der Vorratszeile, woran der Browsertest auf jeder neuen APEX-Version scheiterte.
- `TESTED_APEX` ist eine Liste geprüfter Versionen (26.1, 26.2) statt einer einzelnen.
- `npm run lint` (`tests/contract.js`): Vertrag, Syntax und Versionsnummer ohne laufende Instanz prüfen;
  Testschritt 0 nutzt denselben Code. Neuer Testschritt: APEX-Version der Instanz ist als geprüft eingetragen.

## 1.14.0 – 2026-10-17

Vertrag: nur dokumentierte APEX-API, kein Theme-Markup, Selbstprüfung (siehe README „Vertrag“). Ältere
Stände: siehe Commit-Historie.
