import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  centerFromTopLeft,
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
    { x: 5, y: 0 },
    { x: 15, y: 0 },
  ]);
});

test("a top-left TokenPosition is centred once, not twice", () => {
  const at = centerFromTopLeft({ x: 0, y: 0 }, { width: 1, height: 1 }, 100);
  assert.deepEqual(at, { x: 50, y: 50 });
});
