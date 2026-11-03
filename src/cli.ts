#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadSettings, type Config, type Settings } from "./config.js";
import { Agents, askOnce, type AgentDeps } from "./agents.js";
import { addKey, allKeys, keysFile, keyTail, redactKeys, removeKey } from "./keys.js";
import { finish, poll } from "./rulio.js";
import { runClaude } from "./claude.js";

/**
 * rulio-agent — regularly asks rulio whether a run is due and lets Claude Code
 * work through it. WHEN a run is due is decided by rulio (schedule in the
 * app); this program only executes.
 *
 *   rulio-agent run                keep running (default)
 *   rulio-agent once               ask once with each key and execute due runs
 *   rulio-agent check              check the setup (rulio keys, Claude Code)
 *   rulio-agent add-key <key>      add a key for another account
 *   rulio-agent remove-key <tail>  remove a key by its last 6 characters
 *   rulio-agent list-keys          show the keys by their last 6 characters
 */
const HELP = `Usage: rulio-agent [command]

Commands:
  run                 keep running and execute due runs, one at a time (default)
  once                ask rulio once with each key, execute due runs, then exit
  check               check the setup (all rulio keys, Claude Code login)
  add-key <rulio_…>   add a key for another account; a running rulio-agent picks it up within 30 s
  remove-key <…tail>  remove a key from the file by its last 6 characters
  list-keys           show the keys by their last 6 characters
  help                show this help

Environment:
  RULIO_TOKEN              key from rulio: rulio → AI agent → Connection (or use add-key)
  RULIO_URL                rulio address (default https://api.rulio.net)
  CLAUDE_BIN               path to claude (default claude)
  RULIO_CLIENT_NAME        name shown in rulio (default rulio-agent@<host>)
  RULIO_AGENT_USE_API_KEY  1 = use ANTHROPIC_API_KEY instead of the subscription

More: https://github.com/netlibrary/rulio-agent`;
const log = (msg: string) => console.log(`${new Date().toISOString()} ${redactKeys(msg)}`);

const NO_KEYS = "No rulio key: set RULIO_TOKEN or run `rulio-agent add-key rulio_…` (rulio → AI agent → Connection).";

function checkClaude(settings: Settings): void {
  const v = spawnSync(settings.claudeBin, ["--version"], { encoding: "utf8" });
  if (v.error || v.status !== 0) {
    throw new Error(`Claude Code not found (${settings.claudeBin}). Install it and log in: https://code.claude.com — or set CLAUDE_BIN.`);
  }
  log(`Claude Code: ${v.stdout.trim()}`);
  // Runs need a logged-in Claude Code (claude auth login or CLAUDE_CODE_OAUTH_TOKEN)
  const auth = spawnSync(settings.claudeBin, ["auth", "status", "--text"], { encoding: "utf8" });
  const authText = `${auth.stdout ?? ""}${auth.stderr ?? ""}`;
  if (/not logged in/i.test(authText) && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error("Claude Code is not logged in. Run `claude auth login` once (PC), or run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN (VM/Docker).");
  }
  log("Claude Code: logged in");
  if (process.env.ANTHROPIC_API_KEY && !settings.useApiKey) {
    log("Note: ANTHROPIC_API_KEY is set but removed for runs (subscription instead of API). RULIO_AGENT_USE_API_KEY=1 uses it.");
  }
}

async function checkKey(cfg: Config): Promise<void> {
  const r = await fetch(`${cfg.rulioUrl}/api/agent/state`, { headers: { Authorization: `Bearer ${cfg.rulioToken}` } });
  if (!r.ok) throw new Error(`rulio key ${keyTail(cfg.rulioToken)} rejected (${r.status}) — create a new one in rulio.`);
  const s = (await r.json()) as { settings: { enabled: boolean; broker: string } };
  log(`rulio ${keyTail(cfg.rulioToken)}: connected (${cfg.rulioUrl}) — agent ${s.settings.enabled ? "active" : "paused"}, paper account ${s.settings.broker}`);
}

/** Check every key; returns the errors, one per key that failed */
async function checkKeys(configs: Config[]): Promise<Error[]> {
  const errors: Error[] = [];
  for (const cfg of configs) {
    await checkKey(cfg).catch((err: Error) => {
      log(err.message);
      errors.push(err);
    });
  }
  return errors;
}

function keyCommand(cmd: string, arg: string | undefined): void {
  const path = keysFile();
  if (cmd === "list-keys") {
    const keys = allKeys(process.env, path);
    if (!keys.length) console.log(NO_KEYS);
    for (const k of keys) console.log(`${keyTail(k.key)}  ${k.source === "file" ? path : k.source}`);
    return;
  }
  if (!arg) throw new Error(cmd === "add-key" ? "Usage: rulio-agent add-key <rulio_…>" : "Usage: rulio-agent remove-key <last 6 characters>");
  if (cmd === "add-key") {
    console.log(addKey(path, arg) ? `Key ${keyTail(arg)} added. A running rulio-agent picks it up within 30 s.` : `Key ${keyTail(arg)} is already there.`);
    return;
  }
  console.log(`Key ${keyTail(removeKey(path, arg))} removed. A running rulio-agent stops using it within 30 s.`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "run";
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  if (cmd === "add-key" || cmd === "remove-key" || cmd === "list-keys") {
    keyCommand(cmd, process.argv[3]);
    return;
  }
  if (cmd !== "run" && cmd !== "once" && cmd !== "check") throw new Error(`Unknown command "${cmd}" (run, once, check, add-key, remove-key, list-keys, help)`);
  const settings = loadSettings();
  const path = keysFile();
  const keys = () => allKeys(process.env, path).map((k) => k.key);
  const first = keys();
  if (!first.length && cmd !== "run") throw new Error(NO_KEYS);
  const configs = first.map((rulioToken): Config => ({ ...settings, rulioToken }));
  checkClaude(settings);
  // Before the first run: say right away if the Claude login is missing or a key does not fit
  const failed = await checkKeys(configs);
  if (cmd === "check") {
    if (failed.length === 1) throw failed[0]!;
    if (failed.length) throw new Error(`${failed.length} of ${configs.length} keys failed`);
    return;
  }
  // A key that does not work must not hold up the others; without any working key there is nothing to do
  if (configs.length && failed.length === configs.length) throw failed[0]!;
  const deps: AgentDeps = { poll, runClaude, finish, log, keys };
  if (cmd === "once") {
    const errors: Error[] = [];
    for (const cfg of configs) {
      await askOnce(deps, cfg).catch((err: Error) => {
        log(`${keyTail(cfg.rulioToken)} Error: ${err.message}`);
        errors.push(err);
      });
    }
    if (errors.length === 1) throw errors[0]!;
    if (errors.length) throw new Error(`${errors.length} of ${configs.length} keys failed`);
    return;
  }
  // Without a key it waits for one: a container that keeps restarting could not take `docker exec … add-key`
  if (!configs.length) log(`${NO_KEYS} Waiting for one.`);
  log(`rulio-agent running as ${settings.clientName} against ${settings.rulioUrl} with ${configs.length} ${configs.length === 1 ? "key" : "keys"}`);
  new Agents(settings, deps).start();
  // The loops keep the process alive and handle their own errors
}

main().catch((err: Error) => {
  console.error(redactKeys(err.message));
  process.exit(1);
});
