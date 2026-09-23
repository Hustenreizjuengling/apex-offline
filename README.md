# Offline-Erfassung für Oracle APEX

Die App wird ganz normal im **APEX Builder** gebaut – Seiten, Formulare, Validierungen, Prozesse.
Drei statische Dateien machen daraus eine installierbare PWA, mit der man auch **ohne Verbindung
(VPN weg, Funkloch)** bereits geöffnete Aufträge, Anfragen oder Anlagen bearbeiten, Barcodes und QR-Codes
scannen und unterschreiben lassen kann. Was offline erfasst wurde, wird später **durch dieselbe
APEX-Seite** abgesendet – mit genau den Validierungen und Prozessen aus dem Builder.

Es gibt keine JSON-Definitionen, keinen Seitengenerator, kein eigenes Server-API und keinen Nachbau
der Formulare in JavaScript. Ein neues Feld ist ein neues Item im Builder, sonst nichts.

## So funktioniert es

1. **Offline-Vorrat:** Beim ersten Online-Aufruf je Sitzung lädt die App im Hintergrund alle Seiten, die
   offline gebraucht werden – ohne dass sie jemand öffnen muss (siehe unten). Der Service Worker speichert
   sie und jede weitere aufgerufene Seite. Ohne Verbindung (oder wenn der Server 4 Sekunden nicht
   antwortet) liefert er die zuletzt gespeicherte Fassung.
2. **Offline speichern:** Auf Seiten mit der CSS-Klasse `offline-form` fängt `offline.js` das Absenden
   ab, wenn der Server nicht erreichbar ist, prüft die Pflichtfelder wie online und legt nur die
   **geänderten Felder** (alter und neuer Wert) als Entwurf im Browser ab (IndexedDB).
3. **Übertragen:** Sobald der Server wieder erreichbar ist, lädt `offline.js` jede betroffene Seite
   unsichtbar, setzt die erfassten Werte und sendet sie ab – wie ein Anwender es täte. Erfolg,
   Validierungsfehler und Verbindungsabbruch werden erkannt.
4. **Konflikte:** Hat jemand dasselbe Feld inzwischen auf dem Server geändert, wird nichts
   überschrieben. Der Anwender öffnet den Entwurf, sieht den Server-Wert direkt am Feld und entscheidet.

## Die Bausteine

| Datei (`apex_toolkit/shared-components/static-files/`) | Zweck |
|---|---|
| `offline.js` | Entwürfe, Übertragung, Statusanzeige, Unterschrift, Scan, Vorab-Laden |
| `offline-sw.js` | Service-Worker-Hook: Seiten speichern und offline ausliefern |
| `offline.css` | Statusanzeige, Unterschriftenfeld, Scanner, Druck |
| `messages.css` | optional: Seitenmeldungen oben mittig und kompakt (unabhängig von der Offline-Schicht) |
| `vendor/barcode-detector/` | optional: Barcode-/QR-Decoder für iPhone, Windows, Firefox ([Fremdcode](THIRD-PARTY-NOTICES.md)) |

Datenbankobjekte braucht die Offline-Schicht nicht. `sql/install.sql` legt nur die Beispieltabelle an.

## In eine eigene App übernehmen (einmal je App)

1. **Shared Components → Static Application Files:** `offline.js`, `offline-sw.js`, `offline.css`
   hochladen, für das Scannen auf iPhone/Windows zusätzlich die drei Dateien aus
   `vendor/barcode-detector/` unter demselben Pfad (`zxing_reader.wasm` mit MIME-Typ `application/wasm`).
2. **Application Definition → User Interface:** JavaScript File URLs `#APP_FILES#offline.js`,
   CSS File URLs `#APP_FILES#offline.css` (und `#APP_FILES#messages.css`), *Auto-Dismiss Success
   Messages* einschalten – Erfolgsmeldungen erscheinen dann oben mittig und verschwinden nach 5 Sekunden,
   Fehlermeldungen bleiben stehen, bis sie geschlossen oder behoben sind.
