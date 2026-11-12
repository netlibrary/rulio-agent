<!-- Bei Änderungen beide Dateien anpassen: README.md (Englisch) und README.de.md (Deutsch). -->

# Agentio

🇬🇧 [English](README.md)

Agentio ist ein kleines Programm, das deinen eigenen KI-Agenten (Claude Code oder
OpenCode) **nach Zeitplan** mit [rulio](https://rulio.net) arbeiten lässt. Er
liest dein Konto und die Marktlisten, vergleicht Ideen, legt eigene Regeln **im Paper-Konto** an und schreibt
Berichte. Das alles geschieht in den Grenzen, die du in rulio festlegst.

**Wann** ein Lauf fällig ist, entscheidet rulio. Das stellst du in der App ein:
vor Öffnung, alle N Minuten während der Handelszeit, nach Schluss, bei
Ereignissen oder per Chat bzw. Auftrag. Dieses Programm fragt nur regelmäßig
nach und führt aus.

Der Befehl heißt `agentio`. Der ältere Name `rulio-agent` startet dasselbe
Programm, bestehende Skripte laufen also weiter.

## Was der Agent darf

- **Nur rulio:** Der Agent arbeitet ausschließlich mit den rulio-Werkzeugen
  (MCP). Eingebaute Werkzeuge von Claude Code wie Bash, Dateien lesen und
  schreiben oder Web sind aus (Web nur in Bericht-Läufen, die es erlauben,
  siehe unten), andere MCP-Server ebenso.
- **Web-Recherche in Bericht-Läufen:** Erlaubt die Arbeitsweise des Berichts
  Web-Recherche (in der App: Bericht-Arbeitsweise → „Web-Recherche erlaubt“;
  bei der Thema-Recherche standardmäßig an), kennzeichnet rulio den Lauf mit
  `web`. Nur dann erlaubt Agentio zusätzlich `WebSearch` und `WebFetch` —
  im Web suchen und Seiten lesen. Shell, Dateien und andere MCP-Server bleiben
  aus. Weil Webseiten Anweisungen einschleusen können, **lehnt rulio in so
  einem Lauf alle verändernden Werkzeuge serverseitig ab** (Regeln anlegen,
  ändern, löschen, Ausstiege, Kern, Vorschläge, Listen, Zeichnungen,
  Notizen); Lesen und der Bericht bleiben erlaubt. Abgelehnte Aufrufe stehen
  im Protokoll. Web-Recherche verbraucht mehr von deinem KI-Abo.
- **Unteragenten:** Bei Bericht-Läufen darf er zusätzlich Unteragenten starten.
  Sie haben dieselben Grenzen.
- **rulio erzwingt** serverseitig, unabhängig von diesem Programm:
  - eigene Regeln nur im Paper-Konto, nie mit echtem Geld;
  - Budget, Anzahl der Regeln und neue Regeln je Tag;
  - Notaus;
  - je Schlüssel genau ein Konto.

  Für dein echtes Konto kann der Agent nur **vorschlagen**; übernehmen tust du.

## Voraussetzungen

1. **Konto bei rulio:** In der App unter **KI-Agent › Verbindung** einen
   Schlüssel erzeugen (`rulio_…`). Er gilt für genau ein Konto und lässt sich
   dort jederzeit widerrufen. Den Zeitplan stellst du im KI-Agent-Bereich ein.
2. **[Claude Code](https://code.claude.com)** mit deinem eigenen Abo (Pro/Max)
   oder API-Schlüssel. Agentio startet nur das unveränderte
   `claude`-Programm. Deinen Login liest es nie.
3. **Node.js 20** oder neuer (für Weg 2).

## Weg 1: Cloud-Routine (ohne eigenen Rechner)

Claude Code kann geplante Läufe („Routines“) in der Cloud ausführen, frühestens
stündlich, auf deinem Abo.

1. **Repository:** Dieses Repo forken und den Fork in
   https://claude.ai/code/routines als Repository wählen. Die `.mcp.json` im
   Wurzelverzeichnis bindet rulio ein; sie enthält keinen Schlüssel.
2. **Schlüssel:** In der Umgebung unter **Network secrets** einen Eintrag
   anlegen: erlaubte Website `api.rulio.net`, Header `Authorization`, Präfix
   `Bearer`, Wert = dein `rulio_…`-Schlüssel. Nicht als normale
   Umgebungsvariable anlegen, die sieht jeder mit Zugriff auf die Umgebung.
3. **Prompt:** der Inhalt von [`routine/PROMPT.md`](routine/PROMPT.md).
4. **Auslöser:** stündlich an Werktagen. rulio entscheidet bei jedem Lauf, ob
   wirklich etwas zu tun ist; sonst ist der Lauf nach Sekunden fertig.
5. **Prüfen:** Beim ersten Lauf im rulio-Protokoll nachsehen, ob er ankommt.

## Weg 2: Auf deinem Rechner

```bash
claude auth login                                  # einmal, mit deinem Claude-Abo
npm install -g github:netlibrary/rulio-agent
RULIO_TOKEN=rulio_… agentio check              # Verbindung prüfen
RULIO_TOKEN=rulio_… agentio run                # dauerhaft laufen lassen
```

Unter Windows (PowerShell): `$env:RULIO_TOKEN="rulio_…"; agentio run`

`agentio once` führt höchstens einen fälligen Lauf aus und endet. Das
eignet sich für einen eigenen Zeitplan, etwa per Cron oder Aufgabenplanung.

## Weg 3: Auf einem Server (Docker)

Das Image baust du selbst aus diesem Repo. Dabei lädt der Build Claude Code
aus npm. Ein fertiges Image mit Claude Code gibt es nicht zum Herunterladen:
Claude Code gehört Anthropic und wird nicht von uns weiterverteilt.

### Mit dem Skript (einrichten, aktualisieren, neu starten)

```bash
claude setup-token        # auf deinem Rechner: erzeugt ein Token für Skripte
curl -fsSLo ~/agentio.sh https://raw.githubusercontent.com/netlibrary/rulio-agent/main/scripts/agentio.sh && chmod +x ~/agentio.sh
~/agentio.sh              # einrichten bzw. aktualisieren
```

- Das Skript legt den Container immer gleich an: Name `agentio`,
  `--restart unless-stopped`, das benannte Volume `agentio-keys` für die
  Schlüssel, die Variablen aus `~/agentio.env` (Rechte `600`).
- Beim ersten Aufruf legt es `~/agentio.env` mit Platzhaltern an. Trag deinen
  rulio-Schlüssel und das Claude-Token ein und ruf das Skript noch einmal auf.
- **Aktualisieren** heißt: das Skript erneut ausführen. Es holt das Image,
  entfernt den alten Container und startet einen neuen mit denselben Angaben.
  Volume und Datei bleiben.
- **Übernahme einer älteren Installation:** Läuft ein Container `rulio-agent`
  (oder `agentio`) ohne das benannte Volume, übernimmt das Skript einmalig
  dessen Variablen nach `~/agentio.env` (ohne sie anzuzeigen) und kopiert die
  Schlüsseldateien nach `agentio-keys`, auch aus einem namenlosen Volume. Erst
  danach entfernt es den alten Container. Es meldet, wie viele
  Konten-Schlüssel übernommen wurden.
- Startet der neue Container nicht oder meldet er keine Schlüssel, läuft der
  alte wieder und nichts wird gelöscht. Das Skript löscht nie ein Volume und
  gibt nie einen Schlüssel aus.
- Am Ende zeigt es `agentio status`.
- Es nutzt das Image `ghcr.io/netlibrary/rulio-agent:latest`. Mit einem selbst
  gebauten Image: `AGENTIO_IMAGE=rulio-agent AGENTIO_PULL=0 ~/agentio.sh`.

### Von Hand (für Fortgeschrittene)

```bash
docker build -t rulio-agent https://github.com/netlibrary/rulio-agent.git
docker run -d --restart unless-stopped --name agentio \
  -v agentio-keys:/home/agent/.rulio-agent \
  -e RULIO_TOKEN=rulio_… \
  -e CLAUDE_CODE_OAUTH_TOKEN=… \
  rulio-agent
```

Das benannte Volume (`-v agentio-keys:…`) darf nicht wegfallen. Ohne es legt
Docker ein namenloses Volume an, und die eingetragenen Schlüssel sind beim
Neuanlegen des Containers kaum wiederzufinden.

Fragt der Agent länger als 10 Minuten nicht nach, meldet rulio ihn als offline.

## Mehrere Konten in einem Container

Ein Schlüssel gehört zu genau einem Konto. Für ein zweites Konto legst du dort
einen weiteren Schlüssel an und trägst ihn im laufenden Container ein. Ein
Neustart ist nicht nötig:

```bash
docker exec agentio agentio add-key rulio_…
```

| Befehl | Was er tut |
| --- | --- |
| `agentio add-key <rulio_…>` | Trägt einen Schlüssel in `~/.rulio-agent/keys` ein (Rechte `600`). Ein laufender Agentio übernimmt ihn innerhalb von 30 s. |
| `agentio remove-key <…letzte 6 Zeichen>` | Entfernt einen Schlüssel aus der Datei. Ein Schlüssel in `RULIO_TOKEN` bleibt. |
| `agentio list-keys` | Zeigt die Schlüssel mit ihren letzten 6 Zeichen. |
| `agentio status` | Zeigt die Schlüssel mit ihren letzten 6 Zeichen, je Anbieter nur, ob sein Schlüssel gesetzt ist und woher (Datei oder Variable), und die Claude-Anmeldung. Nie einen Schlüssel. |

- **Ein Lauf zur Zeit:** Läufe aus allen Konten warten aufeinander, wer zuerst
  dran ist, zuerst. Solange ein Lauf läuft, meldet sich jedes Konto mindestens
  einmal pro Minute, damit rulio keines als offline anzeigt.
- **Getrennte Konten:** Ein Lauf bekommt nur den Schlüssel seines Kontos und
  sieht nur dieses Konto.
- **Ein fälliger Lauf** wird in einer eigenen Anfrage abgeholt, immer nur einer
  zugleich und nur, wenn gerade kein anderer läuft.
- **Ein widerrufener Schlüssel:** Er wird einmal geloggt und alle 30 Minuten
  erneut versucht. Die anderen Schlüssel laufen weiter.
- `check` prüft alle Schlüssel, `once` fragt mit jedem Schlüssel einmal.
- Im Log stehen Schlüssel nur mit ihren letzten 6 Zeichen.

**Umstieg von einem älteren Container:** Einmal mit dem Befehl oben neu bauen und
starten. `RULIO_TOKEN` gilt weiter. Fehlt `add-key`, läuft eine ältere Fassung.

## Andere Modelle (OpenCode)

Ein Schlüssel in rulio kann ein eigenes Modell haben. Läufe dieses Schlüssels
nutzen dann [OpenCode](https://opencode.ai) statt Claude Code. Ein Schlüssel ohne
Modell läuft wie bisher mit Claude Code, und dein Claude-Abo bleibt dort.

Der Container enthält OpenCode mit fester Version. Sonst installierst du es mit
`npm install -g opencode-ai@1.19.5`.

### Schlüssel des Anbieters setzen oder tauschen

```bash
docker exec -it agentio agentio set-provider-key opencode
Key for opencode (not shown): ********
Key for opencode stored. It counts from the next run, no restart needed.
```

- Der Schlüssel wird verdeckt abgefragt und nie als Argument übergeben, damit er
  nicht im Verlauf der Shell steht. Ohne Terminal liest der Befehl ihn von der
  Standardeingabe: `docker exec -i agentio agentio set-provider-key opencode < schluessel.txt`.
- Anbieter: `opencode` (`OPENCODE_API_KEY`), `openrouter` (`OPENROUTER_API_KEY`).
  Weitere Variablen aus `RULIO_AGENT_OPENCODE_KEYS` setzt du mit ihrem Namen.
- Gespeichert wird im Volume neben den rulio-Schlüsseln
  (`~/.rulio-agent/provider-keys`, Rechte `600`). Er geht einer Variablen des
  Containers vor. Jeder Lauf liest ihn neu, ein neuer Schlüssel braucht also
  keinen Neustart.
- `agentio remove-provider-key opencode` entfernt ihn. Danach gilt wieder die
  Variable des Containers, falls es eine gibt.
- `agentio status` zeigt, ob ein Schlüssel gesetzt ist, nie den Schlüssel.

Rückfall: den Schlüssel als Variable des Containers mitgeben. Ihn zu tauschen
heißt dann, den Container neu anzulegen.

```bash
docker run -d … -e OPENCODE_API_KEY=… rulio-agent
```

`OPENCODE_API_KEY` ist der Schlüssel aus der [OpenCode Console](https://opencode.ai/console),
für OpenCode Zen (Abrechnung nach Nutzung) oder OpenCode Go (Abo mit
Nutzungsgrenzen). Für Modelle von [OpenRouter](https://openrouter.ai/) gibst du
stattdessen `OPENROUTER_API_KEY` mit. Modelle heißen `anbieter/modell`, der Anbieter
gehört also zum in rulio gewählten Modell. Ein anderer Anbieter braucht nur seinen
Schlüssel: Trag die Variable in `RULIO_AGENT_OPENCODE_KEYS` ein.

Bei jedem Abruf meldet Agentio seine Einrichtung an rulio, damit die App
zeigen kann, wo er läuft und ob das Modell bezahlt werden kann: läuft in Docker
(ja oder nein, über `/.dockerenv`), Claude Code angemeldet (ja, nein, unbekannt;
geprüft beim Start und höchstens alle 10 Minuten), nutzt
`RULIO_AGENT_USE_API_KEY` (ja oder nein), Schlüssel des Anbieters vorhanden (ja
oder nein, gespeichert oder als Variable). Nie gesendet werden ein Schlüssel, der Wert einer Variablen oder ihr
Name.

Die Schutzregeln sind dieselben wie bei Claude Code:

- Nur die rulio-Werkzeuge. Shell, Dateien, Web und Unteragenten sind gesperrt.
  Berichtsläufe mit Web-Recherche bekommen zusätzlich `webfetch` (eine Seite
  lesen) und `websearch` (im Web suchen) von OpenCode; rulio lehnt dann für den
  ganzen Lauf jeden ändernden Aufruf ab, wie bei Claude Code.
- Je Lauf ein eigener, leerer Arbeitsordner, eine eigene Konfiguration und eigene
  Daten, danach gelöscht. Andere Konfigurationen werden nicht gelesen, und aus der
  Umgebung gehen nur die zum Start nötigen Variablen und die Anbieter-Schlüssel mit.
- Agentio setzt Zeit- und Schrittgrenze selbst durch und beendet den Prozess.
  Hat der nächste Schritt in dem Moment schon begonnen, kann rulio seinen
  Werkzeugaufruf noch ausführen.

`websearch` nutzt den Suchdienst Exa (mcp.exa.ai): ohne Schlüssel und ohne
Einstellung, die Suchanfragen gehen an Exa. Berichtsläufe mit Unteragenten laufen
ohne Unteragenten. Kosten je Lauf stehen nur da, wo der Anbieter nach
Nutzung abrechnet, nicht bei Anbietern aus `RULIO_AGENT_FLAT_PROVIDERS`.

## Einstellungen (Umgebungsvariablen)

| Variable | Bedeutung | Standard |
| --- | --- | --- |
| `RULIO_TOKEN` | Schlüssel aus rulio (oder `add-key`) | — |
| `RULIO_URL` | rulio-Adresse | `https://api.rulio.net` |
| `CLAUDE_BIN` | Pfad zu `claude` | `claude` |
| `OPENCODE_BIN` | Pfad zu `opencode` | `opencode` |
| `RULIO_AGENT_OPENCODE_DEPS` | Ordner mit den Paketen, die OpenCode sonst in jedem Lauf installiert; im Container enthalten. Ohne ihn braucht ein Lauf etwa 190 MB im Temp-Ordner | `/opt/opencode-deps` |
| `OPENCODE_API_KEY` | Schlüssel des Anbieters für Schlüssel mit eigenem Modell; ein mit `set-provider-key` gespeicherter geht vor | — |
| `OPENROUTER_API_KEY` | Dasselbe für Modelle von OpenRouter | — |
| `RULIO_AGENT_OPENCODE_KEYS` | Namen der Variablen mit Anbieter-Schlüsseln | `OPENCODE_API_KEY,OPENROUTER_API_KEY` |
| `RULIO_AGENT_FLAT_PROVIDERS` | Anbieter mit Abo, keine Kosten je Lauf | `opencode-go` |
| `RULIO_CLIENT_NAME` | Name in rulio („Agent online“) | `rulio-agent@<Rechner>` |
| `RULIO_AGENT_USE_API_KEY` | `1` = `ANTHROPIC_API_KEY` nutzen statt Abo | aus |

Ist `ANTHROPIC_API_KEY` gesetzt, entfernt Agentio ihn für die Läufe. So
läuft der Agent auf deinem Abo und nicht auf API-Kosten. Das gilt nicht, wenn
`RULIO_AGENT_USE_API_KEY=1` gesetzt ist.

Der Agent wartet vor dem ersten Schritt immer auf die rulio-Werkzeuge, auch wenn
er aus einem Terminal der Claude-Desktop-App gestartet wird: Agentio entfernt
für die Läufe `MCP_CONNECTION_NONBLOCKING`, das die App weitergeben kann.

## So läuft ein Lauf ab

- **Abfragen:** Agentio fragt `POST /api/agent/runner/poll` im Long-Poll.
  Ist nichts fällig, hält rulio die Anfrage bis zu 25 s offen und antwortet
  sofort, wenn eine Chat-Nachricht kommt. Ein Chat-Lauf startet so in Sekunden.
  Bei Fehlern wartet es eine Minute.
- **Lauf:** Ist ein Lauf fällig, startet Agentio `claude -p` mit einer
  temporären MCP-Konfiguration, die **nur** rulio enthält. Erlaubt ist nur
  `mcp__rulio__*` (bei Bericht-Läufen zusätzlich Unteragenten, bei Web-Recherche
  zusätzlich `WebSearch`/`WebFetch`). Zeitdeckel und
  Schrittdeckel kommen aus rulio.
- **Ergebnis:** Am Ende meldet es Status, Zusammenfassung, Schritte, Modell und
  Kosten zurück. In rulio steht alles im KI-Agent-Bereich unter **Protokoll**.

## Entwickeln

```bash
npm install
npm test        # TypeScript bauen und Tests ausführen
```

Commit-Nachrichten und Code-Kommentare schreiben wir auf Englisch.

Für rulio selbst baut `.github/workflows/image.yml` bei einem Push nach `main`
ein Image für den eigenen Betrieb. Es liegt privat auf ghcr.io.

## Lizenz

[MIT](LICENSE). Claude Code ist nicht Teil dieses Repos und steht unter den
Bedingungen von Anthropic.
