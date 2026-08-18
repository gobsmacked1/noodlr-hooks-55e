import { strict as assert } from "node:assert";
import { test } from "node:test";

import { autoRollsWhen } from "../src/util/gm";

// The save-automation gate. `rollerForActor` always names someone when a GM is online,
// so a truthy roller is not "leave the button" — that reading left every NPC save
// unpressed (Hold Person vs Assassin, 2026-08-18).

test("the GM auto-rolls an NPC whose designated roller is the GM", () => {
  assert.equal(autoRollsWhen("gm-id", "gm-id"), true);
});

test("the GM leaves a player character's save for that player", () => {
  assert.equal(autoRollsWhen("player-id", "gm-id"), false);
});

test("a missing election does not roll — a button is better than a guess", () => {
  assert.equal(autoRollsWhen(null, "gm-id"), false);
});

test("the inverted reading (truthy roller means skip) would refuse every NPC save", () => {
  const roller = "gm-id";
  // What the bug did: `if (rollerForActor(actor)) continue`.
  assert.equal(Boolean(roller), true);
  // What it must do: roll when we ARE that roller.
  assert.equal(autoRollsWhen(roller, "gm-id"), true);
});
