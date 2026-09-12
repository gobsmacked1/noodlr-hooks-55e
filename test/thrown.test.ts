import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  hasReturningProperty,
  hasThrownProperty,
  isReturningWeapon,
  throwAskNeeded,
  lootActorType,
  thrownLootPayload,
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

test("stock dnd5e has no Actor type loot — drop as npc", () => {
  assert.equal(lootActorType(["character", "npc", "vehicle", "group"]), "npc");
  assert.equal(lootActorType(["base", "character", "npc"]), "npc");
});

test("loot is used only when a module actually registered that Actor type", () => {
  assert.equal(lootActorType(["npc", "loot"]), "loot");
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
