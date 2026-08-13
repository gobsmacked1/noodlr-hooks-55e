// What a creature can do, in a form this module can execute.
//
// A "capability" is one feature off one sheet — Regeneration, Loathsome Limbs, Pack Tactics —
// compiled from its own prose into rules a deterministic executor can run. The compiling is done once
// by a model in `noodlr` and cached; nothing here ever calls one, and everything here runs
// synchronously during a turn.
//
// WHY THIS SHAPE. `noodlr-rules-corpus` mined 75,487 rule atoms out of nine books and proved two
// things by measurement (`scripts/probe-vocabulary.mjs`). The good news: the model reads these rules
// correctly. Loathsome Limbs came back with `on_turn_end` and the two guards that matter, "the
// creature is Bloodied" and "took 15 or more Slashing damage during that turn". The bad news: the
// mining vocabulary was closed at the KIND level and wide open at the PARAMETER level, so **0 of
// 73,546 conditions were structured** and `other` alone carried **1,367 distinct parameter keys**.
// Comprehension was never the problem; the output contract was. So this schema closes both levels:
// every effect kind states exactly which parameters it takes, and conditions are predicates rather
// than sentences.
//
// The corpus is what says WHICH parameters matter, because the long tails are noise and the heads are
// sharp — `status` appears on 3,249 of 3,253 `apply_status` atoms. Frequencies below are from that
// run and are the reason each field is here.
//
// THE SAFE DIRECTION. Every escape hatch in this file fails CLOSED. An effect kind of `other`, or a
// `custom` predicate, means the model understood a rule it could not express — and a guard that
// cannot be evaluated must prevent the rule from firing, never be skipped. A trait that silently
// heals when it should not is undetectable at the table; one that never fires shows up on the
// capability sheet as needing a human, which the GM can fix in a click.

/** Bumped when a compiled descriptor changes shape in a way an older cache could not be read as. */
export const CAPABILITY_SCHEMA = 1;

/**
 * When a rule fires. Closed, and named for the moment rather than for the Foundry hook, so a future
 * `noodlr-hooks-pf2e` reuses the list against different plumbing.
 *
 * Every entry maps to a hook this module already registers. An event with no hook behind it is a rule
 * nobody can implement, which is exactly why the list is short.
 */
export const TRIGGER_EVENTS = [
  "on_hit",
  "on_miss",
  "on_attack_roll",
  "on_damage_taken",
  "on_save_failed",
  "on_save_succeeded",
  "on_activity_use",
  "on_turn_start",
  "on_turn_end",
  "on_move",
  "on_enter_area",
  "on_leave_reach",
  "on_condition_applied",
  "on_zero_hp",
  "on_short_rest",
  "on_long_rest",
  "always",
] as const;

export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

/**
 * The subset of {@link TRIGGER_EVENTS} that `registerCapabilityExecutor()` attaches a real hook to.
 *
 * The compiler is deliberately offered all seventeen: "the troll regenerates at the start of its turn"
 * and "the cloak recharges on a long rest" are both true readings of the prose, and a vocabulary that
 * hid the events this build cannot hear would teach the model to mis-file rules rather than to skip
 * them. This list is the other half of that bargain — a rule whose event never fires is badged inert
 * instead of being shown as live.
 *
 * Wiring a new hook in `capability/executor.ts` means adding its event here in the same change, or the
 * sheet will go on calling a working rule dead.
 */
export const WIRED_TRIGGERS: readonly TriggerEvent[] = [
  "on_damage_taken",
  "on_zero_hp",
  "on_turn_start",
  "on_turn_end",
  "on_activity_use",
];

/** Units a quantity can be in. `hp` and `temp_hp` are separate because they are spent differently. */
export const UNITS = [
  "ft",
  "mi",
  "m",
  "km",
  "squares",
  "hp",
  "temp_hp",
  "rounds",
  "turns",
  "minutes",
  "hours",
  "days",
  "uses",
  "level",
] as const;

