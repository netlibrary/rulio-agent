import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addKey, allKeys, isMissing, isRulioKey, keyTail, readFileKeys, redactKeys, removeKey } from "./keys.js";

const KEY_A = "rulio_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaAAAAAA";
const KEY_B = "rulio_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbBBBBBB";
const KEY_C = "rulio_cccccccccccccccccccccccccccccccccccccccccCCCCCC";
const tempFile = () => join(mkdtempSync(join(tmpdir(), "rulio-keys-")), ".rulio-agent", "keys");
const posixOnly = { skip: process.platform === "win32" ? "no file modes on Windows" : false };

test("only well-formed rulio keys count", () => {
  assert.ok(isRulioKey(KEY_A));
  for (const bad of ["", "rulio_", "rulio_abc", "abc_defghijkl", `${KEY_A} x`, `${KEY_A}\n${KEY_B}`]) assert.equal(isRulioKey(bad), false, bad);
});

test("environment and file together, a key in both counts once", () => {
  const path = tempFile();
  addKey(path, KEY_A);
  addKey(path, KEY_B);
  assert.deepEqual(allKeys({ RULIO_TOKEN: KEY_A }, path), [
    { key: KEY_A, source: "RULIO_TOKEN" },
    { key: KEY_B, source: "file" },
  ]);
  assert.deepEqual(allKeys({ RULIO_TOKEN: KEY_C }, path).map((k) => k.key), [KEY_C, KEY_A, KEY_B]);
  assert.deepEqual(allKeys({}, path).map((k) => k.key), [KEY_A, KEY_B]);
});

test("only RULIO_TOKEN, no file: exactly that key", () => {
  assert.deepEqual(allKeys({ RULIO_TOKEN: KEY_A }, tempFile()), [{ key: KEY_A, source: "RULIO_TOKEN" }]);
  assert.deepEqual(allKeys({}, tempFile()), []);
});

test("a RULIO_TOKEN that is not a key is an error, as before", () => {
  assert.throws(() => allKeys({ RULIO_TOKEN: "nope" }, tempFile()), /not a rulio key/);
});

test("the file: doubles once, empty lines and foreign lines are skipped", () => {
  const path = tempFile();
  addKey(path, KEY_A);
  writeFileSync(path, `${KEY_A}\n\n  ${KEY_B}  \r\n# a note\n${KEY_A}\nrulio_short\n`);
  assert.deepEqual(readFileKeys(path), [KEY_A, KEY_B]);
});

test("add-key: checks the format, adds once", () => {
  const path = tempFile();
  assert.throws(() => addKey(path, "not-a-key"), /not a rulio key/);
  assert.equal(existsSync(path), false);
  assert.equal(addKey(path, KEY_A), true);
  assert.equal(addKey(path, KEY_A), false);
  assert.equal(addKey(path, KEY_B), true);
  assert.deepEqual(readFileKeys(path), [KEY_A, KEY_B]);
});

test("remove-key: by the last 6 characters, with or without the dots", () => {
  const path = tempFile();
  addKey(path, KEY_A);
  addKey(path, KEY_B);
  assert.equal(removeKey(path, "AAAAAA"), KEY_A);
  assert.deepEqual(readFileKeys(path), [KEY_B]);
  assert.throws(() => removeKey(path, "AAAAAA"), /No key …AAAAAA/);
  assert.throws(() => removeKey(path, "BBB"), /last 6 characters/);
  assert.equal(removeKey(path, "…BBBBBB"), KEY_B);
  assert.deepEqual(readFileKeys(path), []);
});

test("remove-key only touches the file: a key in RULIO_TOKEN stays", () => {
  const path = tempFile();
  addKey(path, KEY_B);
  assert.throws(() => removeKey(path, "AAAAAA"), /RULIO_TOKEN/);
  assert.deepEqual(allKeys({ RULIO_TOKEN: KEY_A }, path).map((k) => k.key), [KEY_A, KEY_B]);
});

test("file modes: 600 from the start, a loose file gets tightened", posixOnly, () => {
  const path = tempFile();
  addKey(path, KEY_A);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  chmodSync(path, 0o644);
  assert.deepEqual(readFileKeys(path), [KEY_A]);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  removeKey(path, "AAAAAA");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("a path below a file counts as missing, on Linux (ENOTDIR) and Windows (ENOENT); other errors stay", () => {
  const file = join(mkdtempSync(join(tmpdir(), "rulio-keys-")), "keys");
  writeFileSync(file, "x\n");
  assert.deepEqual(readFileKeys(join(file, "below")), []);
  assert.equal(isMissing(Object.assign(new Error("x"), { code: "ENOTDIR" })), true);
  assert.equal(isMissing(Object.assign(new Error("x"), { code: "ENOENT" })), true);
  assert.equal(isMissing(Object.assign(new Error("x"), { code: "EACCES" })), false);
});

test("whole keys never get through: the tail stays, the rest goes", () => {
  assert.equal(keyTail(KEY_A), "…AAAAAA");
  const text = redactKeys(`failed: Bearer ${KEY_A} and ${KEY_B}.`);
  assert.equal(text, "failed: Bearer …AAAAAA and …BBBBBB.");
});

const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
function run(home: string, ...args: string[]) {
  const out = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot } });
  return { code: out.status, text: `${out.stdout}${out.stderr}` };
}

test("commands: add-key, list-keys, remove-key without ever printing a whole key", () => {
  const home = mkdtempSync(join(tmpdir(), "rulio-home-"));
  const outputs = [run(home, "add-key", KEY_A), run(home, "add-key", KEY_A), run(home, "add-key", KEY_B), run(home, "list-keys"), run(home, "remove-key", "AAAAAA"), run(home, "list-keys")];
  for (const o of outputs) {
    assert.equal(o.code, 0, o.text);
    assert.doesNotMatch(o.text, /rulio_[a-c]/);
  }
  assert.match(outputs[0]!.text, /Key …AAAAAA added/);
  assert.match(outputs[1]!.text, /already there/);
  assert.match(outputs[3]!.text, /…AAAAAA[\s\S]*…BBBBBB/);
  assert.doesNotMatch(outputs[5]!.text, /AAAAAA/);
  assert.match(outputs[5]!.text, /…BBBBBB/);
  assert.equal(readFileSync(join(home, ".rulio-agent", "keys"), "utf8").trim(), KEY_B);
});

test("commands: errors do not echo what was typed", () => {
  const home = mkdtempSync(join(tmpdir(), "rulio-home-"));
  const bad = run(home, "add-key", "rulio_a b");
  assert.equal(bad.code, 1);
  assert.doesNotMatch(bad.text, /rulio_a/);
  assert.equal(run(home, "add-key").code, 1);
  assert.equal(run(home, "remove-key", "ZZZZZZ").code, 1);
  assert.equal(run(home, "nonsense").code, 1);
});

test("once and check without any key: a clear error", () => {
  const home = mkdtempSync(join(tmpdir(), "rulio-home-"));
  for (const cmd of ["once", "check"]) {
    const out = run(home, cmd);
    assert.equal(out.code, 1);
    assert.match(out.text, /No rulio key/);
  }
});
