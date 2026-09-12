import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  dnd5eMajor,
  isFormModeTransform,
  movementSpeedKey,
  senseRangeOf,
  usesNestedMovementSpeeds,
} from "../src/system/dnd5e-schema";
import { sheetSenses } from "../src/system/dnd5e-concealment";

beforeEach(() => {
  (globalThis as any).game = { system: { id: "dnd5e", version: "6.0.1" } };
});

test("senseRangeOf reads a number or a {value}/{range} wrapper", () => {
  assert.equal(senseRangeOf(60), 60);
  assert.equal(senseRangeOf({ value: 60 }), 60);
  assert.equal(senseRangeOf({ range: 30 }), 30);
  assert.equal(senseRangeOf(null), null);
  assert.ok(Number.isNaN(Number({ value: 60 })));
});

test("movementSpeedKey always writes speeds.walk on the 6.0.1 floor", () => {
  (globalThis as any).game.system.version = undefined;
  assert.equal(dnd5eMajor(), 0);
  assert.equal(usesNestedMovementSpeeds(), true);
  assert.equal(movementSpeedKey("walk"), "system.attributes.movement.speeds.walk");

  (globalThis as any).game.system.version = "6.0.1";
  assert.equal(dnd5eMajor(), 6);
  assert.equal(movementSpeedKey("fly"), "system.attributes.movement.speeds.fly");
});

test("isFormModeTransform is the 6.0 AE Wild Shape, not an actor copy", () => {
  assert.equal(isFormModeTransform({ transform: { mode: "form" } }), true);
  assert.equal(isFormModeTransform(undefined, { mode: "form" }), true);
  assert.equal(isFormModeTransform(undefined, { transform: { mode: "form" } }), true);
  assert.equal(isFormModeTransform({ transform: { mode: "cr" } }), false);
  assert.equal(isFormModeTransform(), false);
});

test("sheetSenses reads an object-shaped range instead of Number({})", () => {
  const actor = {
    system: {
      attributes: {
        senses: {
          ranges: {
            blindsight: { value: 30 },
            tremorsense: { range: 10 },
            truesight: 60,
          },
        },
      },
    },
  };
  const senses = sheetSenses(actor);
  assert.equal(senses.blindsight, 30);
  assert.equal(senses.tremorsense, 10);
  assert.equal(senses.truesight, 60);
});