export type Unit = (typeof UNITS)[number];

/**
 * Quantities the executor resolves against the actor rather than reading off the descriptor.
 *
 * Needed because the books state them that way and the corpus recorded them that way: Tactical Charge
 * mined as `distance: "half Speed"` while Watery Rebuke mined as `distance: 30`. A schema that only
 * admits numbers forces the compiler to guess a number for the first case, and it will guess wrong
 * for every creature that is not the one it was reading about.
 */
export const NAMED_QUANTITIES = [
  "speed",
  "half_speed",
  "remaining_movement",
  "reach",
  "proficiency_bonus",
  "spell_level",
  "character_level",
  "challenge_rating",
] as const;

export type NamedQuantity = (typeof NAMED_QUANTITIES)[number];

/**
 * A number, a die roll, or something only the actor knows. At least one of the three must be present.
 *
 * `dice` is evaluated by a real Foundry `Roll` at execution time, never by the model — the same rule
 * that has governed noodlr since its first release.
 */
export interface Quantity {
  value?: number;
  dice?: string;
  named?: NamedQuantity;
  units?: Unit;
  /** Added per spell-slot level above the base, for upcast scaling. */
  perLevelAbove?: { level: number; value?: number; dice?: string };
}

/**
 * What a rule does. Closed.
 *
 * These are the corpus's 35 kinds plus `summon_creature`, which the probe confirmed was missing: the
 * largest bucket for summon-like atoms was `UNCLASSIFIED / other` at 289, and the Troll's Loathsome
 * Limbs mined as `other` with the note "create it as a Troll Limb" — understood perfectly, nowhere to
 * go.
 */
export const EFFECT_KINDS = [
  "damage",
  "heal",
  "displace",
  "teleport",
  "apply_status",
  "remove_status",
  "grant_advantage",
  "impose_disadvantage",
  "auto_fail",
  "auto_succeed",
  "force_critical",
  "modify_save",
  "substitute_ability",
  "modify_speed",
  "modify_action_cost",
  "extra_attack",
  "take_action",
  "replace_action",
  "restrict_action",
  "initiative_position",
  "grant_sense",
  "negate_sense",
  "resist_damage",
  "grant_capability",
  "grant_proficiency",
  "spend_resource",
  "recover_resource",
  "end_effect",
  "create_area",
  "summon_creature",
  "object_statistics",
  "transform",
  "require_prerequisite",
  "reveal_information",
  "voice_entity",
  "other",
] as const;

export type EffectKind = (typeof EFFECT_KINDS)[number];

interface ParamSpec {
  /** Absent means the effect is malformed and the whole capability is rejected. */
  required: readonly string[];
  optional: readonly string[];
  /** Keys whose value must be a `Quantity` rather than a bare string. */
  quantities?: readonly string[];
  /** False when no executor exists yet: the descriptor is valid, it is simply not run. */
  executable: boolean;
}

/**
 * The closed parameter set for each kind, and whether anything runs it yet.
 *
 * `executable: false` is not a defect — it means the compiler may legitimately produce this and the
 * capability sheet will show it as understood-but-inert. That is strictly better than the model
 * mangling the rule into a shape that does run, and it turns the executor's coverage into a number we
 * can watch go up.
 */
