import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  EFFECT_PARAMS,
  PREDICATE_PARAMS,
  exportable,
  isExecutable,
  isQuantity,
  isTerminal,
  validateCapability,
} from "../src/integration/capability";
import type { Capability, CapabilityRule } from "../src/integration/capability";

/** The Troll's Regeneration, as the compiler is meant to produce it. */
const regeneration: Capability = {
  id: "hash-regeneration",
  label: "Regeneration",
  prose: "The troll regains 15 Hit Points at the start of each of its turns…",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_turn_start" },
      condition: [
        { kind: "hp_at_least", amount: { value: 1, units: "hp" } },
        {
          kind: "damage_taken",
          window: "since_last_turn",
          damageTypes: ["acid", "fire"],
          minimum: { value: 1 },
        },
      ],
      effect: { kind: "heal", amount: { value: 15, units: "hp" }, target: "self" },
      adjudication: "engine",
    },
  ],
};

test("negate is accepted on any predicate, and is not an invented parameter", () => {
  const negated = {
    id: "hash-negate",
    label: "Regeneration",
    status: "compiled" as const,
    rules: [
      {
        trigger: { event: "on_turn_start" as const },
        condition: [
          {
            kind: "damage_taken" as const,
            window: "since_last_turn",
            damageTypes: ["fire"],
            negate: true,
          },
        ],
        effect: { kind: "heal" as const, amount: { value: 15 } },
        adjudication: "engine" as const,
      },
    ],
  };
  assert.deepEqual(validateCapability(negated), { ok: true, errors: [] });
});

test("a well-formed capability validates", () => {
  assert.deepEqual(validateCapability(regeneration), { ok: true, errors: [] });
});

test("an invented parameter is rejected, which is the whole point of closing the level", () => {
  // The corpus produced 1,367 distinct parameter keys for one effect kind by leaving this open.
  const { errors, ok } = validateCapability({
    ...regeneration,
    rules: [
      {
        ...regeneration.rules[0],
        effect: { kind: "heal", amount: { value: 15 }, healingFlavour: "gruesome regrowth" },
      },
    ],
  });
  assert.equal(ok, false);
  assert.match(errors.join("\n"), /unknown parameter "healingFlavour"/);
});

test("a missing required parameter is named, not merely counted", () => {
  const { ok, errors } = validateCapability({
    ...regeneration,
    rules: [{ ...regeneration.rules[0], effect: { kind: "apply_status" } }],
  });
  assert.equal(ok, false);
  assert.match(errors.join("\n"), /missing required parameter "status"/);
});

test("every problem is reported at once so a repair prompt is one round trip", () => {
  const { errors } = validateCapability({
    id: "",
    label: "",
    status: "compiled",
    rules: [
      {
        trigger: { event: "on_fifth_tuesday" },
        condition: [],
        effect: { kind: "explode" },
        adjudication: "engine",
      },
    ],
  });
  assert.ok(
    errors.length >= 4,
    `expected several errors, got ${errors.length}: ${errors.join("; ")}`,
  );
});

test("vocabularies are closed on all three axes", () => {
  const bad = (rule: Partial<CapabilityRule>) =>
    validateCapability({
      ...regeneration,
      rules: [{ ...regeneration.rules[0], ...rule }],
    }).errors.join("\n");

  assert.match(
    bad({ trigger: { event: "on_vibes" as never } }),
    /trigger\.event .* not in the closed vocabulary/,
  );
  assert.match(
    bad({ effect: { kind: "vibe" as never } }),
    /effect\.kind .* not in the closed vocabulary/,
  );
  assert.match(
    bad({ condition: [{ kind: "the_dm_says_so" as never }] }),
    /condition\[0\]\.kind .* not in the closed vocabulary/,
  );
});

test("a quantity may be a number, a die roll or something only the actor knows", () => {
  assert.ok(isQuantity({ value: 15, units: "hp" }));
  assert.ok(isQuantity({ dice: "2d6 + 4" }));
  assert.ok(isQuantity({ named: "half_speed", units: "ft" }));
  // Tactical Charge mined as `distance: "half Speed"` and Watery Rebuke as `distance: 30`; a bare
  // string is exactly the shape that has to stop being accepted.
  assert.equal(isQuantity("half Speed"), false);
  assert.equal(isQuantity(30), false);
  assert.equal(isQuantity({ units: "ft" }), false);
  assert.equal(isQuantity({ named: "vibes" }), false);
});

test("a quantity-typed parameter rejects a bare number", () => {
  const { ok, errors } = validateCapability({
    ...regeneration,
    rules: [{ ...regeneration.rules[0], effect: { kind: "heal", amount: 15 } }],
  });
  assert.equal(ok, false);
  assert.match(errors.join("\n"), /must be a quantity/);
});

test("an unevaluable guard makes the rule inert rather than firing unguarded", () => {
  const guarded: CapabilityRule = {
    trigger: { event: "on_turn_start" },
    condition: [{ kind: "custom", text: "the troll is within sight of its lair" }],
    effect: { kind: "heal", amount: { value: 15 } },
    adjudication: "engine",
  };
  // Valid — the model is allowed to say it could not express a guard.
  assert.equal(validateCapability({ ...regeneration, rules: [guarded] }).ok, true);
  // But it must not run. A monster that regenerates when it should not is invisible at the table.
  assert.equal(isExecutable(guarded), false);
  assert.equal(isExecutable(regeneration.rules[0]), true);
});

