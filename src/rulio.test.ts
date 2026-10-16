import { test } from "node:test";
import assert from "node:assert/strict";
import { nextPollDelay, type PollReply } from "./rulio.js";

const reply = (r: Partial<PollReply>): PollReply => ({ run: null, pollSeconds: 60, enabled: true, ...r });
const order = { id: "r1", trigger: "chat", prompt: "", maxMinutes: 10, maxTurns: 40 };

test("Long-Poll: nach Ablauf ohne Lauf sofort wieder fragen", () => {
  assert.equal(nextPollDelay(reply({ longPoll: true }), 25_000), 0);
});

test("Long-Poll: nach einem Lauf sofort wieder fragen", () => {
  assert.equal(nextPollDelay(reply({ longPoll: true, run: order }), 300), 0);
});

test("Long-Poll kam ohne Lauf viel zu früh zurück (Notaus, Redis weg): Takt des Servers", () => {
  assert.equal(nextPollDelay(reply({ longPoll: true, pollSeconds: 60 }), 200), 60);
  assert.equal(nextPollDelay(reply({ longPoll: true, pollSeconds: 1 }), 200), 5);
});

test("Älterer Server ohne Long-Poll: sein Takt, mindestens 5 s", () => {
  assert.equal(nextPollDelay(reply({ pollSeconds: 60 }), 100), 60);
  assert.equal(nextPollDelay(reply({ pollSeconds: 10, run: order }), 100), 10);
  assert.equal(nextPollDelay(reply({ pollSeconds: 2 }), 100), 5);
});