export const EFFECT_PARAMS: Record<EffectKind, ParamSpec> = {
  // The corpus head: damageType(3755), dice(2851), amount(1973), multiplier(371).
  damage: {
    required: ["amount"],
    optional: ["damageType", "multiplier", "target", "onSave"],
    quantities: ["amount"],
    executable: true,
  },
  // Mined three different ways off one trait ({amount,units} / {amount,target} / {formula}), which is
  // the parameter-bag problem in a single creature. One key, always a Quantity.
  heal: {
    required: ["amount"],
    optional: ["target", "temporary"],
    quantities: ["amount"],
    executable: true,
  },
  displace: {
    required: ["direction", "distance"],
    optional: ["target", "maxSize", "afterMoving"],
    quantities: ["distance"],
    executable: true,
  },
  teleport: {
    required: ["destination"],
    optional: ["target", "maxDistance"],
    quantities: ["maxDistance"],
    executable: false,
  },

  // status(3249) of 3253 atoms. The rest of the 110 keys mined for this kind are noise.
  apply_status: {
    required: ["status"],
    optional: ["target", "duration", "dc", "ability", "escapeDc"],
    quantities: ["duration"],
    executable: true,
  },
  remove_status: { required: ["status"], optional: ["target"], executable: true },

  grant_advantage: {
    required: ["rollType"],
    optional: ["target", "ability", "skill", "against"],
    executable: false,
  },
  impose_disadvantage: {
    required: ["rollType"],
    optional: ["target", "ability", "skill", "against"],
    executable: false,
  },
  auto_fail: { required: ["rollType"], optional: ["target", "ability"], executable: false },
  auto_succeed: { required: ["rollType"], optional: ["target", "ability"], executable: false },
  force_critical: { required: [], optional: ["target", "withinFeet"], executable: false },
  modify_save: {
    required: ["amount"],
    optional: ["ability", "target", "against"],
    quantities: ["amount"],
    executable: false,
  },
  substitute_ability: { required: ["use", "insteadOf"], optional: ["rollType"], executable: false },

  modify_speed: {
    required: [],
    optional: ["amount", "multiplier", "movementType", "setTo", "costMultiplier"],
    quantities: ["amount", "setTo"],
    executable: false,
  },
  // action(2472), cost(1897).
  modify_action_cost: {
    required: ["action"],
    optional: ["cost", "activity", "resource"],
    executable: false,
  },
  extra_attack: { required: ["attacks"], optional: ["activity"], executable: true },
  take_action: {
    required: ["action"],
    optional: ["activity", "target", "choices"],
    executable: false,
  },
  replace_action: {
    required: ["replaces"],
    optional: ["replacement", "options"],
    executable: false,
  },
  // action(1836), restriction(1143).
  restrict_action: { required: ["action"], optional: ["restriction", "limit"], executable: false },
  initiative_position: { required: ["position"], optional: ["relativeTo"], executable: true },

  grant_sense: {
    required: ["sense"],
    optional: ["range", "target"],
    quantities: ["range"],
    executable: false,
  },
  negate_sense: { required: ["sense"], optional: ["target", "blockedBy"], executable: false },
  resist_damage: {
    required: ["damageTypes", "treatment"],
    optional: ["target", "exceptFrom"],
    executable: false,
  },
  // capability(6039) of 6627 — the head is sharp even where the tail is 560 keys wide.
  grant_capability: {
    required: ["capability"],
    optional: ["target", "amount", "frequency"],
    quantities: ["amount"],
    executable: false,
  },
  grant_proficiency: {
    required: ["proficiency"],
    optional: ["target", "expertise"],
    executable: false,
  },

  // resource(1983), amount(1758).
  spend_resource: {
    required: ["resource", "amount"],
    optional: ["maximum"],
    quantities: ["amount"],
    executable: true,
  },
  recover_resource: {
    required: ["resource", "amount"],
    optional: ["maximum"],
    quantities: ["amount"],
    executable: true,
  },
  end_effect: { required: ["effect"], optional: ["target", "when"], executable: false },

  create_area: {
    required: ["areaType", "size"],
    optional: ["properties", "duration", "origin"],
    quantities: ["size", "duration"],
    executable: false,
  },
  // The kind the probe proved was missing. Loathsome Limbs is the worked example: up to four of them,
  // placed in the parent's own space, acting immediately after the parent's turn.
  summon_creature: {
    required: ["creature"],
    optional: ["count", "placement", "disposition", "initiative", "duration", "inheritsOwner"],
    quantities: ["count", "duration"],
    executable: true,
  },
  object_statistics: {
    required: [],
    optional: ["ac", "hp", "size", "immunities"],
    quantities: ["hp"],
    executable: false,
  },
  transform: {
    required: ["form"],
    optional: ["target", "duration", "retains"],
    quantities: ["duration"],
    executable: false,
  },

  // A gate expressed as an effect. The executor treats it as a no-op: the compiler should have put it
  // in `condition`, and saying so on the sheet is more useful than pretending it did something.
  require_prerequisite: { required: ["requirement"], optional: [], executable: false },

  reveal_information: {
    required: ["information"],
    optional: ["dc", "skill", "ability"],
    executable: false,
  },
  // Always adjudication `narration`; routed to noodlr's behavior contract, never run here.
  voice_entity: { required: ["speaker"], optional: ["constraints"], executable: false },

  // The escape hatch. Requires a note, exactly as the corpus schema learned to require one after
  // `other` took 63% of the first run purely because reaching for it was free.
  other: { required: ["note"], optional: [], executable: false },
};

