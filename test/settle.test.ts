import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  combatantPositions,
  combatantsAreMoving,
  tokenIsMoving,
  waitForCombatantsToRest,
} from "../src/core/settle";

function token(opts: {
  id?: string;
  x?: number;
  y?: number;
  contexts?: number;
  state?: string;
}): { id: string; _source: { x: number; y: number; elevation: number }; object: { animationContexts: { size: number } }; movement: { state: string } } {
  return {
    id: opts.id ?? "t",
    _source: { x: opts.x ?? 0, y: opts.y ?? 0, elevation: 0 },
    object: { animationContexts: { size: opts.contexts ?? 0 } },
    movement: { state: opts.state ?? "completed" },
  };
}

function combatant(t: ReturnType<typeof token>): { token: ReturnType<typeof token> } {
  return { token: t };
}

test("a missing token is at rest, not a throw", () => {
  assert.equal(tokenIsMoving(null), false);
  assert.equal(tokenIsMoving(undefined), false);
});

test("a token with no animation and a completed move is at rest", () => {
  assert.equal(tokenIsMoving(token({})), false);
});

test("an open animation context is a slide in progress", () => {
  assert.equal(tokenIsMoving(token({ contexts: 2 })), true);
});

test("pending or planned movement is in flight even before the sprite starts", () => {
  assert.equal(tokenIsMoving(token({ state: "pending" })), true);
  assert.equal(tokenIsMoving(token({ state: "planned" })), true);
});

test("combatantsAreMoving is true when any one of them is sliding", () => {
  const list = [combatant(token({ id: "a" })), combatant(token({ id: "b", contexts: 1 }))];
  assert.equal(combatantsAreMoving(list), true);
  assert.equal(combatantsAreMoving([combatant(token({ id: "a" }))]), false);
});

test("combatantPositions changes when a committed coordinate moves", () => {
  const a = combatant(token({ id: "a", x: 0 }));
  const first = combatantPositions([a]);
  a.token._source.x = 100;
  assert.notEqual(combatantPositions([a]), first);
});

test("waitForCombatantsToRest resolves rest once the slide ends", async () => {
  const moving = token({ id: "a", contexts: 1 });
  const combat = { combatants: [combatant(moving)] };
  const done = waitForCombatantsToRest(combat, { graceMs: 0, staleMs: 5_000, deadlineMs: 1_000 });
  setTimeout(() => {
    moving.object.animationContexts.size = 0;
  }, 20);
  assert.equal(await done, "rest");
});

test("a hung context with no document motion is stale, not a 60 s wait", async () => {
  const stuck = token({ id: "a", contexts: 1, x: 50 });
  const combat = { combatants: [combatant(stuck)] };
  const result = await waitForCombatantsToRest(combat, {
    graceMs: 0,
    staleMs: 30,
    deadlineMs: 500,
  });
  assert.equal(result, "stale");
});
