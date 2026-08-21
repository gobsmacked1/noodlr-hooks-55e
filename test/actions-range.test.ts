import { strict as assert } from "node:assert";
import { test } from "node:test";

import { innateRangedOf, meleeReachOf, thrownRangeOf } from "../src/tactics/actions";

/** The Lycan Spear as dnd5e stores it: melee reach and thrown range on one object. */
const SPEAR = {
  name: "Lycan Spear",
  system: {
    range: { value: 20, long: 60, reach: 5, units: "ft" },
    properties: ["thr", "ver"],
  },
};

const SHORTSWORD = {
  name: "Shortsword",
  system: {
    range: { value: null, long: null, reach: 5, units: "ft" },
    properties: ["fin", "lgt"],
  },
};

const CROSSBOW = {
  name: "Light Crossbow",
  system: {
    range: { value: 80, long: 320, reach: null, units: "ft" },
    properties: ["amm", "lod", "two"],
  },
};

test("a spear's melee reach is 5 ft, never the 20 ft thrown range", () => {
  assert.equal(meleeReachOf(SPEAR), 5);
});

test("a spear can be thrown 20 ft", () => {
  assert.equal(thrownRangeOf(SPEAR), 20);
});

test("a shortsword is 5 ft and cannot be thrown", () => {
  assert.equal(meleeReachOf(SHORTSWORD), 5);
  assert.equal(thrownRangeOf(SHORTSWORD), null);
});

test("a crossbow is not a melee reach, and is not thrown", () => {
  assert.equal(thrownRangeOf(CROSSBOW), null);
});

/** 2024 Archmage Arcane Burst: melee or ranged, no Thrown property. */
const ARCANE_BURST = {
  name: "Arcane Burst",
  system: {
    type: { value: "natural" },
    range: { value: 150, long: null, reach: 5, units: "ft" },
    properties: [],
  },
};

test("Arcane Burst shoots 150 ft and is not a thrown weapon", () => {
  assert.equal(meleeReachOf(ARCANE_BURST), 5);
  assert.equal(thrownRangeOf(ARCANE_BURST), null);
  assert.equal(innateRangedOf(ARCANE_BURST), 150);
});

test("a spear's thrown range is not also an innate ranged mode", () => {
  assert.equal(innateRangedOf(SPEAR), null);
});

test("a shortsword has no second range", () => {
  assert.equal(innateRangedOf(SHORTSWORD), null);
});

test("properties as a Set still count as thrown", () => {
  const item = {
    system: {
      range: { value: 30, reach: 5, units: "ft" },
      properties: new Set(["thr"]),
    },
  };
  assert.equal(meleeReachOf(item), 5);
  assert.equal(thrownRangeOf(item), 30);
});
