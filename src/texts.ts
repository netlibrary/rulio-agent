/**
 * What the program says about itself. In rulio and here it is called Agentio; the
 * repository, the commands, the Docker image, the keys folder and the client id stay
 * rulio-agent.
 */
export const NAME = "Agentio";

export const HELP = `${NAME} – runs your own AI agent on a schedule with rulio

Usage: rulio-agent [command]

Commands:
  run                 keep running and execute due runs, one at a time (default)
  once                ask rulio once with each key, execute due runs, then exit
  check               check the setup (all rulio keys, Claude Code login, OpenCode)
  add-key <rulio_…>   add a key for another account; a running ${NAME} picks it up within 30 s
  remove-key <…tail>  remove a key from the file by its last 6 characters
  list-keys           show the keys by their last 6 characters
  help                show this help

Environment:
  RULIO_TOKEN              key from rulio: rulio → AI agent → Connection (or use add-key)
  RULIO_URL                rulio address (default https://api.rulio.net)
  CLAUDE_BIN               path to claude (default claude)
  OPENCODE_BIN             path to opencode (default opencode)
  OPENCODE_API_KEY         provider key for keys with their own model; OpenCode gets it, nothing else reads it
  OPENROUTER_API_KEY       the same for models from OpenRouter
  RULIO_AGENT_OPENCODE_KEYS   names of the variables with provider keys (default OPENCODE_API_KEY,OPENROUTER_API_KEY)
  RULIO_AGENT_FLAT_PROVIDERS  providers billed by subscription, no cost per run (default opencode-go)
  RULIO_CLIENT_NAME        name shown in rulio (default rulio-agent@<host>)
  RULIO_AGENT_USE_API_KEY  1 = use ANTHROPIC_API_KEY instead of the subscription

More: https://github.com/netlibrary/rulio-agent`;

export const NO_KEYS = "No rulio key: set RULIO_TOKEN or run `rulio-agent add-key rulio_…` (rulio → AI agent → Connection).";

/** Start message of `rulio-agent run` */
export const startLine = (clientName: string, rulioUrl: string, keys: number): string =>
  `${NAME} running as ${clientName} against ${rulioUrl} with ${keys} ${keys === 1 ? "key" : "keys"}`;

export const keyAdded = (tail: string): string => `Key ${tail} added. A running ${NAME} picks it up within 30 s.`;
export const keyRemoved = (tail: string): string => `Key ${tail} removed. A running ${NAME} stops using it within 30 s.`;

/** A run of a key that is no longer in the keys file: rulio shows this at the run */
export const KEY_GONE = `Not started: the key was removed from ${NAME}`;
