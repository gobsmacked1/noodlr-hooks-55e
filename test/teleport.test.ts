import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  isSelfTeleport,
  isTeleportActivity,
  originMoved,
  shouldReplaceTeleportTokens,
  teleportActivationType,
  teleportAffects,
  teleportLanded,
  teleportRangeUnits,
  plannedDestination,
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
  range: { units: "ft", value: 5, override: true },
  target: { override: false, affects: {} },
  item: {
    system: {
      range: { units: "ft", value: 500 },
      target: { affects: { type: "willing", count: "2" } },
    },
  },
};

/** DDB: blink distance on the activity, Self on the item. */
const ddbMisty = {
  type: "teleport",
  range: { units: "ft", value: 30, override: true },
  target: { override: true, affects: { type: "self" } },
  activation: { type: "bonus", override: true },
  item: {
    name: "Misty Step",
    system: { range: { units: "self" }, activation: { type: "bonus" } },
  },
};

/** 7th-level Teleport — leftover activity `units: self` is schema, not a hop. */
const ritual = {
  type: "teleport",
  range: { units: "self", override: false },
  target: { override: false, affects: {} },
  item: {
    name: "Teleport",
    system: {
      range: { units: "ft", value: 10 },
      target: { affects: { type: "willing", count: "9" } },
    },
  },
};

const planeShift = {
  type: "teleport",
  range: { units: "self", override: false },
  target: { override: false, affects: {} },
  item: {
    system: { range: { units: "touch" }, target: { affects: { type: "willing", count: "9" } } },
  },
};

const treeStride = {
  type: "teleport",
  range: { units: "self", override: false },
  target: { override: false, affects: {} },
  item: {
    system: { range: { units: "self" }, target: { affects: { type: "self" } } },
  },
};

/** Legendary hop — 120 ft on the activity, target Self, no item range. */
const sphinx = {
  type: "teleport",
  range: { units: "ft", value: 120, override: false },
  target: { override: false, affects: { type: "self" } },
  item: { name: "Teleport", system: { identifier: "teleport" } },
};

test("a caster hop is a hop whatever encoding it uses; a ritual is not", () => {
  assert.equal(isTeleportActivity(misty), true);
  assert.equal(isSelfTeleport(misty), true);
  assert.equal(isSelfTeleport(ddbMisty), true);
  assert.equal(isSelfTeleport(treeStride), true);
  assert.equal(isSelfTeleport(sphinx), true);
  assert.equal(isSelfTeleport(door), false);
  assert.equal(isSelfTeleport(ritual), false);
  assert.equal(isSelfTeleport(planeShift), false);
  assert.equal(teleportRangeUnits(ritual), "ft");
  assert.equal(teleportRangeUnits(ddbMisty), "ft");
  assert.equal(teleportAffects(sphinx), "self");
  assert.equal(teleportAffects(ritual), "willing");
});

test("Misty Step's slot is the item's bonus, not the activity's action", () => {
  assert.equal(teleportActivationType(misty), "bonus");
  assert.equal(teleportActivationType(ddbMisty), "bonus");
  assert.equal(teleportAffects(ddbMisty), "self");
  assert.equal(teleportAffects(door), "willing");
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

test("the planned destination is the player's chosen square, not moved:true", () => {
  const dest = { x: 400, y: 200, elevation: 0 };
  assert.deepEqual(plannedDestination({ plan: { destination: dest }, moved: true }), dest);
  assert.deepEqual(
    plannedDestination({ plan: { waypoints: [{ x: 100, y: 200 }, dest] } }),
    dest,
  );
  assert.equal(plannedDestination({ moved: true }), null);
});
