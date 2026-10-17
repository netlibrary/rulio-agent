#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadConfig, type Config } from "./config.js";
import { finish, nextPollDelay, poll } from "./rulio.js";
import { runClaude } from "./claude.js";

/**
 * rulio-agent — fragt rulio regelmäßig, ob ein Lauf fällig ist, und lässt ihn
 * von Claude Code abarbeiten. WANN ein Lauf fällig ist, entscheidet rulio
 * (Zeitplan in der App); dieses Programm führt nur aus.
 *
 *   rulio-agent run     dauerhaft laufen (Standard)
 *   rulio-agent once    einmal abfragen und ggf. einen Lauf ausführen
 *   rulio-agent check   Einrichtung prüfen (rulio-Schlüssel, Claude Code)
 */
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

/** Ein Abruf, ggf. ein Lauf; zurück: Sekunden bis zum nächsten Abruf */
async function cycle(cfg: Config): Promise<number> {
  const asked = Date.now();
  const reply = await poll(cfg);
  if (!reply.enabled) log("Notaus aktiv — kein Lauf");
  const delay = nextPollDelay(reply, Date.now() - asked);
  if (!reply.run) return delay;
  const order = reply.run;
  log(`Lauf ${order.id} (${order.trigger}${order.kind === "report" ? ", Bericht" : ""}) — höchstens ${order.maxMinutes} min${order.allowSubagents ? ", mit Unteragenten" : ""}`);
  const started = Date.now();
  const result = await runClaude(cfg, order);
  log(`Lauf ${order.id}: ${result.status} nach ${Math.round((Date.now() - started) / 1000)} s${result.error ? ` — ${result.error}` : ""}`);
  await finish(cfg, order.id, result).catch((err: Error) => log(`Ergebnis nicht gemeldet: ${err.message}`));
  return delay;
}

function check(cfg: Config): Promise<void> {
  const v = spawnSync(cfg.claudeBin, ["--version"], { encoding: "utf8" });
  if (v.error || v.status !== 0) {
    throw new Error(`Claude Code nicht gefunden (${cfg.claudeBin}). Installieren und anmelden: https://code.claude.com — oder CLAUDE_BIN setzen.`);
  }
  log(`Claude Code: ${v.stdout.trim()}`);
  // Läufe brauchen einen angemeldeten Claude Code (claude auth login bzw. CLAUDE_CODE_OAUTH_TOKEN)
  const auth = spawnSync(cfg.claudeBin, ["auth", "status", "--text"], { encoding: "utf8" });
  const authText = `${auth.stdout ?? ""}${auth.stderr ?? ""}`;
  if (/not logged in/i.test(authText) && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error("Claude Code ist nicht angemeldet. Einmal `claude auth login` ausführen (PC) bzw. `claude setup-token` und CLAUDE_CODE_OAUTH_TOKEN setzen (VM/Docker).");
  }
  log("Claude Code: angemeldet");
  if (process.env.ANTHROPIC_API_KEY && !cfg.useApiKey) {
    log("Hinweis: ANTHROPIC_API_KEY ist gesetzt, wird für Läufe aber entfernt (Abo statt API). RULIO_AGENT_USE_API_KEY=1 nutzt ihn.");
  }
  return fetch(`${cfg.rulioUrl}/api/agent/state`, { headers: { Authorization: `Bearer ${cfg.rulioToken}` } }).then(async (r) => {
    if (!r.ok) throw new Error(`rulio-Schlüssel abgelehnt (${r.status}) — in rulio neu erzeugen.`);
    const s = (await r.json()) as { settings: { enabled: boolean; broker: string } };
    log(`rulio: verbunden (${cfg.rulioUrl}) — Agent ${s.settings.enabled ? "aktiv" : "angehalten"}, Paper-Konto ${s.settings.broker}`);
  });
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "run";
  const cfg = loadConfig();
  if (cmd === "check") return check(cfg);
  // Vor dem ersten Lauf: fehlt der Claude-Login oder passt der Schlüssel nicht, gleich sagen
  await check(cfg);
  if (cmd === "once") {
    await cycle(cfg);
    return;
  }
  if (cmd !== "run") throw new Error(`Unbekannter Befehl „${cmd}" (run, once, check)`);
  log(`rulio-agent läuft als ${cfg.clientName} gegen ${cfg.rulioUrl}`);
  for (;;) {
    let wait = 60;
    try {
      wait = await cycle(cfg);
    } catch (err) {
      log(`Fehler: ${(err as Error).message} — neuer Versuch gleich`);
    }
    if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
