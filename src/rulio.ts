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
}

export interface PollReply {
  run: RunOrder | null;
  pollSeconds: number;
  enabled: boolean;
  /** rulio held the request open (long poll) — ask again right away; older servers omit it */
  longPoll?: boolean;
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

async function call<T>(cfg: Config, path: string, body: unknown, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(`${cfg.rulioUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.rulioToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rulio ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/**
 * Poll: reports the client as online; if a run is due, its order comes back.
 * Long poll: if nothing is due, rulio holds the request open for up to `wait`
 * seconds and answers as soon as a chat message arrives.
 */
export function poll(cfg: Config, wait = POLL_WAIT_SECONDS): Promise<PollReply> {
  return call<PollReply>(cfg, "/api/agent/runner/poll", { client: cfg.clientName, wait }, (wait + 20) * 1000);
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
