import { strict as assert } from "node:assert";
import { test } from "node:test";

import { meleeReached, tokenIdOf } from "../src/tactics/execute";

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

test("tokenIdOf reads a BoardActor, a Token, or a document", () => {
  assert.equal(tokenIdOf({ tokenId: "abc" }), "abc");
  assert.equal(tokenIdOf({ document: { id: "def" } }), "def");
  assert.equal(tokenIdOf({ token: { document: { id: "ghi" } } }), "ghi");
  assert.equal(tokenIdOf({}), undefined);
  assert.equal(tokenIdOf({ tokenId: "" }), undefined);
});
