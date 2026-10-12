import type { Config } from "./config.js";

/** Was rulio für einen Lauf vorgibt (Backend: agent/runner.ts) */
export interface RunOrder {
  id: string;
  trigger: string;
  prompt: string;
  maxMinutes: number;
  maxTurns: number;
}

export interface PollReply {
  run: RunOrder | null;
  pollSeconds: number;
  enabled: boolean;
}

export interface RunResult {
  status: "ok" | "error" | "timeout";
  summary?: string | null;
  turns?: number | null;
  costUsd?: number | null;
  error?: string | null;
}

async function call<T>(cfg: Config, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${cfg.rulioUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.rulioToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rulio ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** Abruf: meldet den Client als online; ist ein Lauf fällig, kommt sein Auftrag */
export function poll(cfg: Config): Promise<PollReply> {
  return call<PollReply>(cfg, "/api/agent/runner/poll", { client: cfg.clientName });
}

export function finish(cfg: Config, id: string, result: RunResult): Promise<unknown> {
  return call(cfg, `/api/agent/runner/runs/${id}/finish`, result);
}
