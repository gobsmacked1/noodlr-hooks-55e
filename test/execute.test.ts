import { strict as assert } from "node:assert";
import { test } from "node:test";

import { meleeReached } from "../src/tactics/execute";

test("a 5 ft Bite does not reach from 33 ft", () => {
  assert.equal(meleeReached(33, 5), false);
});

test("a 5 ft Bite reaches from 5 ft", () => {
  assert.equal(meleeReached(5, 5), true);
});

test("an unreadable gap never authorises a swing", () => {
  assert.equal(meleeReached(Number.POSITIVE_INFINITY, 5), false);
  assert.equal(meleeReached(5, Number.NaN), false);
  assert.equal(meleeReached(5, 0), false);
});
