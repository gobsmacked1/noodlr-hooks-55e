import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  classifyActivityRange,
  isTooFar,
  itemMeleeReach,
} from "../src/system/dnd5e-range";

const UNARMED = {
  name: "Unarmed Strike",
  system: { range: { reach: 5, units: "ft" }, properties: [] },
};

const SPEAR = {
  name: "Lycan Spear",
  system: {
    range: { value: 20, long: 60, reach: 5, units: "ft" },
    properties: ["thr", "ver"],
  },
};

const CROSSBOW = {
  name: "Light Crossbow",
  system: {
    range: { value: 80, long: 320, reach: null, units: "ft" },
    properties: ["amm", "lod", "two"],
  },
};

function flurry() {
  return {
    type: "utility",
    range: { units: "self", override: false },
    target: { affects: { type: "creature", count: 1 } },
  };
}

function patientDefense() {
  return {
    type: "utility",
    range: { units: "self" },
    target: { affects: { type: "self" } },
  };
}

test("Flurry-shaped utility (Self + creature) is melee", () => {
  const got = classifyActivityRange(flurry(), { name: "Monk's Focus" }, { grid: 5, pointedReach: 5 });
  assert.equal(got.kind, "melee");
  assert.equal(got.reason, "self-creature");
  assert.equal(got.limit, 5);
});

test("Patient Defense (Self + self) is skipped", () => {
  const got = classifyActivityRange(patientDefense());
  assert.equal(got.kind, "skip");
  assert.equal(got.reason, "self");
});

test("an Unarmed Strike attack is melee at the item reach", () => {
  const got = classifyActivityRange(
    { type: "attack", attack: { type: { value: "" } } },
    UNARMED,
  );
  assert.equal(got.kind, "melee");
  assert.equal(got.reason, "attack");
  assert.equal(got.limit, 5);
});

test("a thrown spear is ranged at long range, not a 20-foot poke", () => {
  const got = classifyActivityRange(
    { type: "attack", attack: { type: { value: "melee" } } },
    SPEAR,
    { attackMode: "thrown" },
  );
  assert.equal(got.kind, "ranged");
  assert.equal(got.limit, 60);
  assert.equal(got.short, 20);
});

test("a spear with no attackMode yet is skipped, not refused as melee", () => {
  const got = classifyActivityRange(
    { type: "attack", attack: { type: { value: "melee" } } },
    SPEAR,
  );
  assert.equal(got.kind, "skip");
  assert.equal(got.reason, "ambiguous-mode");
});

test("itemMeleeReach never reads range.value", () => {
  assert.equal(itemMeleeReach(SPEAR, 5), 5);
  assert.equal(itemMeleeReach(UNARMED, 5), 5);
});

test("a ranged attack uses long range", () => {
  const got = classifyActivityRange(
    { type: "attack", attack: { type: { value: "ranged" } } },
    CROSSBOW,
  );
  assert.equal(got.kind, "ranged");
  assert.equal(got.reason, "attack");
  assert.equal(got.limit, 320);
});

test("a 2014-shaped 5 ft utility is ranged max 5", () => {
  const got = classifyActivityRange({
    type: "utility",
    range: { value: 5, units: "ft" },
    target: { affects: { type: "creature" } },
  });
  assert.equal(got.kind, "ranged");
  assert.equal(got.reason, "stated-range");
  assert.equal(got.limit, 5);
});

test("melee is a cylinder: 50 ft away is too far, 5 ft is not, 5 ft + 10 ft up is", () => {
  const melee = { kind: "melee" as const, reason: "self-creature", limit: 5 };
  assert.equal(isTooFar(melee, 50, 0), true);
  assert.equal(isTooFar(melee, 5, 0), false);
  assert.equal(isTooFar(melee, 5, 10), true);
});

test("ranged is 3D hypot against long range", () => {
  const bow = { kind: "ranged" as const, reason: "attack", limit: 80, short: 80 };
  assert.equal(isTooFar(bow, 50, 0), false);
  assert.equal(isTooFar(bow, 100, 0), true);
});
