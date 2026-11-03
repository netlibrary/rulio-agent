import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Agents, askOnce, TIMING, type AgentDeps, type Timing } from "./agents.js";
import { mcpConfig } from "./claude.js";
import { poll, RulioError, type PollOptions, type PollReply, type RunOrder, type RunResult } from "./rulio.js";
import type { Config } from "./config.js";

const KEY_A = "rulio_aaaaaaaaaaaaaaaaAAAAAA";
const KEY_B = "rulio_bbbbbbbbbbbbbbbbBBBBBB";
const KEY_C = "rulio_ccccccccccccccccCCCCCC";
const settings = { rulioUrl: "https://rulio.test", claudeBin: "claude", clientName: "rulio-agent@test", useApiKey: false };
const fast: Timing = { busyPollSeconds: 0.02, errorRetrySeconds: 0.02, rejectedRetrySeconds: 0.2, reloadSeconds: 0.02, longPollSeconds: 0.03, noOrderRetrySeconds: 0.02 };
const order = (id: string, over: Partial<RunOrder> = {}): RunOrder => ({ id, trigger: "manual", prompt: "go", maxMinutes: 10, maxTurns: 40, ...over });
const idle: PollReply = { run: null, pollSeconds: 60, enabled: true, longPoll: true };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`Timed out waiting for: ${what}`);
    await delay(2);
  }
}

/** A rulio server and a Claude Code as far as this program can tell */
function world(keys: string[]) {
  const state = {
    keys,
    /** Orders due per key: handed out on the next poll without busy */
    due: new Map<string, RunOrder[]>(),
    /** Answers instead of the usual ones, per key */
    fails: new Map<string, Error>(),
    /** A server without `busy`: hands out due orders on every poll */
    oldServer: false,
    polls: [] as Array<{ key: string; busy: boolean; at: number }>,
    openPolls: new Map<string, number>(),
    started: [] as Array<{ id: string; cfg: Config; order: RunOrder }>,
    active: 0,
    mostActive: 0,
    release: new Map<string, () => void>(),
    finished: [] as Array<{ id: string; key: string; result: RunResult }>,
    logs: [] as string[],
  };
  const deps: AgentDeps = {
    keys: () => state.keys,
    log: (m) => state.logs.push(m),
    poll: async (cfg: Config, opts: PollOptions) => {
      const key = cfg.rulioToken;
      state.polls.push({ key, busy: !!opts.busy, at: Date.now() });
      await delay(0);
      const fail = state.fails.get(key);
      if (fail) throw fail;
      const take = (): PollReply | null => {
        if (opts.peek && !state.oldServer) return state.due.get(key)?.length ? { ...idle, due: true } : null;
        const run = state.due.get(key)?.shift() ?? null;
        return run ? { ...idle, run } : null;
      };
      const none = { run: null, pollSeconds: 60, enabled: true };
      if (opts.busy && !state.oldServer) return none;
      const now = take();
      if (now || opts.busy) return now ?? none;
      if (opts.wait === 0) return none;
      // Long poll: open until something is due, as long as the client may wait
      state.openPolls.set(key, (state.openPolls.get(key) ?? 0) + 1);
      try {
        const until = Date.now() + (opts.wait ?? fast.longPollSeconds) * 1000;
        while (Date.now() < until) {
          const later = take();
          if (later) return later;
          await delay(2);
        }
        return idle;
      } finally {
        state.openPolls.set(key, (state.openPolls.get(key) ?? 1) - 1);
      }
    },
    runClaude: (cfg, o) =>
      new Promise((resolve) => {
        state.started.push({ id: o.id, cfg, order: o });
        state.active++;
        state.mostActive = Math.max(state.mostActive, state.active);
        state.release.set(o.id, () => {
          state.active--;
          resolve({ status: "ok", summary: `done ${o.id}` });
        });
      }),
    finish: async (cfg, id, result) => {
      state.finished.push({ id, key: cfg.rulioToken, result });
    },
  };
  return { state, deps };
}

const started = (s: { started: Array<{ id: string }> }) => s.started.map((r) => r.id);

