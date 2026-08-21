import { strict as assert } from "node:assert";
import { test } from "node:test";

import { shouldStand, standCost } from "../src/system/dnd5e-prone";

test("standCost is half Speed, rounded down", () => {
  assert.equal(standCost(30), 15);
  assert.equal(standCost(25), 12);
  assert.equal(standCost(0), 0);
  assert.equal(standCost(NaN), 0);
});

const stay = {
  prone: true,
  speed: 30,
  keepDistance: true,
  meleeWithin5: false,
  travels: false,
  meleeAttack: false,
  flies: false,
};

test("melee within 5 feet stands — Advantage against you", () => {
  assert.equal(shouldStand({ ...stay, meleeWithin5: true }), true);
});

test("keepDistance stay-put against only ranged threats stays down", () => {
  assert.equal(shouldStand(stay), false);
});

test("without keepDistance, default is stand", () => {
  assert.equal(shouldStand({ ...stay, keepDistance: false }), true);
});

test("a flyer stands — crawl zeroes every mode except walk", () => {
  assert.equal(shouldStand({ ...stay, flies: true }), true);
});

test("a plan that travels stands", () => {
  assert.equal(shouldStand({ ...stay, travels: true }), true);
});

test("a melee attack from the ground stands — Disadvantage on the swing", () => {
  assert.equal(shouldStand({ ...stay, meleeAttack: true }), true);
});

test("Speed 0 cannot stand", () => {
  assert.equal(shouldStand({ ...stay, keepDistance: false, speed: 0 }), false);
});

test("not Prone never stands", () => {
  assert.equal(shouldStand({ ...stay, prone: false, keepDistance: false }), false);
});
