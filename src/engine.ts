import { runClaude } from "./claude.js";
import { runOpenCode } from "./opencode.js";
import type { Config } from "./config.js";
import type { RunOrder, RunResult } from "./rulio.js";

type Engine = (cfg: Config, order: RunOrder) => Promise<RunResult>;

/** The order decides: without a model the unchanged Claude Code, with one OpenCode */
export const runEngineFor = (claude: Engine, opencode: Engine): Engine => (cfg, order) => (order.model ? opencode(cfg, order) : claude(cfg, order));

export const runEngine: Engine = runEngineFor(runClaude, (cfg, order) => runOpenCode(cfg, order));
