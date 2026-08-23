import { strict as assert } from "node:assert";
import { test } from "node:test";

import { burrowAlpha, flyBobPx, movementActionOf } from "../src/core/motion-fx";

test("a burrower is invisible until the animation is done", () => {
  assert.equal(burrowAlpha(false), 0);
  assert.equal(burrowAlpha(true), 1);
  assert.equal(burrowAlpha(true, 0.8), 0.8);
});

test("a fly bob is zero at the start and end of the segment", () => {
  assert.equal(flyBobPx(0), 0);
  assert.ok(Math.abs(flyBobPx(1)) < 1e-10);
  assert.ok(flyBobPx(0.25) > 0);
  assert.ok(flyBobPx(0.75) < 0);
});

test("movement action reads the option first", () => {
  assert.equal(movementActionOf({ action: "burrow" }, "walk"), "burrow");
  assert.equal(movementActionOf({}, "Fly"), "fly");
  assert.equal(movementActionOf(null, ""), "");
});
