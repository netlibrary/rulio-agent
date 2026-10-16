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
  /** rulio hat die Anfrage offen gehalten (Long-Poll) — gleich wieder fragen; ältere Server lassen es weg */
  longPoll?: boolean;
}

/** So lange darf rulio einen Abruf offen halten, bis etwas zu tun ist (Server-Höchstwert 25 s) */
export const POLL_WAIT_SECONDS = 25;

export interface RunResult {
  status: "ok" | "error" | "timeout";
  summary?: string | null;
  turns?: number | null;
  costUsd?: number | null;
  error?: string | null;
  /** Hauptmodell des Laufs (Modell-ID aus Claude Code); null = unbekannt */
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
 * Abruf: meldet den Client als online; ist ein Lauf fällig, kommt sein Auftrag.
 * Long-Poll: Ist nichts fällig, hält rulio die Anfrage bis zu `wait` Sekunden
 * offen und antwortet sofort, sobald eine Chat-Nachricht kommt.
 */
export function poll(cfg: Config, wait = POLL_WAIT_SECONDS): Promise<PollReply> {
  return call<PollReply>(cfg, "/api/agent/runner/poll", { client: cfg.clientName, wait }, (wait + 20) * 1000);
}

/**
 * Wann wieder fragen (Sekunden). Mit Long-Poll sofort — außer rulio kam ohne
 * Lauf deutlich vor der Wartezeit zurück (Notaus, Redis weg): dann im Takt
 * des Servers, damit kein Dauerfeuer entsteht. Ältere Server: ihr Takt, ab 5 s.
 */
export function nextPollDelay(reply: PollReply, elapsedMs: number, wait = POLL_WAIT_SECONDS): number {
  if (!reply.longPoll) return Math.max(5, reply.pollSeconds);
  if (reply.run) return 0;
  return elapsedMs >= (wait * 1000) / 2 ? 0 : Math.max(5, reply.pollSeconds);
}

export function finish(cfg: Config, id: string, result: RunResult): Promise<unknown> {
  return call(cfg, `/api/agent/runner/runs/${id}/finish`, result);
}