/** Start, and whatever the test does: nothing keeps running after it */
function begin(t: TestContext, state: { release: Map<string, () => void> }, agents: Agents): Agents {
  t.after(async () => {
    let stopped = false;
    const stopping = agents.stop().then(() => {
      stopped = true;
    });
    while (!stopped) {
      for (const release of state.release.values()) release();
      await delay(2);
    }
    await stopping;
  });
  agents.start();
  return agents;
}

test("two accounts due at once: one run at a time, the second starts after the first", async (t) => {
  const { state, deps } = world([KEY_A, KEY_B]);
  state.due.set(KEY_A, [order("a1")]);
  state.due.set(KEY_B, [order("b1")]);
  const agents = begin(t, state, new Agents(settings, deps, fast));
  await until("the first run", () => state.started.length === 1);
  const first = state.started[0]!.id;
  const second = first === "a1" ? "b1" : "a1";
  await delay(60);
  assert.deepEqual(started(state), [first]);
  assert.equal(state.due.get(second === "a1" ? KEY_A : KEY_B)!.length, 1, "the second order stays at rulio: handed out, it could no longer be taken back");
  state.release.get(first)!();
  await until("the second run", () => state.started.length === 2);
  assert.equal(state.started[1]!.id, second);
  assert.equal(state.finished[0]!.id, first);
  state.release.get(second)!();
  await until("both finished", () => state.finished.length === 2);
  assert.equal(state.mostActive, 1);
  await agents.stop();
});

test("each run works with the key of its own account only", async (t) => {
  const { state, deps } = world([KEY_A, KEY_B]);
  state.due.set(KEY_B, [order("b1")]);
  const agents = begin(t, state, new Agents(settings, deps, fast));
  await until("the run", () => state.started.length === 1);
  const config = mcpConfig(state.started[0]!.cfg);
  assert.ok(config.includes(KEY_B));
  assert.ok(!config.includes(KEY_A));
  state.release.get("b1")!();
  await until("finished", () => state.finished.length === 1);
  assert.equal(state.finished[0]!.key, KEY_B);
  await agents.stop();
});

test("during a run every key checks in as busy, the running one too; no order is asked for", async (t) => {
  const { state, deps } = world([KEY_A, KEY_B]);
  state.due.set(KEY_A, [order("a1")]);
  const agents = begin(t, state, new Agents(settings, deps, fast));
  await until("the run", () => state.started.length === 1);
  const from = state.polls.length;
  await until("busy check-ins from both", () => {
    const since = state.polls.slice(from);
    return since.filter((p) => p.key === KEY_A).length >= 3 && since.filter((p) => p.key === KEY_B).length >= 3;
  });
  assert.ok(state.polls.slice(from).every((p) => p.busy));
  state.due.set(KEY_B, [order("b1")]);
  await delay(60);
  assert.deepEqual(started(state), ["a1"], "due in the other account: waits, is not even handed out");
  assert.equal(state.due.get(KEY_B)!.length, 1);
  state.release.get("a1")!();
  await until("the waiting run", () => state.started.length === 2);
  state.release.get("b1")!();
  await until("finished", () => state.finished.length === 2);
  await agents.stop();
});

test("check-ins stay well inside the 10 minutes after which rulio reports a client offline", () => {
  assert.equal(TIMING.busyPollSeconds, 60);
  assert.equal(TIMING.reloadSeconds, 30);
});

test("after a run the others ask for orders right away, not at the next check-in", async (t) => {
  const { state, deps } = world([KEY_A, KEY_B]);
  state.due.set(KEY_A, [order("a1")]);
  const agents = begin(t, state, new Agents(settings, deps, { ...fast, busyPollSeconds: 60 }));
  await until("the run", () => state.started.length === 1);
  await until("the check-in of the other key", () => state.polls.some((p) => p.busy && p.key === KEY_B));
  await delay(20);
  state.due.set(KEY_B, [order("b1")]);
  state.release.get("a1")!();
  await until("the next run within moments", () => state.started.length === 2, 500);
  state.release.get("b1")!();
  await until("finished", () => state.finished.length === 2);
  await agents.stop();
});

