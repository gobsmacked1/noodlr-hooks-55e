import { strict as assert } from "node:assert";
import { test } from "node:test";

import { leftoverPastZero } from "../src/system/dnd5e-dying";
import {
  isBludgeoningOnly,
  knockoutQualifies,
  meleeFromParts,
} from "../src/system/dnd5e-knockout";

test("only Bludgeoning qualifies; empty and mixed types do not", () => {
  assert.equal(isBludgeoningOnly(["bludgeoning"]), true);
  assert.equal(isBludgeoningOnly(["Bludgeoning", "bludgeoning"]), true);
  assert.equal(isBludgeoningOnly([]), false);
  assert.equal(isBludgeoningOnly([""]), false);
  assert.equal(isBludgeoningOnly(["bludgeoning", "piercing"]), false);
  assert.equal(isBludgeoningOnly(["piercing"]), false);
  assert.equal(isBludgeoningOnly(["fire"]), false);
});

test("meleeFromParts: thrown and ranged fail; empty Attack type is melee", () => {
  assert.equal(meleeFromParts({ attackType: "melee" }), true);
  assert.equal(meleeFromParts({ activityType: "attack" }), true);
  assert.equal(meleeFromParts({ actionType: "mwak" }), true);
  assert.equal(meleeFromParts({ attackMode: "thrown", attackType: "melee" }), false);
  assert.equal(meleeFromParts({ attackMode: "ranged" }), false);
  assert.equal(meleeFromParts({ attackType: "ranged" }), false);
  assert.equal(meleeFromParts({ actionType: "rwak" }), false);
  assert.equal(meleeFromParts({ rollType: "save", activityType: "attack" }), false);
  assert.equal(meleeFromParts({}), null);
});

test("knockoutQualifies: leftover below max, melee bludgeoning, no death saves", () => {
  const base = {
    types: ["bludgeoning"],
    melee: true as boolean | null,
    leftover: 4,
    maxHp: 19,
    usesDeathSaves: false,
  };
  assert.deepEqual(knockoutQualifies(base), { ok: true, reason: "" });
  assert.equal(knockoutQualifies({ ...base, leftover: 0 }).ok, true);
  assert.deepEqual(knockoutQualifies({ ...base, leftover: 19 }), {
    ok: false,
    reason: "massive",
  });
  assert.deepEqual(knockoutQualifies({ ...base, leftover: 20 }), {
    ok: false,
    reason: "massive",
  });
  assert.deepEqual(knockoutQualifies({ ...base, usesDeathSaves: true }), {
    ok: false,
    reason: "death-saves",
  });
  assert.deepEqual(knockoutQualifies({ ...base, melee: false }), {
    ok: false,
    reason: "not-melee",
  });
  assert.deepEqual(knockoutQualifies({ ...base, melee: null }), {
    ok: false,
    reason: "unknown-melee",
  });
  assert.deepEqual(knockoutQualifies({ ...base, types: ["bludgeoning", "piercing"] }), {
    ok: false,
    reason: "not-bludgeoning-only",
  });
  assert.deepEqual(knockoutQualifies({ ...base, maxHp: 0 }), { ok: false, reason: "no-max" });
});

test("leftoverPastZero: exactly 0 HP still has leftover 0; massive is leftover >= max", () => {
  // 10 HP, 0 temp, 10 damage → exactly 0, leftover 0.
  assert.equal(leftoverPastZero(10, 0, 10), 0);
  // 10 HP, 4 damage past 0.
  assert.equal(leftoverPastZero(10, 0, 14), 4);
  // Temp absorbs first.
  assert.equal(leftoverPastZero(10, 5, 14), 0);
  assert.equal(leftoverPastZero(10, 5, 20), 5);
});