3. **Progressive Web App:** aktivieren und installierbar machen; *Service Worker Hooks* → File URL
   `#APP_FILES#offline-sw.js`. Voraussetzung: HTTPS und Friendly URLs (Standard).
4. **Security → Browser Security → Embed in Frames:** *Allow from same origin* (die Übertragung lädt
   die Seite unsichtbar in einem Rahmen der eigenen App).
5. Empfohlen: **Session Management** – längere *Maximum Session Length / Idle Time* für Arbeitstage im
   Außendienst (Beispiel-App: 24 h / 8 h). Solange die Sitzung gilt, wird ohne neue Anmeldung übertragen.

## Eine Seite offlinefähig machen (je Formularseite)

| Wo im Builder | Einstellung | Warum |
|---|---|---|
| Page → Appearance → CSS Classes | `offline-form` | nur diese Seiten erfassen offline |
| Primärschlüssel-Item → Security → Session State Protection | *Checksum Required – User Level* (der Formular-Assistent setzt *Session Level* – umstellen) | die Prüfsumme in Links bleibt nach neuer Anmeldung gültig |
| Links und Buttons auf die Seite → Set Items | Primärschlüssel übergeben, bei „Neu" **leer** | ohne Item wäre die Prüfsumme an die Sitzung gebunden |
| Buttons → Button Name | Builder-Standard behalten: `CREATE`, `SAVE`, `DELETE` | am Namen erkennt `offline.js` Neuanlage und Löschen; heißt der Anlegen-Button anders, überschreibt die nächste Offline-Neuanlage die vorige |

Alles andere bleibt wie gewohnt: Felder, Pflichtfelder, Validierungen, *Form – Automatic Row
Processing*, Verzweigungen. Beispiel: `apex_toolkit/pages/p00002-auftrag.apx`.

## Prüfungen offline

Beim Offline-Speichern prüft der Browser alles, was APEX am **Item selbst** festlegt: *Value Required*,
*Maximum Length*, bei Zahlenfeldern *Minimum/Maximum Value*, bei Textfeldern der Subtyp (E-Mail, URL).
Diese Regeln gelten online zusätzlich auf dem Server – eine Regel, an einer Stelle, ohne JavaScript.
Beispiel: `P2_MESSWERT` mit Minimum 30 und Maximum 90 lehnt 150 offline sofort am Feld ab.

**Validierungen** (Page → Validations, PL/SQL) brauchen die Datenbank. Sie laufen bei der Übertragung;
schlägt eine fehl, bekommt der Entwurf den Status *fehler* mit der Meldung, und der Anwender korrigiert ihn
auf der Seite. Einfache Bereichs- und Pflichtprüfungen deshalb am Item festlegen, echte Geschäftsregeln
(Abgleich mit anderen Tabellen, mehrere Datensätze) als Validierung.

