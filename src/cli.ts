#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadConfig, type Config } from "./config.js";
import { finish, nextPollDelay, poll } from "./rulio.js";
import { runClaude } from "./claude.js";

/**
 * rulio-agent — regularly asks rulio whether a run is due and lets Claude Code
 * work through it. WHEN a run is due is decided by rulio (schedule in the
 * app); this program only executes.
 *
 *   rulio-agent run     keep running (default)
 *   rulio-agent once    ask once and execute a due run, if any
 *   rulio-agent check   check the setup (rulio key, Claude Code)
 */
const HELP = `Usage: rulio-agent [command]

Commands:
  run     keep running and execute due runs (default)
  once    ask rulio once, execute a due run if any, then exit
  check   check the setup (rulio key, Claude Code login)
  help    show this help

Environment:
  RULIO_TOKEN              key from rulio (required): rulio → AI agent → Connection
  RULIO_URL                rulio address (default https://api.rulio.net)
  CLAUDE_BIN               path to claude (default claude)
  RULIO_CLIENT_NAME        name shown in rulio (default rulio-agent@<host>)
  RULIO_AGENT_USE_API_KEY  1 = use ANTHROPIC_API_KEY instead of the subscription

More: https://github.com/netlibrary/rulio-agent`;
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

/** One poll, possibly one run; returns seconds until the next poll */
async function cycle(cfg: Config): Promise<number> {
  const asked = Date.now();
  const reply = await poll(cfg);
  if (!reply.enabled) log("Emergency stop active — no run");
  const delay = nextPollDelay(reply, Date.now() - asked);
  if (!reply.run) return delay;
  const order = reply.run;
  log(`Run ${order.id} (${order.trigger}${order.kind === "report" ? ", report" : ""}) — at most ${order.maxMinutes} min${order.allowSubagents ? ", with subagents" : ""}${order.web ? ", with web research" : ""}`);
  const started = Date.now();
  const result = await runClaude(cfg, order);
  log(`Run ${order.id}: ${result.status} after ${Math.round((Date.now() - started) / 1000)} s${result.error ? ` — ${result.error}` : ""}`);
  await finish(cfg, order.id, result).catch((err: Error) => log(`Result not reported: ${err.message}`));
  return delay;
}

function check(cfg: Config): Promise<void> {
  const v = spawnSync(cfg.claudeBin, ["--version"], { encoding: "utf8" });
  if (v.error || v.status !== 0) {
    throw new Error(`Claude Code not found (${cfg.claudeBin}). Install it and log in: https://code.claude.com — or set CLAUDE_BIN.`);
  }
  log(`Claude Code: ${v.stdout.trim()}`);
  // Runs need a logged-in Claude Code (claude auth login or CLAUDE_CODE_OAUTH_TOKEN)
  const auth = spawnSync(cfg.claudeBin, ["auth", "status", "--text"], { encoding: "utf8" });
  const authText = `${auth.stdout ?? ""}${auth.stderr ?? ""}`;
  if (/not logged in/i.test(authText) && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error("Claude Code is not logged in. Run `claude auth login` once (PC), or run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN (VM/Docker).");
  }
  log("Claude Code: logged in");
  if (process.env.ANTHROPIC_API_KEY && !cfg.useApiKey) {
    log("Note: ANTHROPIC_API_KEY is set but removed for runs (subscription instead of API). RULIO_AGENT_USE_API_KEY=1 uses it.");
  }
  return fetch(`${cfg.rulioUrl}/api/agent/state`, { headers: { Authorization: `Bearer ${cfg.rulioToken}` } }).then(async (r) => {
    if (!r.ok) throw new Error(`rulio key rejected (${r.status}) — create a new one in rulio.`);
    const s = (await r.json()) as { settings: { enabled: boolean; broker: string } };
    log(`rulio: connected (${cfg.rulioUrl}) — agent ${s.settings.enabled ? "active" : "paused"}, paper account ${s.settings.broker}`);
  });
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "run";
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  const cfg = loadConfig();
  if (cmd === "check") return check(cfg);
  // Before the first run: say right away if the Claude login is missing or the key does not fit
  await check(cfg);
  if (cmd === "once") {
    await cycle(cfg);
    return;
  }
  if (cmd !== "run") throw new Error(`Unknown command "${cmd}" (run, once, check, help)`);
  log(`rulio-agent running as ${cfg.clientName} against ${cfg.rulioUrl}`);
  for (;;) {
    let wait = 60;
    try {
      wait = await cycle(cfg);
    } catch (err) {
      log(`Error: ${(err as Error).message} — retrying shortly`);
    }
    if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
