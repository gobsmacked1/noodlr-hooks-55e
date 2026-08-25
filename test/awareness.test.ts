import test from "node:test";
import assert from "node:assert/strict";

import { applyAwareness, forgetSightings } from "../src/tactics/awareness.js";
import { hasLineOfSight } from "../src/rules/sight.js";

// Walls are not stealth. A monk who never hid, then shut two doors, used to stay on
// `board.enemies` so the Beholder rayed him and hid from someone who already could not
// see it. These fakes only need `checkCollision` and a document the remember-spot can
// centre.

function token(id: string, wall: boolean) {
  return {
    id,
    name: id,
    center: { x: 50, y: 50 },
    checkCollision: () => wall,
    document: { id, x: 0, y: 0, width: 1, height: 1, elevation: 0 },
  };
}

function board(wall: boolean): any {
  const self = token("beholder", wall);
  const enemy = token("monk", false);
  return {
    self: { token: self, tokenId: "beholder", name: "Beholder", elevation: 0 },
    enemies: [
      {
        token: enemy,
        tokenId: "monk",
        name: "Monkey McMonkface",
        elevation: 0,
        distance: 50,
      },
    ],
    allies: [],
    unseen: [],
    units: "ft",
    speed: 20,
  };
}

test("hasLineOfSight is the wall ray: collision means no view", () => {
  const clear = token("a", false);
  const blocked = token("b", true);
  const target = token("c", false);
  assert.equal(hasLineOfSight(clear, target), true);
  assert.equal(hasLineOfSight(blocked, target), false);
});

test("a wall drops the enemy even when they never hid", () => {
  forgetSightings();
  const aware = applyAwareness(board(true));
  assert.equal(aware.enemies.length, 0, "two closed doors is not line of sight");
  assert.equal(aware.unseen.length, 0, "never seen from here — no search, no ambush leak");
});

test("clear line of sight keeps them on the board", () => {
  forgetSightings();
  const aware = applyAwareness(board(false));
  assert.equal(aware.enemies.length, 1);
  assert.equal(aware.enemies[0]?.name, "Monkey McMonkface");
});

test("once seen, a wall turns them into a search, not a ray target", () => {
  forgetSightings();
  applyAwareness(board(false));
  const lost = applyAwareness(board(true));
  assert.equal(lost.enemies.length, 0, "Eye Rays have nobody they can see");
  assert.equal(lost.unseen.length, 1);
  assert.equal(lost.unseen[0]?.name, "Monkey McMonkface");
});
