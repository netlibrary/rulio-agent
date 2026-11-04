import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSettings, type Config } from "./config.js";
import { killTree, opencodeArgs, opencodeConfig, opencodeEnv, providerOf, runOpenCode, StreamReader } from "./opencode.js";
import type { RunOrder } from "./rulio.js";

const cfg: Config = {
  rulioUrl: "https://api.rulio.net",
  rulioToken: "rulio_eigener",
  claudeBin: "claude",
  opencodeBin: "opencode",
  opencodeKeys: ["OPENCODE_API_KEY"],
  flatRateProviders: ["opencode-go"],
  clientName: "t",
  useApiKey: false,
};
const order: RunOrder = { id: "r1", trigger: "manual", prompt: "Los", maxMinutes: 1, maxTurns: 3, model: "opencode/some-model" };

test("the configuration of a run holds only rulio with the key of this run, everything else denied", () => {
  const c = opencodeConfig(cfg, order) as { mcp: Record<string, { url: string; headers: Record<string, string> }>; permission: Record<string, string>; model: string; small_model: string; agent: { build: { steps: number } } };
  assert.deepEqual(Object.keys(c.mcp), ["rulio"]);
  assert.equal(c.mcp.rulio!.url, "https://api.rulio.net/mcp");
  assert.equal(c.mcp.rulio!.headers.Authorization, "Bearer rulio_eigener");
  assert.deepEqual(c.permission, { "*": "deny", "rulio_*": "allow" });
  assert.equal(c.model, "opencode/some-model");
  assert.equal(c.small_model, "opencode/some-model");
  assert.equal(c.agent.build.steps, 3);
});

