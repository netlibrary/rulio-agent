import type { Config } from "./config.js";

/** What rulio specifies for a run (backend: agent/runner.ts) */
export interface RunOrder {
  id: string;
  trigger: string;
  prompt: string;
  maxMinutes: number;
  maxTurns: number;
  /** Report run: the longer limits already come in maxMinutes/maxTurns */
  kind?: "report";
  /** Subagents allowed — parallel steps of a report; older servers omit it */
  allowSubagents?: boolean;
  /**
   * Web research allowed (report runs whose workflow permits it): web search
   * and reading pages. rulio then rejects every changing tool for this run.
   */
  web?: boolean;
}

export interface PollReply {
  run: RunOrder | null;
  pollSeconds: number;
  enabled: boolean;
  /** rulio held the request open (long poll) — ask again right away; older servers omit it */
  longPoll?: boolean;
  /** Answer to `peek`: a run is due and waits to be picked up; older servers hand it out instead */
  due?: boolean;
}

/** How long rulio may hold a poll open until there is something to do (server maximum 25 s) */
export const POLL_WAIT_SECONDS = 25;

export interface RunResult {
  status: "ok" | "error" | "timeout";
  summary?: string | null;
  turns?: number | null;
  costUsd?: number | null;
  error?: string | null;
  /** Main model of the run (model ID from Claude Code); null = unknown */
  model?: string | null;
}

/** rulio answered with an error status */
export class RulioError extends Error {
  constructor(
    readonly status: number,
    text: string,
  ) {
    super(`rulio ${status}: ${text.slice(0, 300)}`);
  }
}

/** The key itself is the problem: unknown, revoked or not allowed here */
export const isKeyRejected = (err: unknown): boolean => err instanceof RulioError && (err.status === 401 || err.status === 403);

async function call<T>(cfg: Config, path: string, body: unknown, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(`${cfg.rulioUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.rulioToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new RulioError(res.status, text);
  return JSON.parse(text) as T;
}

export interface PollOptions {
  /** A run is going on: only check in, rulio hands out no order and does not hold the request open */
  busy?: boolean;
  /** Only find out whether a run is due: rulio answers `due` and hands out nothing */
  peek?: boolean;
  /** Seconds rulio may hold the request open */
  wait?: number;
}

/**
 * Poll: reports the client as online; if a run is due, its order comes back.
 * Long poll: if nothing is due, rulio holds the request open for up to
 * POLL_WAIT_SECONDS and answers as soon as a chat message arrives.
 */
export function poll(cfg: Config, { busy, peek, wait = POLL_WAIT_SECONDS }: PollOptions = {}): Promise<PollReply> {
  if (busy) return call<PollReply>(cfg, "/api/agent/runner/poll", { client: cfg.clientName, busy: true }, 20_000);
  return call<PollReply>(cfg, "/api/agent/runner/poll", { client: cfg.clientName, wait, ...(peek ? { peek: true } : {}) }, (wait + 20) * 1000);
}

/**
 * When to ask again (seconds). With long poll right away — unless rulio came
 * back without a run well before the wait time (emergency stop, Redis down):
 * then at the server's interval, so there is no tight loop. Older servers:
 * their interval, at least 5 s.
 */
export function nextPollDelay(reply: PollReply, elapsedMs: number, wait = POLL_WAIT_SECONDS): number {
  if (!reply.longPoll) return Math.max(5, reply.pollSeconds);
  if (reply.run) return 0;
  return elapsedMs >= (wait * 1000) / 2 ? 0 : Math.max(5, reply.pollSeconds);
}

export function finish(cfg: Config, id: string, result: RunResult): Promise<unknown> {
  return call(cfg, `/api/agent/runner/runs/${id}/finish`, result);
}
