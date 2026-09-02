import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  OWED_SECONDS,
  OWED_SECONDS_MAX,
  OWED_SECONDS_MIN,
  OWED_TIMEOUT_CHOICE,
  OWED_TRANSPORT_MS,
  clampOwedSeconds,
  owedAdvanceBudgetMs,
  owedClockForUser,
  owedTransportMs,
  shouldBlockAdvance,
  shouldPromptOwed,
  type OwedLine,
} from "../src/rules/owed-roll";

// Two decisions that look "helpful" if inverted:
//
//   1. A timeout on a demanded save must ROLL, never skip. A reaction clock may spend a renewing
//      resource; a petrify save that times out into silence is a turn taken with no consequence.
//   2. The initiative gate is only turn/round. HP edits, combatant adds, and the owed flag write
//      itself must not freeze the tracker.

test("OWED_TIMEOUT_CHOICE is roll, never skip", () => {
  assert.equal(OWED_TIMEOUT_CHOICE, "roll");
  assert.notEqual(OWED_TIMEOUT_CHOICE, "skip");
});

const owed: OwedLine[] = [
  { tokenId: "t1", name: "Monk", kind: "save", ability: "dex", dc: 16, source: "Eye Ray" },
];

test("shouldBlockAdvance is true only on turn or round when someone still owes", () => {
  assert.equal(shouldBlockAdvance(owed, { turn: 2 }), true);
  assert.equal(shouldBlockAdvance(owed, { round: 2 }), true);
  assert.equal(shouldBlockAdvance(owed, { turn: 2, round: 2 }), true);
  assert.equal(shouldBlockAdvance(owed, { flags: { "noodlr-hooks-55e": { owed } } }), false);
  assert.equal(shouldBlockAdvance(owed, { combatants: [] }), false);
  assert.equal(shouldBlockAdvance([], { turn: 2 }), false);
  assert.equal(shouldBlockAdvance(owed, null), false);
  assert.equal(shouldBlockAdvance(owed, "turn"), false);
});

test("owed seconds clamp to 0–120 and 0 means no prompt", () => {
  assert.equal(clampOwedSeconds(-3), OWED_SECONDS_MIN);
  assert.equal(clampOwedSeconds(0), 0);
  assert.equal(clampOwedSeconds(6), 6);
  assert.equal(clampOwedSeconds(120), OWED_SECONDS_MAX);
  assert.equal(clampOwedSeconds(999), OWED_SECONDS_MAX);
  assert.equal(clampOwedSeconds("nope"), OWED_SECONDS);
  assert.equal(shouldPromptOwed(0), false);
  assert.equal(shouldPromptOwed(6), true);
  assert.equal(shouldPromptOwed(30), true);
});

test("owed clock follows who rolls, not sheet type: only a non-GM player gets the Player timer", () => {
  assert.equal(owedClockForUser(true), "gm");
  assert.equal(owedClockForUser(false), "players");
  assert.equal(owedClockForUser(null), "gm");
  assert.equal(owedClockForUser(undefined), "gm");
});

test("transport and initiative hold outlast the longer clock", () => {
  assert.equal(owedTransportMs(0), OWED_TRANSPORT_MS);
  assert.ok(owedTransportMs(30) > 30_000);
  assert.ok(owedTransportMs(120) >= 120_000);
  assert.ok(owedAdvanceBudgetMs(0, 30) >= 30_000);
  assert.ok(owedAdvanceBudgetMs(0, 120) >= 120_000);
  assert.ok(owedAdvanceBudgetMs(0, 0) >= 5_000);
});

test("Mass Suggestion on four targets holds until the last die exists", () => {
  const four: OwedLine[] = [
    { tokenId: "a", name: "A", kind: "save", ability: "wis", dc: 15, source: "Mass Suggestion" },
    { tokenId: "b", name: "B", kind: "save", ability: "wis", dc: 15, source: "Mass Suggestion" },
    { tokenId: "c", name: "C", kind: "save", ability: "wis", dc: 15, source: "Mass Suggestion" },
    { tokenId: "d", name: "D", kind: "save", ability: "wis", dc: 15, source: "Mass Suggestion" },
  ];
  assert.equal(shouldBlockAdvance(four, { turn: 3 }), true);
  assert.equal(shouldBlockAdvance(four.slice(0, 1), { turn: 3 }), true);
  assert.equal(shouldBlockAdvance([], { turn: 3 }), false);
});