test("a revoked key is logged once and asked again rarely; the others keep running", async (t) => {
  const { state, deps } = world([KEY_A, KEY_B]);
  state.fails.set(KEY_A, new RulioError(401, "Schlüssel unbekannt oder widerrufen"));
  const agents = begin(t, state, new Agents(settings, deps, fast));
  await until("the rejection", () => state.logs.some((l) => l.includes("rejected")));
  state.due.set(KEY_B, [order("b1")]);
  await until("the run of the other key", () => state.started.length === 1);
  await delay(50);
  const rejected = state.logs.filter((l) => l.includes("rejected"));
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!, /…AAAAAA/);
  assert.equal(state.polls.filter((p) => p.key === KEY_A).length, 1, "no hammering with a revoked key");
  state.release.get("b1")!();
  await until("finished", () => state.finished.length === 1);
  // It is tried again after the long pause; the run of the other key did not wake it
  await until("the retry", () => state.polls.filter((p) => p.key === KEY_A).length === 2);
  state.fails.delete(KEY_A);
  state.due.set(KEY_A, [order("a2")]);
  await until("accepted again", () => state.logs.some((l) => l.includes("…AAAAAA Key accepted again")));
  await until("its run", () => state.started.length === 2);
  state.release.get("a2")!();
  await until("finished", () => state.finished.length === 2);
  await agents.stop();
});

test("403 counts as rejected too; other errors retry soon and stay with their key", async (t) => {
  const { state, deps } = world([KEY_A, KEY_B]);
  state.fails.set(KEY_A, new RulioError(403, "no"));
  state.fails.set(KEY_B, new Error("network down"));
  const agents = begin(t, state, new Agents(settings, deps, { ...fast, rejectedRetrySeconds: 60 }));
  await until("several retries of the network error", () => state.polls.filter((p) => p.key === KEY_B).length >= 3);
  assert.equal(state.polls.filter((p) => p.key === KEY_A).length, 1);
  assert.ok(state.logs.some((l) => l.startsWith("…BBBBBB Error: network down")));
  await agents.stop();
});

test("a new key in the file starts without a restart; a removed one ends after its check-in", async (t) => {
  const { state, deps } = world([KEY_A]);
  const agents = begin(t, state, new Agents(settings, deps, fast));
  await until("the first key asks", () => state.polls.some((p) => p.key === KEY_A));
  assert.ok(!state.polls.some((p) => p.key === KEY_B));
  state.keys = [KEY_A, KEY_B];
  state.due.set(KEY_B, [order("b1")]);
  await until("the run of the new key", () => state.started.length === 1);
  assert.equal(state.started[0]!.cfg.rulioToken, KEY_B);
  state.release.get("b1")!();
  await until("finished", () => state.finished.length === 1);
  state.keys = [KEY_B];
  await until("the removal", () => state.logs.some((l) => l.includes("…AAAAAA Key removed")));
  state.due.set(KEY_A, [order("a2")]);
  await until("the last long poll of the removed key to end", () => !state.openPolls.get(KEY_A));
  await agents.stop();
});

test("a removed key picks up nothing more, even with an order due", async (t) => {
  const { state, deps } = world([KEY_A]);
  const agents = begin(t, state, new Agents(settings, deps, fast));
  await until("the long poll", () => state.openPolls.get(KEY_A) === 1);
  state.keys = [];
  await until("the removal", () => state.logs.some((l) => l.includes("Key removed")));
  state.due.set(KEY_A, [order("a1")]);
  await delay(60);
  assert.deepEqual(started(state), []);
  assert.equal(state.due.get(KEY_A)!.length, 1);
  await agents.stop();
});

test("an older server hands out a removed key's order in its last poll: reported, not run", async (t) => {
  const { state, deps } = world([KEY_A]);
  state.oldServer = true;
  const agents = begin(t, state, new Agents(settings, deps, { ...fast, longPollSeconds: 0.3 }));
  await until("the long poll", () => state.openPolls.get(KEY_A) === 1);
  state.keys = [];
  await until("the removal", () => state.logs.some((l) => l.includes("Key removed")));
  state.due.set(KEY_A, [order("a1")]);
  await until("the report", () => state.finished.length === 1);
  assert.deepEqual(started(state), []);
  assert.equal(state.finished[0]!.result.status, "error");
  assert.match(state.finished[0]!.result.error!, /removed/);
  await agents.stop();
});

