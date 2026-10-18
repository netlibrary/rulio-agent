import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { RunOrder, RunResult } from "./rulio.js";

/**
 * Execute a run with Claude Code — the unmodified `claude` program with the
 * user's login. Safeguards:
 *  - only the rulio MCP server (own, temporary configuration; all other MCP
 *    servers and the built-in tools such as Bash/Read are off)
 *  - only rulio tools allowed, everything else is denied without asking
 *  - time limit (abort) and turn limit
 * Report runs may also start subagents (tool "Agent"): parallel steps, one
 * per stock. Subagents only inherit what the run has — the rulio tools; Bash,
 * files and web stay off.
 */
export function mcpConfig(cfg: Config): string {
  return JSON.stringify({
    mcpServers: {
      rulio: { type: "http", url: `${cfg.rulioUrl}/mcp`, headers: { Authorization: `Bearer ${cfg.rulioToken}` } },
    },
  });
}

/** Built-in tool for subagents in Claude Code (formerly "Task", now an alias) */
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

/**
 * The main model of a run: Claude Code lists the tokens per model ID in
 * `modelUsage` (subtasks often run on a smaller model) — the one with the most
 * output tokens counts. null if the field is missing.
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

/** Read the result of `--output-format json` — tolerant, fields change now and then */
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
      // With is_error the reason is in the result text (e.g. "Not logged in"), not in subtype
      error: failed ? (out.is_error && out.result ? out.result : (out.subtype ?? `Exit ${exitCode}`)) : null,
    };
  } catch {
    return {
      status: "error",
      summary: null,
      error: `Claude Code output not readable (exit ${exitCode}): ${text.slice(0, 500)}`,
    };
  }
}

export async function runClaude(cfg: Config, order: RunOrder): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), "rulio-agent-"));
  const configPath = join(dir, "mcp.json");
  // Contains the rulio key: readable only by the own user, removed after the run
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
        resolve({ status: "error", error: `Claude Code could not be started (${cfg.claudeBin}): ${err.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ status: "timeout", error: `Aborted after ${order.maxMinutes} minutes`, summary: null });
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
