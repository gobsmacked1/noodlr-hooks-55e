import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  THROWN_STOCK,
  hasReturningProperty,
  hasThrownProperty,
  isReturningWeapon,
  pinSizePx,
  quantityAfterThrow,
  throwAskNeeded,
  thrownLootPayload,
  withinPickupReach,
} from "../src/system/dnd5e-thrown";

const DAGGER = {
  name: "Dagger",
  system: {
    quantity: 2,
    equipped: true,
    range: { value: 20, long: 60, reach: 5, units: "ft" },
    properties: ["fin", "lgt", "thr"],
  },
};

const RETURNING = {
  name: "Returning Dagger",
  system: { properties: ["thr", "ret"] },
};

const NAMED = {
  name: "Dagger of Returning",
  system: { properties: ["thr"] },
};

test("a dagger has the thrown property", () => {
  assert.equal(hasThrownProperty(DAGGER), true);
  assert.equal(hasThrownProperty({ system: { properties: ["fin"] } }), false);
});

test("Returning is the ret property or the word in the name", () => {
  assert.equal(isReturningWeapon(RETURNING), true);
  assert.equal(hasReturningProperty(RETURNING), true);
  assert.equal(isReturningWeapon(NAMED), true);
  assert.equal(hasReturningProperty(NAMED), false);
  assert.equal(isReturningWeapon(DAGGER), false);
});

test("inside melee reach is a stab, not a throw prompt", () => {
  assert.equal(throwAskNeeded(DAGGER, undefined, false, true), "melee");
});

test("35 ft with a dagger asks whether to throw", () => {
  assert.equal(throwAskNeeded(DAGGER, undefined, true, true), "ask");
});

test("beyond thrown long range is too far", () => {
  assert.equal(throwAskNeeded(DAGGER, undefined, true, false), "too-far");
});

test("an already-thrown mode does not ask again", () => {
  assert.equal(throwAskNeeded(DAGGER, "thrown", true, true), "already");
  assert.equal(throwAskNeeded(DAGGER, "thrown-offhand", true, true), "already");
});

test("a weapon without thr never asks", () => {
  assert.equal(throwAskNeeded({ system: { properties: [] } }, undefined, true, true), "none");
});

test("every stock thrown weapon uses the same ask as a dagger", () => {
  assert.deepEqual([...THROWN_STOCK], [
    "Dagger",
    "Handaxe",
    "Javelin",
    "Light Hammer",
    "Spear",
    "Trident",
    "Dart",
  ]);
  for (const name of THROWN_STOCK) {
    const item = { name, system: { properties: ["thr"], range: { value: 20, long: 60, reach: 5 } } };
    assert.equal(hasThrownProperty(item), true, name);
    assert.equal(throwAskNeeded(item, undefined, true, true), "ask", name);
  }
});

test("spend only if dnd5e did not already decrement", () => {
  assert.deepEqual(quantityAfterThrow(2, 2), { next: 1, alreadySpent: false });
  assert.deepEqual(quantityAfterThrow(2, 1), { next: 1, alreadySpent: true });
  assert.deepEqual(quantityAfterThrow(1, 1), { next: 0, alreadySpent: false });
  assert.deepEqual(quantityAfterThrow(1, 0), { next: 0, alreadySpent: true });
});

test("the pin is a fraction of a square, never a creature footprint", () => {
  assert.equal(pinSizePx(100), 35);
  assert.equal(pinSizePx(200), 64);
  assert.ok(pinSizePx(100) < 100);
});

test("pickup reach is adjacent including a diagonal", () => {
  const token = { x: 0, y: 0, width: 1, height: 1 };
  const beside = { x: 125, y: 25, width: 35, height: 35 };
  const far = { x: 400, y: 400, width: 35, height: 35 };
  assert.equal(withinPickupReach(token, beside, 100), true);
  assert.equal(withinPickupReach(token, far, 100), false);
});

test("loot payload is one unequipped copy with a fresh id", () => {
  const got = thrownLootPayload({
    ...DAGGER,
    _id: "abc",
    toObject() {
      return { _id: "abc", name: "Dagger", system: { ...DAGGER.system } };
    },
  });
  assert.ok(got);
  assert.equal(got._id, undefined);
  assert.equal((got.system as { quantity?: number }).quantity, 1);
  assert.equal((got.system as { equipped?: boolean }).equipped, false);
});
