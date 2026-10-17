import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeArgs, mcpConfig, parseClaudeOutput } from "./claude.js";

const cfg = { rulioUrl: "https://api.rulio.net", rulioToken: "rulio_x", claudeBin: "claude", clientName: "t", useApiKey: false };

test("nur der rulio-Server, eingebaute Werkzeuge aus, nur rulio-Werkzeuge erlaubt", () => {
  const args = claudeArgs("/tmp/mcp.json", { maxTurns: 40 });
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__rulio__*");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(args[args.indexOf("--max-turns") + 1], "40");
});

test("Bericht-Lauf: nur das Unteragenten-Werkzeug dazu, sonst bleibt alles aus", () => {
  const args = claudeArgs("/tmp/mcp.json", { maxTurns: 200, allowSubagents: true });
  assert.equal(args[args.indexOf("--tools") + 1], "Agent");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__rulio__*,Agent");
  assert.equal(args[args.indexOf("--max-turns") + 1], "200");
  // Ohne die Angabe (ältere Server, normale Läufe): wie bisher
  const plain = claudeArgs("/tmp/mcp.json", { maxTurns: 40, allowSubagents: false });
  assert.equal(plain[plain.indexOf("--tools") + 1], "");
  assert.equal(plain[plain.indexOf("--allowedTools") + 1], "mcp__rulio__*");
});

test("MCP-Konfiguration zeigt auf /mcp mit dem Schlüssel", () => {
  const c = JSON.parse(mcpConfig(cfg));
  assert.equal(c.mcpServers.rulio.url, "https://api.rulio.net/mcp");
  assert.equal(c.mcpServers.rulio.headers.Authorization, "Bearer rulio_x");
});

test("Ausgabe lesen: Erfolg mit Kosten und Schritten", () => {
  const r = parseClaudeOutput(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Nichts getan.", num_turns: 7, total_cost_usd: 0.12 }), 0);
  assert.deepEqual(r, { status: "ok", summary: "Nichts getan.", turns: 7, costUsd: 0.12, model: null, error: null });
});

test("Ausgabe lesen: Hauptmodell = das mit den meisten Ausgabe-Tokens (rulio-tickets#91)", () => {
  const r = parseClaudeOutput(
    JSON.stringify({
      subtype: "success",
      result: "ok",
      modelUsage: {
        "claude-haiku-5-5": { inputTokens: 9000, outputTokens: 300 },
        "claude-opus-5-5": { inputTokens: 2000, outputTokens: 1800 },
      },
    }),
    0,
  );
  assert.equal(r.model, "claude-opus-5-5");
});

test("Ausgabe lesen: ohne modelUsage ist das Modell unbekannt", () => {
  assert.equal(parseClaudeOutput(JSON.stringify({ subtype: "success", result: "ok" }), 0).model, null);
});

test("Ausgabe lesen: Schrittdeckel erreicht ist ein Fehler", () => {
  const r = parseClaudeOutput(JSON.stringify({ subtype: "error_max_turns", is_error: true, num_turns: 40 }), 1);
  assert.equal(r.status, "error");
  assert.equal(r.error, "error_max_turns");
});

test("Ausgabe lesen: Unlesbares wird als Fehler gemeldet", () => {
  const r = parseClaudeOutput("kaputt", 2);
  assert.equal(r.status, "error");
  assert.match(r.error ?? "", /nicht lesbar/);
});

test("Ausgabe lesen: bei is_error steht der Grund im Ergebnistext", () => {
  const r = parseClaudeOutput(JSON.stringify({ subtype: "success", is_error: true, result: "Not logged in · Please run /login", num_turns: 1 }), 1);
  assert.equal(r.status, "error");
  assert.equal(r.error, "Not logged in · Please run /login");
});
