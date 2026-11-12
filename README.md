<!-- When you change this file, update both: README.md (English) and README.de.md (German). -->

# Agentio

🇩🇪 [Deutsch](README.de.md)

Agentio is a small program that lets your own AI agent (Claude Code or OpenCode)
work with [rulio](https://rulio.net) **on a schedule**. It reads your account and
the market lists, compares ideas, creates its own rules **in the paper account** and writes reports. All of this
happens within the limits you set in rulio.

**When** a run is due is decided by rulio. You set it up in the app: before the
open, every N minutes during market hours, after the close, on events, or via
chat or a task. This program only checks in regularly and executes.

The command is `agentio`. The older name `rulio-agent` starts the same program,
so existing scripts keep working.

## What the agent may do

- **rulio only:** The agent works exclusively with the rulio tools (MCP).
  Claude Code's built-in tools such as Bash, reading and writing files, or web
  access are off (web only in report runs that allow it, see below), and so are
  other MCP servers.
- **Subagents:** In report runs it may also start subagents. They have the same
  limits.
- **Web research in report runs:** If the report's workflow allows it (in the
  app: report workflow → "Web research allowed"; on by default for theme
  research), rulio marks the run with `web`. Only then Agentio additionally
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
   (Pro/Max) or API key. Agentio only starts the unmodified `claude`
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
RULIO_TOKEN=rulio_… agentio check              # check the connection
RULIO_TOKEN=rulio_… agentio run                # keep it running
```

On Windows (PowerShell): `$env:RULIO_TOKEN="rulio_…"; agentio run`

`agentio once` runs at most one due run and exits. That suits a schedule of
your own, for example via cron or Task Scheduler.

## Option 3: On a server (Docker)

You build the image yourself from this repo. The build downloads Claude Code
from npm. There is no ready-made image with Claude Code to download: Claude
Code belongs to Anthropic and is not redistributed by us.

### With the script (set up, update, restart)

```bash
claude setup-token        # on your machine: creates a token for scripts
curl -fsSLo ~/agentio.sh https://raw.githubusercontent.com/netlibrary/rulio-agent/main/scripts/agentio.sh && chmod +x ~/agentio.sh
~/agentio.sh              # set up or update
```

- The script always creates the container the same way: name `agentio`,
  `--restart unless-stopped`, the named volume `agentio-keys` for the keys, the
  variables from `~/agentio.env` (mode `600`).
- On the first run it creates `~/agentio.env` with placeholders. Put your rulio
  key and the Claude token in it and run the script again.
- **Updating** means running it again: it fetches the image, removes the old
  container and starts a new one with the same settings. Volume and file stay.
- **Taking over an older installation:** If a container `rulio-agent` (or
  `agentio`) runs without the named volume, the script takes over its
  variables once into `~/agentio.env` (without showing them) and copies its key
  files into `agentio-keys`, also from an unnamed volume. Only then does it
  remove the old container. It says how many account keys it took over.
- If the new container does not start or reports no keys, the old one runs
  again and nothing is deleted. The script never deletes a volume and never
  prints a key.
- At the end it shows `agentio status`.
- It uses the image `ghcr.io/netlibrary/rulio-agent:latest`. With an image you
  built yourself: `AGENTIO_IMAGE=rulio-agent AGENTIO_PULL=0 ~/agentio.sh`.

### By hand (advanced)

```bash
docker build -t rulio-agent https://github.com/netlibrary/rulio-agent.git
docker run -d --restart unless-stopped --name agentio \
  -v agentio-keys:/home/agent/.rulio-agent \
  -e RULIO_TOKEN=rulio_… \
  -e CLAUDE_CODE_OAUTH_TOKEN=… \
  rulio-agent
