import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { poll } from "./rulio.js";
import { CLAUDE_CHECK_MS, setupProbe } from "./setup.js";
import type { Config } from "./config.js";

const cfg = { claudeBin: "claude", useApiKey: false, opencodeKeys: ["OPENCODE_API_KEY", "OPENROUTER_API_KEY"] };
const loggedIn = async () => ({ text: "Logged in", failed: false, notFound: false });
// Stored provider keys (#945) come from the home directory: an empty one of its own, never the real one
const testHome = mkdtempSync(join(tmpdir(), "setup-home-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

test("provider key stored with set-provider-key (#945): counts without a variable, read anew at every poll", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "pk-")), "provider-keys");
  const probe = setupProbe({ exists: () => false, env: {}, runClaude: loggedIn, providerKeysPath: path });
  assert.equal((await probe(cfg)).providerKey, false);
  writeFileSync(path, "OPENROUTER_API_KEY=or-erfunden-123\n");
  assert.equal((await probe(cfg)).providerKey, true);
});

test("docker is recognised by /.dockerenv, nothing else", async () => {
  const yes = await setupProbe({ exists: (p) => p === "/.dockerenv", env: {}, runClaude: loggedIn })(cfg);
  assert.equal(yes.docker, true);
  const no = await setupProbe({ exists: () => false, env: {}, runClaude: loggedIn })(cfg);
  assert.equal(no.docker, false);
});

test("provider key: yes or no, for each name of RULIO_AGENT_OPENCODE_KEYS; an empty value is no key", async () => {
  const probe = (env: NodeJS.ProcessEnv) => setupProbe({ exists: () => false, env, runClaude: loggedIn })(cfg);
  assert.equal((await probe({})).providerKey, false);
  assert.equal((await probe({ OPENCODE_API_KEY: "" })).providerKey, false);
  assert.equal((await probe({ OPENCODE_API_KEY: "zen" })).providerKey, true);
  assert.equal((await probe({ OPENROUTER_API_KEY: "or" })).providerKey, true);
});

test("claude: logged in, not logged in, token instead of a login, program missing, check failed", async () => {
  const probe = (text: string, failed: boolean, notFound: boolean, env: NodeJS.ProcessEnv = {}) =>
    setupProbe({ exists: () => false, env, runClaude: async () => ({ text, failed, notFound }) })(cfg);
  assert.equal((await probe("Logged in", false, false)).claude, "ok");
  assert.equal((await probe("Not logged in", true, false)).claude, "missing");
  assert.equal((await probe("Not logged in", true, false, { CLAUDE_CODE_OAUTH_TOKEN: "t" })).claude, "ok");
  assert.equal((await probe("", true, true)).claude, "missing");
  assert.equal((await probe("", true, false)).claude, "unknown");
});

test("RULIO_AGENT_USE_API_KEY: the key counts, Claude is not asked", async () => {
  let asked = 0;
  const runClaude = async () => (asked++, { text: "", failed: false, notFound: false });
  const withKey = await setupProbe({ exists: () => false, env: { ANTHROPIC_API_KEY: "a" }, runClaude })({ ...cfg, useApiKey: true });
  assert.deepEqual([withKey.claude, withKey.claudeApiKey], ["ok", true]);
  const without = await setupProbe({ exists: () => false, env: {}, runClaude })({ ...cfg, useApiKey: true });
  assert.deepEqual([without.claude, without.claudeApiKey], ["missing", true]);
  assert.equal(asked, 0);
});

test("the login is checked at most every 10 minutes, not with every poll; several keys at once ask once", async () => {
  let asked = 0;
  let clock = 1_000;
  const probe = setupProbe({ exists: () => false, env: {}, now: () => clock, runClaude: async () => (asked++, { text: "Logged in", failed: false, notFound: false }) });
  await Promise.all([probe(cfg), probe(cfg), probe(cfg)]);
  assert.equal(asked, 1);
  clock += CLAUDE_CHECK_MS - 1;
  await probe(cfg);
  assert.equal(asked, 1);
  clock += 1;
  await probe(cfg);
  assert.equal(asked, 2);
});

test("every poll carries the setup, with no key and no value in it", async () => {
  const saved = { fetch: globalThis.fetch, zen: process.env.OPENCODE_API_KEY };
  process.env.OPENCODE_API_KEY = "zen-geheim";
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return new Response(JSON.stringify({ run: null, pollSeconds: 60, enabled: true }), { status: 200 });
  }) as typeof fetch;
  const config = { rulioUrl: "https://rulio.test", rulioToken: "rulio_geheim", clientName: "rulio-agent@t", claudeBin: "gibt-es-nicht-claude", useApiKey: false, opencodeKeys: ["OPENCODE_API_KEY"] } as Config;
  try {
    await poll(config, {});
    await poll(config, { busy: true });
    await poll(config, { peek: true, wait: 0 });
  } finally {
    globalThis.fetch = saved.fetch;
    process.env.OPENCODE_API_KEY = saved.zen;
  }
  assert.equal(bodies.length, 3);
  for (const body of bodies) {
    const sent = JSON.parse(body) as { setup: Record<string, unknown> };
    assert.deepEqual(Object.keys(sent.setup).sort(), ["claude", "claudeApiKey", "docker", "providerKey"]);
    assert.equal(sent.setup.providerKey, true);
    for (const secret of ["zen-geheim", "rulio_geheim", "OPENCODE_API_KEY"]) assert.ok(!body.includes(secret), secret);
  }
});