/**
 * Guards on a rule, ANDed. Closed, because the corpus proved the alternative.
 *
 * Every predicate below was derived from the conditions that actually recur across 73,546 mined
 * entries rather than from imagination: `target is a creature` (434), `target is within range` (260),
 * `target is Large or smaller` (148), `spell slot level is above N` (377 across three variants),
 * `has at least 1 Hit Point`, and `the creature has not taken this damage during the current turn`
 * (96).
 */
export const PREDICATES = [
  "has_status",
  "lacks_status",
  "hp_at_least",
  "hp_at_most",
  "hp_fraction_at_most",
  "damage_taken",
  "target_type",
  "size_at_most",
  "size_at_least",
  "within_distance",
  "can_see",
  "own_turn",
  "in_combat",
  "spell_level_at_least",
  "has_capability",
  "custom",
] as const;

export type PredicateKind = (typeof PREDICATES)[number];

export const PREDICATE_PARAMS: Record<PredicateKind, ParamSpec> = {
  has_status: { required: ["status"], optional: ["who"], executable: true },
  lacks_status: { required: ["status"], optional: ["who"], executable: true },
  hp_at_least: {
    required: ["amount"],
    optional: ["who"],
    quantities: ["amount"],
    executable: true,
  },
  hp_at_most: { required: ["amount"], optional: ["who"], quantities: ["amount"], executable: true },
  // Bloodied is `hp_fraction_at_most: 0.5`. Named that way because "bloodied" is a 2024 word and this
  // vocabulary has to survive a system that does not use it.
  hp_fraction_at_most: { required: ["fraction"], optional: ["who"], executable: true },
  // The Loathsome Limbs predicate: types + a floor + a window. `window` is what makes "took 15
  // Slashing during that turn" and "has taken no Acid since its last turn" the same predicate.
  damage_taken: {
    required: ["window"],
    optional: ["damageTypes", "minimum", "who"],
    quantities: ["minimum"],
    executable: true,
  },
  target_type: { required: ["types"], optional: ["who"], executable: true },
  size_at_most: { required: ["size"], optional: ["who"], executable: true },
  size_at_least: { required: ["size"], optional: ["who"], executable: true },
  within_distance: {
    required: ["feet"],
    optional: ["of", "who"],
    quantities: ["feet"],
    executable: true,
  },
  can_see: { required: [], optional: ["who", "whom"], executable: true },
  own_turn: { required: [], optional: ["who"], executable: true },
  in_combat: { required: [], optional: [], executable: true },
  spell_level_at_least: { required: ["level"], optional: [], executable: false },
  has_capability: { required: ["capability"], optional: ["who"], executable: false },
  // Fails closed. A rule guarded by something we cannot evaluate does not fire, and says why on the
  // capability sheet. The opposite choice - ignore the guard and fire anyway - produces a monster
  // that regenerates when it should not, which nobody at the table can see is wrong.
  custom: { required: ["text"], optional: [], executable: false },
};