```

The named volume (`-v agentio-keys:…`) must not be left out. Without it Docker
creates an unnamed volume, and the added keys are hard to find again when the
container is created anew.

If the agent does not check in for more than 10 minutes, rulio shows it as
offline.

## Several accounts in one container

One key belongs to exactly one account. For a second account, create another
key in that account and add it to the running container. No restart is needed:

```bash
docker exec agentio agentio add-key rulio_…
```

| Command | What it does |
| --- | --- |
| `agentio add-key <rulio_…>` | Adds a key to `~/.rulio-agent/keys` (mode `600`). A running Agentio picks it up within 30 s. |
| `agentio remove-key <…last 6 characters>` | Removes a key from the file. A key in `RULIO_TOKEN` stays. |
| `agentio list-keys` | Shows the keys by their last 6 characters. |
| `agentio status` | Shows the keys by their last 6 characters, for each provider only whether its key is set and where from (file or variable), and the Claude login. Never a key. |

- **One run at a time:** Runs from all accounts wait for each other, first come,
  first served. While a run is going on, every account keeps checking in at
  least once a minute, so rulio shows none of them as offline.
- **Separate accounts:** A run only gets the key of its own account and only
  sees that account.
- **A due run** is picked up in a request of its own, one at a time and only
  while no other run is going on.
- **A revoked key:** It is logged once and tried again every 30 minutes. The
  other keys keep running.
- `check` checks all keys, `once` asks with each key once.
- Keys appear in the log only by their last 6 characters.

**Switching from an older container:** Build and start it once with the command
above. `RULIO_TOKEN` keeps working. If `add-key` is missing, you are on an older
version.

## Other models (OpenCode)

A key in rulio can have its own model. Runs for that key then use
[OpenCode](https://opencode.ai) instead of Claude Code. A key without a model
runs with Claude Code as before, and your Claude subscription stays there.

The container includes OpenCode with a fixed version. Elsewhere install it with
`npm install -g opencode-ai@1.19.5`.

### Set or replace the provider key

```bash
docker exec -it agentio agentio set-provider-key opencode
Key for opencode (not shown): ********
Key for opencode stored. It counts from the next run, no restart needed.
```

- The key is asked for hidden and is never an argument, so it does not stay in
  the shell history. Without a terminal it is read from standard input:
  `docker exec -i agentio agentio set-provider-key opencode < key.txt`.
- Providers: `opencode` (`OPENCODE_API_KEY`), `openrouter` (`OPENROUTER_API_KEY`).
  Other variables from `RULIO_AGENT_OPENCODE_KEYS` are set by their name.
- It is stored in the volume next to the rulio keys (`~/.rulio-agent/provider-keys`,
  mode `600`) and goes before a variable of the container. Every run reads it
  again, so a new key needs no restart.
- `agentio remove-provider-key opencode` removes it; the variable of the
  container then counts again, if there is one.
- `agentio status` shows whether a key is set, never the key.

Fallback: pass the key as a variable of the container. Changing it then means
creating the container again.

```bash
docker run -d … -e OPENCODE_API_KEY=… rulio-agent
```

`OPENCODE_API_KEY` is the key from the [OpenCode Console](https://opencode.ai/console),
for OpenCode Zen (billed per use) or OpenCode Go (subscription with usage limits).
For models from [OpenRouter](https://openrouter.ai/) pass `OPENROUTER_API_KEY`
instead. Models are named `provider/model`, so the provider is part of the model
chosen in rulio. Another provider only needs its key: list the variable in
`RULIO_AGENT_OPENCODE_KEYS`.

With every poll Agentio tells rulio about its setup, so the app can show
where it runs and whether the model can be paid for: running in Docker (yes or
no, from `/.dockerenv`), Claude Code logged in (yes, no, unknown; checked at the
start and at most every 10 minutes), using `RULIO_AGENT_USE_API_KEY` (yes or no),
a provider key present (yes or no, stored or as a variable). It never sends a key, the value of a variable
or its name.

The safeguards are the same as with Claude Code:

- Only the rulio tools. Shell, files, web and subagents are denied. Report runs
  with web research also get OpenCode's `webfetch` (reading a page) and
  `websearch` (searching the web); rulio then refuses every changing call for
  the whole run, as with Claude Code.
- Its own empty working directory, configuration and data per run, removed
  afterwards. Other configurations are not read, and of the environment only the
  variables needed to start and the provider keys are passed on.
- Agentio enforces the time and step limits itself and ends the process. If
  the next step has already started at that moment, its tool call may still be
  carried out by rulio.

`websearch` uses the search service Exa (mcp.exa.ai): no key and no setting
needed, the search queries go to Exa. Report runs with subagents run without
subagents. Cost per run is only reported where the provider
bills per use, not for providers listed in `RULIO_AGENT_FLAT_PROVIDERS`.

## Settings (environment variables)

| Variable | Meaning | Default |
| --- | --- | --- |
| `RULIO_TOKEN` | Key from rulio (or use `add-key`) | — |
| `RULIO_URL` | rulio address | `https://api.rulio.net` |
| `CLAUDE_BIN` | Path to `claude` | `claude` |
| `OPENCODE_BIN` | Path to `opencode` | `opencode` |
| `RULIO_AGENT_OPENCODE_DEPS` | Folder with the packages OpenCode would otherwise install on every run; included in the container. Without it, a run needs about 190 MB in the temp folder | `/opt/opencode-deps` |
| `OPENCODE_API_KEY` | Provider key for keys with their own model; a key stored with `set-provider-key` goes first | — |
| `OPENROUTER_API_KEY` | The same for models from OpenRouter | — |
| `RULIO_AGENT_OPENCODE_KEYS` | Names of the variables with provider keys | `OPENCODE_API_KEY,OPENROUTER_API_KEY` |
| `RULIO_AGENT_FLAT_PROVIDERS` | Providers billed by subscription, no cost per run | `opencode-go` |
| `RULIO_CLIENT_NAME` | Name shown in rulio ("agent online") | `rulio-agent@<host>` |
| `RULIO_AGENT_USE_API_KEY` | `1` = use `ANTHROPIC_API_KEY` instead of the subscription | off |

If `ANTHROPIC_API_KEY` is set, Agentio removes it for the runs. That way the
agent runs on your subscription and not on API costs. This does not apply if
`RULIO_AGENT_USE_API_KEY=1` is set.

The agent always waits for the rulio tools before the first step, even when it is
started from a terminal of the Claude desktop app: Agentio removes
`MCP_CONNECTION_NONBLOCKING` (which the app may pass on) for the runs.

## How a run works

- **Polling:** Agentio calls `POST /api/agent/runner/poll` as a long poll.
  If nothing is due, rulio keeps the request open for up to 25 s and answers
  immediately when a chat message arrives. A chat run therefore starts within
  seconds. On errors it waits a minute.
- **Run:** When a run is due, Agentio starts `claude -p` with a temporary
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