test("two accounts due in the same moment: nothing is handed out that cannot run next", async (t) => {
  const { state, deps } = world([KEY_A, KEY_B]);
  const agents = begin(t, state, new Agents(settings, deps, fast));
  await until("both wait for work", () => state.openPolls.get(KEY_A) === 1 && state.openPolls.get(KEY_B) === 1);
  state.due.set(KEY_A, [order("a1")]);
  state.due.set(KEY_B, [order("b1")]);
  await until("the first run", () => state.started.length === 1);
  await delay(50);
  const handedOut = ["a1", "b1"].filter((id) => !(id === "a1" ? state.due.get(KEY_A)! : state.due.get(KEY_B)!).length);
  assert.deepEqual(handedOut, started(state));
  state.release.get(state.started[0]!.id)!();
  await until("the second run", () => state.started.length === 2);
  state.release.get(state.started[1]!.id)!();
  await until("both reported", () => state.finished.length === 2);
  assert.deepEqual(state.finished.map((f) => f.result.status), ["ok", "ok"]);
  await agents.stop();
});

test("due, but picking it up brings nothing: no tight loop", async (t) => {
  const { state, deps } = world([KEY_A]);
  const dry: AgentDeps = { ...deps, poll: async (cfg, opts) => (opts.peek ? { ...idle, due: true } : deps.poll(cfg, opts)) };
  const agents = begin(t, state, new Agents(settings, dry, { ...fast, noOrderRetrySeconds: 0.05 }));
  await delay(120);
  const asked = state.polls.length;
  assert.ok(asked >= 1 && asked <= 4, `asked ${asked} times`);
  await agents.stop();
});

test("a file that cannot be read changes nothing", async (t) => {
  const { state, deps } = world([KEY_A]);
  let broken = false;
  const agents = begin(t, state, new Agents(settings, { ...deps, keys: () => {
    if (broken) throw new Error("EACCES");
    return state.keys;
  } }, fast));
  await until("the first key asks", () => state.polls.length >= 1);
  broken = true;
  await until("the message", () => state.logs.some((l) => l.includes("Keys not readable")));
  await delay(50);
  assert.equal(state.logs.filter((l) => l.includes("Keys not readable")).length, 1);
  assert.ok(!state.logs.some((l) => l.includes("Key removed")));
  state.due.set(KEY_A, [order("a1")]);
  await until("the run", () => state.started.length === 1);
  state.release.get("a1")!();
  await until("finished", () => state.finished.length === 1);
  await agents.stop();
});

test("only RULIO_TOKEN: asks with a long poll, executes, reports, as before", async (t) => {
  const { state, deps } = world([KEY_A]);
  const agents = begin(t, state, new Agents(settings, deps, fast));
  await until("the long poll", () => state.openPolls.get(KEY_A) === 1);
  assert.equal(state.polls[0]!.busy, false);
  state.due.set(KEY_A, [order("a1", { kind: "report", allowSubagents: true, web: true })]);
  await until("the run", () => state.started.length === 1);
  assert.equal(state.started[0]!.order.maxMinutes, 10);
  state.release.get("a1")!();
  await until("finished", () => state.finished.length === 1);
  assert.deepEqual(state.finished[0], { id: "a1", key: KEY_A, result: { status: "ok", summary: "done a1" } });
  assert.ok(state.logs.some((l) => l.includes("Run a1 (manual, report) — at most 10 min, with subagents, with web research")));
  await until("the next long poll", () => state.openPolls.get(KEY_A) === 1);
  await agents.stop();
});

test("an older server without busy hands out a run during a run: it waits its turn", async (t) => {
  const { state, deps } = world([KEY_A, KEY_B]);
  state.oldServer = true;
  state.due.set(KEY_A, [order("a1")]);
  const agents = begin(t, state, new Agents(settings, deps, fast));
  await until("the first run", () => state.started.length === 1);
  state.due.set(KEY_B, [order("b1")]);
  await until("handed out", () => state.due.get(KEY_B)!.length === 0);
  await delay(50);
  assert.deepEqual(started(state), ["a1"]);
  assert.equal(state.mostActive, 1);
  state.release.get("a1")!();
  await until("its turn", () => state.started.length === 2);
  state.release.get("b1")!();
  await until("finished", () => state.finished.length === 2);
  await agents.stop();
});