/** Where a limited use replenishes. `recharge` is the d6 kind and carries `recharge: "5-6"`. */
export const USE_PERIODS = [
  "turn",
  "round",
  "encounter",
  "day",
  "short_rest",
  "long_rest",
  "recharge",
] as const;

export type UsePeriod = (typeof USE_PERIODS)[number];

export interface Predicate {
  kind: PredicateKind;
  /**
   * Invert the answer. One flag rather than a mirrored half-vocabulary.
   *
   * Needed by the first real descriptor written against this schema: the Troll regenerates "unless it
   * took Acid or Fire damage since its last turn", and `damage_taken` can only say that it did. The
   * alternative was a `damage_not_taken` kind, and then a negated twin of every other predicate as the
   * next stat block asked for one.
   *
   * **Negation does not rescue an unevaluable guard.** "Could not tell" inverts to "could not tell",
   * never to true — otherwise every predicate we cannot answer becomes a rule that fires, which is the
   * exact failure mode this whole file is built to avoid.
   */
  negate?: boolean;
  [param: string]: unknown;
}

export interface Effect {
  kind: EffectKind;
  [param: string]: unknown;
}

export interface CapabilityRule {
  trigger: { event: TriggerEvent; [param: string]: unknown };
  /** ANDed. An empty array means the rule always fires on its trigger. */
  condition: Predicate[];
  effect: Effect;
  uses?: { max: number; per: UsePeriod; recharge?: string };
  /**
   * Who carries this out. `engine` runs here; `narration` is handed to noodlr as a `SPEAK_AS`
   * behavior request; `gm` is shown on the sheet and never acted on automatically.
   */
  adjudication: "engine" | "narration" | "gm";
  /** Free text for `gm` and for anything a reviewer should see. Never parsed. */
  note?: string;
}

export interface Capability {
  /** The prose hash. The cache key, and the reason one wording compiled once serves 270 creatures. */
  id: string;
  label: string;
  /**
   * The prose this was compiled from. Kept locally because it is the operator's own content on their
   * own disk and the sheet has to show what a rule came from; STRIPPED on export, which is the same
   * boundary `assertNoQuotes` enforces at the other end of the corpus pipeline.
   */
  prose?: string;
  rules: CapabilityRule[];
  compiledBy?: { model: string; at: number; schema: number };
  /**
   * `locked` survives recompilation. Once a GM has corrected a bad compile, a model upgrade or a cache
   * miss must never quietly undo that work.
   */
  status: "compiled" | "edited" | "locked" | "rejected";
  /**
   * When a human last rewrote the rules by hand.
   *
   * Separate from `status` because status is a single slot and locking needs it: without this, a GM
   * who edits, locks, then unlocks comes back to a descriptor labelled "compiled" that no model ever
   * wrote. Editing deliberately does NOT protect a descriptor — locking is what does that — so this is
   * a truthful label rather than a second lock.
   */
  editedAt?: number;
}

function checkParams(
  spec: ParamSpec | undefined,
  node: Record<string, unknown>,
  label: string,
  errors: string[],
): void {
  if (!spec) return;
  for (const key of spec.required) {
    const value = node[key];
    if (value === undefined || value === null || value === "") {
      errors.push(`${label} is missing required parameter "${key}"`);
    }
  }
  const allowed = new Set<string>([
    ...spec.required,
    ...spec.optional,
    "kind",
    "event",
    "note",
    "negate",
  ]);
  for (const key of Object.keys(node)) {
    // The whole point of closing the parameter level: an unknown key is a model inventing a field,
    // which is how one effect kind ended up with 1,367 of them.
    if (!allowed.has(key)) errors.push(`${label} has unknown parameter "${key}"`);
  }
  for (const key of spec.quantities ?? []) {
    if (node[key] !== undefined && !isQuantity(node[key])) {
      errors.push(`${label} parameter "${key}" must be a quantity {value|dice|named}`);
    }
  }
}

