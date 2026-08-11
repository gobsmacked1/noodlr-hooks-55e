import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { conditionsMet, evaluatePredicate } from "../src/capability/predicates";
import { __damageLogInternals, noteTurnStart } from "../src/capability/damage-log";

const damage = __damageLogInternals();

function actorFake(overrides: Record<string, any> = {}) {
  return {
    uuid: "Actor.troll",
    name: "Troll",
    type: "npc",
    statuses: new Set<string>(),
    system: {
      attributes: { hp: { value: 40, max: 84 } },
      details: { type: { value: "giant" } },
      traits: { size: "lg" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as any).game = { system: { id: "dnd5e" }, combat: { round: 1, started: true } };
  (globalThis as any).canvas = { grid: { size: 100, distance: 5 } };
  damage.reset();
});

test("hp_fraction_at_most is how Bloodied is expressed", () => {
  const troll = actorFake();
  const ctx = { self: { actor: troll } };
  assert.deepEqual(evaluatePredicate({ kind: "hp_fraction_at_most", fraction: 0.5 }, ctx), {
    evaluable: true,
    value: true,
  });
  troll.system.attributes.hp.value = 60;
  assert.equal(evaluatePredicate({ kind: "hp_fraction_at_most", fraction: 0.5 }, ctx).value, false);
});

test("a creature with no maximum hit points cannot be asked about a fraction", () => {
  const ctx = { self: { actor: actorFake({ system: { attributes: { hp: { value: 3 } } } }) } };
  const verdict = evaluatePredicate({ kind: "hp_fraction_at_most", fraction: 0.5 }, ctx);
  assert.equal(verdict.evaluable, false);
  assert.match(String(verdict.reason), /maximum hit points/);
});

test("a predicate about somebody absent is unanswerable, not false", () => {
  // The distinction is the whole design: false would let `lacks_status` pass on a trigger that has no
  // target, and a rule would fire against nobody.
  const verdict = evaluatePredicate(
    { kind: "lacks_status", status: "prone", who: "target" },
    { self: { actor: actorFake() } },
  );
  assert.equal(verdict.evaluable, false);
});

test('target_type treats "creature" as a category rather than a type', () => {
  // 434 of the mined conditions say "target is a creature", which no sheet states as a type value.
  const ctx = { self: { actor: actorFake() } };
  assert.equal(evaluatePredicate({ kind: "target_type", types: ["creature"] }, ctx).value, true);
  assert.equal(evaluatePredicate({ kind: "target_type", types: ["giant"] }, ctx).value, true);
  assert.equal(evaluatePredicate({ kind: "target_type", types: ["undead"] }, ctx).value, false);
});

test("size compares by rank, and the two spellings dnd5e uses agree", () => {
  const ctx = { self: { actor: actorFake() } }; // "lg"
  assert.equal(evaluatePredicate({ kind: "size_at_most", size: "large" }, ctx).value, true);
  assert.equal(evaluatePredicate({ kind: "size_at_most", size: "med" }, ctx).value, false);
  assert.equal(evaluatePredicate({ kind: "size_at_least", size: "medium" }, ctx).value, true);
});

test("damage_taken carries the window through to the ledger, including its refusals", () => {
  const troll = actorFake();
  const ctx = { self: { actor: troll } };
  noteTurnStart("Actor.troll");
  damage.record({ uuid: "Actor.troll" }, 16, ["slashing"]);

  assert.equal(
    evaluatePredicate(
      {
        kind: "damage_taken",
        window: "this_turn",
        damageTypes: ["slashing"],
        minimum: { value: 15 },
      },
      ctx,
    ).value,
    true,
  );
  assert.equal(
    evaluatePredicate({ kind: "damage_taken", window: "this_turn", damageTypes: ["fire"] }, ctx)
      .value,
    false,
  );
});

test("negate inverts a real answer", () => {
  const ctx = { self: { actor: actorFake() } };
  assert.equal(evaluatePredicate({ kind: "target_type", types: ["undead"] }, ctx).value, false);
  assert.equal(
    evaluatePredicate({ kind: "target_type", types: ["undead"], negate: true }, ctx).value,
    true,
  );
});

test("negate does NOT rescue an unevaluable guard", () => {
  // The trap the whole fail-closed design turns on: if "could not tell" inverted to true, every
  // predicate we cannot answer would become a rule that fires.
  const verdict = evaluatePredicate(
    { kind: "custom", text: "GM discretion", negate: true },
    { self: { actor: actorFake() } },
  );
  assert.equal(verdict.evaluable, false);
  assert.equal(verdict.value, false);
});

test("a custom guard never passes, and says so", () => {
  const verdict = evaluatePredicate(
    { kind: "custom", text: "if the moon is full" },
    { self: { actor: actorFake() } },
  );
  assert.equal(verdict.evaluable, false);
  assert.match(String(verdict.reason), /moon is full/);
});

test("within_distance measures on the scene grid", () => {
  const here = { document: { x: 0, y: 0, width: 1, height: 1 } };
  const there = { document: { x: 300, y: 0, width: 1, height: 1 } }; // 3 squares = 15 ft
  const ctx = {
    self: { actor: actorFake(), token: here },
    target: { actor: actorFake({ uuid: "Actor.other" }), token: there },
  };
  assert.equal(
    evaluatePredicate(
      { kind: "within_distance", who: "target", of: "self", feet: { value: 20 } },
      ctx,
    ).value,
    true,
  );
  assert.equal(
    evaluatePredicate(
      { kind: "within_distance", who: "target", of: "self", feet: { value: 10 } },
      ctx,
    ).value,
    false,
  );
});

test("guards are ANDed and short-circuit on the first false", () => {
  const ctx = { self: { actor: actorFake() } };
  const result = conditionsMet(
    [
      { kind: "hp_fraction_at_most", fraction: 0.5 },
      { kind: "target_type", types: ["undead"] },
    ],
    ctx,
  );
  assert.deepEqual(result, { met: false });
});

test("an unevaluable guard is reported differently from a false one", () => {
  // A GM reading the capability sheet needs to tell "the rule correctly did not apply" from "this
  // rule can never apply and somebody has to look at it".
  const ctx = { self: { actor: actorFake() } };
  const result = conditionsMet([{ kind: "custom", text: "GM discretion" }], ctx);
  assert.equal(result.met, false);
  assert.match(String(result.blockedBy), /^custom:/);
});

test("no guards at all means the rule always fires on its trigger", () => {
  assert.deepEqual(conditionsMet([], { self: { actor: actorFake() } }), { met: true });
  assert.deepEqual(conditionsMet(undefined, { self: { actor: actorFake() } }), { met: true });
});

test("a predicate that throws is unevaluable rather than fatal", () => {
  const exploding = {
    get uuid(): string {
      throw new Error("prepared data is broken");
    },
  };
  const verdict = evaluatePredicate(
    { kind: "damage_taken", window: "ever" },
    { self: { actor: exploding } },
  );
  assert.equal(verdict.evaluable, false);
});
