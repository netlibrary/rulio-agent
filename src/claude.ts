import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { RunOrder, RunResult } from "./rulio.js";

/**
 * Einen Lauf mit Claude Code ausführen — dem unveränderten `claude`-Programm
 * mit dem Login des Nutzers. Abgesichert:
 *  - nur der rulio-MCP-Server (eigene, temporäre Konfiguration; alle anderen
 *    MCP-Server und die eingebauten Werkzeuge wie Bash/Read sind aus)
 *  - nur rulio-Werkzeuge erlaubt, alles andere wird ohne Nachfrage abgelehnt
 *  - Zeitdeckel (Abbruch) und Schrittdeckel
 * Bericht-Läufe (rulio-tickets#255) dürfen zusätzlich Unteragenten starten
 * (Werkzeug „Agent“): parallele Schritte, je Aktie einer. Unteragenten erben
 * nur, was der Lauf hat — die rulio-Werkzeuge; Bash, Dateien und Web bleiben aus.
 */
export function mcpConfig(cfg: Config): string {
  return JSON.stringify({
    mcpServers: {
      rulio: { type: "http", url: `${cfg.rulioUrl}/mcp`, headers: { Authorization: `Bearer ${cfg.rulioToken}` } },
    },
  });
}

/** Eingebautes Werkzeug für Unteragenten in Claude Code (früher „Task“, heute ein Alias) */
export const SUBAGENT_TOOL = "Agent";

export function claudeArgs(configPath: string, order: Pick<RunOrder, "maxTurns" | "allowSubagents">): string[] {
  const sub = order.allowSubagents === true;
  return [
    "-p",
    "--mcp-config",
    configPath,
    "--strict-mcp-config",
    "--tools",
    sub ? SUBAGENT_TOOL : "",
    "--allowedTools",
    sub ? `mcp__rulio__*,${SUBAGENT_TOOL}` : "mcp__rulio__*",
    "--permission-mode",
    "dontAsk",
    "--max-turns",
    String(order.maxTurns),
    "--output-format",
    "json",
    "--no-session-persistence",
  ];
}

/** Ergebnis von `--output-format json` lesen — tolerant, Felder ändern sich gelegentlich */
/**
 * Das Hauptmodell eines Laufs: Claude Code nennt in `modelUsage` je Modell-ID
 * die Tokens (Unteraufgaben laufen oft auf einem kleineren Modell) — es zählt
 * das mit den meisten Ausgabe-Tokens. null, wenn die Angabe fehlt.
 */
export function mainModel(usage: unknown): string | null {
  if (!usage || typeof usage !== "object") return null;
  let best: string | null = null;
  let most = -1;
  for (const [id, u] of Object.entries(usage as Record<string, { outputTokens?: unknown }>)) {
    const out = typeof u?.outputTokens === "number" ? u.outputTokens : 0;
    if (out > most) {
      most = out;
      best = id;
    }
  }
  return best;
}

export function parseClaudeOutput(stdout: string, exitCode: number | null): RunResult {
  const text = stdout.trim();
  const start = text.lastIndexOf("\n{");
  const json = start >= 0 ? text.slice(start + 1) : text;
  try {
    const out = JSON.parse(json) as {
      result?: string;
      is_error?: boolean;
      subtype?: string;
      num_turns?: number;
      total_cost_usd?: number;
      modelUsage?: unknown;
    };
    const failed = out.is_error === true || (out.subtype !== undefined && out.subtype !== "success") || (exitCode ?? 0) !== 0;
    return {
      status: failed ? "error" : "ok",
      summary: out.result ?? null,
      turns: typeof out.num_turns === "number" ? out.num_turns : null,
      costUsd: typeof out.total_cost_usd === "number" ? out.total_cost_usd : null,
      model: mainModel(out.modelUsage),
      // Bei is_error steht der Grund im Ergebnistext (z. B. „Not logged in“), nicht im subtype
      error: failed ? (out.is_error && out.result ? out.result : (out.subtype ?? `Exit ${exitCode}`)) : null,
    };
  } catch {
    return {
      status: "error",
      summary: null,
      error: `Ausgabe von Claude Code nicht lesbar (Exit ${exitCode}): ${text.slice(0, 500)}`,
    };
  }
}

export async function runClaude(cfg: Config, order: RunOrder): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), "rulio-agent-"));
  const configPath = join(dir, "mcp.json");
  // Enthält den rulio-Schlüssel: nur für den eigenen Nutzer lesbar, nach dem Lauf weg
  writeFileSync(configPath, mcpConfig(cfg), { mode: 0o600 });
  const env = { ...process.env };
  if (!cfg.useApiKey) delete env.ANTHROPIC_API_KEY;
  try {
    return await new Promise<RunResult>((resolve) => {
      const child = spawn(cfg.claudeBin, claudeArgs(configPath, order), { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, order.maxMinutes * 60_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ status: "error", error: `Claude Code nicht startbar (${cfg.claudeBin}): ${err.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ status: "timeout", error: `Nach ${order.maxMinutes} Minuten abgebrochen`, summary: null });
          return;
        }
        const result = parseClaudeOutput(stdout, code);
        if (result.status === "error" && !result.error && stderr) result.error = stderr.slice(0, 1000);
        resolve(result);
      });
      child.stdin.end(order.prompt);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