export function isQuantity(value: unknown): value is Quantity {
  if (typeof value !== "object" || value === null) return false;
  const q = value as Quantity;
  const hasValue = typeof q.value === "number" && Number.isFinite(q.value);
  const hasDice = typeof q.dice === "string" && q.dice.trim() !== "";
  const hasNamed =
    typeof q.named === "string" && (NAMED_QUANTITIES as readonly string[]).includes(q.named);
  if (!hasValue && !hasDice && !hasNamed) return false;
  if (q.units !== undefined && !(UNITS as readonly string[]).includes(q.units)) return false;
  return true;
}

/**
 * Structurally validate one compiled capability. Returns every problem rather than the first, so the
 * compiler can repair them all in one round trip instead of N.
 *
 * Deliberately says nothing about whether the rule is a FAITHFUL reading of the prose. Nothing here
 * can know that; the capability sheet and the corpus regression harness are what answer it.
 */
export function validateCapability(input: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const cap = input as Capability;

  if (!cap || typeof cap !== "object")
    return { ok: false, errors: ["capability is not an object"] };
  if (typeof cap.id !== "string" || cap.id.trim() === "")
    errors.push("id must be a non-empty string");
  if (typeof cap.label !== "string" || cap.label.trim() === "") {
    errors.push("label must be a non-empty string");
  }
  if (!Array.isArray(cap.rules)) {
    errors.push("rules must be an array");
    return { ok: false, errors };
  }
  // A capability with no rules is a compile that produced nothing. That is a legitimate answer for a
  // purely flavourful trait, but it must be stated by returning an empty array deliberately rather
  // than arrived at by a malformed one, so it is allowed and simply never fires.

  cap.rules.forEach((rule, index) => {
    const at = `rules[${index}]`;
    if (!rule || typeof rule !== "object") {
      errors.push(`${at} is not an object`);
      return;
    }
    if (!(TRIGGER_EVENTS as readonly string[]).includes(rule.trigger?.event)) {
      errors.push(`${at}.trigger.event "${rule.trigger?.event}" is not in the closed vocabulary`);
    }
    if (!(EFFECT_KINDS as readonly string[]).includes(rule.effect?.kind)) {
      errors.push(`${at}.effect.kind "${rule.effect?.kind}" is not in the closed vocabulary`);
    } else {
      checkParams(EFFECT_PARAMS[rule.effect.kind], rule.effect, `${at}.effect`, errors);
    }

    if (rule.condition !== undefined && !Array.isArray(rule.condition)) {
      errors.push(`${at}.condition must be an array`);
    } else {
      (rule.condition ?? []).forEach((predicate, pIndex) => {
        const pAt = `${at}.condition[${pIndex}]`;
        if (!(PREDICATES as readonly string[]).includes(predicate?.kind)) {
          errors.push(`${pAt}.kind "${predicate?.kind}" is not in the closed vocabulary`);
          return;
        }
        checkParams(PREDICATE_PARAMS[predicate.kind], predicate, pAt, errors);
      });
    }

    if (rule.uses !== undefined) {
      if (!Number.isFinite(rule.uses.max) || rule.uses.max <= 0) {
        errors.push(`${at}.uses.max must be a positive number`);
      }
      if (!(USE_PERIODS as readonly string[]).includes(rule.uses.per)) {
        errors.push(`${at}.uses.per "${rule.uses.per}" is not in the closed vocabulary`);
      }
    }

    if (!["engine", "narration", "gm"].includes(rule.adjudication)) {
      errors.push(`${at}.adjudication must be engine, narration or gm`);
    }
    if (rule.adjudication === "gm" && !String(rule.note ?? "").trim()) {
      errors.push(`${at} adjudication "gm" requires a note saying what the human has to decide`);
    }
    if (rule.effect?.kind === "voice_entity" && rule.adjudication !== "narration") {
      errors.push(`${at} effect "voice_entity" is always adjudication "narration"`);
    }
  });

  return { ok: errors.length === 0, errors };
}

