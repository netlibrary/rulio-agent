import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";
import { PROVIDERS, providerLabel, withProviderKeys } from "./providerKeys.js";
import type { RunOrder, RunResult } from "./rulio.js";

/**
 * Execute a run with OpenCode (`opencode run`), the engine for every model that
 * is not the Claude subscription. The order names the model as
 * `provider/model`, so changing the provider needs no code. Safeguards, the
 * same as for Claude Code:
 *  - only the rulio MCP server, all other tools denied, with `--auto` too.
 *    Report runs with web research (`order.web`) also get OpenCode's two web
 *    tools, `webfetch` and `websearch`; rulio then refuses every changing call
 *    for the whole run (webRunMayCall), whatever the model
 *  - an empty working directory and its own config, data and cache directories
 *    per run: OPENCODE_CONFIG_CONTENT is merged with other configurations rather
 *    than replacing them, so none may be reachable
 *  - only the environment listed here, so the keys of other accounts and other
 *    services stay out. Provider keys come from `agentio set-provider-key`
 *    (providerKeys.ts) before the variables of the container, read anew for
 *    every run
 *  - time limit and step limit, both enforced here. `steps` alone is no limit:
 *    OpenCode only asks the model to stop and keeps offering it the tools
 *
 * A step limit reached while the next step has already started: its tool call
 * is on its way to rulio and may still be carried out there.
 */
export const OPENCODE_VERSION = "1.19.5";
/** Time between asking the process to end and forcing it */
const KILL_GRACE_MS = 5000;
/** From the parent, needed to start the program; nothing else is inherited */
const BASE_ENV = ["PATH", "SYSTEMROOT", "TEMP", "TMP", "LANG", "NODE_EXTRA_CA_CERTS"];

/** OpenCode's web tools, allowed only in report runs with web research */
export const WEB_TOOLS = ["webfetch", "websearch"] as const;
/**
 * Search service of `websearch`, fixed to Exa (mcp.exa.ai, no key). OpenCode
 * offers the tool on its own only with its own providers and otherwise picks the
 * service per session; with these variables it is there for every provider and
 * always Exa.
 */
export const WEB_SEARCH_ENV = { OPENCODE_ENABLE_EXA: "1", OPENCODE_WEBSEARCH_PROVIDER: "exa" } as const;

/** The configuration of one run: only rulio, everything else denied; web research adds the two web tools */
export function opencodeConfig(cfg: Pick<Config, "rulioUrl" | "rulioToken">, order: Pick<RunOrder, "model" | "maxTurns" | "web">): Record<string, unknown> {
  return {
    model: order.model,
    small_model: order.model,
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    plugin: [],
    mcp: { rulio: { type: "remote", url: `${cfg.rulioUrl}/mcp`, headers: { Authorization: `Bearer ${cfg.rulioToken}` }, oauth: false } },
    permission: { "*": "deny", "rulio_*": "allow", ...(order.web === true ? Object.fromEntries(WEB_TOOLS.map((t) => [t, "allow"])) : {}) },
    // A polite limit: a model that follows it still writes its summary. The limit itself is in runOpenCode
    agent: { build: { steps: order.maxTurns } },
  };
}

export function opencodeArgs(prompt: string): string[] {
  return ["run", "--format", "json", "--auto", "--pure", prompt];
}

/** Environment of one run: the base, its own directories, the provider keys named in the settings; for web research the choice of search service */
export function opencodeEnv(
  cfg: Pick<Config, "rulioUrl" | "rulioToken" | "opencodeKeys">,
  order: Pick<RunOrder, "model" | "maxTurns" | "web">,
  home: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_ENV, ...cfg.opencodeKeys]) if (base[name] !== undefined) env[name] = base[name];
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".data"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".state"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    ...(order.web === true ? WEB_SEARCH_ENV : {}),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(cfg, order)),
  };
}

/**
 * OpenCode installs its plugin package into the config directory on every start,
 * even with no plugin in use: 188 MB and a download per run, on a /tmp of 64 MB
 * on the VM. With the same packages in place from the image it has nothing to
 * fetch. Without them (outside the container) it installs them as before.
 */
export function linkOpencodeDeps(home: string, deps: string): boolean {
  const modules = join(deps, "node_modules");
  if (!existsSync(modules)) return false;
  const dir = join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) copyFileSync(join(deps, file), join(dir, file));
  symlinkSync(modules, join(dir, "node_modules"), "dir");
  return true;
}

/** Provider part of `provider/model` */
export const providerOf = (model: string): string => model.split("/")[0] ?? "";

/** What the JSON stream says so far; the stream also decides when the step limit is reached */
export class StreamReader {
  steps = 0;
  private cost = 0;
  private sawCost = false;
  private text: string | null = null;
  private error: string | null = null;
  private rest = "";

