import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  EFFECT_PARAMS,
  PREDICATE_PARAMS,
  exportable,
  isExecutable,
  isQuantity,
  isTerminal,
  normalizeCapability,
  normalizeDamageWindow,
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
  assert.deepEqual(validateCapability(negated), { ok: true, errors: [], warnings: [] });
});

test("a well-formed capability validates, and needs no repair", () => {
  assert.deepEqual(validateCapability(regeneration), { ok: true, errors: [], warnings: [] });
});

// ---- Repairing what a compiler hands back --------------------------------------------------------
//
// The census that motivated all of this: 576 of 693 compiled guards were filed under `conditions`,
// plural, and read by nothing. These tests pin the recovery AND the reporting, because the reporting is
// what turns the next rename from a two-release mystery into a line in the log.

test("guards filed under the plural are read, and the alias is reported", () => {
  const { capability, notes } = normalizeCapability({
    ...regeneration,
    rules: [
      {
        trigger: { event: "on_turn_start" },
        conditions: [
          {
            kind: "damage_taken",
            window: "since_last_turn",
            damageTypes: ["acid", "fire"],
            negate: true,
          },
        ],
        effect: { kind: "heal", amount: { value: 15 } },
        adjudication: "engine",
      },
    ],
  });
  const rule = capability.rules[0] as unknown as CapabilityRule & Record<string, unknown>;
  assert.equal(rule.condition?.length, 1, "the guard the Troll's regeneration turns on");
  assert.equal(rule.condition?.[0].negate, true, "and the negation that makes fire stop it");
  assert.equal(rule.conditions, undefined, "the alias is consumed, not left beside its replacement");
  assert.match(notes.join("\n"), /used "conditions" for its guards/);
});

test("both keys MERGE rather than one winning, because a dropped guard is the bug", () => {
  // ANDed, so merging can only make a rule fire less often. Preferring either one silently loses a
  // guard, which is precisely the failure mode this layer exists to end.
  const { capability } = normalizeCapability({
    ...regeneration,
    rules: [
      {
        trigger: { event: "on_turn_start" },
        condition: [{ kind: "hp_at_least", amount: { value: 1 } }],
        conditions: [{ kind: "in_combat" }],
        effect: { kind: "heal", amount: { value: 15 } },
        adjudication: "engine",
      },
    ],
  });
  assert.deepEqual(
    capability.rules[0].condition?.map((c) => c.kind),
    ["hp_at_least", "in_combat"],
  );
});

test("a free-text damage window is read, and says what it was read as", () => {
  // All three of these were live in one cache at once, for the same two rules.
  const { capability, notes } = normalizeCapability({
    ...regeneration,
    rules: [
      {
        trigger: { event: "on_turn_start" },
        condition: [
          { kind: "damage_taken", window: "since the start of its previous turn" },
          { kind: "damage_taken", window: "this turn" },
          { kind: "damage_taken", window: "This Round" },
        ],
        effect: { kind: "heal", amount: { value: 15 } },
        adjudication: "engine",
      },
    ],
  });
  assert.deepEqual(
    capability.rules[0].condition?.map((c) => c.window),
    ["since_last_turn", "this_turn", "this_round"],
  );
  assert.equal(notes.length, 3, "each repair is reported, not just the first");
});

test("an unreadable window is LEFT ALONE, so the guard fails closed and names itself", () => {
  // Guessing `ever` here would widen the guard: for Regeneration that is the difference between a troll
  // that stops burning and one that never regenerates again for the rest of the campaign.
  const { capability, notes } = normalizeCapability({
    ...regeneration,
    rules: [
      {
        trigger: { event: "on_turn_start" },
        condition: [{ kind: "damage_taken", window: "whenever the moon is full" }],
        effect: { kind: "heal", amount: { value: 15 } },
        adjudication: "engine",
      },
    ],
  });
  assert.equal(capability.rules[0].condition?.[0].window, "whenever the moon is full");
  assert.match(notes.join("\n"), /is not a known window; the guard will not evaluate/);
});

test("normalising twice changes nothing, which is what lets the cache and the validator both do it", () => {
  const once = normalizeCapability({
    ...regeneration,
    rules: [
      {
        trigger: { event: "on_turn_start" },
        conditions: [{ kind: "damage_taken", window: "this turn" }],
        effect: { kind: "heal", amount: { value: 15 } },
        adjudication: "engine",
      },
    ],
  });
  const twice = normalizeCapability(once.capability);
  assert.deepEqual(twice.capability, once.capability);
  assert.deepEqual(twice.notes, [], "and the second pass has nothing left to report");
});

test("an unrecognised rule key is WARNED about, never fatal", () => {
  // The guard that would have caught `conditions` on day one. Rejecting would throw away a descriptor
  // whose trigger, guards and effect are all fine, and spend a repair round to be told the same thing.
  const { ok, warnings } = validateCapability({
    ...regeneration,
    rules: [{ ...regeneration.rules[0], whenever: "the moon is full" }],
  });
  assert.equal(ok, true);
  assert.match(warnings.join("\n"), /unrecognised key "whenever"/);
});

