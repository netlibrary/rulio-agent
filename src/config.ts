import { hostname } from "node:os";

/**
 * Settings from the environment. The rulio keys come from keys.ts, one Config
 * per key; the Claude login belongs to Claude Code itself (`claude login` or
 * CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`) — rulio-agent never reads it.
 * Provider keys for other models are only passed on to OpenCode.
 */
export interface Config {
  rulioUrl: string;
  rulioToken: string;
  claudeBin: string;
  opencodeBin: string;
  /** Packages OpenCode wants in its config directory, installed ahead of time (Dockerfile) */
  opencodeDeps: string;
  /** Environment variables with provider keys that OpenCode gets, nothing else is passed on */
  opencodeKeys: string[];
  /** Providers billed by subscription: what OpenCode reports as cost is no real cost of the run */
  flatRateProviders: string[];
  clientName: string;
  /** Pass ANTHROPIC_API_KEY on to Claude Code (otherwise removed: the run should use the subscription) */
  useApiKey: boolean;
}

export type Settings = Omit<Config, "rulioToken">;

const list = (value: string | undefined, fallback: string[]): string[] =>
  value === undefined ? fallback : value.split(",").map((s) => s.trim()).filter(Boolean);

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    rulioUrl: (env.RULIO_URL?.trim() || "https://api.rulio.net").replace(/\/+$/, ""),
    claudeBin: env.CLAUDE_BIN?.trim() || "claude",
    opencodeBin: env.OPENCODE_BIN?.trim() || "opencode",
    opencodeDeps: env.RULIO_AGENT_OPENCODE_DEPS?.trim() || "/opt/opencode-deps",
    opencodeKeys: list(env.RULIO_AGENT_OPENCODE_KEYS, ["OPENCODE_API_KEY", "OPENROUTER_API_KEY"]),
    flatRateProviders: list(env.RULIO_AGENT_FLAT_PROVIDERS, ["opencode-go"]),
    clientName: env.RULIO_CLIENT_NAME?.trim() || `rulio-agent@${hostname()}`,
    useApiKey: env.RULIO_AGENT_USE_API_KEY === "1",
  };
}
