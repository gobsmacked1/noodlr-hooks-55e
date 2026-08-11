import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  __damageLogInternals,
  damageTakenBy,
  damageTakenMatches,
  noteTurnStart,
  onDamageTaken,
} from "../src/capability/damage-log";
import type { DamageTakenEvent } from "../src/capability/damage-log";

const internals = __damageLogInternals();
const TROLL = "Actor.troll";

/** The module reads `game.combat.round`; nothing else in the log touches a Foundry global. */
function inCombat(round: number): void {
  (globalThis as any).game = { combat: { round } };
}

function hit(amount: number, types: string[] = []): void {
  internals.record({ uuid: TROLL, name: "Troll" }, amount, types);
}

beforeEach(() => {
  internals.reset();
  inCombat(1);
});

test("damage is recorded with what it was and when", () => {
  noteTurnStart(TROLL);
  hit(12, ["slashing"]);
  const answer = damageTakenBy(TROLL, { window: "this_turn" });
  assert.equal(answer.evaluable, true);
  assert.equal(answer.total, 12);
  assert.deepEqual(answer.matched[0].types, ["slashing"]);
});

test("a window that cannot be evaluated is not the same as taking nothing", () => {
  // Out of combat there are no turns, so "during that turn" has no referent. Saying "took nothing"
  // would let a turn-scoped guard pass by accident.
  hit(12, ["fire"]);
  const answer = damageTakenBy(TROLL, { window: "this_turn" });
  assert.equal(answer.evaluable, false);
  assert.equal(damageTakenMatches(TROLL, { window: "this_turn", damageTypes: ["fire"] }), false);
  // `ever` is always evaluable, and finds it.
  assert.equal(damageTakenBy(TROLL, { window: "ever" }).total, 12);
});

test("Loathsome Limbs: 15 or more Slashing during that turn", () => {
  noteTurnStart(TROLL);
  hit(8, ["slashing"]);
  hit(9, ["slashing"]);
  assert.equal(
    damageTakenMatches(TROLL, { window: "this_turn", damageTypes: ["slashing"], minimum: 15 }),
    true,
  );
});

test("…and the same damage in the wrong type does not count", () => {
  noteTurnStart(TROLL);
  hit(30, ["bludgeoning"]);
  assert.equal(
    damageTakenMatches(TROLL, { window: "this_turn", damageTypes: ["slashing"], minimum: 15 }),
    false,
  );
});

test("…nor does enough of the right type spread across two turns", () => {
  noteTurnStart(TROLL);
  hit(9, ["slashing"]);
  noteTurnStart(TROLL);
  hit(9, ["slashing"]);
  assert.equal(
    damageTakenMatches(TROLL, { window: "this_turn", damageTypes: ["slashing"], minimum: 15 }),
    false,
  );
  assert.equal(damageTakenBy(TROLL, { window: "this_turn" }).total, 9);
});

test("Regeneration: acid or fire anywhere between the troll's turns suppresses it", () => {
  noteTurnStart(TROLL); // round 1: the troll acts
  hit(6, ["fire"]); // the wizard burns it on somebody else's turn
  noteTurnStart(TROLL); // round 2: the troll's turn begins

  // `this_turn` misses it — the fire landed before this turn started, which is why the rule needs a
  // window that spans the gap.
  assert.equal(
    damageTakenMatches(TROLL, { window: "this_turn", damageTypes: ["fire", "acid"] }),
    false,
  );
  assert.equal(
    damageTakenMatches(TROLL, { window: "since_last_turn", damageTypes: ["fire", "acid"] }),
    true,
  );
});

test("…and with no fire at all, regeneration is not suppressed", () => {
  noteTurnStart(TROLL);
  hit(20, ["slashing"]);
  noteTurnStart(TROLL);
  assert.equal(
    damageTakenMatches(TROLL, { window: "since_last_turn", damageTypes: ["fire", "acid"] }),
    false,
  );
});

test("untyped damage does not satisfy a typed guard", () => {
  // A player's client applied it and no card named a type. Guessing "fire" would stop a troll
  // regenerating for a reason nobody at the table could find.
  noteTurnStart(TROLL);
  hit(9, []);
  assert.equal(damageTakenMatches(TROLL, { window: "this_turn", damageTypes: ["fire"] }), false);
  assert.equal(damageTakenMatches(TROLL, { window: "this_turn" }), true);
});

test("a round window follows the combat round, not the creature's turn", () => {
  noteTurnStart(TROLL);
  hit(5, ["cold"]);
  inCombat(2);
  hit(7, ["cold"]);
  assert.equal(damageTakenBy(TROLL, { window: "this_round" }).total, 7);
  assert.equal(damageTakenBy(TROLL, { window: "ever" }).total, 12);
});

test("one creature's damage is not another's", () => {
  noteTurnStart(TROLL);
  noteTurnStart("Actor.ogre");
  hit(30, ["fire"]);
  assert.equal(damageTakenBy("Actor.ogre", { window: "this_turn" }).total, 0);
});

test("listeners are told, and a broken one does not stop the rest", () => {
  const seen: DamageTakenEvent[] = [];
  onDamageTaken(() => {
    throw new Error("this listener is broken");
  });
  const off = onDamageTaken((event) => seen.push(event));

  noteTurnStart(TROLL);
  hit(4, ["acid"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].amount, 4);

  off();
  hit(4, ["acid"]);
  assert.equal(seen.length, 1, "unsubscribing actually unsubscribes");
});

test("healing is not damage", () => {
  noteTurnStart(TROLL);
  internals.record({ uuid: TROLL }, -5, ["healing"]);
  internals.record({ uuid: TROLL }, 0, ["fire"]);
  assert.equal(damageTakenBy(TROLL, { window: "this_turn" }).matched.length, 0);
});

test("the ledger does not grow without bound over a long fight", () => {
  noteTurnStart(TROLL);
  for (let i = 0; i < 2500; i++) hit(1, ["slashing"]);
  assert.ok(internals.entries.length <= 2000, `entries capped, got ${internals.entries.length}`);
});
