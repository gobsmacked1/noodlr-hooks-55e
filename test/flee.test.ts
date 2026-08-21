import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  FLEE_TURNS,
  fledState,
  nearSceneEdge,
  shouldDespawn,
} from "../src/tactics/flee";

test("a missing or shapeless flag is not a flee", () => {
  assert.equal(fledState(null), null);
  assert.equal(fledState({ flags: {} }), null);
  assert.equal(fledState({ flags: { "noodlr-hooks-55e": { fled: { turns: 1 } } } }), null);
});

test("a stamped flee is readable off either namespace", () => {
  const state = { combatId: "c1", turns: 2, at: 1 };
  const modern = fledState({ flags: { "noodlr-hooks-55e": { fled: state } } });
  assert.deepEqual(modern, state);
  const legacy = fledState({ flags: { noodlr: { fled: state } } });
  assert.deepEqual(legacy, state);
});

test("despawn after three own turns, or the moment the edge is reached", () => {
  assert.equal(shouldDespawn({ combatId: "c", turns: 1, at: 0 }, false), false);
  assert.equal(shouldDespawn({ combatId: "c", turns: 2, at: 0 }, false), false);
  assert.equal(shouldDespawn({ combatId: "c", turns: FLEE_TURNS, at: 0 }, false), true);
  assert.equal(shouldDespawn({ combatId: "c", turns: 1, at: 0 }, true), true);
});

test("the last square before the map runs out is already the edge", () => {
  const rect = { x: 0, y: 0, width: 1000, height: 1000 };
  const edge = { x: 0, y: 400, width: 1, height: 1 };
  const mid = { x: 400, y: 400, width: 1, height: 1 };
  assert.equal(nearSceneEdge(edge, rect, 100), true);
  assert.equal(nearSceneEdge(mid, rect, 100), false);
});
