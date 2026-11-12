import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP, KEY_GONE, keyAdded, keyRemoved, NAME, NO_KEYS, startLine } from "./texts.js";

// The program is called Agentio (rulio-tickets#844), the command agentio (#945, rulio-agent works the same);
// image, folder and client id stay rulio-agent
test("help starts with Agentio and names the command agentio", () => {
  assert.equal(NAME, "Agentio");
  const lines = HELP.split("\n");
  assert.equal(lines[0], "Agentio – runs your own AI agent on a schedule with rulio");
  assert.ok(lines.includes("Usage: agentio [command]   (rulio-agent works the same)"));
  assert.match(HELP, /set-provider-key <provider>/);
  assert.match(HELP, /remove-provider-key <provider>/);
  assert.match(HELP, /^ {2}status {14}/m);
  assert.match(HELP, /a running Agentio picks it up within 30 s/);
  assert.match(HELP, /default rulio-agent@<host>/);
  assert.match(HELP, /https:\/\/github\.com\/netlibrary\/rulio-agent$/);
  assert.doesNotMatch(HELP, /running rulio-agent/);
});

test("start message names Agentio", () => {
  assert.equal(startLine("rulio-agent@vm", "https://api.rulio.net", 1), "Agentio running as rulio-agent@vm against https://api.rulio.net with 1 key");
  assert.equal(startLine("base", "http://localhost:4100", 2), "Agentio running as base against http://localhost:4100 with 2 keys");
});

test("messages about the running program name Agentio, commands are agentio", () => {
  assert.equal(keyAdded("abc123"), "Key abc123 added. A running Agentio picks it up within 30 s.");
  assert.equal(keyRemoved("abc123"), "Key abc123 removed. A running Agentio stops using it within 30 s.");
  assert.equal(KEY_GONE, "Not started: the key was removed from Agentio");
  assert.match(NO_KEYS, /`agentio add-key rulio_…`/);
});
