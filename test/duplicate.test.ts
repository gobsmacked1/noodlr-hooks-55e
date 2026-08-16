import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  activityDamage,
  canonicalFormula,
  duplicatesActivityDamage,
} from "../src/capability/duplicate";
import type { CapabilityRule } from "../src/integration/capability";

// The whole point of this guard is that its two failure directions are wildly asymmetric: refusing a
// real rider silently deletes damage a player is owed, while letting a restatement through doubles a
// cantrip. So every test below is about the boundary rather than the happy path.

function onHitDamage(dice: string, damageType?: string): CapabilityRule {
  return {
    trigger: { event: "on_hit" },
    condition: [],
    effect: { kind: "damage", amount: { dice }, ...(damageType ? { damageType } : {}) },
    adjudication: "engine",
  } as CapabilityRule;
}

/** Fire Bolt as dnd5e stores it: an attack activity whose one damage part is the printed 1d10. */
const FIRE_BOLT = {
  name: "Fire Bolt",
  damage: {
    parts: [{ number: 1, denomination: 10, types: new Set(["fire"]), formula: "1d10" }],
  },
};

/** A longsword's base damage, which `prepareFinalData` has already unshifted into `parts`. */
const LONGSWORD = {
  name: "Longsword",
  damage: {
    parts: [{ number: 1, denomination: 8, types: new Set(["slashing"]), formula: "1d8" }],
  },
};

test("a rule restating the ability's own printed damage is refused, by name and by dice", () => {
  const reason = duplicatesActivityDamage(onHitDamage("1d10", "fire"), FIRE_BOLT);
  assert.ok(reason, "the 45-of-71 case in the live cache");
  assert.match(String(reason), /Fire Bolt/);
  assert.match(String(reason), /1d10/);
});

test("a genuine rider of different dice runs, which is the direction that must not break", () => {
  // Flame Tongue beside a longsword. Refusing this would delete damage the player is owed, and the
  // player has no way to tell that a rule was declined.
  assert.equal(duplicatesActivityDamage(onHitDamage("2d6", "fire"), LONGSWORD), null);
});

test("same dice, different type is a rider rather than a restatement", () => {
  assert.equal(duplicatesActivityDamage(onHitDamage("1d8", "piercing"), LONGSWORD), null);
});

test("an activity whose damage cannot be read is permission, not suspicion", () => {
  for (const activity of [undefined, null, {}, { damage: {} }, { damage: { parts: "nope" } }]) {
    assert.equal(
      duplicatesActivityDamage(onHitDamage("1d10", "fire"), activity),
      null,
      JSON.stringify(activity),
    );
  }
});

test("only a damage effect is ever compared; nothing else can double", () => {
  const heal = {
    trigger: { event: "on_hit" },
    condition: [],
    effect: { kind: "heal", amount: { dice: "1d10" } },
    adjudication: "engine",
  } as unknown as CapabilityRule;
  assert.equal(duplicatesActivityDamage(heal, FIRE_BOLT), null);
});

test("a formula is compared by what it rolls, not by how it was typed", () => {
  assert.equal(canonicalFormula("1 D 10"), "1d10");
  assert.equal(canonicalFormula("2 + 1d6"), canonicalFormula("1d6 + 2"));
  assert.equal(canonicalFormula(""), "");
  assert.equal(canonicalFormula(undefined), "");
  // A flat amount is a formula too — a part carrying only a bonus is a real shape.
  assert.equal(canonicalFormula(7), "7");
});

test("a plain-data part is read as the model's own getter would read it", () => {
  // A descriptor may be compared against source data rather than a prepared activity, where the
  // `formula` getter does not exist. Both paths have to reach the same string or the guard is a
  // coin flip depending on where the activity came from.
  assert.deepEqual(activityDamage({ damage: { parts: [{ number: 2, denomination: 6 }] } }), [
    { formula: "2d6", types: [] },
  ]);
  assert.deepEqual(
    activityDamage({ damage: { parts: [{ number: 1, denomination: 4, bonus: "2" }] } }),
    [{ formula: "1d4+2", types: [] }],
  );
  assert.deepEqual(
    activityDamage({
      damage: { parts: [{ custom: { enabled: true, formula: "3d6" }, number: 1, denomination: 8 }] },
    }),
    [{ formula: "3d6", types: [] }],
    "custom wins over the automatic formula, as it does in the model",
  );
  assert.deepEqual(activityDamage({ damage: { parts: [{ types: ["fire"] }] } }), []);
});

test("types arrive as a Set from a prepared activity and an Array from source", () => {
  assert.deepEqual(activityDamage({ damage: { parts: [{ formula: "1d6", types: ["Cold"] }] } }), [
    { formula: "1d6", types: ["cold"] },
  ]);
  assert.deepEqual(
    activityDamage({ damage: { parts: [{ formula: "1d6", types: new Set(["Cold"]) }] } }),
    [{ formula: "1d6", types: ["cold"] }],
  );
});

test("an untyped part still catches a restatement, because the dice already matched", () => {
  const untyped = { name: "Slam", damage: { parts: [{ formula: "2d8" }] } };
  assert.ok(duplicatesActivityDamage(onHitDamage("2d8", "bludgeoning"), untyped));
  assert.ok(duplicatesActivityDamage(onHitDamage("2d8"), untyped));
});
