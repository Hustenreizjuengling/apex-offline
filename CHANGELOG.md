# Änderungen

Versionsnummer wie im README „Release und Update“: Fehlerkorrektur erhöht die dritte Stelle (1.14.1), neues
Verhalten die zweite (1.15.0). Die Version steht in `apex_toolkit/application.apx` und in der Fußzeile der App.

## 1.15.1 – 2026-11-01

Fehlerkorrekturen zu 1.15.0 (Befunde eines zweiten Reviews).

- **Upgrade der Browser-Datenbank** bei noch offener älterer Registerkarte: Bisher galt das Warten als Fehler
  („Offline gestört“). Jetzt wartet die neue Fassung; die ältere Registerkarte gibt die Verbindung frei und meldet
  „Neue Fassung in einer anderen Registerkarte – Seite neu laden“. Ein Rückbau auf eine Fassung vor 1.15.0 zeigt
  auf Geräten mit der neuen Datenbank „Offline gestört“, bis die Websitedaten gelöscht sind (README, Release).
- **Benutzernamen außerhalb Latin-1** (ł, kyrillisch, CJK) machten den Header `x-offline-user` ungültig; der
  Service Worker speicherte dann keine Seiten mehr, ohne Hinweis. Der Name wird kodiert abgelegt.
- **Geduld nach dem Absenden** nur noch nach einem gelungenen POST (Antwort ok); ein fehlgeschlagener zählte mit und
  ließ die nächste Seite auf einer halbtoten Verbindung 30 statt 4 s warten.
- Eine **überholte Erreichbarkeitsprüfung** liefert ihren Aufrufern das Ergebnis der neuesten Prüfung statt des
  alten Zustands (der Vorrat zählte sonst eine Seite als „nicht abrufbar“, obwohl die Verbindung weg war).
- **Sende-Sperre:** Der Status „sendet“ entsteht nur noch unter der Sperre, auch beim Online-Speichern; bisher
  stand er für Mikrosekunden ohne Sperre im Speicher, ein zweites Fenster hätte den Entwurf als abgebrochen
  eingestuft.
- Testaufträge werden auch nach einem abgebrochenen Testlauf entfernt; neuer Testschritt 12d (Übernahme der
  Entwürfe aus der Datenbank der Version 1).

## 1.15.0 – 2026-11-01

Neues Verhalten; in eigenen Apps die Region „Offline-Kennung“ auf Seite 0 nachziehen (siehe README, Schritt 6).

- **Entwürfe ohne Bilddaten lesen:** Die Anzeige, die Liste der Entwürfe und die regelmäßige Prüfung lasen alle
  Entwürfe samt Fotos (mehrere 100 KB je Foto) aus IndexedDB – alle 30 Sekunden und bei jeder Aktualisierung.
  Jetzt gibt es einen Index (`meta`) ohne Werte und ein kleines Vorschaubild (160 px, einige KB), das beim
  Speichern entsteht; das Foto selbst wird nur zum Übertragen, Öffnen und für die Großansicht gelesen.
  Vorhandene Entwürfe werden beim ersten Start übernommen (ohne Vorschaubild – es kommt dann aus dem Foto).
- **Gespeicherte Seiten gehören ihrem Benutzer:** Die Seitenkennung auf Seite 0 trägt `data-user="&APP_USER."`;
  der Service Worker speichert den Benutzer mit und liefert eine gespeicherte Seite nur dem Benutzer aus, der sie
  geladen hat. Bisher konnte auf einem weitergegebenen Gerät der nächste Benutzer kurz eine Seite des
  Vorgängers sehen, wenn seine erste Seite länger als 4 Sekunden brauchte. Ohne `data-user` (alte App) wie bisher.
  Testschritt 12c.
- **Geduld nach dem Absenden:** In der Minute nach einem Absenden (POST) wartet der Service Worker 30 statt
  4 Sekunden auf den Server – er ist dann erreichbar, eine gespeicherte Fassung wäre die falsche.
- **Sende-Sperre bis zum Abschluss:** Ein Entwurf wird noch unter der Web-Locks-Sperre abgeschlossen (gelöscht
  oder umgestuft). Ein zweites Fenster sah ihn bisher für Millisekunden als „sendet“ ohne Sperre und hätte ihn als
  abgebrochen eingestuft.
- **Speicher aufräumen:** Die Grenze von 500 gespeicherten Seiten greift jetzt auch bei kurzlebigen Service
  Workern und beim Aktivieren; Datei-Caches älterer APEX-Versionen (bis auf die vorige) werden beim Aktivieren
  entfernt.

## 1.14.2 – 2026-11-01

Fehlerkorrekturen.

- **Erfassung konnte verloren gehen,** wenn beim Online-Speichern statt der APEX-Seite etwas anderes im
  unsichtbaren Rahmen ankam (Hotspot-Anmeldung, Proxy- oder Fehlerseite): Das galt als Ablehnung durch den
  Server, und ein neuer Entwurf wurde gelöscht; die Eingaben standen nur noch im offenen Formular. Jetzt löscht
  nur eine echte Ablehnung (Meldungen der Seite); sonst bleibt der Entwurf mit Status *fehler* und dem Grund
  erhalten, und *Jetzt übertragen* sendet ihn nach. Testschritt 13e.
- **Browser-Speicher nicht nutzbar** (IndexedDB fehlt, gesperrt oder vom System geschlossen): Bisher brach der
  Start still ab – keine Anzeige, kein Vorrat, kein Hinweis. Jetzt meldet die Anzeige „Offline gestört“ mit dem
  Grund, APEX speichert normal. Testschritt 13d.
- **Leere Unterschrift:** Ein Tippen auf das Unterschriftenfeld ohne Strich speicherte ein weißes Bild, das als
  ausgefüllte Unterschrift galt. Gespeichert wird nur, wenn gezeichnet wurde.
- Kommt eine Erfassungsseite aus dem Back/Forward-Cache des Browsers zurück, nimmt „Speichern“ wieder an
  (das Merkzeichen „Speichern läuft“ wird zurückgesetzt).
- Die Hinweisseiten des Service Workers („Keine Verbindung“, „Nur online verfügbar“) versuchen es alle 15 s
  erneut, solange der Browser online meldet. Bisher nur einmal beim `online`-Ereignis; scheiterte dieser
  Versuch (Netz gerade erst zurück, Server langsamer als 4 s), blieb der Hinweis stehen.

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