/**
 * The whole closed vocabulary, as plain JSON, to be handed to whoever compiles for us.
 *
 * **The compiler must not import this file, and must not hardcode any of it.** `noodlr` is game-system
 * agnostic on purpose; a future `noodlr-hooks-pf2e` will fire the same `noodlrHooks.compile` hook with
 * a vocabulary of its own, and a compiler that knew 5e's list would quietly validate the wrong one. So
 * the contract carries the rules of the language along with the request, and the listener builds both
 * its prompt and its validator out of what it was handed.
 *
 * `executable` deliberately travels too: a compiler that knows which kinds run can prefer one that
 * does when a rule could honestly be expressed either way.
 */
export function capabilityVocabulary(): Record<string, unknown> {
  const params = (table: Record<string, ParamSpec>) =>
    Object.fromEntries(
      Object.entries(table).map(([kind, spec]) => [
        kind,
        {
          required: [...spec.required],
          optional: [...spec.optional],
          quantities: [...(spec.quantities ?? [])],
          executable: spec.executable,
        },
      ]),
    );
  return {
    schema: CAPABILITY_SCHEMA,
    triggerEvents: [...TRIGGER_EVENTS],
    effects: params(EFFECT_PARAMS),
    predicates: params(PREDICATE_PARAMS),
    usePeriods: [...USE_PERIODS],
    units: [...UNITS],
    namedQuantities: [...NAMED_QUANTITIES],
    adjudication: ["engine", "narration", "gm"],
  };
}

/** Whether anything in this build actually runs the rule, for the sheet's inert/active badge. */
export function isExecutable(rule: CapabilityRule): boolean {
  if (rule.adjudication !== "engine") return false;
  if (!WIRED_TRIGGERS.includes(rule.trigger?.event as TriggerEvent)) return false;
  if (!EFFECT_PARAMS[rule.effect?.kind as EffectKind]?.executable) return false;
  // One unevaluable guard is enough to stop the rule: see the fail-closed note at the top.
  return (rule.condition ?? []).every((p) => PREDICATE_PARAMS[p.kind]?.executable);
}

/**
 * Effect kinds that state a permanent property, which `capability/standing.ts` answers by query.
 *
 * Kept here beside `WIRED_TRIGGERS` because the two together are what the sheet's badge means, and a
 * list in one file contradicting a badge in another is precisely the failure the `WIRED_TRIGGERS` note
 * above was written about. `standing.ts` imports this rather than keeping a second copy.
 */
export const STANDING_EFFECTS: readonly EffectKind[] = [
  "grant_sense",
  "negate_sense",
  "resist_damage",
  "grant_capability",
  "grant_proficiency",
  "modify_speed",
  "extra_attack",
  "substitute_ability",
  "grant_advantage",
  "impose_disadvantage",
];

/**
 * Is this rule a standing fact rather than something that fires?
 *
 * `always` is not in `WIRED_TRIGGERS` and must not be: there is no hook for "permanently true", and
 * adding one would mean inventing a moment at which a fact happens. But 35.6% of the corpus's atoms
 * carry it, so treating every one of them as inert told the operator that a third of what they paid to
 * compile does nothing. It is read instead — see `capability/standing.ts` for who reads what.
 */
export function isStanding(rule: CapabilityRule): boolean {
  if (rule.adjudication !== "engine") return false;
  if (rule.trigger?.event !== "always") return false;
  return STANDING_EFFECTS.includes(rule.effect?.kind as EffectKind);
}

/** Strip everything that came out of a book, so a compiled cache can be shared. */
export function exportable(capability: Capability): Capability {
  const { prose: _prose, ...rest } = capability;
  return rest;
}
