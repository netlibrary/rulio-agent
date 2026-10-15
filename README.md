# rulio-agent

Lässt einen KI-Agenten (Claude Code) **nach Zeitplan** mit
[rulio](https://rulio.net) arbeiten: Er liest dein Konto und die Marktlisten,
prüft Regeln und legt eigene Regeln **im Paper-Konto** an — in den Grenzen, die
du in rulio festlegst (Einstellungen → KI-Agent → Auftrag).

**WANN** ein Lauf fällig ist, entscheidet rulio (Zeitplan in der App: vor
Öffnung, alle N Minuten während der Handelszeit, nach Schluss, „Jetzt laufen
lassen"). Dieses Programm fragt nur regelmäßig nach und führt aus.

Was der Agent darf und was nicht, erzwingt rulio selbst — nicht dieses Programm:
nur eigene Regeln, nur Paper-Konto, Budget, Anzahl, Notaus.

## Voraussetzungen

1. In rulio: Einstellungen → **KI-Agent** → Verbindung → Schlüssel erzeugen
   (`rulio_…`). Unter **Auftrag** Zeitplan einschalten.
2. [Claude Code](https://code.claude.com) mit deinem eigenen Abo (Pro/Max) oder
   API-Schlüssel. rulio-agent startet nur das unveränderte `claude`-Programm und
   liest deinen Login nie.

## Weg 1: Cloud-Routine (ohne eigenen Rechner)

Claude Code kann geplante Läufe („Routines") in der Cloud ausführen, frühestens
stündlich, auf deinem Abo.

1. Dieses Repo (bzw. einen Fork) in https://claude.ai/code/routines als
   Repository wählen — die `.mcp.json` im Wurzelverzeichnis bindet rulio ein.
2. In der Umgebung unter **Network secrets** einen Eintrag anlegen:
   erlaubte Website `api.rulio.net`, Header `Authorization`, Präfix `Bearer`,
   Wert = dein `rulio_…`-Schlüssel. (Nicht als normale Umgebungsvariable — die
   sieht jeder mit Zugriff auf die Umgebung.)
3. Prompt: Inhalt von [`routine/PROMPT.md`](routine/PROMPT.md).
4. Auslöser: stündlich an Werktagen (Voreinstellung „hourly" bzw. „weekdays"
   plus `/schedule update` mit Cron). Die nächste Ausführungszeit in der
   Oberfläche prüfen — wie Cron-Zeiten in deine Zeitzone fallen, ist dort zu
   sehen. rulio entscheidet bei jedem Lauf, ob wirklich etwas zu tun ist —
   sonst ist der Lauf nach Sekunden fertig.
5. Hinweis: Ob das Network Secret auch für den MCP-Verkehr gilt, ist in der
   Anthropic-Dokumentation nicht ausdrücklich beschrieben — beim ersten Lauf
   im rulio-Protokoll prüfen, ob er ankommt.

## Weg 2: Auf deinem PC

```bash
claude auth login          # einmal, mit deinem Claude-Abo
npm install -g github:netlibrary/rulio-agent   # privates Repo: gh auth login vorher
RULIO_TOKEN=rulio_… rulio-agent check
RULIO_TOKEN=rulio_… rulio-agent run
```

Windows (PowerShell): `$env:RULIO_TOKEN="rulio_…"; rulio-agent run`

## Weg 3: Auf einer VM (Docker)

```bash
claude setup-token         # auf deinem Rechner: erzeugt ein Token für Skripte
docker build -t rulio-agent https://github.com/netlibrary/rulio-agent.git
docker run -d --restart unless-stopped \
  -e RULIO_TOKEN=rulio_… \
  -e CLAUDE_CODE_OAUTH_TOKEN=… \
  rulio-agent
```

Für den Dauerbetrieb bei rulio baut `.github/workflows/image.yml` das Image
nach `ghcr.io/netlibrary/rulio-agent`; ausgerollt wird es aus
netlibrary/finance-deployment (`deploy-agent.yml`, eingesperrt: nur lesbares
Dateisystem, keine Rechte, gedeckelter Speicher). Fragt der Agent länger als
10 Minuten nicht nach, meldet rulio ihn als offline.

## Einstellungen (Umgebungsvariablen)

| Variable | Bedeutung | Standard |
| --- | --- | --- |
| `RULIO_TOKEN` | Schlüssel aus rulio (Pflicht) | — |
| `RULIO_URL` | rulio-Adresse | `https://api.rulio.net` |
| `CLAUDE_BIN` | Pfad zu `claude` | `claude` |
| `RULIO_CLIENT_NAME` | Name in rulio („Agent online") | `rulio-agent@<Rechner>` |
| `RULIO_AGENT_USE_API_KEY` | `1` = `ANTHROPIC_API_KEY` nutzen statt Abo | aus |

Ist `ANTHROPIC_API_KEY` gesetzt, entfernt rulio-agent ihn für die Läufe, damit
dein Abo genutzt wird (sonst liefe es auf API-Kosten) — außer
`RULIO_AGENT_USE_API_KEY=1`.

## So läuft ein Lauf ab

- rulio-agent fragt jede Minute `POST /api/agent/runner/poll`.
- Ist ein Lauf fällig, startet es `claude -p` mit einer temporären
  MCP-Konfiguration, die **nur** rulio enthält; eingebaute Werkzeuge (Bash,
  Dateien lesen …) sind aus, nur `mcp__rulio__*` ist erlaubt. Zeitdeckel und
  Schrittdeckel kommen aus rulio.
- Am Ende meldet es Status, Zusammenfassung, Schritte und Kosten zurück. In
  rulio steht alles unter KI-Agent → Protokoll.
