import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { validateWatch, WATCH_EVENTS } from "../src/integration/watch";
import type { CreatureAction } from "../src/tactics/actions";
import { holdable, triggersFor } from "../src/tactics/ready-plan";
import {
  cannedTriggers,
  mentalScores,
  readiableActivation,
  requiresConcentration,
} from "../src/system/dnd5e-ready";

// FOUR THINGS ARE PINNED, and they are the ones that fail SILENTLY.
//
//   1. THE VALIDATOR, because the thing on the other end of `noodlrHooks.watch` is a language model at one
//      remove. An invented event name that got through would compile to a trigger nothing ever fires, and
//      the player would be told their action was readied. Same discipline as `validateCapability`, with one
//      deliberate difference: an unknown FIELD is dropped rather than failing the descriptor, because half
//      an understood sentence is worth more than a refusal.
//   2. WHAT MAY BE READIED. "You cannot ready a Bonus Action" is a rule, and an empty activation being
//      unreadiable is a census finding — 109 of 2067 activities in a real world carry none because they are
//      the companion half of something else. Offering one holds a rule that cannot be used alone.
//   3. THE CANNED TRIGGERS, which are the whole feature on a table with no AI module. Every one has to be
//      `judge: false` or the fallback path costs model calls it cannot make, and every one has to name an
//      event from the closed list or it is a picker entry that does nothing.
//   4. WHAT A MONSTER MAY HOLD AND FOR WHAT. The NPC choice is random, so the only thing standing between
//      it and nonsense is the pairing rule: a melee weapon waits for something to arrive in reach, a bow
//      waits at a distance, and nothing waits on a resource a six-second clock could burn.
//
// The expiry arithmetic is `live()`, which is deliberately not exported: it reads `game.combats` and the
// record's stamp, and a test of it would be a test of a mock tracker. What makes it safe is the same trick
// the action ledger uses — a stamp belonging to another turn reads as absent, so nothing is ever cleared and
// every client computes the same answer with no write and no race.

beforeEach(() => {
  (globalThis as any).game = { system: { id: "dnd5e" } };
});

/* -------------------------------------------- */
/*  Checking what the compiler sent back         */
/* -------------------------------------------- */

test("a well-formed descriptor survives intact", () => {
  const watch = validateWatch({
    events: ["creature_moves"],
    subject: { names: ["Goblin"], side: "enemy", sense: "sight" },
    where: { ofSelf: 30 },
    statuses: ["Prone"],
    judge: false,
    summary: "a goblin comes within 30 feet",
  });
  assert.deepEqual(watch?.events, ["creature_moves"]);
  assert.deepEqual(watch?.subject, { names: ["goblin"], side: "enemy", sense: "sight" });
  assert.deepEqual(watch?.where, { ofSelf: 30 });
  assert.deepEqual(watch?.statuses, ["prone"], "statuses are the system's own ids, lowercase");
  assert.equal(watch?.judge, false);
});

test("an invented event is dropped, and a descriptor left with none is unwatchable", () => {
  // Not merely filtered: the player has to be TOLD, at declaration time, before the Action is charged.
  // Silently keeping a descriptor with no events is a readied action that can never fire.
  const partly = validateWatch({ events: ["creature_moves", "the_tide_comes_in"], judge: true });
  assert.deepEqual(partly?.events, ["creature_moves"]);
  assert.equal(partly?.problem, undefined);

  const nothing = validateWatch({ events: ["the_tide_comes_in"], judge: true });
  assert.deepEqual(nothing?.events, []);
  assert.ok(nothing?.problem, "a descriptor with nothing watchable has to say so");
});

test("judge defaults to true, because guessing false makes a trigger fire on the wrong event", () => {
  // Asymmetric on purpose. A needless judge call costs a fraction of a cent; a judge flag that should have
  // been true means the predicates alone decide, and they cannot read "if the Cutpurse FLEES".
  assert.equal(validateWatch({ events: ["creature_moves"] })?.judge, true);
  assert.equal(validateWatch({ events: ["creature_moves"], judge: "yes" })?.judge, true);
  assert.equal(validateWatch({ events: ["creature_moves"], judge: false })?.judge, false);
});

