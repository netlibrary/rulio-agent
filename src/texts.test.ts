import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP, KEY_GONE, keyAdded, keyRemoved, NAME, NO_KEYS, startLine } from "./texts.js";

// The program is called Agentio; commands, image, folder and client id stay rulio-agent (rulio-tickets#844)
test("help starts with Agentio, the commands stay rulio-agent", () => {
  assert.equal(NAME, "Agentio");
  const lines = HELP.split("\n");
  assert.equal(lines[0], "Agentio – runs your own AI agent on a schedule with rulio");
  assert.ok(lines.includes("Usage: rulio-agent [command]"));
  assert.match(HELP, /a running Agentio picks it up within 30 s/);
  assert.match(HELP, /default rulio-agent@<host>/);
  assert.match(HELP, /https:\/\/github\.com\/netlibrary\/rulio-agent$/);
  assert.doesNotMatch(HELP, /running rulio-agent/);
});

test("start message names Agentio", () => {
  assert.equal(startLine("rulio-agent@vm", "https://api.rulio.net", 1), "Agentio running as rulio-agent@vm against https://api.rulio.net with 1 key");
  assert.equal(startLine("base", "http://localhost:4100", 2), "Agentio running as base against http://localhost:4100 with 2 keys");
});

test("messages about the running program name Agentio, commands stay rulio-agent", () => {
  assert.equal(keyAdded("abc123"), "Key abc123 added. A running Agentio picks it up within 30 s.");
  assert.equal(keyRemoved("abc123"), "Key abc123 removed. A running Agentio stops using it within 30 s.");
  assert.equal(KEY_GONE, "Not started: the key was removed from Agentio");
  assert.match(NO_KEYS, /`rulio-agent add-key rulio_…`/);
});
