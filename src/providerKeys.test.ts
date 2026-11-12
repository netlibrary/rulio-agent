import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { runOpenCode } from "./opencode.js";
import { providerKeySources, providerSecrets, providerVariable, readProviderKeys, redactSecrets, withProviderKeys } from "./providerKeys.js";
import type { RunOrder } from "./rulio.js";

/**
 * Provider keys per command (rulio-tickets#945): `agentio set-provider-key` stores the key in
 * the volume, the next run uses it without a restart. Made-up keys only.
 */
const HOME = mkdtempSync(join(tmpdir(), "agentio-home-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const FILE = join(HOME, ".rulio-agent", "provider-keys");

const KEY_FILE = "zen-aus-der-datei-1234567890";
const KEY_VAR = "zen-aus-der-variable-0987654321";
const KEY_OR = "or-aus-der-datei-5555555555";

const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
function run(args: string[], input = "", env: NodeJS.ProcessEnv = {}) {
  const out = spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME, USERPROFILE: HOME, SystemRoot: process.env.SystemRoot, CLAUDE_BIN: join(HOME, "kein-claude"), ...env },
  });
  return { code: out.status, text: `${out.stdout}${out.stderr}` };
}

const cfg: Config = {
  rulioUrl: "https://api.rulio.net",
  rulioToken: "rulio_eigener",
  claudeBin: "claude",
  opencodeBin: "opencode",
  opencodeDeps: "/none",
  opencodeKeys: ["OPENCODE_API_KEY", "OPENROUTER_API_KEY"],
  flatRateProviders: ["opencode-go"],
  clientName: "t",
  useApiKey: false,
};
const order: RunOrder = { id: "r1", trigger: "manual", prompt: "Los", maxMinutes: 1, maxTurns: 3, model: "opencode/some-model" };

/** A fake OpenCode that says its provider key back, in its text and in an error */
function fakeOpenCode(seen: Array<string | undefined>): typeof spawn {
  const dir = mkdtempSync(join(tmpdir(), "fake-opencode-"));
  const path = join(dir, "fake.mjs");
  writeFileSync(
    path,
    `const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
say({ type: "text", part: { text: "Schlüssel " + process.env.OPENCODE_API_KEY } });
say({ type: "step_finish", part: { cost: 0 } });
say({ type: "error", error: { data: { message: "Key " + process.env.OPENCODE_API_KEY + " rejected" } } });
`,
  );
  return ((_c: string, _a: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    seen.push(options.env?.OPENCODE_API_KEY);
    return spawn(process.execPath, [path], options);
  }) as unknown as typeof spawn;
}

test("set-provider-key opencode from standard input: file with mode 600, the next run passes the key on, no restart", async () => {
  delete process.env.OPENCODE_API_KEY;
  const set = run(["set-provider-key", "opencode"], `${KEY_FILE}\n`);
  assert.equal(set.code, 0, set.text);
  assert.match(set.text, /Key for opencode stored\. It counts from the next run, no restart needed\./);
  assert.ok(!set.text.includes(KEY_FILE));
  assert.equal(readFileSync(FILE, "utf8"), `OPENCODE_API_KEY=${KEY_FILE}\n`);
  if (process.platform !== "win32") assert.equal(statSync(FILE).mode & 0o777, 0o600);

  // The same process, started before the key was stored: it reads the file at the run
  const seen: Array<string | undefined> = [];
  const r = await runOpenCode(cfg, order, fakeOpenCode(seen));
  assert.deepEqual(seen, [KEY_FILE]);
  // Black-out: the key from the file appears in no output
  assert.equal(r.summary, "Schlüssel ***");
  assert.equal(r.error, "Key *** rejected");
});

test("file and variable: the file counts; only the variable: as before", async () => {
  run(["set-provider-key", "opencode"], KEY_FILE);
  process.env.OPENCODE_API_KEY = KEY_VAR;
  try {
    const seen: Array<string | undefined> = [];
    const r = await runOpenCode(cfg, order, fakeOpenCode(seen));
    assert.deepEqual(seen, [KEY_FILE]);
    assert.ok(!`${r.summary}${r.error}`.includes(KEY_FILE) && !`${r.summary}${r.error}`.includes(KEY_VAR));

    const removed = run(["remove-provider-key", "opencode"], "", { OPENCODE_API_KEY: KEY_VAR });
    assert.equal(removed.code, 0, removed.text);
    assert.match(removed.text, /Stored key for opencode removed\. The variable of the container still counts\./);
    const only: Array<string | undefined> = [];
    await runOpenCode(cfg, order, fakeOpenCode(only));
    assert.deepEqual(only, [KEY_VAR]);
  } finally {
    delete process.env.OPENCODE_API_KEY;
  }
});

