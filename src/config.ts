import { hostname } from "node:os";

/**
 * Settings from the environment. The rulio keys come from keys.ts, one Config
 * per key; the Claude login belongs to Claude Code itself (`claude login` or
 * CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`) — rulio-agent never reads it.
 */
export interface Config {
  rulioUrl: string;
  rulioToken: string;
  claudeBin: string;
  clientName: string;
  /** Pass ANTHROPIC_API_KEY on to Claude Code (otherwise removed: the run should use the subscription) */
  useApiKey: boolean;
}

export type Settings = Omit<Config, "rulioToken">;

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    rulioUrl: (env.RULIO_URL?.trim() || "https://api.rulio.net").replace(/\/+$/, ""),
    claudeBin: env.CLAUDE_BIN?.trim() || "claude",
    clientName: env.RULIO_CLIENT_NAME?.trim() || `rulio-agent@${hostname()}`,
    useApiKey: env.RULIO_AGENT_USE_API_KEY === "1",
  };
}