test("a nonsense distance is dropped rather than kept as an unsatisfiable predicate", () => {
  // Zero is not a distance anybody means, and a negative one is nonsense. Either would make a predicate
  // that can never pass look exactly like one that was never set.
  const watch = validateWatch({
    events: ["creature_moves"],
    where: { ofSelf: 0, ofAlly: -5, beyondSelf: 10, inReach: true },
  });
  assert.deepEqual(watch?.where, { beyondSelf: 10, inReach: true });
});

test("an unknown side or sense is ignored rather than trusted", () => {
  const watch = validateWatch({
    events: ["creature_moves"],
    subject: { side: "frenemy", sense: "smell", names: ["", "  Troll  "] },
  });
  assert.deepEqual(watch?.subject, { names: ["troll"] });
});

test("duplicate events collapse, and lists are capped", () => {
  const watch = validateWatch({
    events: ["creature_moves", "creature_moves"],
    subject: { names: Array.from({ length: 20 }, (_, i) => `name${i}`) },
    statuses: Array.from({ length: 20 }, (_, i) => `s${i}`),
  });
  assert.deepEqual(watch?.events, ["creature_moves"]);
  assert.equal(watch?.subject?.names?.length, 8);
  assert.equal(watch?.statuses?.length, 8);
});

test("a non-object answer is no answer, which the caller reads as no compiler", () => {
  for (const answer of [null, undefined, "creature_moves", 7]) {
    assert.equal(validateWatch(answer), null);
  }
});

/* -------------------------------------------- */
/*  What may be readied                          */
/* -------------------------------------------- */

test("an Action may be readied and a Bonus Action may not", () => {
  assert.equal(readiableActivation("action"), true);
  assert.equal(readiableActivation("ACTION"), true);
  assert.equal(readiableActivation("bonus"), false, "the rule forbids it outright");
  assert.equal(readiableActivation("reaction"), false, "that is what the response itself costs");
  assert.equal(readiableActivation("minute"), false, "longer than an action cannot fit in a reaction");
});

test("an empty activation is not readiable, which is the census's finding rather than the rules'", () => {
  // The companion half of something else — the save rider on a bite, the extra damage on a sneak attack.
  // Holding one would hold a rule that cannot be used on its own.
  assert.equal(readiableActivation(""), false);
  assert.equal(readiableActivation(undefined), false);
  assert.equal(readiableActivation(null), false);
});

test("concentration is read from either shape the system stores properties in", () => {
  assert.equal(requiresConcentration({}, { requiresConcentration: true }), true);
  assert.equal(
    requiresConcentration({ system: { properties: new Set(["concentration"]) } }, {}),
    true,
  );
  assert.equal(requiresConcentration({ system: { properties: ["concentration"] } }, {}), true);
  assert.equal(requiresConcentration({ system: { properties: new Set(["vocal"]) } }, {}), false);
});

/* -------------------------------------------- */
/*  The gate, and the fallback picker            */
/* -------------------------------------------- */

test("an unreadable sheet reports null rather than zero", () => {
  // The caller defaults to allowing on null. Reporting zero would turn a lich into a beetle, which is the
  // same call the planner makes for an unreadable creature.
  assert.deepEqual(mentalScores({ system: { abilities: { int: { value: 10 } } } }), {
    int: 10,
    wis: null,
  });
  assert.deepEqual(mentalScores({}), { int: null, wis: null });
});

test("the layer reports nothing on another game system", () => {
  (globalThis as any).game.system.id = "pf2e";
  assert.deepEqual(mentalScores({ system: { abilities: { int: { value: 20 } } } }), {
    int: null,
    wis: null,
  });
});

