import type { Config, Settings } from "./config.js";
import { keyTail } from "./keys.js";
import { isKeyRejected, nextPollDelay, POLL_WAIT_SECONDS, type PollOptions, type PollReply, type RunOrder, type RunResult } from "./rulio.js";

/**
 * One loop per key, at most one run at a time. Every loop keeps checking in, so
 * rulio sees each account as reachable even during a long run in another one.
 * A loop waits for work with `peek`, which hands out nothing, and picks the
 * order up in a second request: one at a time and only while nothing runs. An
 * order handed out can no longer be taken back, so two accounts due at the same
 * moment must not both get theirs. A run gets the Config of its loop and with it
 * only the key of its own account.
 */
export interface AgentDeps {
  poll(cfg: Config, opts: PollOptions): Promise<PollReply>;
  runEngine(cfg: Config, order: RunOrder): Promise<RunResult>;
  finish(cfg: Config, id: string, result: RunResult): Promise<unknown>;
  log(msg: string): void;
  /** The keys that should be running right now */
  keys(): string[];
}

export const TIMING = {
  /** Check-in while a run is going on: rulio shows a client as offline after 10 minutes */
  busyPollSeconds: 60,
  errorRetrySeconds: 60,
  /** A revoked key may stay revoked for good: no hurry to ask again */
  rejectedRetrySeconds: 30 * 60,
  /** How soon a key added to or removed from the file takes effect */
  reloadSeconds: 30,
  /** How long rulio may hold a request open while waiting for work */
  longPollSeconds: POLL_WAIT_SECONDS,
  /** A run was reported as due, but picking it up brought none: not again right away */
  noOrderRetrySeconds: 5,
};
export type Timing = typeof TIMING;

interface Loop {
  cfg: Config;
  label: string;
  active: boolean;
  rejected: boolean;
  /** Ends the current sleep */
  wake: (() => void) | null;
}

interface Job {
  loop: Loop;
  order: RunOrder;
  receivedAt: number;
}

/** Execute a run and report the result; a run of its own Config, nothing shared */
async function execute(deps: AgentDeps, cfg: Config, label: string, order: RunOrder): Promise<void> {
  deps.log(`${label} Run ${order.id} (${order.trigger}${order.kind === "report" ? ", report" : ""}) — at most ${order.maxMinutes} min${order.allowSubagents ? ", with subagents" : ""}${order.web ? ", with web research" : ""}`);
  const started = Date.now();
  const result = await deps.runEngine(cfg, order).catch((err: Error): RunResult => ({ status: "error", error: err.message }));
  deps.log(`${label} Run ${order.id}: ${result.status} after ${Math.round((Date.now() - started) / 1000)} s${result.error ? ` — ${result.error}` : ""}`);
  await deps.finish(cfg, order.id, result).catch((err: Error) => deps.log(`${label} Result not reported: ${err.message}`));
}

/** `once`: ask with this key, execute a due run. Errors are the caller's to report */
export async function askOnce(deps: AgentDeps, cfg: Config): Promise<void> {
  const label = keyTail(cfg.rulioToken);
  const reply = await deps.poll(cfg, {});
  if (!reply.enabled) deps.log(`${label} Emergency stop active — no run`);
  if (reply.run) await execute(deps, cfg, label, reply.run);
}

export class Agents {
  private readonly loops = new Map<string, Loop>();
  private readonly ended = new Set<Promise<void>>();
  private readonly queue: Job[] = [];
  /** Picking up orders goes one at a time */
  private pickups: Promise<void> = Promise.resolve();
  private running: Job | null = null;
  private stopped = false;
  private reload: ReturnType<typeof setInterval> | null = null;
  private keysFailing = false;

  constructor(
    private readonly settings: Settings,
    private readonly deps: AgentDeps,
    private readonly timing: Timing = TIMING,
  ) {}

  get busy(): boolean {
    return this.running !== null || this.queue.length > 0;
  }

  start(): void {
    this.sync();
    this.reload = setInterval(() => this.sync(), this.timing.reloadSeconds * 1000);
  }

  /** Bring the loops in line with the keys; a file that cannot be read changes nothing */
  sync(): void {
    let wanted: string[];
    try {
      wanted = this.deps.keys();
      this.keysFailing = false;
    } catch (err) {
      if (!this.keysFailing) this.deps.log(`Keys not readable, keeping the current ones: ${(err as Error).message}`);
      this.keysFailing = true;
      return;
    }
    for (const key of wanted) {
      const known = this.loops.get(key);
      if (known) {
        known.active = true;
        continue;
      }
      this.startLoop(key);
    }
    for (const [key, loop] of this.loops) {
      if (loop.active && !wanted.includes(key)) {
        this.deps.log(`${loop.label} Key removed — ending after the current check-in`);
        loop.active = false;
        loop.wake?.();
      }
    }
  }

