import { hostname } from "node:os";

/**
 * Einstellungen aus der Umgebung. Der rulio-Schlüssel ist Pflicht; der
 * Claude-Login gehört Claude Code selbst (`claude login` bzw.
 * CLAUDE_CODE_OAUTH_TOKEN aus `claude setup-token`) — rulio-agent liest ihn
 * nie.
 */
export interface Config {
  rulioUrl: string;
  rulioToken: string;
  claudeBin: string;
  clientName: string;
  /** ANTHROPIC_API_KEY an Claude Code durchreichen (sonst entfernt: der Lauf soll das Abo nutzen) */
  useApiKey: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rulioToken = env.RULIO_TOKEN?.trim() ?? "";
  if (!rulioToken.startsWith("rulio_")) {
    throw new Error("RULIO_TOKEN fehlt oder ist kein rulio-Schlüssel (rulio → Einstellungen → KI-Agent → Verbindung).");
  }
  return {
    rulioUrl: (env.RULIO_URL?.trim() || "https://api.rulio.net").replace(/\/+$/, ""),
    rulioToken,
    claudeBin: env.CLAUDE_BIN?.trim() || "claude",
    clientName: env.RULIO_CLIENT_NAME?.trim() || `rulio-agent@${hostname()}`,
    useApiKey: env.RULIO_AGENT_USE_API_KEY === "1",
  };
}
