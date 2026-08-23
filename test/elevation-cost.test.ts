import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ELEVATION_TAX,
  affordableElevation,
  crossesZeroPlane,
  elevationTaxFromSize,
  historyTravelCost,
  pathTravelCost,
  segmentTravelCost,
  verticalCost,
} from "../src/core/elevation-cost";

test("the size tax is the table the user wrote down", () => {
  assert.equal(elevationTaxFromSize("tiny"), 5);
  assert.equal(elevationTaxFromSize("sm"), 10);
  assert.equal(elevationTaxFromSize("small"), 10);
  assert.equal(elevationTaxFromSize("med"), 10);
  assert.equal(elevationTaxFromSize("medium"), 10);
  assert.equal(elevationTaxFromSize("lg"), 20);
  assert.equal(elevationTaxFromSize("large"), 20);
  assert.equal(elevationTaxFromSize("huge"), 30);
  assert.equal(elevationTaxFromSize("grg"), 40);
  assert.equal(elevationTaxFromSize("gargantuan"), 40);
  assert.equal(ELEVATION_TAX.tiny, 5);
});

test("an unreadable size is taxed nothing, not invented as Gargantuan", () => {
  assert.equal(elevationTaxFromSize(null), 0);
  assert.equal(elevationTaxFromSize("vehicle"), 0);
});

test("airborne height change is |Δz| with no tax; leaving or meeting 0 is taxed", () => {
  assert.equal(crossesZeroPlane(20, 15), false);
  assert.equal(verticalCost(20, 15, "fly", 20), 5);

  assert.equal(crossesZeroPlane(0, 30), true);
  assert.equal(verticalCost(0, 30, "fly", 20), 30);
  assert.equal(verticalCost(0, 5, "burrow", 20), 20);
  assert.equal(verticalCost(30, 0, "fly", 20), 30);
  assert.equal(verticalCost(10, -10, "swim", 10), 20);
});

test("walk and displace never add our Z line", () => {
  assert.equal(verticalCost(0, 10, "walk", 10), 0);
  assert.equal(verticalCost(0, -10, "crawl", 10), 0);
  assert.equal(verticalCost(20, 0, "displace", 20), 0);
});

test("a long jump with no height change spends nothing extra", () => {
  assert.equal(verticalCost(0, 0, "jump", 10), 0);
  const flat = segmentTravelCost(
    { action: "jump", cost: 16, fromElev: 0, toElev: 0, horizontal: 16 },
    10,
  );
  assert.equal(flat.total, 16);
  assert.equal(flat.surcharge, 0);
});

test("a high jump off the ground pays the size tax", () => {
  assert.equal(verticalCost(0, 6, "jump", 10), 10);
});

test("EQUIDISTANT 30 ft across + 10 ft down spends 40, not core's 30", () => {
  const mixed = segmentTravelCost(
    { action: "fly", cost: 30, fromElev: 30, toElev: 20, horizontal: 30 },
    20,
  );
  assert.equal(mixed.total, 40);
  assert.equal(mixed.surcharge, 10);
});

test("RECTILINEAR that already added |Δz| is not charged a second time", () => {
  const additive = segmentTravelCost(
    { action: "fly", cost: 40, fromElev: 30, toElev: 20, horizontal: 30 },
    20,
  );
  assert.equal(additive.total, 40);
  assert.equal(additive.surcharge, 0);
});

test("a pure vertical climb spends the tax, not a 5-foot burrow under a Large bulette", () => {
  const dive = segmentTravelCost(
    { action: "burrow", cost: 5, fromElev: 0, toElev: -5, horizontal: 0 },
    20,
  );
  assert.equal(dive.total, 20);
});

test("a 120 ft rise is 120, not 120 plus another 120", () => {
  const up = segmentTravelCost(
    { action: "fly", cost: 120, fromElev: 0, toElev: 120, horizontal: 0 },
    5,
  );
  assert.equal(up.total, 120);
});

test("history starts at Foundry's cost-0 origin, so the first real step has a from-elevation", () => {
  const spend = historyTravelCost(
    [
      { x: 0, y: 0, elevation: 0, action: "fly", cost: 0 },
      { x: 0, y: 0, elevation: 10, action: "fly", cost: 10 },
    ],
    10,
    () => 0,
  );
  assert.equal(spend.total, 10);
});

test("a level fly after takeoff is XY only", () => {
  const spend = pathTravelCost(
    { elevation: 30, action: "fly" },
    [{ elevation: 30, action: "fly", cost: 40, x: 400, y: 0 }],
    20,
    () => 40,
  );
  assert.equal(spend.total, 40);
  assert.equal(spend.surcharge, 0);
});

test("affordableElevation refuses a takeoff the tax cannot pay, and a partial descent that cannot land", () => {
  assert.equal(affordableElevation(0, 40, 9, "fly", 10), 0);
  assert.equal(affordableElevation(0, 40, 10, "fly", 10), 10);
  assert.equal(affordableElevation(20, 0, 15, "fly", 20), 5);
  assert.equal(affordableElevation(20, 0, 20, "fly", 20), 0);
});
