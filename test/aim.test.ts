import { strict as assert } from "node:assert";
import { test } from "node:test";

import { aimOrigin, aimPlacement, directionDeg, excludeCaster, foundryShape } from "../src/tactics/aim";

test("dnd5e line and wall become a Foundry ray", () => {
  assert.equal(foundryShape("line"), "ray");
  assert.equal(foundryShape("wall"), "ray");
  assert.equal(foundryShape("cone"), "cone");
  assert.equal(foundryShape("sphere"), "circle");
  assert.equal(foundryShape("cube"), "rect");
  assert.equal(foundryShape(""), null);
});

test("a line east has direction 0 and originates on the caster", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 100, y: 0 };
  assert.equal(directionDeg(from, to), 0);
  assert.deepEqual(aimOrigin("ray", from, to), from);
  assert.deepEqual(aimPlacement("ray", from, to), { x: 0, y: 0, direction: 0 });
});

test("a line south has direction 90 on a y-down canvas", () => {
  assert.equal(directionDeg({ x: 0, y: 0 }, { x: 0, y: 100 }), 90);
});

test("a Fireball sits on the nominated target, not the caster", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 200, y: 50 };
  assert.deepEqual(aimOrigin("circle", from, to), to);
  assert.equal(aimPlacement("circle", from, to).x, 200);
  assert.equal(aimPlacement("circle", from, to).y, 50);
});

test("the caster is not a target of their own Lightning Bolt", () => {
  assert.equal(excludeCaster("ray"), true);
  assert.equal(excludeCaster("cone"), true);
  assert.equal(excludeCaster("circle"), false);
});
