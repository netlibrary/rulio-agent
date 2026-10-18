<!-- Bei Änderungen beide Dateien anpassen: README.md (Englisch) und README.de.md (Deutsch). -->

# rulio-agent

🇬🇧 [English](README.md)

Lässt deinen eigenen KI-Agenten (Claude Code) **nach Zeitplan** mit
[rulio](https://rulio.net) arbeiten. Er liest dein Konto und die Marktlisten,
vergleicht Ideen, legt eigene Regeln **im Paper-Konto** an und schreibt
Berichte. Das alles geschieht in den Grenzen, die du in rulio festlegst.

**Wann** ein Lauf fällig ist, entscheidet rulio. Das stellst du in der App ein:
vor Öffnung, alle N Minuten während der Handelszeit, nach Schluss, bei
Ereignissen oder per Chat bzw. Auftrag. Dieses Programm fragt nur regelmäßig
nach und führt aus.

## Was der Agent darf

- **Nur rulio:** Der Agent arbeitet ausschließlich mit den rulio-Werkzeugen
  (MCP). Eingebaute Werkzeuge von Claude Code wie Bash, Dateien lesen und
  schreiben oder Web sind aus, andere MCP-Server ebenso.
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
   oder API-Schlüssel. rulio-agent startet nur das unveränderte
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
RULIO_TOKEN=rulio_… rulio-agent check              # Verbindung prüfen
RULIO_TOKEN=rulio_… rulio-agent run                # dauerhaft laufen lassen
```

Unter Windows (PowerShell): `$env:RULIO_TOKEN="rulio_…"; rulio-agent run`

`rulio-agent once` führt höchstens einen fälligen Lauf aus und endet. Das
eignet sich für einen eigenen Zeitplan, etwa per Cron oder Aufgabenplanung.

## Weg 3: Auf einem Server (Docker)

Das Image baust du selbst aus diesem Repo. Dabei lädt der Build Claude Code
aus npm. Ein fertiges Image mit Claude Code gibt es nicht zum Herunterladen:
Claude Code gehört Anthropic und wird nicht von uns weiterverteilt.

```bash
claude setup-token        # auf deinem Rechner: erzeugt ein Token für Skripte
docker build -t rulio-agent https://github.com/netlibrary/rulio-agent.git
docker run -d --restart unless-stopped \
  -e RULIO_TOKEN=rulio_… \
  -e CLAUDE_CODE_OAUTH_TOKEN=… \
  rulio-agent
```

Fragt der Agent länger als 10 Minuten nicht nach, meldet rulio ihn als offline.

## Einstellungen (Umgebungsvariablen)

| Variable | Bedeutung | Standard |
| --- | --- | --- |
| `RULIO_TOKEN` | Schlüssel aus rulio (Pflicht) | — |
| `RULIO_URL` | rulio-Adresse | `https://api.rulio.net` |
| `CLAUDE_BIN` | Pfad zu `claude` | `claude` |
| `RULIO_CLIENT_NAME` | Name in rulio („Agent online“) | `rulio-agent@<Rechner>` |
| `RULIO_AGENT_USE_API_KEY` | `1` = `ANTHROPIC_API_KEY` nutzen statt Abo | aus |

Ist `ANTHROPIC_API_KEY` gesetzt, entfernt rulio-agent ihn für die Läufe. So
läuft der Agent auf deinem Abo und nicht auf API-Kosten. Das gilt nicht, wenn
`RULIO_AGENT_USE_API_KEY=1` gesetzt ist.

## So läuft ein Lauf ab

- **Abfragen:** rulio-agent fragt `POST /api/agent/runner/poll` im Long-Poll.
  Ist nichts fällig, hält rulio die Anfrage bis zu 25 s offen und antwortet
  sofort, wenn eine Chat-Nachricht kommt. Ein Chat-Lauf startet so in Sekunden.
  Bei Fehlern wartet es eine Minute.
- **Lauf:** Ist ein Lauf fällig, startet rulio-agent `claude -p` mit einer
  temporären MCP-Konfiguration, die **nur** rulio enthält. Erlaubt ist nur
  `mcp__rulio__*` (bei Bericht-Läufen zusätzlich Unteragenten). Zeitdeckel und
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