  /** Stop all loops and wait for them and for the runs that are left */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reload) clearInterval(this.reload);
    for (const loop of this.loops.values()) loop.wake?.();
    while (this.ended.size) await Promise.all(this.ended);
  }

  private startLoop(key: string): void {
    const loop: Loop = { cfg: { ...this.settings, rulioToken: key }, label: keyTail(key), active: true, rejected: false, wake: null };
    this.loops.set(key, loop);
    this.deps.log(`${loop.label} Key active`);
    const ended: Promise<void> = this.runLoop(loop).finally(() => {
      this.ended.delete(ended);
      this.loops.delete(key);
    });
    this.ended.add(ended);
  }

  private async runLoop(loop: Loop): Promise<void> {
    while (loop.active && !this.stopped) {
      let seconds: number;
      try {
        seconds = await this.ask(loop);
        if (loop.rejected) this.deps.log(`${loop.label} Key accepted again`);
        loop.rejected = false;
      } catch (err) {
        seconds = this.failed(loop, err as Error);
      }
      if (seconds > 0 && loop.active && !this.stopped) await this.sleep(loop, seconds);
    }
  }

  /** One poll; returns seconds until the next */
  private async ask(loop: Loop): Promise<number> {
    if (this.busy) {
      const reply = await this.deps.poll(loop.cfg, { busy: true });
      // A server without `busy` hands out runs anyway. Assigned is assigned: it waits its turn
      if (reply.run) this.enqueue(loop, reply.run);
      // The run may have ended during this check-in, with nobody asleep to wake
      return this.busy ? this.timing.busyPollSeconds : 0;
    }
    const asked = Date.now();
    const reply = await this.deps.poll(loop.cfg, { peek: true, wait: this.timing.longPollSeconds });
    if (!reply.enabled) this.deps.log(`${loop.label} Emergency stop active — no run`);
    if (reply.due) {
      if (loop.active) await this.pickUp(loop);
      return this.busy ? this.timing.busyPollSeconds : this.timing.noOrderRetrySeconds;
    }
    // A server without `peek` hands the run out right here
    if (reply.run) this.enqueue(loop, reply.run);
    return nextPollDelay(reply, Date.now() - asked, this.timing.longPollSeconds);
  }

  /** Whoever comes second finds a run going on and leaves the order at rulio */
  private pickUp(loop: Loop): Promise<void> {
    const done = this.pickups.then(async () => {
      if (this.busy) return;
      const reply = await this.deps.poll(loop.cfg, { wait: 0 });
      if (reply.run) this.enqueue(loop, reply.run);
    });
    this.pickups = done.catch(() => {});
    return done;
  }

  private failed(loop: Loop, err: Error): number {
    if (isKeyRejected(err)) {
      if (!loop.rejected) this.deps.log(`${loop.label} Key rejected by rulio — the other keys keep running. Create a new one in rulio.`);
      loop.rejected = true;
      return this.timing.rejectedRetrySeconds;
    }
    this.deps.log(`${loop.label} Error: ${err.message} — retrying shortly`);
    return this.timing.errorRetrySeconds;
  }

  private enqueue(loop: Loop, order: RunOrder): void {
    const wasBusy = this.busy;
    this.queue.push({ loop, order, receivedAt: Date.now() });
    if (wasBusy) return;
    this.busyChanged();
    void this.work();
  }

  /** First come, first served, one at a time */
  private async work(): Promise<void> {
    const worked: Promise<void> = (async () => {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        this.running = job;
        await this.runJob(job);
        this.running = null;
      }
    })().finally(() => this.ended.delete(worked));
    this.ended.add(worked);
    await worked;
    this.busyChanged();
  }

  private async runJob({ loop, order, receivedAt }: Job): Promise<void> {
    const { cfg, label } = loop;
    const notStarted = (error: string) =>
      this.deps.finish(cfg, order.id, { status: "error", error }).catch((err: Error) => this.deps.log(`${label} Result not reported: ${err.message}`));
    if (!loop.active) {
      this.deps.log(`${label} Run ${order.id}: not started, key removed`);
      await notStarted("Not started: the key was removed from rulio-agent");
      return;
    }
    // rulio counts the run from the moment it was handed out, waiting included
    const waited = Math.floor((Date.now() - receivedAt) / 60_000);
    const left = order.maxMinutes - waited;
    if (left < 1) {
      this.deps.log(`${label} Run ${order.id}: not started, it waited ${waited} min for another run`);
      await notStarted(`Not started: it waited ${waited} minutes for a run in another account`);
      return;
    }
    await execute(this.deps, cfg, label, waited ? { ...order, maxMinutes: left } : order);
  }

  /** A run starts or the last one ended: sleepers ask again */
  private busyChanged(): void {
    for (const loop of this.loops.values()) if (!loop.rejected) loop.wake?.();
  }

  private sleep(loop: Loop, seconds: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        loop.wake = null;
        resolve();
      };
      const timer = setTimeout(done, seconds * 1000);
      loop.wake = done;
    });
  }
}
