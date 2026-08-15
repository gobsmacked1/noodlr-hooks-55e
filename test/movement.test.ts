import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { approaches } from "../src/core/movement";

const GRID = 100;
const ORIGIN = { x: 0, y: 0 };
/** Due east, so a positive angular offset turns the step south and the arithmetic is easy to read. */
const EAST = 0;
/** 600px is six squares, i.e. 30 feet at this scene's scale. */
const WANTED = 600;

beforeEach(() => {
  (globalThis as any).canvas = { grid: { size: GRID, distance: 5 } };
});

/** How far a candidate closes the gap along the original bearing. Negative means it went backwards. */
function progress(point: { x: number; y: number }): number {
  return point.x - ORIGIN.x;
}

test("the direct route is tried first, at full stretch", () => {
  const [first] = approaches(ORIGIN, EAST, WANTED);
  assert.equal(Math.round(first.point.x), WANTED);
  assert.equal(Math.round(first.point.y), 0);
  assert.equal(first.label, "30 ft");
});

test("a blocked straight line is followed by a sidestep, not just a shorter straight line", () => {
  // The whole of the reported bug: every candidate used to lie on the same line, so a wall in front of a
  // creature refused all four and it stood there for the rest of the fight.
  const offset = approaches(ORIGIN, EAST, WANTED).filter((c) => Math.abs(c.point.y) > 1);
  assert.ok(offset.length >= 4, `expected a fan to either side, got ${offset.length} angled steps`);
  assert.ok(
    offset.some((c) => c.point.y > 0) && offset.some((c) => c.point.y < 0),
    "the fan must go both ways, or every creature breaks the same way round an obstacle",
  );
});

test("candidates are ordered by ground closed, so a shallow detour beats a short shuffle", () => {
  const gains = approaches(ORIGIN, EAST, WANTED).map((c) => progress(c.point));
  for (let i = 1; i < gains.length; i += 1) {
    assert.ok(
      gains[i] <= gains[i - 1] + 1e-6,
      `candidate ${i} closes ${gains[i]}px, more than the ${gains[i - 1]}px before it`,
    );
  }
});

test("every candidate makes progress; none is sideways or backwards", () => {
  // A step that gains nothing is worse than not moving: it spends the budget and ends the approach.
  for (const candidate of approaches(ORIGIN, EAST, WANTED)) {
    assert.ok(
      progress(candidate.point) > 1,
      `${candidate.label} closes ${progress(candidate.point)}px`,
    );
  }
});

test("the list stays short, because each entry is a real move attempt", () => {
  assert.ok(approaches(ORIGIN, EAST, WANTED).length <= 8);
});

test("no candidate is further than the creature can go", () => {
  for (const candidate of approaches(ORIGIN, EAST, WANTED)) {
    const distance = Math.hypot(candidate.point.x, candidate.point.y);
    assert.ok(distance <= WANTED + 1e-6, `${candidate.label} is ${distance}px away`);
  }
});

test("an angled step is labelled as one, so a refusal in the log says which way it tried", () => {
  const angled = approaches(ORIGIN, EAST, WANTED).find((c) => Math.abs(c.point.y) > 1);
  assert.match(String(angled?.label), /ft at -?\d+\u00b0$/);
});

test("the bearing is respected, not assumed to be east", () => {
  const north = approaches(ORIGIN, -Math.PI / 2, WANTED);
  assert.equal(Math.round(north[0].point.x), 0);
  assert.equal(Math.round(north[0].point.y), -WANTED);
});
