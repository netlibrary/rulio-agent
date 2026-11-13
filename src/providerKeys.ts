import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isMissing } from "./keys.js";

/**
 * Provider keys for keys with their own model (OPENCODE_API_KEY, OPENROUTER_API_KEY, …),
 * set with `agentio set-provider-key` in the file ~/.rulio-agent/provider-keys
 * (mode 600, one `NAME=value` per line), next to the rulio keys in the same volume.
 * A key in the file goes before the variable of the container; the variable stays
 * as the fallback. Every run reads the file again, so a new key needs no restart.
 * A provider key is never shown, not even shortened.
 */

/** Short names for `set-provider-key`; other variables from RULIO_AGENT_OPENCODE_KEYS by their own name */
export const PROVIDERS: Readonly<Record<string, string>> = { opencode: "OPENCODE_API_KEY", openrouter: "OPENROUTER_API_KEY" };

const NAME = /^[A-Z][A-Z0-9_]*$/;

export const providerKeysFile = (): string => join(homedir(), ".rulio-agent", "provider-keys");

/** The variable behind `opencode`, `openrouter` or a variable named in RULIO_AGENT_OPENCODE_KEYS */
export function providerVariable(provider: string, opencodeKeys: string[]): string {
  const name = PROVIDERS[provider.toLowerCase()] ?? provider;
  if (!opencodeKeys.includes(name)) {
    const known = [...new Set([...Object.keys(PROVIDERS), ...opencodeKeys.filter((v) => !Object.values(PROVIDERS).includes(v))])];
    throw new Error(`Unknown provider "${provider}" (${known.join(", ")}). Other variables first go into RULIO_AGENT_OPENCODE_KEYS.`);
  }
  return name;
}

/** How a variable is called in messages: its short name if it has one */
export const providerLabel = (variable: string): string => Object.entries(PROVIDERS).find(([, v]) => v === variable)?.[0] ?? variable;

/** The file holds keys: nobody else may read it, even if it was created by hand */
function tighten(path: string): void {
  if (process.platform === "win32") return;
  try {
    if (statSync(path).mode & 0o077) chmodSync(path, 0o600);
  } catch {
    // Missing file or a read-only file system: nothing to tighten
  }
}

/** Keys in the file by variable; lines that are not `NAME=value` are skipped */
export function readProviderKeys(path: string = providerKeysFile()): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (isMissing(err)) return {};
    throw err;
  }
  tighten(path);
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i < 1) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (NAME.test(name) && value) out[name] = value;
  }
  return out;
}

/** Replace in one step: a run never reads half a file */
function writeKeys(path: string, keys: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lines = Object.entries(keys).map(([k, v]) => `${k}=${v}`);
  const next = `${path}.${process.pid}.tmp`;
  writeFileSync(next, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
  renameSync(next, path);
  tighten(path);
}

/** Store a key for this variable; a key already there is replaced */
export function setProviderKey(variable: string, value: string, path: string = providerKeysFile()): void {
  const key = value.trim();
  if (!key) throw new Error("No key given.");
  if (/[\s=]/.test(key)) throw new Error("That does not look like a provider key (it contains spaces or line breaks).");
  writeKeys(path, { ...readProviderKeys(path), [variable]: key });
}

/** Remove the key for this variable from the file; false if there was none. A variable of the container stays */
export function removeProviderKey(variable: string, path: string = providerKeysFile()): boolean {
  const keys = readProviderKeys(path);
  if (!(variable in keys)) return false;
  delete keys[variable];
  writeKeys(path, keys);
  return true;
}

/** The environment with the provider keys of the file in front of those of the container */
export function withProviderKeys(opencodeKeys: string[], env: NodeJS.ProcessEnv = process.env, path: string = providerKeysFile()): NodeJS.ProcessEnv {
  const file = readProviderKeys(path);
  const out = { ...env };
  for (const name of opencodeKeys) if (file[name]) out[name] = file[name];
  return out;
}

/** Where the key of each variable comes from, never the key itself */
export function providerKeySources(
  opencodeKeys: string[],
  env: NodeJS.ProcessEnv = process.env,
  path: string = providerKeysFile(),
): Array<{ variable: string; source: "file" | "variable" | null }> {
  const file = readProviderKeys(path);
  return opencodeKeys.map((variable) => ({ variable, source: file[variable] ? "file" : env[variable] ? "variable" : null }));
}

/** Every provider key in use (file and container), to black them out of any output */
export function providerSecrets(opencodeKeys: string[], env: NodeJS.ProcessEnv = process.env, path: string = providerKeysFile()): string[] {
  const all = withProviderKeys(opencodeKeys, env, path);
  const fromEnv = opencodeKeys.map((n) => env[n]);
  return [...new Set([...opencodeKeys.map((n) => all[n]), ...fromEnv].filter((v): v is string => !!v))];
}

/** Black out provider keys: `***` instead of the key */
export const redactSecrets = (text: string, secrets: string[]): string => secrets.reduce((t, s) => t.split(s).join("***"), text);
