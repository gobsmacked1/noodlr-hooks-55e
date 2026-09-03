import { strict as assert } from "node:assert";
import { test } from "node:test";

import { leaveSquareAt, pendingRemainder, shouldHoldMove } from "../src/rules/move-hold";

test("the Halt square is the first out-of-reach waypoint, not the origin", () => {
  const route = [
    { x: 0, y: 0, elevation: 0 },
    { x: 100, y: 0, elevation: 0 },
    { x: 200, y: 0, elevation: 0 },
  ];
  assert.deepEqual(leaveSquareAt(route, 0), { x: 100, y: 0, elevation: 0 });
  assert.deepEqual(leaveSquareAt(route, 1), { x: 200, y: 0, elevation: 0 });
  assert.equal(leaveSquareAt(route, 2), null);
  assert.equal(leaveSquareAt([], 0), null);
});

test("a one-square walk has nothing left to pause", () => {
  assert.equal(shouldHoldMove(true, 0), false);
  assert.equal(shouldHoldMove(true, 3), true);
  assert.equal(shouldHoldMove(false, 3), false);
  assert.equal(pendingRemainder({ pending: { waypoints: [{}, {}] } }), 2);
  assert.equal(pendingRemainder({ pending: { waypoints: [] } }), 0);
  assert.equal(pendingRemainder({}), 0);
});