test("the environment holds its own directories and the provider key, not the keys of others", () => {
  const env = opencodeEnv(cfg, order, "/x/home", { PATH: "/bin", OPENCODE_API_KEY: "zen", RULIO_TOKEN: "rulio_anderer", CLAUDE_CODE_OAUTH_TOKEN: "c", ANTHROPIC_API_KEY: "a", GITHUB_TOKEN: "g", HOME: "/root" });
  assert.equal(env.OPENCODE_API_KEY, "zen");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/x/home");
  assert.match(env.XDG_CONFIG_HOME!, /home/);
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  for (const name of ["RULIO_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) assert.equal(env[name], undefined, name);
  assert.ok(!JSON.stringify(env).includes("rulio_anderer"));
});

test("another provider needs only a setting", () => {
  const s = loadSettings({ RULIO_AGENT_OPENCODE_KEYS: "OPENROUTER_API_KEY, OPENCODE_API_KEY", RULIO_AGENT_FLAT_PROVIDERS: "" });
  assert.deepEqual(s.opencodeKeys, ["OPENROUTER_API_KEY", "OPENCODE_API_KEY"]);
  assert.deepEqual(s.flatRateProviders, []);
  assert.deepEqual(loadSettings({}).opencodeKeys, ["OPENCODE_API_KEY"]);
  assert.deepEqual(loadSettings({}).flatRateProviders, ["opencode-go"]);
  assert.equal(providerOf("openrouter/some/model"), "openrouter");
});

test("arguments: JSON stream, no external plugins, the prompt last", () => {
  const args = opencodeArgs("Los");
  assert.deepEqual(args.slice(0, 3), ["run", "--format", "json"]);
  assert.ok(args.includes("--auto") && args.includes("--pure"));
  assert.equal(args.at(-1), "Los");
});

test("reading the stream: steps, cost, the last text, errors, also split across chunks", () => {
  const r = new StreamReader();
  const a = JSON.stringify({ type: "step_finish", part: { cost: 0.01 } });
  r.push(`${a.slice(0, 5)}`);
  assert.equal(r.steps, 0);
  r.push(`${a.slice(5)}\nkein json\n`);
  assert.equal(r.steps, 1);
  r.push(`${JSON.stringify({ type: "text", part: { text: "Zwischenstand" } })}\n${JSON.stringify({ type: "text", part: { text: "Fertig" } })}\n`);
  r.push(`${JSON.stringify({ type: "step_finish", part: { cost: 0.02 } })}\n`);
  assert.deepEqual(r.result(), { summary: "Fertig", turns: 2, cost: 0.03, error: null });
  r.push(`${JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "Kaputt" } } })}\n`);
  assert.equal(r.result().error, "Kaputt");
  const none = new StreamReader();
  none.push(`${JSON.stringify({ type: "step_finish", part: {} })}\n`);
  assert.equal(none.result().cost, null);
});

/** A stand-in for the program, started with node; `mode` says how it behaves */
function fake(mode: "endless" | "hang" | "done" | "fail" | "leak"): typeof spawn {
  const dir = mkdtempSync(join(tmpdir(), "fake-opencode-"));
  const path = join(dir, "fake.mjs");
  writeFileSync(
    path,
    `const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const step = () => say({ type: "step_finish", part: { cost: 0.5 } });
const mode = ${JSON.stringify(mode)};
if (mode === "endless") setInterval(step, 20);
if (mode === "hang") { step(); setInterval(() => {}, 1000); }
if (mode === "done") { say({ type: "text", part: { text: "Zusammenfassung" } }); step(); }
if (mode === "fail") { process.stderr.write("schlecht rulio_eigener"); process.exit(3); }
if (mode === "leak") { say({ type: "text", part: { text: "Schlüssel rulio_eigener" } }); say({ type: "error", error: { data: { message: "rulio_eigener abgelehnt" } } }); }
`,
  );
  return ((_c: string, _a: readonly string[], options: object) => spawn(process.execPath, [path], options)) as unknown as typeof spawn;
}

test("step limit: the run ends at the limit even if the model keeps going", async () => {
  const r = await runOpenCode(cfg, order, fake("endless"));
  assert.equal(r.status, "error");
  assert.match(r.error!, /limit of 3 steps/);
  assert.ok(r.turns! >= 3);
  assert.equal(r.model, "opencode/some-model");
});

test("time limit: a tool call that hangs ends with the run", async () => {
  const r = await runOpenCode(cfg, { ...order, maxMinutes: 0.01, maxTurns: 50 }, fake("hang"));
  assert.equal(r.status, "timeout");
  assert.match(r.error!, /Aborted/);
});

test("the result is read: summary, steps, cost from a provider billing per run", async () => {
  const r = await runOpenCode(cfg, order, fake("done"));
  assert.deepEqual(r, { model: "opencode/some-model", summary: "Zusammenfassung", turns: 1, costUsd: 0.5, status: "ok", error: null });
});

test("no running cost with a subscription: what the output says there is no real cost", async () => {
  const r = await runOpenCode(cfg, { ...order, model: "opencode-go/some-model" }, fake("done"));
  assert.equal(r.costUsd, null);
  assert.equal(r.model, "opencode-go/some-model");
});

test("no key in what goes back to rulio", async () => {
  const failed = await runOpenCode(cfg, order, fake("fail"));
  assert.equal(failed.status, "error");
  assert.ok(!failed.error!.includes("rulio_eigener"));
  const leaked = await runOpenCode(cfg, order, fake("leak"));
  assert.ok(!JSON.stringify(leaked).includes("rulio_eigener"));
});

test("web research is rejected with a clear reason, nothing is started", async () => {
  let started = false;
  const spy = ((...args: Parameters<typeof spawn>) => {
    started = true;
    return spawn(...args);
  }) as typeof spawn;
  const r = await runOpenCode(cfg, { ...order, web: true }, spy);
  assert.equal(r.status, "error");
  assert.match(r.error!, /Web research/);
  assert.equal(started, false);
});

test("a report with subagents runs without them: no such tool is allowed", () => {
  const c = opencodeConfig(cfg, { ...order, allowSubagents: true } as RunOrder) as { permission: Record<string, string> };
  assert.deepEqual(c.permission, { "*": "deny", "rulio_*": "allow" });
});

test("program missing: a clear error", async () => {
  const r = await runOpenCode({ ...cfg, opencodeBin: join(tmpdir(), "gibt-es-nicht-opencode") }, order);
  assert.equal(r.status, "error");
  assert.match(r.error!, /could not be started/);
});

test("ending a process group on Linux, the whole tree on Windows", () => {
  const killed: Array<[number, unknown]> = [];
  const original = process.kill;
  process.kill = ((pid: number, signal: unknown) => (killed.push([pid, signal]), true)) as typeof process.kill;
  try {
    killTree({ pid: 42, kill: () => true }, "SIGTERM", "linux");
  } finally {
    process.kill = original;
  }
  assert.deepEqual(killed, [[-42, "SIGTERM"]]);
});
