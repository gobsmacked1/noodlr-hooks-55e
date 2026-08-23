import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  centerFromTopLeft,
  inMeleeReach,
  leftReachAlong,
  movementRoute,
} from "../src/rules/reactions";
import type { Point } from "../src/core/positioning";

const hypot = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

test("leaving a 10 ft reach from 5 ft to 15 ft provokes", () => {
  const watcher: Point = { x: 0, y: 0 };
  const left = leftReachAlong(
    watcher,
    [
      { x: 5, y: 0 },
      { x: 15, y: 0 },
    ],
    { width: 0, height: 0 },
    10,
    0,
    hypot,
  );
  assert.equal(left, true);
});

test("a move that never entered reach does not provoke", () => {
  const watcher: Point = { x: 0, y: 0 };
  const left = leftReachAlong(
    watcher,
    [
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ],
    { width: 0, height: 0 },
    10,
    0,
    hypot,
  );
  assert.equal(left, false);
});

test("the destination on the movement is the end of the route, not _source", () => {
  const route = movementRoute(
    { origin: { x: 5, y: 0 }, destination: { x: 15, y: 0 } },
    { x: 5, y: 0 },
  );
  assert.deepEqual(route, [
    { x: 5, y: 0, elevation: 0 },
    { x: 15, y: 0, elevation: 0 },
  ]);
});

test("an omitted origin elevation is not a takeoff from the floor", () => {
  const route = movementRoute(
    { origin: { x: 5, y: 0 }, destination: { x: 15, y: 0, elevation: 10 } },
    { x: 15, y: 0, elevation: 10 },
  );
  assert.deepEqual(route, [
    { x: 5, y: 0, elevation: 10 },
    { x: 15, y: 0, elevation: 10 },
  ]);
});

test("a stated takeoff is kept even when x and y do not change", () => {
  const route = movementRoute({
    origin: { x: 5, y: 0, elevation: 0 },
    destination: { x: 5, y: 0, elevation: 10 },
  });
  assert.deepEqual(route, [
    { x: 5, y: 0, elevation: 0 },
    { x: 5, y: 0, elevation: 10 },
  ]);
});

test("vertical reach is the same number as horizontal reach", () => {
  assert.equal(inMeleeReach(5, 5, 0, 0), true);
  assert.equal(inMeleeReach(5, 5, 10, 0), false);
  assert.equal(inMeleeReach(5, 5, -10, 0), false);
  assert.equal(inMeleeReach(5, 5, 5, 0), true);
});

test("taking off from adjacent still leaves reach and provokes", () => {
  const left = leftReachAlong(
    { x: 0, y: 0 },
    [
      { x: 5, y: 0, elevation: 0 },
      { x: 5, y: 0, elevation: 10 },
    ],
    { width: 0, height: 0 },
    5,
    0,
    hypot,
    0,
  );
  assert.equal(left, true);
});

test("a flyer already above reach does not provoke by walking away", () => {
  const left = leftReachAlong(
    { x: 0, y: 0 },
    [
      { x: 5, y: 0, elevation: 10 },
      { x: 15, y: 0, elevation: 10 },
    ],
    { width: 0, height: 0 },
    5,
    0,
    hypot,
    0,
  );
  assert.equal(left, false);
});

test("a burrower below reach does not provoke by walking away", () => {
  const left = leftReachAlong(
    { x: 0, y: 0 },
    [
      { x: 5, y: 0, elevation: -10 },
      { x: 15, y: 0, elevation: -10 },
    ],
    { width: 0, height: 0 },
    5,
    0,
    hypot,
    0,
  );
  assert.equal(left, false);
});

test("a top-left TokenPosition is centred once, not twice", () => {
  const at = centerFromTopLeft({ x: 0, y: 0 }, { width: 1, height: 1 }, 100);
  assert.deepEqual(at, { x: 50, y: 50 });
});
