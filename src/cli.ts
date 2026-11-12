#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadSettings, type Config, type Settings } from "./config.js";
import { Agents, askOnce, type AgentDeps } from "./agents.js";
import { addKey, allKeys, keysFile, keyTail, redactKeys, removeKey } from "./keys.js";
import { providerKeySources, providerLabel, providerSecrets, providerVariable, redactSecrets, removeProviderKey, setProviderKey, withProviderKeys } from "./providerKeys.js";
import { finish, poll } from "./rulio.js";
import { currentSetup } from "./setup.js";
import { runEngine } from "./engine.js";
import { HELP, keyAdded, keyRemoved, NO_KEYS, NO_PROVIDER_KEY_GIVEN, providerKeyRemoved, providerKeySet, startLine } from "./texts.js";

/**
 * Agentio (command `agentio`, also `rulio-agent`) — regularly asks rulio whether a run is due and lets Claude Code
 * or, for a key with its own model, OpenCode work through it. WHEN a run is due
 * is decided by rulio (schedule in the app); this program only executes.
 *
 *   agentio run                    keep running (default)
 *   agentio once                   ask once with each key and execute due runs
 *   agentio check                  check the setup (rulio keys, Claude Code)
 *   agentio status                 keys, provider keys (set or not) and the Claude login
 *   agentio add-key <key>          add a key for another account
 *   agentio remove-key <tail>      remove a key by its last 6 characters
 *   agentio list-keys              show the keys by their last 6 characters
 *   agentio set-provider-key <p>   store a provider key (asked for hidden), no restart
 *   agentio remove-provider-key <p>
 */
/** Neither a rulio key nor a provider key (file or variable) reaches the log */
const redact = (msg: string): string => redactSecrets(redactKeys(msg), providerSecrets(loadSettings().opencodeKeys));
const log = (msg: string) => console.log(`${new Date().toISOString()} ${redact(msg)}`);


/** Which engine can run? Claude Code alone, OpenCode alone or both; without any there is nothing to do */
function checkEngines(settings: Settings): void {
  const open = spawnSync(settings.opencodeBin, ["--version"], { encoding: "utf8" });
  const opencode = !open.error && open.status === 0;
  const providerEnv = withProviderKeys(settings.opencodeKeys);
  const keyed = settings.opencodeKeys.some((name) => !!providerEnv[name]);
  if (opencode) log(`OpenCode: ${open.stdout.trim()}${keyed ? "" : " (no provider key: keys with their own model cannot run)"}`);
  try {
    checkClaude(settings);
  } catch (err) {
    if (!opencode || !keyed) throw err;
    log(`${(err as Error).message} Keys with their own model still run with OpenCode.`);
  }
}

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
  if (!arg) throw new Error(cmd === "add-key" ? "Usage: agentio add-key <rulio_…>" : "Usage: agentio remove-key <last 6 characters>");
  if (cmd === "add-key") {
    console.log(addKey(path, arg) ? keyAdded(keyTail(arg)) : `Key ${keyTail(arg)} is already there.`);
    return;
  }
  console.log(keyRemoved(keyTail(removeKey(path, arg))));
}

/**
 * The key comes hidden from the terminal, never as an argument (it would stay in the shell history).
 * Without a terminal it is read from standard input, so `… < file` works.
 */
async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    let text = "";
    for await (const chunk of input) text += String(chunk);
    return text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  }
  process.stdout.write(prompt);
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (err?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("Cancelled, nothing stored."));
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch >= " ") {
          value += ch;
          process.stdout.write("*");
        }
      }
    };
    input.on("data", onData);
  });
}

async function providerKeyCommand(cmd: string, arg: string | undefined): Promise<void> {
  const { opencodeKeys } = loadSettings();
  if (!arg) throw new Error(`Usage: agentio ${cmd} <opencode|openrouter|variable name>`);
  const variable = providerVariable(arg, opencodeKeys);
  const label = providerLabel(variable);
  if (cmd === "remove-provider-key") {
    console.log(providerKeyRemoved(label, removeProviderKey(variable), !!process.env[variable]));
    return;
  }
  const key = await readSecret(`Key for ${label} (not shown): `);
  if (!key) throw new Error(NO_PROVIDER_KEY_GIVEN);
  setProviderKey(variable, key);
  console.log(providerKeySet(label));
}

/** What is set, never a key: rulio keys by their last 6 characters, provider keys only as set or not */
async function status(): Promise<void> {
  const settings = loadSettings();
  const keys = allKeys(process.env, keysFile());
  const sources = providerKeySources(settings.opencodeKeys);
  const claude = (await currentSetup(settings)).claude;
  const row = (label: string, text: string) => console.log(`${label.padEnd(13)}${text}`);
  row("Accounts:", keys.length ? `${keys.length} ${keys.length === 1 ? "key" : "keys"} (${keys.map((k) => keyTail(k.key)).join(", ")})` : "no key");
  const source = (s: (typeof sources)[number]) => (s.source === "file" ? "set (file)" : s.source === "variable" ? "set (variable)" : "not set");
  row("Providers:", sources.map((s) => `${providerLabel(s.variable)} ${source(s)}`).join(" · ") || "none");
  const login = claude === "ok" ? "logged in" : claude === "missing" ? "not logged in or not installed" : "could not check";
  row("Claude Code:", settings.useApiKey ? (claude === "ok" ? "uses ANTHROPIC_API_KEY" : "ANTHROPIC_API_KEY missing") : login);
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
  if (cmd === "set-provider-key" || cmd === "remove-provider-key") {
    await providerKeyCommand(cmd, process.argv[3]);
    return;
  }
  if (cmd === "status") {
    await status();
    return;
  }
  if (cmd !== "run" && cmd !== "once" && cmd !== "check") {
    throw new Error(`Unknown command "${cmd}" (run, once, check, status, add-key, remove-key, list-keys, set-provider-key, remove-provider-key, help)`);
  }
  const settings = loadSettings();
  const path = keysFile();
  const keys = () => allKeys(process.env, path).map((k) => k.key);
  const first = keys();
  if (!first.length && cmd !== "run") throw new Error(NO_KEYS);
  const configs = first.map((rulioToken): Config => ({ ...settings, rulioToken }));
  checkEngines(settings);
  // Before the first run: say right away if the Claude login is missing or a key does not fit
  const failed = await checkKeys(configs);
  if (cmd === "check") {
    if (failed.length === 1) throw failed[0]!;
    if (failed.length) throw new Error(`${failed.length} of ${configs.length} keys failed`);
    return;
  }
  // A key that does not work must not hold up the others; without any working key there is nothing to do
  if (configs.length && failed.length === configs.length) throw failed[0]!;
  const deps: AgentDeps = { poll, runEngine, finish, log, keys };
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
  log(startLine(settings.clientName, settings.rulioUrl, configs.length));
  new Agents(settings, deps).start();
  // The loops keep the process alive and handle their own errors
}

main().catch((err: Error) => {
  console.error(redact(err.message));
  process.exit(1);
});