Die Meldungen der Browser-Prüfung sind APEX-Texte. `shared-components/messages.apx` stellt die wichtigsten
auf Deutsch (*Shared Components → Text Messages*, „Used in JavaScript"), falls das deutsche Sprachpaket
auf der Instanz fehlt.

## Seiten nur für online

Seiten, die ohne Verbindung keinen Sinn ergeben (Auswertungen, Verwaltung), bekommen die Page-CSS-Klasse
**`online-only`** (Page → Appearance → CSS Classes). Ohne Verbindung zeigen sie statt des Inhalts den
Hinweis „Nur online verfügbar"; Kopfleiste und Menü bleiben, sodass man zu den offline verfügbaren Seiten
wechseln kann. Reißt die Verbindung ab, während die Seite offen ist, erscheint der Hinweis sofort; kommt
sie zurück, lädt die Seite ihren aktuellen Inhalt. Eine gespeicherte Fassung zeigt nie veraltete Zahlen –
`offline.css` blendet ihren Inhalt aus, bevor das JavaScript läuft. Beispiel: Seite 5 „Auswertung".

## Bedienelemente per CSS-Klasse

| Klasse | Wo | Ergebnis |
|---|---|---|
| `offline-signature` | Textarea-Item → Advanced → CSS Classes | Unterschriftenfeld; Wert ist ein Bild als Data-URL (Spalte CLOB, Session State Data Type CLOB, Label-Template „Optional – Above") |
| `offline-photo` | Textarea-Item → Advanced → CSS Classes | Fotofeld: Kamera oder Galerie, Vorschau; das Bild wird im Browser auf höchstens 1600 Pixel verkleinert und ist als JPEG-Data-URL der Wert des Items (Spalte CLOB, Session State Data Type CLOB) |
| `offline-scan` | Textfeld-Item → Advanced → CSS Classes | Kamera-Taste für Barcode und QR-Code; Hand- und Bluetooth-Scanner tippen ohnehin ins Feld |
| `offline-prefetch` | Region (z. B. Bericht) → Appearance → CSS Classes | die Ziele ihrer Links und Buttons gehören zum Offline-Vorrat (siehe unten) |

## Offline-Vorrat: was ohne vorheriges Öffnen offline verfügbar ist

Beim ersten Online-Aufruf je Sitzung lädt die App im Hintergrund – die Anzeige zeigt dabei „Online · lädt":

1. alle Seiten des **Navigationsmenüs**,
2. von dort aus, auch mehrstufig, die Ziele aller **Links und Buttons in Regionen mit `offline-prefetch`**.

In der Beispiel-App sind das die Auftragsliste (Menü), jeder Auftrag und jedes Protokoll (Links im Bericht),
die Anlegeseite (Button „Neuer Auftrag" in derselben Region) und je Auftrag die Seite „Foto hinzufügen"
(Button in der Region „Fotos" des Auftrags) – bei fünf Aufträgen 17 Seiten, ohne einen Klick. Die Liste der
Entwürfe zeigt, wie viele Seiten offline verfügbar sind.

Damit eine Seite zum Vorrat gehört, muss sie also im Menü stehen oder von einer `offline-prefetch`-Region
aus verlinkt sein. Übersprungen werden Links mit Request (sie könnten auf der Zielseite etwas auslösen),
Links auf modale Dialoge und fremde Apps. Höchstens 300 Seiten je Durchlauf; große Bestände deshalb in der
Liste auf die eigenen Datensätze filtern (z. B. `where techniker = :APP_USER`).

## Was der Anwender sieht

In der Kopfleiste neben dem angemeldeten Benutzer steht der Zustand: **Online**, **Offline** oder
**„2 offen"** (Seiten ohne Navigationsleiste zeigen ihn unten links). In Listen sind Datensätze
mit offenem Entwurf markiert (●). Ein Klick auf die Anzeige öffnet die Liste der Entwürfe mit
*Öffnen*, *Verwerfen* und *Jetzt übertragen*. Jeder Entwurf heißt wie die Seite plus ihr erster
ausgefüllter Wert, z. B. „Auftrag: A-1005" – das kennzeichnende Feld gehört also nach oben.

| Status | Bedeutung |
|---|---|
| wartet | wird automatisch übertragen, sobald der Server erreichbar ist (ggf. nach Anmeldung) |
| fehler | der Server hat abgelehnt (z. B. Validierung) – öffnen, korrigieren, speichern |
| konflikt | dasselbe Feld wurde inzwischen auf dem Server geändert – öffnen, entscheiden, speichern |
| unklar | Neuanlage, bei der die Verbindung während des Speicherns abriss – erst prüfen, ob der Datensatz schon existiert, dann öffnen oder verwerfen |

## Fotos am Auftrag

Beispiel für Anhänge, die offline entstehen: beliebig viele Fotos je Auftrag in der Tabelle
`OE_AUFTRAG_FOTO`. Die Seite 4 „Foto" ist ein normales natives Formular auf dieser Tabelle mit einem
Textarea-Item `P4_FOTO` (CSS-Klasse `offline-photo`) und einer Bemerkung. Der Auftrag (Seite 2) zeigt die
Fotos in der Region „Fotos", deren Button „Foto hinzufügen" die Seite 4 mit dem Auftrag öffnet.

Offline ist ein Foto ein Entwurf wie jede andere Neuanlage und wird später durch Seite 4 abgesendet. APEX
überträgt dabei auch Item-Werte mit mehreren 100 000 Zeichen (geprüft mit 260 000). Ein Handyfoto wird
durch das Verkleinern auf 1600 Pixel zu etwa 150–400 KB. Für eine eigene Fotoseite gelten dieselben Regeln
wie für jede Erfassungsseite: `offline-form`, Primärschlüssel und Auftragsbezug mit *User Level*, Link mit
leerem Primärschlüssel. Bilder als Data-URL zeigt `pck_oe_html` an (`sql/pck_oe_html.sql`).

## Protokoll

Seite 3 zeigt einen Auftrag mit Unterschrift und Fotos druckfertig an; *Drucken / PDF* nutzt den
Druckdialog des Browsers. Unterschrift und Fotos gibt `pck_oe_html` aus, weil das Item *Display Image*
keine Data-URLs über 4000 Zeichen darstellen kann. Offline erfasste Daten erscheinen im Protokoll nach der
Übertragung.

## Grenzen

* Offline verfügbar ist der Offline-Vorrat und alles, was online aufgerufen wurde – im Stand des letzten
  Online-Aufrufs bzw. Vorrats (einmal je Sitzung, also z. B. bei der Anmeldung am Morgen).
* Offline funktionieren Textfelder, Auswahllisten, Optionsfelder, Schalter, Datum, Zahl, Unterschrift und
  Scan. **Nicht** offline: Popup LOV, kaskadierende LOVs, Bearbeiten im Interactive Grid, Datei-Upload,
  serverseitige Dynamic Actions, Regionen mit Lazy Loading.
* Anmelden geht nur online. *Rejoin Sessions* wirkt auf der Instanz nicht; die installierte App startet
  online deshalb mit der Anmeldung, offline mit der gespeicherten Startseite.
* Auf iPhone/iPad bleiben die Daten nur dauerhaft erhalten, wenn die App zum Home-Bildschirm hinzugefügt
  wurde.
* Gespeicherte Seiten enthalten die Daten, die der Anwender gesehen hat. Meldet sich auf dem Gerät ein
  anderer Benutzer an, werden sie gelöscht; Entwürfe sieht und überträgt nur ihr Ersteller.

## Beispiel-App installieren

```text
sql -name <verbindung>
SQL> cd sql
SQL> @install.sql                         -- Tabellen OE_AUFTRAG (fünf Aufträge), OE_AUFTRAG_FOTO, Paket PCK_OE_HTML
SQL> cd ..
SQL> apex import -input apex_toolkit -workspace <workspace>   -- App 1700, Alias ERFASSUNG
```

Aufruf: `https://<server>/ords/r/<workspace>/erfassung`. Rückbau: App löschen, `@sql/uninstall.sql`.

## Test

`tests/offline.test.js` spielt den Außendienst im echten Browser (Playwright, Chromium) gegen eine
laufende Instanz durch: Liste und nie geöffneter Auftrag offline, Erfassen mit Unterschrift, Neuanlage,
automatische Übertragung, Konflikt, abgelaufene Sitzung mit neuer Anmeldung, Scannen mit simulierter
Kamera ohne Zugriff auf fremde Server.

```text
OE_URL=https://<server>/ords/r/<workspace>/erfassung OE_USER=<benutzer> OE_PASSWORD=<kennwort> \
PLAYWRIGHT=<pfad>/node_modules/playwright node tests/offline.test.js
```
