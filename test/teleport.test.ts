import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  isSelfTeleport,
  isTeleportActivity,
  originMoved,
  shouldReplaceTeleportTokens,
  teleportActivationType,
  teleportLanded,
  tokenOrigin,
} from "../src/system/dnd5e-teleport";

const misty = {
  type: "teleport",
  range: { units: "self", override: false },
  activation: { type: "action", override: false },
  item: {
    name: "Misty Step",
    system: { range: { units: "self" }, activation: { type: "bonus" } },
  },
};

const door = {
  type: "teleport",
  range: { units: "ft", value: 500, override: false },
  item: { system: { range: { units: "ft", value: 500 } } },
};

test("Misty Step is a self teleport; Dimension Door is not", () => {
  assert.equal(isTeleportActivity(misty), true);
  assert.equal(isSelfTeleport(misty), true);
  assert.equal(isSelfTeleport(door), false);
});

test("Misty Step's slot is the item's bonus, not the activity's action", () => {
  assert.equal(teleportActivationType(misty), "bonus");
});

test("a blink that constrained back to the origin did not land", () => {
  const token = { id: "t1", document: { id: "t1", _source: { x: 100, y: 200 } } };
  const before = new Map([["t1", { x: 100, y: 200 }]]);
  assert.equal(tokenOrigin(token)?.x, 100);
  assert.equal(originMoved({ x: 100, y: 200 }, { x: 100, y: 200 }), false);
  assert.equal(teleportLanded(before, [{ token }]), false);
});

test("a blink that changed _source landed", () => {
  const token = { id: "t1", document: { id: "t1", _source: { x: 300, y: 200 } } };
  const before = new Map([["t1", { x: 100, y: 200 }]]);
  assert.equal(teleportLanded(before, [{ token }]), true);
});

test("a leftover multi-select is replaced; the caster alone is not", () => {
  assert.equal(shouldReplaceTeleportTokens([], "sorc"), true);
  assert.equal(shouldReplaceTeleportTokens(["wolf"], "sorc"), true);
  assert.equal(shouldReplaceTeleportTokens(["sorc", "wolf"], "sorc"), true);
  assert.equal(shouldReplaceTeleportTokens(["sorc"], "sorc"), false);
});

test("an empty or unreadable plan is not a landing", () => {
  assert.equal(teleportLanded(new Map(), []), false);
  assert.equal(teleportLanded(new Map([["t1", { x: 1, y: 1 }]]), { moved: true }), false);
});