test("every canned trigger is free to evaluate and names a real event", () => {
  // These ARE the feature on a table with no AI module, and on the NPC side they are the only triggers
  // there will ever be. One of them set to judge:true would silently cost a model call per event on a
  // table that has nothing to answer it.
  const known = new Set<string>(WATCH_EVENTS);
  const triggers = cannedTriggers(10);
  assert.ok(triggers.length >= 6, "the six common cases, in one click");
  for (const trigger of triggers) {
    assert.equal(trigger.descriptor.judge, false, `${trigger.id} must not need a judge`);
    assert.ok(trigger.descriptor.events.length, `${trigger.id} must watch for something`);
    assert.ok(trigger.descriptor.summary, `${trigger.id} must be describable to the player`);
    for (const event of trigger.descriptor.events) {
      assert.ok(known.has(event), `${trigger.id} watches an unknown event ${event}`);
    }
    // Every one must survive our own validator, or the picker and the compiler disagree about the schema.
    assert.deepEqual(validateWatch(trigger.descriptor)?.events, trigger.descriptor.events);
  }
});

test("the creature's own reach is what 'backs out of reach' means", () => {
  // A hardcoded 5 would make the most-wanted trigger wrong for half the bestiary.
  const giant = cannedTriggers(15).find((t) => t.id === "leaves");
  const kobold = cannedTriggers(5).find((t) => t.id === "leaves");
  assert.equal(giant?.descriptor.where?.beyondSelf, 15);
  assert.equal(kobold?.descriptor.where?.beyondSelf, 5);
});

/* -------------------------------------------- */
/*  What a monster is allowed to hold, and for what */
/* -------------------------------------------- */

const action = (over: Partial<CreatureAction> = {}): CreatureAction =>
  ({
    item: {},
    name: "Scimitar",
    kind: "attack",
    economy: "action",
    ranged: false,
    melee: true,
    range: 5,
    available: true,
    depleting: false,
    ...over,
  }) as CreatureAction;

test("a monster never holds a resource it cannot get back", () => {
  // The release prompt fires on a six-second clock, so a readied breath weapon is spent on the first
  // goblin through the door. Same rule `util/prompt.ts` states from the other end — a clock may spend a
  // renewing resource and never a depleting one. A player is exempt because they said so in writing; a
  // random choice has said nothing.
  assert.equal(holdable(action()), true);
  assert.equal(holdable(action({ depleting: true })), false);
});

test("only an available Action-costed attack or control effect is held", () => {
  assert.equal(holdable(action({ economy: "bonus" })), false);
  assert.equal(holdable(action({ available: false })), false);
  assert.equal(holdable(action({ kind: "utility" })), false);
  assert.equal(holdable(action({ kind: "heal" })), false);
  assert.equal(holdable(action({ kind: "control" })), true);
});

test("the trigger a monster waits for is one its held action can answer", () => {
  // The whole of what stops "random" reading as "wrong": a scimitar waiting for "an enemy comes into
  // view" is holding an action it cannot use at the moment the trigger fires.
  const byId = new Map(cannedTriggers(5).map((t) => [t.id, t]));
  for (const ranged of [true, false]) {
    const ids = triggersFor(ranged);
    assert.ok(ids.length, "there must be something to draw from");
    for (const id of ids) {
      const trigger = byId.get(id);
      assert.ok(trigger, `${id} is not a canned trigger, so nothing would ever pair with it`);
      const reach = trigger.descriptor.where?.inReach === true;
      assert.equal(
        reach,
        !ranged,
        `${id} fires ${reach ? "in reach" : "at a distance"}, which a ${ranged ? "bow" : "blade"} cannot use`,
      );
    }
  }
  // `leaves` is deliberately absent from both: the opportunity-attack layer already answers a departure
  // for free, so readying for one spends an Action to buy a reaction the creature had anyway.
  assert.ok(!triggersFor(true).includes("leaves"));
  assert.ok(!triggersFor(false).includes("leaves"));
});
