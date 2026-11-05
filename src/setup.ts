import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { Settings } from "./config.js";

/**
 * What rulio-agent tells rulio about its setup with every poll, so the app can
 * show where it runs and whether the model can be paid for. Only yes or no:
 * never a key, never the value or the name of a variable.
 */
export interface AgentSetup {
  docker: boolean;
  /** Claude Code: logged in, not logged in, or the check itself failed */
  claude: "ok" | "missing" | "unknown";
  /** Runs with Claude Code use ANTHROPIC_API_KEY instead of the subscription */
  claudeApiKey: boolean;
  /** A provider key for keys with their own model is present */
  providerKey: boolean;
}

/** The login is checked at the start and then at most this often, not with every poll */
export const CLAUDE_CHECK_MS = 10 * 60_000;
const CLAUDE_CHECK_TIMEOUT_MS = 15_000;

type RunClaude = (bin: string) => Promise<{ text: string; failed: boolean; notFound: boolean }>;

const runClaudeAuth: RunClaude = (bin) =>
  new Promise((resolve) => {
    execFile(bin, ["auth", "status", "--text"], { encoding: "utf8", timeout: CLAUDE_CHECK_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      resolve({ text: `${stdout ?? ""}${stderr ?? ""}`, failed: !!err, notFound: code === "ENOENT" });
    });
  });

export interface SetupDeps {
  exists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  runClaude?: RunClaude;
  now?: () => number;
}

/** Without a cached answer it asks once, also for several keys at the same time */
export function setupProbe({ exists = existsSync, env = process.env, runClaude = runClaudeAuth, now = Date.now }: SetupDeps = {}) {
  let known: { at: number; claude: AgentSetup["claude"] } | null = null;
  let asking: Promise<AgentSetup["claude"]> | null = null;

  const askClaude = async (cfg: Pick<Settings, "claudeBin" | "useApiKey">): Promise<AgentSetup["claude"]> => {
    if (cfg.useApiKey) return env.ANTHROPIC_API_KEY ? "ok" : "missing";
    const r = await runClaude(cfg.claudeBin);
    if (r.notFound) return "missing";
    if (/not logged in/i.test(r.text)) return env.CLAUDE_CODE_OAUTH_TOKEN ? "ok" : "missing";
    return r.failed ? "unknown" : "ok";
  };

  const claude = (cfg: Pick<Settings, "claudeBin" | "useApiKey">): Promise<AgentSetup["claude"]> => {
    if (known && now() - known.at < CLAUDE_CHECK_MS) return Promise.resolve(known.claude);
    asking ??= askClaude(cfg)
      .catch((): AgentSetup["claude"] => "unknown")
      .then((value) => {
        known = { at: now(), claude: value };
        asking = null;
        return value;
      });
    return asking;
  };

  return async (cfg: Pick<Settings, "claudeBin" | "useApiKey" | "opencodeKeys">): Promise<AgentSetup> => ({
    docker: exists("/.dockerenv"),
    claude: await claude(cfg),
    claudeApiKey: cfg.useApiKey,
    providerKey: cfg.opencodeKeys.some((name) => !!env[name]),
  });
}

export const currentSetup = setupProbe();