test("normalizeDamageWindow is conservative about what it recognises", () => {
  assert.equal(normalizeDamageWindow("since_last_turn"), "since_last_turn");
  assert.equal(normalizeDamageWindow("SINCE-LAST-TURN"), "since_last_turn");
  // "since ... turn" must not be read as "this turn" just because it contains the word.
  assert.equal(normalizeDamageWindow("since the end of its last turn"), "since_last_turn");
  assert.equal(normalizeDamageWindow("during the current turn"), "this_turn");
  assert.equal(normalizeDamageWindow("at any point this round"), "this_round");
  assert.equal(normalizeDamageWindow("ever"), "ever");
  assert.equal(normalizeDamageWindow(""), null);
  assert.equal(normalizeDamageWindow(undefined), null);
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

test("a subject the resolver cannot name is an error, not a near miss", () => {
  // The live cache holds `who: "hit target"`, `"saving creature"`, `"owner"`, `"familiar"` and a
  // player character's proper name. Each of those resolves to nobody, so the guard refuses and takes
  // its rule with it — a descriptor that validated cleanly and can never fire on any turn.
  for (const key of ["who", "whom", "of"]) {
    const rule = {
      trigger: { event: "on_turn_start" },
      condition: [{ kind: "hp_at_least", amount: { value: 1 }, [key]: "the owner" }],
      effect: { kind: "heal", amount: { value: 15 } },
      adjudication: "engine",
    } as unknown as CapabilityRule;
    const { ok, errors } = validateCapability({ ...regeneration, rules: [rule] });
    assert.equal(ok, false, key);
    assert.match(errors.join("\n"), /the owner/, key);
  }
  const named = {
    trigger: { event: "on_turn_start" },
    condition: [{ kind: "hp_at_least", amount: { value: 1 }, who: "target" }],
    effect: { kind: "heal", amount: { value: 15 } },
    adjudication: "engine",
  } as unknown as CapabilityRule;
  assert.equal(validateCapability({ ...regeneration, rules: [named] }).ok, true);
});

test("a status this world cannot apply is an error, because lacks_status would fail OPEN", () => {
  const prior = (globalThis as Record<string, unknown>).CONFIG;
  (globalThis as Record<string, unknown>).CONFIG = {
    statusEffects: [{ id: "prone" }, { id: "poisoned" }],
  };
  try {
    const invented = (kind: string, extra: Record<string, unknown>): CapabilityRule =>
      ({
        trigger: { event: "on_turn_start" },
        condition: kind === "lacks_status" ? [{ kind, status: "sheathed in booming energy" }] : [],
        effect:
          kind === "lacks_status"
            ? { kind: "heal", amount: { value: 1 } }
            : { kind, status: "sheathed in booming energy", ...extra },
        adjudication: "engine",
      }) as unknown as CapabilityRule;

    // On the effect: a status nothing recognises is applied to nobody.
    assert.equal(
      validateCapability({ ...regeneration, rules: [invented("apply_status", {})] }).ok,
      false,
    );
    // On the guard, which is the unsafe direction: nobody HAS an invented status, so "lacks" is true
    // of everyone and the rule fires unconditionally with nothing reporting why.
    assert.equal(
      validateCapability({ ...regeneration, rules: [invented("lacks_status", {})] }).ok,
      false,
    );
    // A real one passes, and the reserved ones stay valid-but-inert so the sheet can show the reading.
    const prone = {
      trigger: { event: "on_turn_start" },
      condition: [],
      effect: { kind: "apply_status", status: "Prone" },
      adjudication: "engine",
    } as unknown as CapabilityRule;
    assert.equal(validateCapability({ ...regeneration, rules: [prone] }).ok, true);
    const dead = {
      trigger: { event: "on_turn_start" },
      condition: [],
      effect: { kind: "apply_status", status: "slain" },
      adjudication: "engine",
    } as unknown as CapabilityRule;
    assert.equal(validateCapability({ ...regeneration, rules: [dead] }).ok, true);
  } finally {
    (globalThis as Record<string, unknown>).CONFIG = prior;
  }
});

test("an unreadable status list is permission, or every census and test rejects everything", () => {
  assert.equal((globalThis as Record<string, unknown>).CONFIG, undefined);
  const rule = {
    trigger: { event: "on_turn_start" },
    condition: [],
    effect: { kind: "apply_status", status: "whatever the module registered" },
    adjudication: "engine",
  } as unknown as CapabilityRule;
  assert.equal(validateCapability({ ...regeneration, rules: [rule] }).ok, true);
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
  assert.deepEqual(validateCapability(limbs), { ok: true, errors: [], warnings: [] });
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
