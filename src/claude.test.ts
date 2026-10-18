import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeArgs, mcpConfig, parseClaudeOutput } from "./claude.js";

const cfg = { rulioUrl: "https://api.rulio.net", rulioToken: "rulio_x", claudeBin: "claude", clientName: "t", useApiKey: false };

test("only the rulio server, built-in tools off, only rulio tools allowed", () => {
  const args = claudeArgs("/tmp/mcp.json", { maxTurns: 40 });
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__rulio__*");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(args[args.indexOf("--max-turns") + 1], "40");
});

test("report run: only the subagent tool added, everything else stays off", () => {
  const args = claudeArgs("/tmp/mcp.json", { maxTurns: 200, allowSubagents: true });
  assert.equal(args[args.indexOf("--tools") + 1], "Agent");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__rulio__*,Agent");
  assert.equal(args[args.indexOf("--max-turns") + 1], "200");
  // Without the flag (older servers, normal runs): unchanged
  const plain = claudeArgs("/tmp/mcp.json", { maxTurns: 40, allowSubagents: false });
  assert.equal(plain[plain.indexOf("--tools") + 1], "");
  assert.equal(plain[plain.indexOf("--allowedTools") + 1], "mcp__rulio__*");
});

test("MCP configuration points to /mcp with the key", () => {
  const c = JSON.parse(mcpConfig(cfg));
  assert.equal(c.mcpServers.rulio.url, "https://api.rulio.net/mcp");
  assert.equal(c.mcpServers.rulio.headers.Authorization, "Bearer rulio_x");
});

test("read output: success with cost and turns", () => {
  const r = parseClaudeOutput(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Nothing done.", num_turns: 7, total_cost_usd: 0.12 }), 0);
  assert.deepEqual(r, { status: "ok", summary: "Nothing done.", turns: 7, costUsd: 0.12, model: null, error: null });
});

test("read output: main model = the one with the most output tokens", () => {
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

test("read output: without modelUsage the model is unknown", () => {
  assert.equal(parseClaudeOutput(JSON.stringify({ subtype: "success", result: "ok" }), 0).model, null);
});

test("read output: hitting the turn limit is an error", () => {
  const r = parseClaudeOutput(JSON.stringify({ subtype: "error_max_turns", is_error: true, num_turns: 40 }), 1);
  assert.equal(r.status, "error");
  assert.equal(r.error, "error_max_turns");
});

test("read output: unreadable output is reported as an error", () => {
  const r = parseClaudeOutput("garbage", 2);
  assert.equal(r.status, "error");
  assert.match(r.error ?? "", /not readable/);
});

test("read output: with is_error the reason is in the result text", () => {
  const r = parseClaudeOutput(JSON.stringify({ subtype: "success", is_error: true, result: "Not logged in · Please run /login", num_turns: 1 }), 1);
  assert.equal(r.status, "error");
  assert.equal(r.error, "Not logged in · Please run /login");
});
