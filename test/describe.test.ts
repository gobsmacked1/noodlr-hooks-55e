import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  describeCapability,
  describeEffect,
  describePredicate,
  describeQuantity,
  describeRule,
  describeUses,
} from "../src/capability/describe";
import type { Capability } from "../src/integration/capability";

// The Troll, because it is the scenario the whole compiler was designed against and it exercises the
// three shapes that are easy to render wrongly: a negated guard, a named quantity, and a summon.

test("a bare number keeps its units and a named quantity does not grow any", () => {
  assert.equal(describeQuantity({ value: 15, units: "hp" }), "15 hit points");
  assert.equal(describeQuantity({ named: "half_speed" }), "half its Speed");
  assert.equal(describeQuantity({ dice: "2d6 + 4", units: "hp" }), "2d6 + 4 hit points");
  assert.equal(describeQuantity(undefined), "");
});

test("upcasting is spelled out rather than dropped", () => {
  assert.equal(
    describeQuantity({ dice: "8d6", perLevelAbove: { level: 3, dice: "1d6" } }),
    "8d6 (+1d6 per level above 3)",
  );
});

test("negation wraps the clause instead of rewording it", () => {
  const guard = {
    kind: "damage_taken" as const,
    window: "since_last_turn",
    damageTypes: ["acid", "fire"],
  };
  assert.equal(describePredicate(guard), "it took acid or fire damage since its last turn");
  assert.equal(
    describePredicate({ ...guard, negate: true }),
    "not (it took acid or fire damage since its last turn)",
  );
});

test("an effect with no hand-written phrase still renders honestly", () => {
  // The point of the fallback: a rule the sheet cannot phrase must still be VISIBLE, because a line a
  // reviewer never sees is a line they cannot veto.
  const text = describeEffect({ kind: "grant_proficiency", skill: "stealth" } as any);
  assert.match(text, /grant proficiency/);
  assert.match(text, /stealth/);
});

test("a unit the sentence already says is not said twice", () => {
  assert.equal(
    describeEffect({ kind: "heal", amount: { value: 15, units: "hp" } } as any),
    "restore 15 hit points to itself",
  );
  assert.equal(
    describeEffect({
      kind: "damage",
      amount: { dice: "2d6", units: "hp" },
      damageType: "fire",
    } as any),
    "deal 2d6 fire damage",
  );
  // Only the implied unit is dropped. Feet in a damage phrase would be a genuine oddity worth seeing.
  assert.equal(
    describeEffect({
      kind: "displace",
      direction: "away",
      distance: { value: 10, units: "ft" },
    } as any),
    "push the target away 10 feet",
  );
});

test("uses read the way a stat block writes them", () => {
  assert.equal(describeUses({ max: 3, per: "long_rest" }), "3 per long rest");
  assert.equal(describeUses({ max: 1, per: "recharge", recharge: "5-6" }), "recharge 5-6");
  assert.equal(describeUses(undefined), "");
});

test("Regeneration renders as the sentence the stat block means", () => {
  const line = describeRule({
    trigger: { event: "on_turn_start" },
    condition: [
      { kind: "hp_at_least", amount: { value: 1 } },
      {
        kind: "damage_taken",
        window: "since_last_turn",
        damageTypes: ["acid", "fire"],
        negate: true,
      },
    ],
    effect: { kind: "heal", amount: { value: 15, units: "hp" } },
    adjudication: "engine",
  });
  assert.equal(
    line,
    "at the start of its turn, if it has at least 1 hit points and not (it took acid or fire damage " +
      "since its last turn) → restore 15 hit points to itself",
  );
});

test("a rule nothing executes is rendered and flagged, never hidden", () => {
  const capability: Capability = {
    id: "hash-troll",
    label: "Loathsome Limbs",
    status: "compiled",
    rules: [
      {
        trigger: { event: "on_damage_taken" },
        condition: [],
        effect: { kind: "summon_creature", creature: "Troll Limb", count: { value: 1 } },
        adjudication: "engine",
      },
      {
        trigger: { event: "on_turn_end" },
        condition: [],
        effect: { kind: "other", note: "the GM decides whether the severed limb crawls" },
        adjudication: "gm",
      },
    ],
  };

  const views = describeCapability(capability);
  assert.equal(views.length, 2);
  assert.equal(views[0].runs, true);
  assert.match(views[0].text, /summon 1 × Troll Limb/);
  // `gm` adjudication is never executable, whatever the effect says.
  assert.equal(views[1].runs, false);
  assert.match(views[1].text, /the GM decides/);
  // Nothing was passed to check against, so `refused` is "not asked" rather than "clear".
  assert.equal(views[0].refused, "");
});

test("a rule restating the item's own damage is badged on the sheet, not only refused at the table", () => {
  // The refusal is arithmetic: the dice are simply rolled twice, nothing throws, and nothing appears
  // in the log. So it has to be legible to whoever opens the compiled ability, or the guard reads as
  // the rule having quietly stopped working.
  const capability: Capability = {
    id: "hash-firebolt",
    label: "Fire Bolt",
    status: "compiled",
    rules: [
      {
        trigger: { event: "on_hit" },
        condition: [],
        effect: { kind: "damage", amount: { dice: "1d10" }, damageType: "fire", target: "target" },
        adjudication: "engine",
      },
      {
        trigger: { event: "on_hit" },
        condition: [],
        effect: { kind: "damage", amount: { dice: "2d6" }, damageType: "fire", target: "target" },
        adjudication: "engine",
      },
    ],
  };
  const item = {
    system: {
      activities: {
        abc: {
          name: "Fire Bolt",
          damage: { parts: [{ number: 1, denomination: 10, types: ["fire"] }] },
        },
      },
    },
  };

  const views = describeCapability(capability, item);
  assert.match(views[0].refused, /already rolls 1d10/);
  // The rider is untouched, which is the direction that must not break.
  assert.equal(views[1].refused, "");
});
