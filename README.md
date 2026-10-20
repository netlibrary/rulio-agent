<!-- When you change this file, update both: README.md (English) and README.de.md (German). -->

# rulio-agent

🇩🇪 [Deutsch](README.de.md)

Lets your own AI agent (Claude Code) work with [rulio](https://rulio.net)
**on a schedule**. It reads your account and the market lists, compares ideas,
creates its own rules **in the paper account** and writes reports. All of this
happens within the limits you set in rulio.

**When** a run is due is decided by rulio. You set it up in the app: before the
open, every N minutes during market hours, after the close, on events, or via
chat or a task. This program only checks in regularly and executes.

## What the agent may do

- **rulio only:** The agent works exclusively with the rulio tools (MCP).
  Claude Code's built-in tools such as Bash, reading and writing files, or web
  access are off (web only in report runs that allow it, see below), and so are
  other MCP servers.
- **Subagents:** In report runs it may also start subagents. They have the same
  limits.
- **Web research in report runs:** If the report's workflow allows it (in the
  app: report workflow → "Web research allowed"; on by default for theme
  research), rulio marks the run with `web`. Only then rulio-agent additionally
  allows Claude Code's `WebSearch` and `WebFetch` — searching the web and
  reading pages. Shell, files and other MCP servers stay off. Because web
  pages can contain planted instructions, **rulio rejects every changing tool
  in such a run on the server** (creating, changing or deleting rules, exits,
  core fill, proposals, lists, drawings, notes); reading and the report itself
  remain allowed. Rejected calls appear in the log. Web research uses more of
  your AI subscription.
- **rulio enforces** on the server, independently of this program:
  - its own rules only in the paper account, never with real money;
  - budget, number of rules and new rules per day;
  - emergency stop;
  - exactly one account per key.

  For your real account the agent can only **suggest**; you decide whether to
  adopt it.

## Requirements

1. **A rulio account:** In the app under **AI agent › Connection**, create a
   key (`rulio_…`). It is valid for exactly one account and can be revoked
   there at any time. You set the schedule in the AI agent section.
2. **[Claude Code](https://code.claude.com)** with your own subscription
   (Pro/Max) or API key. rulio-agent only starts the unmodified `claude`
   program. It never reads your login.
3. **Node.js 20** or newer (for option 2).

## Option 1: Cloud routine (no machine of your own)

Claude Code can run scheduled jobs ("routines") in the cloud, at most hourly,
on your subscription.

1. **Repository:** Fork this repo and pick the fork as the repository in
   https://claude.ai/code/routines. The `.mcp.json` in the root directory adds
   rulio; it contains no key.
2. **Key:** In the environment under **Network secrets**, add an entry: allowed
   website `api.rulio.net`, header `Authorization`, prefix `Bearer`, value =
   your `rulio_…` key. Do not add it as a normal environment variable; anyone
   with access to the environment can see those.
3. **Prompt:** the content of [`routine/PROMPT.md`](routine/PROMPT.md).
4. **Trigger:** hourly on weekdays. On every run rulio decides whether there is
   really something to do; otherwise the run is over in seconds.
5. **Check:** After the first run, look in the rulio log to see whether it
   arrived.

## Option 2: On your machine

```bash
claude auth login                                  # once, with your Claude subscription
npm install -g github:netlibrary/rulio-agent
RULIO_TOKEN=rulio_… rulio-agent check              # check the connection
RULIO_TOKEN=rulio_… rulio-agent run                # keep it running
```

On Windows (PowerShell): `$env:RULIO_TOKEN="rulio_…"; rulio-agent run`

`rulio-agent once` runs at most one due run and exits. That suits a schedule of
your own, for example via cron or Task Scheduler.

## Option 3: On a server (Docker)

You build the image yourself from this repo. The build downloads Claude Code
from npm. There is no ready-made image with Claude Code to download: Claude
Code belongs to Anthropic and is not redistributed by us.

```bash
claude setup-token        # on your machine: creates a token for scripts
docker build -t rulio-agent https://github.com/netlibrary/rulio-agent.git
docker run -d --restart unless-stopped \
  -e RULIO_TOKEN=rulio_… \
  -e CLAUDE_CODE_OAUTH_TOKEN=… \
  rulio-agent
```

If the agent does not check in for more than 10 minutes, rulio shows it as
offline.

## Settings (environment variables)

| Variable | Meaning | Default |
| --- | --- | --- |
| `RULIO_TOKEN` | Key from rulio (required) | — |
| `RULIO_URL` | rulio address | `https://api.rulio.net` |
| `CLAUDE_BIN` | Path to `claude` | `claude` |
| `RULIO_CLIENT_NAME` | Name shown in rulio ("agent online") | `rulio-agent@<host>` |
| `RULIO_AGENT_USE_API_KEY` | `1` = use `ANTHROPIC_API_KEY` instead of the subscription | off |

If `ANTHROPIC_API_KEY` is set, rulio-agent removes it for the runs. That way the
agent runs on your subscription and not on API costs. This does not apply if
`RULIO_AGENT_USE_API_KEY=1` is set.

## How a run works

- **Polling:** rulio-agent calls `POST /api/agent/runner/poll` as a long poll.
  If nothing is due, rulio keeps the request open for up to 25 s and answers
  immediately when a chat message arrives. A chat run therefore starts within
  seconds. On errors it waits a minute.
- **Run:** When a run is due, rulio-agent starts `claude -p` with a temporary
  MCP configuration that contains **only** rulio. Only `mcp__rulio__*` is
  allowed (plus subagents in report runs, plus `WebSearch`/`WebFetch` in report
  runs with web research). Time and turn limits come from rulio.
- **Result:** At the end it reports status, summary, turns, model and cost back
  to rulio. In rulio you find everything in the AI agent section under **Log**.

## Development

```bash
npm install
npm test        # build TypeScript and run the tests
```

Please write commit messages and code comments in English.

For rulio itself, `.github/workflows/image.yml` builds an image for its own
operation on a push to `main`. It is kept private on ghcr.io.

## License

[MIT](LICENSE). Claude Code is not part of this repo and is subject to
Anthropic's terms.
