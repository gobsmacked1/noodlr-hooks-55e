import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  horizontalSceneUnits,
  modeClearsWalls,
  pathClearsWalls,
  segmentsOf,
} from "../src/core/traverse";

const flyer = { hasFly: true, hasClimb: false, hasBurrow: false };
const climber = { hasFly: false, hasClimb: true, hasBurrow: false };
const burrower = { hasFly: false, hasClimb: false, hasBurrow: true };
const jumper = { hasFly: false, hasClimb: false, hasBurrow: false, jumpLong: 16 };

test("fly or climb at elevation above 0 clears a wall; walk at the same height does not", () => {
  assert.equal(modeClearsWalls({ action: "fly", fromElevation: 10, toElevation: 10, ...flyer, horizontal: 5 }), true);
  assert.equal(modeClearsWalls({ action: "climb", fromElevation: 0, toElevation: 10, ...climber, horizontal: 5 }), true);
  assert.equal(
    modeClearsWalls({
      action: "walk",
      fromElevation: 10,
      toElevation: 10,
      hasFly: true,
      hasClimb: true,
      hasBurrow: false,
      horizontal: 5,
    }),
    false,
  );
});

test("a flyer that never leaves the ground does not clear walls", () => {
  assert.equal(modeClearsWalls({ action: "fly", fromElevation: 0, toElevation: 0, ...flyer, horizontal: 30 }), false);
});

test("fly without a fly speed does not clear walls even when airborne", () => {
  assert.equal(
    modeClearsWalls({
      action: "fly",
      fromElevation: 10,
      toElevation: 10,
      hasFly: false,
      hasClimb: false,
      hasBurrow: false,
      horizontal: 5,
    }),
    false,
  );
});

test("burrow only clears walls below ground", () => {
  assert.equal(modeClearsWalls({ action: "burrow", fromElevation: 0, toElevation: -5, ...burrower, horizontal: 5 }), true);
  assert.equal(modeClearsWalls({ action: "burrow", fromElevation: 0, toElevation: 0, ...burrower, horizontal: 5 }), false);
  assert.equal(modeClearsWalls({ action: "burrow", fromElevation: 5, toElevation: 5, ...burrower, horizontal: 5 }), false);
});

test("swim never clears walls", () => {
  assert.equal(
    modeClearsWalls({
      action: "swim",
      fromElevation: -5,
      toElevation: -5,
      hasFly: false,
      hasClimb: false,
      hasBurrow: false,
      horizontal: 100,
    }),
    false,
  );
});

test("a long jump at ground level clears a thin obstacle it can reach", () => {
  assert.equal(
    modeClearsWalls({ action: "jump", fromElevation: 0, toElevation: 0, ...jumper, horizontal: 5 }),
    true,
  );
  assert.equal(
    modeClearsWalls({ action: "jump", fromElevation: 0, toElevation: 0, ...jumper, horizontal: 20 }),
    false,
  );
});

test("a jump that has already risen clears regardless of the long-jump number", () => {
  assert.equal(
    modeClearsWalls({ action: "jump", fromElevation: 10, toElevation: 10, jumpLong: 0, horizontal: 30, ...flyer }),
    true,
  );
});

test("the whole path is refused if any walking segment is still on the ground", () => {
  const facts = { hasFly: true, hasClimb: false, hasBurrow: false, jumpLong: null, defaultAction: "fly" };
  const measure = () => 5;
  const mixed = segmentsOf(
    [
      { x: 0, y: 0, elevation: 0, action: "fly" },
      { x: 100, y: 0, elevation: 0, action: "fly" },
      { x: 200, y: 0, elevation: 10, action: "fly" },
    ],
    facts,
    measure,
  );
  assert.equal(pathClearsWalls(mixed), false);

  const airborne = segmentsOf(
    [
      { x: 0, y: 0, elevation: 10, action: "fly" },
      { x: 100, y: 0, elevation: 10, action: "fly" },
    ],
    facts,
    measure,
  );
  assert.equal(pathClearsWalls(airborne), true);
});

test("a pure elevation change is not a wall-crossing", () => {
  assert.equal(pathClearsWalls([{ action: "fly", fromElevation: 0, toElevation: 10, ...flyer, horizontal: 0 }]), false);
});

test("horizontal scene units convert pixels through the grid", () => {
  assert.equal(horizontalSceneUnits({ x: 0, y: 0 }, { x: 100, y: 0 }, 100, 5), 5);
  assert.equal(horizontalSceneUnits({ x: 0, y: 0 }, { x: 100, y: 100 }, 100, 5), Math.hypot(5, 5));
});