test("remove-provider-key: afterwards the reason „no key“ as before, nothing is started", async () => {
  run(["set-provider-key", "opencode"], KEY_FILE);
  assert.equal(run(["remove-provider-key", "opencode"]).code, 0);
  assert.deepEqual(readProviderKeys(FILE), {});
  const again = run(["remove-provider-key", "opencode"]);
  assert.match(again.text, /No stored key for opencode\./);
  const seen: Array<string | undefined> = [];
  const r = await runOpenCode(cfg, order, fakeOpenCode(seen));
  assert.equal(r.status, "error");
  assert.match(r.error!, /^No provider key in this container for opencode\/some-model\. Set OPENCODE_API_KEY or OPENROUTER_API_KEY with `agentio set-provider-key opencode`/);
  assert.deepEqual(seen, []);
});

test("status: accounts by their last 6 characters, providers only set or not with the source, never a key", () => {
  run(["set-provider-key", "openrouter"], KEY_OR);
  const rulioKey = "rulio_statusstatusstatusstatusABCDEF";
  assert.equal(run(["add-key", rulioKey]).code, 0);
  const out = run(["status"], "", { OPENCODE_API_KEY: KEY_VAR });
  assert.equal(out.code, 0, out.text);
  assert.match(out.text, /^Accounts: {4}1 key \(…ABCDEF\)$/m);
  assert.match(out.text, /^Providers: {3}opencode set \(variable\) · openrouter set \(file\)$/m);
  assert.match(out.text, /^Claude Code: not logged in or not installed$/m);
  for (const secret of [KEY_VAR, KEY_OR, rulioKey]) assert.ok(!out.text.includes(secret), "no key in status");
  assert.match(run(["status"]).text, /opencode not set · openrouter set \(file\)/);
  run(["remove-provider-key", "openrouter"]);
  run(["remove-key", "ABCDEF"]);
});

test("set-provider-key: provider names and variables of RULIO_AGENT_OPENCODE_KEYS, nothing else; an empty input stores nothing", () => {
  const keys = ["OPENCODE_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY"];
  assert.equal(providerVariable("opencode", keys), "OPENCODE_API_KEY");
  assert.equal(providerVariable("OpenRouter", keys), "OPENROUTER_API_KEY");
  assert.equal(providerVariable("GROQ_API_KEY", keys), "GROQ_API_KEY");
  assert.throws(() => providerVariable("PATH", keys), /Unknown provider "PATH"/);
  const unknown = run(["set-provider-key", "PATH"], KEY_FILE);
  assert.equal(unknown.code, 1);
  assert.ok(!unknown.text.includes(KEY_FILE));
  const groq = run(["set-provider-key", "GROQ_API_KEY"], "groq-erfunden-123456", { RULIO_AGENT_OPENCODE_KEYS: "OPENCODE_API_KEY,GROQ_API_KEY" });
  assert.equal(groq.code, 0, groq.text);
  assert.equal(readProviderKeys(FILE).GROQ_API_KEY, "groq-erfunden-123456");
  assert.equal(run(["remove-provider-key", "GROQ_API_KEY"], "", { RULIO_AGENT_OPENCODE_KEYS: "OPENCODE_API_KEY,GROQ_API_KEY" }).code, 0);
  const empty = run(["set-provider-key", "opencode"], "\n");
  assert.equal(empty.code, 1);
  assert.match(empty.text, /No key given, nothing stored\./);
  assert.equal(run(["set-provider-key"]).code, 1);
});

test("helpers: the file goes first, sources without keys, black-out of file and variable", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pk-")), "provider-keys");
  writeFileSync(path, `OPENCODE_API_KEY=${KEY_FILE}\nkaputt\n=leer\nlower=x\n`);
  const env = { OPENCODE_API_KEY: KEY_VAR, OPENROUTER_API_KEY: KEY_OR, PATH: "/bin" };
  const keys = ["OPENCODE_API_KEY", "OPENROUTER_API_KEY"];
  assert.deepEqual(readProviderKeys(path), { OPENCODE_API_KEY: KEY_FILE });
  assert.equal(withProviderKeys(keys, env, path).OPENCODE_API_KEY, KEY_FILE);
  assert.equal(withProviderKeys(keys, env, path).OPENROUTER_API_KEY, KEY_OR);
  assert.deepEqual(providerKeySources(keys, env, path), [
    { variable: "OPENCODE_API_KEY", source: "file" },
    { variable: "OPENROUTER_API_KEY", source: "variable" },
  ]);
  const secrets = providerSecrets(keys, env, path);
  assert.equal(redactSecrets(`a ${KEY_FILE} b ${KEY_VAR} c ${KEY_OR}`, secrets), "a *** b *** c ***");
  assert.deepEqual(readProviderKeys(join(path, "fehlt")), {});
});

test("agentio and rulio-agent start the same program", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin: Record<string, string> };
  assert.equal(pkg.bin.agentio, "dist/cli.js");
  assert.equal(pkg.bin["rulio-agent"], "dist/cli.js");
  const docker = readFileSync(join(root, "Dockerfile"), "utf8");
  assert.match(docker, /ln -s \/app\/dist\/cli\.js \/usr\/local\/bin\/agentio/);
  assert.match(docker, /ln -s \/app\/dist\/cli\.js \/usr\/local\/bin\/rulio-agent/);
  assert.ok(existsSync(cli));
  assert.match(run(["help"]).text, /Usage: agentio \[command\]/);
});
