import { strict as assert } from "node:assert";
import { test } from "node:test";

import { doorCenter, mayReachDoor, withinInteractReach } from "../src/rules/interact";
import type { Point } from "../src/core/positioning";

const hypot = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

test("a door's centre is the midpoint of wall.c", () => {
  assert.deepEqual(doorCenter({ c: [0, 0, 100, 0] }), { x: 50, y: 0 });
  assert.equal(doorCenter({ c: [0, 0] }), null);
});

test("one square away is in reach; across the room is not", () => {
  // 1×1 token whose centre is the origin (grid defaults to 100 px when canvas is absent).
  const token = { x: -50, y: -50, width: 1, height: 1 };
  assert.equal(withinInteractReach(token, { x: 5, y: 0 }, 5, hypot), true);
  assert.equal(withinInteractReach(token, { x: 50, y: 0 }, 5, hypot), false);
});

test("a GM with no token may stage a door; a player may not", () => {
  const door = { x: 0, y: 0 };
  assert.equal(mayReachDoor({ isGM: true, tokens: [], door, reach: 5, measure: hypot }).ok, true);
  assert.deepEqual(mayReachDoor({ isGM: false, tokens: [], door, reach: 5, measure: hypot }), {
    ok: false,
    reason: "no-token",
  });
});

test("a GM who has a token is held to the same reach as a player", () => {
  const far = { x: -50, y: -50, width: 1, height: 1 };
  const door = { x: 80, y: 0 };
  const gm = mayReachDoor({ isGM: true, tokens: [far], door, reach: 5, measure: hypot });
  const player = mayReachDoor({ isGM: false, tokens: [far], door, reach: 5, measure: hypot });
  assert.deepEqual(gm, { ok: false, reason: "too-far" });
  assert.deepEqual(player, { ok: false, reason: "too-far" });
});
