import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { jumpDistances, JUMP_RUN_UP } from "../src/system/dnd5e-checks";
import { jumpLegs, jumpState, jumpVeto, runUpSoFar } from "../src/rules/jump";

function fighter(strength: number | null, mod?: number) {
  return {
    name: "Fighter",
    system: {
      abilities: strength === null ? {} : { str: { value: strength, mod: mod ?? null } },
    },
  };
}

/** A movement waypoint as core records one: an action, a terrain-adjusted cost, an elevation. */
function step(action: string, cost: number, elevation = 0) {
  return { action, cost, elevation };
}

beforeEach(() => {
  (globalThis as any).game = {
    system: { id: "dnd5e" },
    settings: { get: () => true },
    i18n: {
      format: (key: string, data: Record<string, string>) =>
        `${key} ${Object.entries(data)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`,
      localize: (key: string) => key,
    },
  };
  (globalThis as any).canvas = { scene: { grid: { units: "ft" } } };
});

/* -------------------------------------------- */
/*  The distances                                */
/* -------------------------------------------- */

test("the long jump is the Strength SCORE and the high jump is the MODIFIER", () => {
  // The single most common mistake with this rule, and the two numbers are far enough apart that
  // getting them the wrong way round still looks plausible: 16 feet across, 6 feet up.
  const distances = jumpDistances(fighter(16, 3));
  assert.equal(distances.longRunning, 16);
  assert.equal(distances.highRunning, 6);
});

test("standing halves both, rounding down", () => {
  const distances = jumpDistances(fighter(15, 2));
  assert.equal(distances.longRunning, 15);
  assert.equal(distances.longStanding, 7);
  assert.equal(distances.highRunning, 5);
  assert.equal(distances.highStanding, 2);
});

test("a missing modifier is derived from the score", () => {
  const distances = jumpDistances(fighter(20));
  assert.equal(distances.highRunning, 3 + 5);
});

test("a High Jump has a floor of nothing, never a negative", () => {
  const distances = jumpDistances(fighter(1, -5));
  assert.equal(distances.highRunning, 0);
  assert.equal(distances.highStanding, 0);
});

test("an unreadable sheet says so rather than reporting zero", () => {
  const distances = jumpDistances(fighter(null));
  assert.equal(distances.unreadable, true);
  assert.equal(jumpState({ actor: fighter(null) }), null);
});

/* -------------------------------------------- */
/*  Reading a path                               */
/* -------------------------------------------- */

test("consecutive jump waypoints are ONE leap, not four", () => {
  // The reason this is a walker rather than a per-waypoint check: dragging four squares in a single
  // motion emits four waypoints and is one twenty-foot jump.
  const legs = jumpLegs([step("jump", 5), step("jump", 5), step("jump", 5), step("jump", 5)]);
  assert.equal(legs.length, 1);
  assert.equal(legs[0].cost, 20);
  assert.equal(legs[0].horizontal, 20);
});

test("walking between two leaps splits them and restarts the run-up", () => {
  const legs = jumpLegs([step("walk", 10), step("jump", 10), step("walk", 5), step("jump", 10)]);
  assert.equal(legs.length, 2);
  assert.equal(legs[0].runUp, 10);
  // Five feet of walking after landing is not the ten a running jump needs.
  assert.equal(legs[1].runUp, 5);
});

test("flying into a leap is not a run-up", () => {
  const legs = jumpLegs([step("fly", 30), step("jump", 10)]);
  assert.equal(legs[0].runUp, 0);
});

test("rise is measured against where the leap began", () => {
  const legs = jumpLegs([step("walk", 10, 0), step("jump", 8, 5)]);
  assert.equal(legs[0].rise, 5);
  // Horizontal is what is left of the path once the climb is accounted for.
  assert.equal(legs[0].horizontal, 3);
});

test("run-up already spent this turn carries into the next drag", () => {
  const doc = { movementHistory: [step("walk", 15)] };
  assert.equal(runUpSoFar(doc), 15);
  // ...and a jump in the history resets it: you cannot bank a run-up across a leap.
  assert.equal(runUpSoFar({ movementHistory: [step("walk", 15), step("jump", 10)] }), 0);
});

/* -------------------------------------------- */
/*  The veto                                     */
/* -------------------------------------------- */

function doc(strength: number, history: any[] = []) {
  return { actor: fighter(strength, Math.floor((strength - 10) / 2)), movementHistory: history };
}

function proposed(waypoints: any[]) {
  return { pending: { waypoints } };
}

test("a leap within the standing distance is allowed with no run-up", () => {
  assert.equal(jumpVeto(doc(16), proposed([step("jump", 8)])), null);
});

test("a leap beyond the standing distance is refused when nobody ran", () => {
  const complaint = jumpVeto(doc(16), proposed([step("jump", 15)]));
  assert.match(String(complaint), /TooFar/);
  assert.match(String(complaint), /kind=standing/);
});

test("the same leap is allowed once the run-up has been taken", () => {
  assert.equal(jumpVeto(doc(16, [step("walk", JUMP_RUN_UP)]), proposed([step("jump", 15)])), null);
});

test("walking then leaping inside one drag is measured as the leap alone", () => {
  // A drag that walks fifteen feet and then leaps ten is a legal ten-foot jump. Judging it on the
  // path's total cost of twenty-five would be enforcing a rule that does not exist.
  assert.equal(jumpVeto(doc(12), proposed([step("walk", 15), step("jump", 10)])), null);
});

test("height is checked separately from distance", () => {
  const complaint = jumpVeto(doc(16, [step("walk", 10)]), proposed([step("jump", 12, 12)]));
  assert.match(String(complaint), /TooHigh/);
});

test("a path with no jump in it is none of this layer's business", () => {
  assert.equal(jumpVeto(doc(8), proposed([step("walk", 200)])), null);
});

test("an unreadable Strength score holds nobody to anything", () => {
  const nothing = { actor: fighter(null), movementHistory: [] };
  assert.equal(jumpVeto(nothing, proposed([step("jump", 100)])), null);
});

test("the layer declines entirely on another game system", () => {
  (globalThis as any).game.system.id = "pf2e";
  assert.equal(jumpVeto(doc(10), proposed([step("jump", 100)])), null);
});
