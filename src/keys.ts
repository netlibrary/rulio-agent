import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The rulio keys of this machine: RULIO_TOKEN plus the file
 * ~/.rulio-agent/keys (mode 600, one key per line). One key belongs to exactly
 * one account, so several accounts mean several keys. A key is only ever shown
 * by its last 6 characters.
 */
const KEY = /^rulio_[A-Za-z0-9_-]{6,}$/;
const ANY_KEY = /rulio_[A-Za-z0-9_-]+/g;
const TAIL = 6;

export const isRulioKey = (s: string): boolean => KEY.test(s);

/** How a key appears in output: …abc123 */
export const keyTail = (key: string): string => `…${key.slice(-TAIL)}`;

/** Never let a whole key reach the log, whatever text it came with */
export const redactKeys = (text: string): string => text.replace(ANY_KEY, keyTail);

export const keysFile = (): string => join(homedir(), ".rulio-agent", "keys");

/**
 * A path that is not there counts as an empty file: missing (ENOENT), or a parent that is a file
 * (ENOTDIR — on Linux; Windows reports ENOENT for the same path)
 */
export const isMissing = (err: unknown): boolean => ["ENOENT", "ENOTDIR"].includes(String((err as NodeJS.ErrnoException).code));

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/** The file holds keys: nobody else may read it, even if it was created by hand */
function tighten(path: string): void {
  if (process.platform === "win32") return;
  try {
    if (statSync(path).mode & 0o077) chmodSync(path, 0o600);
  } catch {
    // Missing file or a read-only file system: nothing to tighten
  }
}

/** Keys in the file, each once; empty lines and anything that is not a key are skipped */
export function readFileKeys(path: string): string[] {
  tighten(path);
  return [...new Set(readLines(path).map((l) => l.trim()).filter(isRulioKey))];
}

/** Replace in one step: a running rulio-agent never reads half a file */
function writeLines(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const next = `${path}.${process.pid}.tmp`;
  writeFileSync(next, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
  renameSync(next, path);
  tighten(path);
}

/** Add a key to the file; false if it is already there */
export function addKey(path: string, key: string): boolean {
  if (!isRulioKey(key)) throw new Error("That is not a rulio key (rulio → AI agent → Connection).");
  const keys = readFileKeys(path);
  if (keys.includes(key)) return false;
  writeLines(path, [...keys, key]);
  return true;
}

/** Remove the key with these last 6 characters from the file; a key in RULIO_TOKEN stays */
export function removeKey(path: string, tail: string): string {
  const wanted = tail.replace(/^[….]+/, "").slice(-TAIL);
  if (wanted.length < TAIL) throw new Error(`Give the last ${TAIL} characters of the key (agentio list-keys).`);
  const keys = readFileKeys(path);
  const hits = keys.filter((k) => k.endsWith(wanted));
  if (!hits.length) throw new Error(`No key …${wanted} in ${path}. A key from RULIO_TOKEN can only be changed where the variable is set.`);
  if (hits.length > 1) throw new Error(`Several keys end in …${wanted}. Edit ${path} by hand.`);
  writeLines(path, keys.filter((k) => k !== hits[0]));
  return hits[0]!;
}

export interface KeyEntry {
  key: string;
  source: "RULIO_TOKEN" | "file";
}

/** RULIO_TOKEN first, then the file; a key in both counts once */
export function allKeys(env: NodeJS.ProcessEnv, path: string): KeyEntry[] {
  const fromEnv = env.RULIO_TOKEN?.trim() ?? "";
  if (fromEnv && !fromEnv.startsWith("rulio_")) {
    throw new Error("RULIO_TOKEN is not a rulio key (rulio → AI agent → Connection).");
  }
  const file = readFileKeys(path).filter((k) => k !== fromEnv);
  return [...(fromEnv ? [{ key: fromEnv, source: "RULIO_TOKEN" as const }] : []), ...file.map((key) => ({ key, source: "file" as const }))];
}