test("a compiled rule may not kill, whatever it read", () => {
  // The first smoke test's second surprise: the Troll's own prose says it dies only if it ends its
  // turn with 0 hit points and took fire or acid, and the compiler read the restriction as the
  // instruction. Whether that particular compile was repairable is beside the point — a descriptor
  // that removes a creature from play is the one outcome nobody can undo from a chat card, and the
  // dying layer already owns it. So the vocabulary keeps the word and the executor refuses it.
  for (const status of ["dead", "Defeated", "SLAIN"]) {
    const rule: CapabilityRule = {
      trigger: { event: "on_turn_start" },
      condition: [],
      effect: { kind: "apply_status", status },
      adjudication: "engine",
    };
    assert.equal(validateCapability({ ...regeneration, rules: [rule] }).ok, true, status);
    assert.equal(isTerminal(rule), true, status);
    assert.equal(isExecutable(rule), false, status);
  }
  const prone: CapabilityRule = {
    trigger: { event: "on_turn_start" },
    condition: [],
    effect: { kind: "apply_status", status: "prone" },
    adjudication: "engine",
  };
  assert.equal(isTerminal(prone), false);
  assert.equal(isExecutable(prone), true);
});

test("an effect kind with no executor is valid and inert", () => {
  const rule: CapabilityRule = {
    trigger: { event: "always" },
    condition: [],
    effect: { kind: "grant_advantage", rollType: "attack" },
    adjudication: "engine",
  };
  assert.equal(validateCapability({ ...regeneration, rules: [rule] }).ok, true);
  assert.equal(isExecutable(rule), false);
});

test("narration and gm rules never execute here", () => {
  const narration: CapabilityRule = {
    trigger: { event: "on_activity_use" },
    condition: [],
    effect: { kind: "voice_entity", speaker: "the corpse" },
    adjudication: "narration",
  };
  assert.equal(validateCapability({ ...regeneration, rules: [narration] }).ok, true);
  assert.equal(isExecutable(narration), false);
  // Miscategorising it as engine work is a contract error, not a preference.
  assert.match(
    validateCapability({
      ...regeneration,
      rules: [{ ...narration, adjudication: "engine" }],
    }).errors.join("\n"),
    /always adjudication "narration"/,
  );
});

test("a gm rule must say what the human has to decide", () => {
  const rule: CapabilityRule = {
    trigger: { event: "always" },
    condition: [],
    effect: { kind: "other", note: "the DM decides" },
    adjudication: "gm",
  };
  assert.match(
    validateCapability({ ...regeneration, rules: [rule] }).errors.join("\n"),
    /requires a note/,
  );
  assert.equal(
    validateCapability({ ...regeneration, rules: [{ ...rule, note: "Rule the fall." }] }).ok,
    true,
  );
});

test("the escape hatch is not free — `other` must carry a note", () => {
  // `other` took 63% of the corpus's first run precisely because reaching for it cost nothing.
  const { errors } = validateCapability({
    ...regeneration,
    rules: [{ ...regeneration.rules[0], effect: { kind: "other" } }],
  });
  assert.match(errors.join("\n"), /missing required parameter "note"/);
});

test("uses are bounded and their period is closed", () => {
  const withUses = (uses: unknown) =>
    validateCapability({
      ...regeneration,
      rules: [{ ...regeneration.rules[0], uses }],
    }).errors.join("\n");

  assert.equal(withUses({ max: 4, per: "day" }), "");
  assert.match(withUses({ max: 0, per: "day" }), /uses\.max must be a positive number/);
  assert.match(withUses({ max: 4, per: "fortnight" }), /uses\.per .* not in the closed vocabulary/);
});

test("summoning has a home, with the count and placement the Troll needs", () => {
  const limbs: Capability = {
    id: "hash-loathsome-limbs",
    label: "Loathsome Limbs",
    status: "compiled",
    rules: [
      {
        trigger: { event: "on_turn_end" },
        condition: [
          { kind: "hp_fraction_at_most", fraction: 0.5 },
          {
            kind: "damage_taken",
            window: "this_turn",
            damageTypes: ["slashing"],
            minimum: { value: 15 },
          },
        ],
        effect: {
          kind: "summon_creature",
          creature: "Troll Limb",
          count: { value: 1 },
          placement: "self_space",
          disposition: "hostile",
          initiative: "after_summoner",
        },
        uses: { max: 4, per: "day" },
        adjudication: "engine",
      },
    ],
  };
  assert.deepEqual(validateCapability(limbs), { ok: true, errors: [] });
  assert.equal(isExecutable(limbs.rules[0]), true);
});

test("export strips the prose and nothing else", () => {
  const shared = exportable(regeneration);
  assert.equal(shared.prose, undefined);
  assert.equal(shared.label, "Regeneration");
  assert.deepEqual(shared.rules, regeneration.rules);
  // The original is untouched; the sheet still has something to show the GM.
  assert.ok(regeneration.prose);
});

test("every vocabulary entry has a parameter spec, so nothing validates by accident", () => {
  for (const [kind, spec] of Object.entries(EFFECT_PARAMS)) {
    assert.ok(Array.isArray(spec.required), `${kind} has no required list`);
    assert.equal(typeof spec.executable, "boolean", `${kind} does not say whether it runs`);
  }
  for (const [kind, spec] of Object.entries(PREDICATE_PARAMS)) {
    assert.ok(Array.isArray(spec.required), `${kind} has no required list`);
    assert.equal(typeof spec.executable, "boolean", `${kind} does not say whether it runs`);
  }
});