test("a run that waited loses that time; if its limit passed while waiting it does not start", async (t) => {
  const { state, deps } = world([KEY_A, KEY_B]);
  state.oldServer = true;
  state.due.set(KEY_A, [order("a1")]);
  const realNow = Date.now;
  const agents = begin(t, state, new Agents(settings, deps, fast));
  await until("the first run", () => state.started.length === 1);
  state.due.set(KEY_B, [order("b1", { maxMinutes: 3 }), order("b2", { maxMinutes: 10 })]);
  await until("both handed out", () => state.due.get(KEY_B)!.length === 0);
  // Five minutes later
  Date.now = () => realNow() + 5 * 60_000;
  try {
    state.release.get("a1")!();
    await until("the second order runs", () => state.started.length === 2);
    assert.equal(state.started[1]!.id, "b2");
    assert.equal(state.started[1]!.order.maxMinutes, 5);
    const skipped = state.finished.find((f) => f.id === "b1")!;
    assert.equal(skipped.result.status, "error");
    assert.match(skipped.result.error!, /Not started/);
    state.release.get("b2")!();
    await until("finished", () => state.finished.length === 3);
    await agents.stop();
  } finally {
    Date.now = realNow;
  }
});

test("a run that cannot even start is reported and does not block the next", async (t) => {
  const { state, deps } = world([KEY_A, KEY_B]);
  state.due.set(KEY_A, [order("a1")]);
  const failing: AgentDeps = { ...deps, runClaude: (cfg, o) => (o.id === "a1" ? Promise.reject(new Error("no temp dir")) : deps.runClaude(cfg, o)) };
  const agents = begin(t, state, new Agents(settings, failing, fast));
  await until("the report", () => state.finished.length === 1);
  assert.deepEqual(state.finished[0]!.result, { status: "error", error: "no temp dir" });
  state.due.set(KEY_B, [order("b1")]);
  await until("the next run", () => state.started.length === 1);
  state.release.get("b1")!();
  await until("finished", () => state.finished.length === 2);
  await agents.stop();
});

test("no whole key in anything this program logs", async (t) => {
  const { state, deps } = world([KEY_A, KEY_B, KEY_C]);
  state.fails.set(KEY_C, new RulioError(401, "no"));
  state.due.set(KEY_A, [order("a1")]);
  const agents = begin(t, state, new Agents(settings, deps, fast));
  await until("the run", () => state.started.length === 1);
  state.keys = [KEY_A];
  state.release.get("a1")!();
  await until("finished", () => state.finished.length === 1);
  await until("the removals", () => state.logs.filter((l) => l.includes("Key removed")).length === 2);
  await agents.stop();
  for (const line of state.logs) assert.doesNotMatch(line, /rulio_/);
});

test("once: asks with the key, executes a due run and reports it", async () => {
  const { state, deps } = world([KEY_A]);
  state.due.set(KEY_A, [order("a1")]);
  const asked = askOnce(deps, { ...settings, rulioToken: KEY_A });
  await until("the run", () => state.started.length === 1);
  state.release.get("a1")!();
  await asked;
  assert.equal(state.finished.length, 1);
  assert.equal(state.polls[0]!.busy, false);
});

test("the request: busy does not wait, peek hands out nothing, otherwise a long poll; 401 comes through", async () => {
  const realFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  const cfg = { ...settings, rulioToken: KEY_A };
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return new Response(JSON.stringify(idle), { status: 200 });
  }) as typeof fetch;
  try {
    await poll(cfg, { busy: true });
    await poll(cfg, { peek: true });
    await poll(cfg, { wait: 0 });
    await poll(cfg);
    assert.deepEqual(bodies, [
      { client: "rulio-agent@test", busy: true },
      { client: "rulio-agent@test", wait: 25, peek: true },
      { client: "rulio-agent@test", wait: 0 },
      { client: "rulio-agent@test", wait: 25 },
    ]);
    globalThis.fetch = (async () => new Response("gone", { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(poll(cfg), (err: RulioError) => err.status === 401);
  } finally {
    globalThis.fetch = realFetch;
  }
});