  /** Feed output; returns the number of finished steps */
  push(chunk: string): number {
    this.rest += chunk;
    let i: number;
    while ((i = this.rest.indexOf("\n")) >= 0) {
      this.line(this.rest.slice(0, i));
      this.rest = this.rest.slice(i + 1);
    }
    return this.steps;
  }

  private line(line: string): void {
    let e: { type?: string; part?: { text?: unknown; cost?: unknown }; error?: { name?: unknown; data?: { message?: unknown } } };
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (e.type === "step_finish") {
      this.steps++;
      if (typeof e.part?.cost === "number") {
        this.cost += e.part.cost;
        this.sawCost = true;
      }
    } else if (e.type === "text" && typeof e.part?.text === "string" && e.part.text.trim()) {
      this.text = e.part.text;
    } else if (e.type === "error") {
      this.error = String(e.error?.data?.message ?? e.error?.name ?? "OpenCode reported an error");
    }
  }

  result(): { summary: string | null; turns: number; cost: number | null; error: string | null } {
    return { summary: this.text, turns: this.steps, cost: this.sawCost ? this.cost : null, error: this.error };
  }
}

/** End the process and whatever it started */
export function killTree(child: Pick<ChildProcess, "pid" | "kill">, signal: NodeJS.Signals = "SIGTERM", platform: NodeJS.Platform = process.platform): void {
  if (!child.pid) return;
  try {
    if (platform === "win32") execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    // Its own process group (`detached`), so a started helper goes with it
    else process.kill(-child.pid, signal);
  } catch {
    // Already gone
  }
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export async function runOpenCode(cfg: Config, order: RunOrder, spawnFn: SpawnFn = spawn): Promise<RunResult> {
  const model = order.model!;
  // Each run reads the stored provider keys again: a key set with `agentio set-provider-key` counts without a restart
  const env = withProviderKeys(cfg.opencodeKeys);
  // Ohne Schlüssel des Anbieters käme nur eine unverständliche Absage von dort
  if (!cfg.opencodeKeys.some((name) => env[name])) {
    const provider = PROVIDERS[providerOf(model)] ? providerOf(model) : providerLabel(cfg.opencodeKeys[0] ?? "OPENCODE_API_KEY");
    return {
      status: "error",
      model,
      error: `No provider key in this container for ${model}. Set ${cfg.opencodeKeys.join(" or ") || "RULIO_AGENT_OPENCODE_KEYS"} with \`agentio set-provider-key ${provider}\` (no restart needed) or as a variable of the container, or choose Claude Code for this key in rulio.`,
    };
  }
  const root = mkdtempSync(join(tmpdir(), "rulio-agent-"));
  const home = join(root, "home");
  const work = join(root, "work");
  mkdirSync(home);
  mkdirSync(work);
  linkOpencodeDeps(home, cfg.opencodeDeps);
  // Keys of the file and of the container: neither may reach rulio or the log
  const secrets = [cfg.rulioToken, ...new Set(cfg.opencodeKeys.flatMap((name) => [env[name], process.env[name]]).filter((v): v is string => !!v))];
  const clean = (text: string | null): string | null => (text === null ? null : secrets.reduce((t, s) => t.split(s).join("***"), text));
  const reader = new StreamReader();
  const flat = cfg.flatRateProviders.includes(providerOf(model));
  try {
    return await new Promise<RunResult>((resolve) => {
      const child = spawnFn(cfg.opencodeBin, opencodeArgs(order.prompt), {
        cwd: work,
        env: opencodeEnv(cfg, order, home, env),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      let stderr = "";
      let stoppedFor: "steps" | "time" | null = null;
      let force: ReturnType<typeof setTimeout> | null = null;
      const stop = (why: "steps" | "time") => {
        if (stoppedFor) return;
        stoppedFor = why;
        killTree(child);
        force = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
      };
      const timer = setTimeout(() => stop("time"), order.maxMinutes * 60_000);
      child.stdout?.on("data", (c: Buffer) => {
        if (reader.push(c.toString()) >= order.maxTurns) stop("steps");
      });
      child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ status: "error", model, error: `OpenCode could not be started (${cfg.opencodeBin}): ${err.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (force) clearTimeout(force);
        const out = reader.result();
        const base = { model, summary: clean(out.summary), turns: out.turns, costUsd: flat ? null : out.cost };
        if (stoppedFor === "time") {
          resolve({ ...base, status: "timeout", summary: null, error: `Aborted after ${order.maxMinutes} minutes` });
          return;
        }
        if (stoppedFor === "steps") {
          resolve({ ...base, status: "error", error: `Aborted at the limit of ${order.maxTurns} steps` });
          return;
        }
        const failed = (code ?? 0) !== 0 || out.error !== null;
        resolve({ ...base, status: failed ? "error" : "ok", error: failed ? clean(out.error ?? (stderr.slice(0, 1000) || `Exit ${code}`)) : null });
      });
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
