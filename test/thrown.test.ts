import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  THROWN_STOCK,
  hasReturningProperty,
  hasThrownProperty,
  inHandQuantity,
  isReturningWeapon,
  pinSizePx,
  quantityAfterThrow,
  throwAskNeeded,
  isPlayerThrower,
  pinIsPlayerOwned,
  thrownLootPayload,
  thrownStacksMatch,
  vacuumItemsLabel,
  withinPickupReach,
  withinVacuumReach,
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

test("an imported quantity of 0 is one in hand until that copy is emptied", () => {
  assert.equal(inHandQuantity(0, false), 1);
  assert.equal(inHandQuantity(0, true), 0);
  assert.equal(inHandQuantity(3, false), 3);
  assert.equal(inHandQuantity(2, true), 2);
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

test("vacuum reach is 5 ft — a diagonal throw is not back in the thrower's hand", () => {
  const token = { x: 0, y: 0, width: 1, height: 1 };
  const beside = { x: 125, y: 25, width: 35, height: 35 };
  const diagonalThrow = { x: 125, y: 125, width: 35, height: 35 };
  const twoAway = { x: 225, y: 25, width: 35, height: 35 };
  assert.equal(withinVacuumReach(token, beside, 100, 5), true);
  assert.equal(withinVacuumReach(token, diagonalThrow, 100, 5), false);
  assert.equal(withinVacuumReach(token, twoAway, 100, 5), false);
  assert.equal(withinPickupReach(token, beside, 100, 5), true);
  assert.equal(withinPickupReach(token, diagonalThrow, 100, 5), false);
});

test("player-owned is the sheet type, never hasPlayerOwner", () => {
  assert.equal(isPlayerThrower({ type: "character" }), true);
  assert.equal(isPlayerThrower({ type: "npc" }), false);
  assert.equal(pinIsPlayerOwned({ playerOwned: true }), true);
  assert.equal(pinIsPlayerOwned({ ownerType: "character" }), true);
  assert.equal(pinIsPlayerOwned({}), false);
  assert.equal(pinIsPlayerOwned({ ownerType: "npc" }), false);
});

test("a returned throw stacks on the remaining copies", () => {
  assert.equal(
    thrownStacksMatch({ name: "Dagger", system: { identifier: "dagger" } }, { name: "Dagger", system: { identifier: "dagger" } }),
    true,
  );
  assert.equal(
    thrownStacksMatch({ name: "Dagger", type: "weapon" }, { name: "Dagger", type: "weapon" }),
    true,
  );
  assert.equal(
    thrownStacksMatch({ name: "Dagger", system: { identifier: "dagger" } }, { name: "Handaxe", system: { identifier: "handaxe" } }),
    false,
  );
});

test("one vacuum card lists counts without inventing plurals", () => {
  assert.equal(vacuumItemsLabel([{ name: "Dagger", count: 2 }, { name: "Handaxe", count: 1 }]), "2 × Dagger, 1 × Handaxe");
  assert.equal(vacuumItemsLabel([{ name: "Dagger", count: 1 }]), "1 × Dagger");
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
