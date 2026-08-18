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
 * Which client runs the executor for a wired trigger.
 *
 * THIS IS NOT A DETAIL OF THE WIRING, IT IS THE DIFFERENCE BETWEEN A RULE FIRING AND NOT FIRING, and
 * it is a question about the hook rather than about the rule. `isGM` is a role several clients hold,
 * so a trigger carried by a *document* hook arrives everywhere and has to be narrowed to one writer or
 * a troll summons a limb per assistant GM. But several of the system's hooks fire on the ACTING client
 * alone — `dnd5e.postUseActivity` and `dnd5e.restCompleted` both do — and there the same gate narrows
 * nothing: it discards the event outright whenever a player owns the actor, which for rests and
 * ability uses is most of the time. A player's own long rest would recover nothing and announce
 * nothing, silently, on a table where the identical rule works for the GM's monsters.
 *
 * So the answer is declared per event and {@link WIRED_TRIGGERS} is DERIVED from this table rather
 * than written beside it: adding a hook IS declaring who executes, and there is no way to wire one
 * without answering the question.
 *
 * `acting-client` is not merely permitted, it is the only client that can act: it owns the actor by
 * construction. What it may NOT be able to do is mutate the world — creating a token or a combatant
 * needs rights a player does not have — and that is why the answer is per event rather than derived
 * from the hook automatically. A refusal there is caught by `fireTrigger`'s own try/catch and recorded
 * as a non-firing with its reason, so it is a logged refusal rather than a broken turn; it is still a
 * refusal, which is the whole reason `on_activity_use` stays on the primary GM for now.
 */
export type RunsOn = "primary-gm" | "acting-client";

/**
 * The subset of {@link TRIGGER_EVENTS} that `registerCapabilityExecutor()` attaches a real hook to,
 * each with the client that executes it.
 *
 * The compiler is deliberately offered all seventeen: "the troll regenerates at the start of its turn"
 * and "the cloak recharges on a long rest" are both true readings of the prose, and a vocabulary that
 * hid the events this build cannot hear would teach the model to mis-file rules rather than to skip
 * them. This table is the other half of that bargain — a rule whose event never fires is badged inert
 * instead of being shown as live.
 *
 * Wiring a new hook in `capability/executor.ts` means adding its event here in the same change, or the
 * sheet will go on calling a working rule dead.
 */
const WIRED: Partial<Record<TriggerEvent, RunsOn>> = {
  // Off our own damage ledger, which is maintained on every client because the amount is only
  // computable from `updateActor` and that fires everywhere.
  on_damage_taken: "primary-gm",
  on_zero_hp: "primary-gm",
  // `updateCombat` is a document hook: every client sees the turn change.
  on_turn_start: "primary-gm",
  on_turn_end: "primary-gm",
  // A CLIENT-LOCAL HOOK DELIBERATELY LEFT ON THE GM, which means a player's own ability use still
  // fires nothing. Not an oversight and not the rests' situation: an activity can reach every effect
  // kind there is, including `summon_creature` and `insert_combatant`, and those need world rights a
  // player has not got — so widening this gate trades a silent non-firing for a partial one, where
  // the spend lands on the player's own sheet and the summon beside it is refused. The fix is a relay
  // to the primary GM (`util/queries.ts` already carries one for Influence), not a wider gate.
  on_activity_use: "primary-gm",
  // `Hooks.callAll("dnd5e.restCompleted")` on the client that rested, i.e. usually a player. Safe to
  // run there on evidence rather than on hope: every engine-adjudicated rest rule in the live cache is
  // a `recover_resource` on the resting creature's own item (`npm run census:rests`), which is exactly
  // what that client has rights to.
  on_short_rest: "acting-client",
  on_long_rest: "acting-client",
  // Dispatched from `rules/damage.ts` once the attack's verdict has settled, which is already primary-GM
  // only — it is the same client that reads the verdict, applies the damage and writes the gate flag.
  // See `capability/attack.ts` for why they fire from the attacker's side and for the settings this
  // therefore inherits.
  on_hit: "primary-gm",
  on_miss: "primary-gm",
};

export const WIRED_TRIGGERS: readonly TriggerEvent[] = Object.keys(WIRED) as TriggerEvent[];

/**
 * Which client runs the executor for `event`.
 *
 * Defaults to `primary-gm` for anything unwired, which is the conservative answer: an unwired event is
 * never dispatched at all, and an event added without a table entry gates rather than fanning out.
 */
export function runsOn(event: TriggerEvent): RunsOn {
  return WIRED[event] ?? "primary-gm";
}

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

  // `target` was measured onto this one rather than mined: 13 of 114 validation errors across a live
  // 960-wording recompile were an `unknown parameter "target"` here, which is a spell that slows what
  // it hits having no way to say whose Speed changed. `describe.ts` was already rendering
  // `who(effect.target)` for this kind, so the omission contradicted our own renderer.
  modify_speed: {
    required: [],
    optional: ["amount", "multiplier", "movementType", "setTo", "costMultiplier", "target"],
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

/**
 * Whom a predicate may ask about. Closed, and the one truth `capability/predicates.ts` resolves from.
 *
 * Declared here beside the predicates because `who` is a parameter of a predicate in the closed set,
 * and the whole job of this file is to close the parameter level as well as the kind level. **It was
 * the one parameter left open**, which cost exactly what an open parameter always costs: a live cache
 * holds `who: "caster"`, `"hit target"`, `"saving creature"`, `"owner"`, `"familiar"` and several
 * proper nouns — including a guard naming a player character, which can never evaluate on any turn.
 *
 * `subjectFor` fails closed on an unknown value, so those guards refuse rather than fire, and their
 * rules refuse with them. That is the safe direction and it is still a rule the operator paid for and
 * does not get. The remedy is at the other end: the vocabulary now SAYS what resolves.
 *
 * `trigger` is deliberately vaguer than the other three — it means "whoever caused this", which is the
 * attacker on a hit and the target on a save. It exists so a rule can be written once for a trigger
 * whose causing side differs between events.
 */
export const SUBJECTS = ["self", "target", "attacker", "trigger"] as const;

export type SubjectName = (typeof SUBJECTS)[number];

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

/**
 * The windows `damage_taken` can be asked about. Closed, and declared HERE rather than in
 * `capability/damage-log.ts` because it is vocabulary: `window` is a required parameter of a predicate
 * in the closed set, and the one thing this file exists to do is close the parameter level as well as
 * the kind level.
 *
 * It was not enumerated originally, and the cost of that was measured on 2026-08-16: the live cache
 * held `"since_last_turn"`, `"since the start of its previous turn"` and `"this turn"` for the same two
 * rules. Only the first matched, so the Troll's Regeneration and Loathsome Limbs guards were
 * unevaluable even once the reader was looking at the right key. `damage-log.ts` derives its type from
 * this list so there is one answer to "which windows exist".
 */
export const DAMAGE_WINDOWS = ["this_turn", "since_last_turn", "this_round", "ever"] as const;

export type DamageWindow = (typeof DAMAGE_WINDOWS)[number];

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
   * WHAT THE WORLD WAS WHEN THIS READING WAS MADE. Stamped by the cache rather than by the compiler:
   * the compiler answers a question about prose and knows nothing about the ruleset that prose will be
   * executed under, and this is the ruleset. See `capability/age.ts` for what is done with it —
   * reported, never acted on.
   */
  compiledIn?: { foundry: string; system: string };
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

// ---- Repairing what a compiler hands back --------------------------------------------------------
//
// A closed vocabulary only closes what it NAMES. Two things went unnamed and cost the same bug twice.
//
// The guard array is `condition`, singular, and the prompt describes it as "conditions" in English. The
// live cache was censused on 2026-08-16: 576 of 693 guards had been compiled correctly and filed under
// `conditions`, plural — a key nothing read. Every key the prompt names in dotted form (`trigger.event`,
// `effect.kind`) was correct 100% of the time; the one named only as an English noun was correct 26% of
// the time. The Troll's Regeneration and Loathsome Limbs were both in the 74%.
//
// And `damage_taken.window` was a required parameter whose legal values were never enumerated, so the
// same two rules carried `"since_last_turn"`, `"since the start of its previous turn"` and `"this turn"`
// between them and only the first was readable.
//
// Both are fixed properly in the doctrine and the vocabulary. This layer exists because a descriptor
// already paid for must not have to be bought again, and because a prompt cannot be RELIED on: the
// normaliser is the guard, and `validateCapability` reporting an unrecognised key is how the next
// rename gets noticed on the day it happens rather than two releases later.

/** Rule keys `CapabilityRule` declares. Anything else is either an alias below or a model invention. */
const RULE_KEYS = new Set(["trigger", "condition", "effect", "uses", "adjudication", "note"]);

/** Keys a compiler has been seen to use for the guard array, all folded into `condition`. */
const CONDITION_ALIASES = ["conditions", "requirements", "prerequisites"] as const;

/** Phrases that resolve to a canonical damage window. Ordered: the narrowest reading is tested first. */
const WINDOW_PHRASES: readonly [RegExp, DamageWindow][] = [
  // "since its last turn", "since the start of its previous turn" — the span between two of its turns.
  [/\b(last|previous|preceding)\s+turn\b/, "since_last_turn"],
  [/\bsince\b.*\bturn\b/, "since_last_turn"],
  [/\b(this|that|the|current|its own)\s+turn\b/, "this_turn"],
  [/\bturn\b/, "this_turn"],
  [/\bround\b/, "this_round"],
  [/\b(ever|always|any\s+time|at\s+all)\b/, "ever"],
];

/**
 * Resolve a `window` value to one of {@link DAMAGE_WINDOWS}, or null when it cannot be read.
 *
 * Null rather than a guess: an unrecognised window leaves the raw string in place, `damage_taken`
 * reports it as unevaluable, and the rule fails closed with the operator's own text on the capability
 * sheet. Guessing `ever` would silently widen the guard, which for Regeneration is the difference
 * between a troll that stops burning and one that never regenerates again.
 */
export function normalizeDamageWindow(raw: unknown): DamageWindow | null {
  const text = String(raw ?? "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z_]/g, "")
    .trim();
  if (!text) return null;
  if ((DAMAGE_WINDOWS as readonly string[]).includes(text)) return text as DamageWindow;
  const prose = text.replace(/_/g, " ");
  for (const [pattern, window] of WINDOW_PHRASES) {
    if (pattern.test(prose)) return window;
  }
  return null;
}

export interface NormalizeReport {
  /** One line per repair, for the log and the capability sheet. Empty is the healthy case. */
  notes: string[];
}

/**
 * Fold a raw rule into the shape the executor reads. Pure, idempotent, and never throws.
 *
 * Idempotent matters: this is applied at every point a descriptor enters the cache AND again before
 * validation, so that what is validated is what will run.
 */
function normalizeRule(raw: unknown, at: string, notes: string[]): CapabilityRule {
  const rule = { ...(raw as Record<string, unknown>) } as CapabilityRule & Record<string, unknown>;

  const guards: Predicate[] = Array.isArray(rule.condition) ? [...rule.condition] : [];
  for (const alias of CONDITION_ALIASES) {
    const found = rule[alias];
    if (found === undefined) continue;
    delete rule[alias];
    if (!Array.isArray(found)) {
      notes.push(`${at}.${alias} was not an array; ignored`);
      continue;
    }
    // ANDed, so merging both keys can only make the rule fire LESS often. Preferring one and dropping
    // the other is the choice that loses a guard, which is the failure this whole layer exists for.
    guards.push(...(found as Predicate[]));
    notes.push(`${at} used "${alias}" for its guards; read as "condition"`);
  }
  rule.condition = guards;

  for (const [index, predicate] of guards.entries()) {
    if (predicate?.kind !== "damage_taken") continue;
    const canonical = normalizeDamageWindow(predicate.window);
    if (canonical === null) {
      notes.push(
        `${at}.condition[${index}].window "${String(predicate.window)}" is not a known window; ` +
          `the guard will not evaluate`,
      );
      continue;
    }
    if (canonical !== predicate.window) {
      notes.push(
        `${at}.condition[${index}].window "${String(predicate.window)}" read as "${canonical}"`,
      );
      guards[index] = { ...predicate, window: canonical };
    }
  }

  for (const key of Object.keys(rule)) {
    if (!RULE_KEYS.has(key)) notes.push(`${at} has unrecognised key "${key}"`);
  }
  return rule as CapabilityRule;
}

/**
 * Fold a whole capability into the shape the executor reads.
 *
 * Applied on every ingress into the cache — a shard read, a fresh compile, a GM edit, an import — so
 * no consumer downstream has to know that any of this ever happened.
 */
export function normalizeCapability<T extends { rules?: unknown }>(
  capability: T,
): { capability: T } & NormalizeReport {
  const notes: string[] = [];
  if (!capability || typeof capability !== "object" || !Array.isArray(capability.rules)) {
    return { capability, notes };
  }
  const rules = capability.rules.map((rule, index) =>
    normalizeRule(rule, `rules[${index}]`, notes),
  );
  return { capability: { ...capability, rules }, notes };
}

function checkParams(
  spec: ParamSpec | undefined,
  node: Record<string, unknown>,
  label: string,
  kind: string,
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
    //
    // NAMES THE KIND, because the parameter set is per-kind and the label ("rules[0].effect") does
    // not carry it. 13 of 114 errors in a live recompile were one plausible parameter on one kind
    // that had simply never been declared, and the bare message could not tell that story: whoever
    // reads it cannot decide between "the model invented a field" and "our vocabulary has a gap".
    if (!allowed.has(key)) {
      errors.push(`${label} has unknown parameter "${key}" — "${kind}" does not take it`);
    }
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
 *
 * `warnings` are REPORTED, never fatal, and the distinction is deliberate. An unrecognised rule key is
 * exactly the signal that would have caught `conditions` on the day it first appeared — but rejecting on
 * it would throw away a descriptor whose trigger, guards and effect are all fine and spend a repair
 * round to be told the same thing. Whoever calls this must surface them; nobody may gate on them.
 */
export function validateCapability(input: unknown): {
  ok: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];

  if (!input || typeof input !== "object") {
    return { ok: false, errors: ["capability is not an object"], warnings: [] };
  }
  const statuses = knownStatuses().map((id) => id.toLowerCase());
  /**
   * A status nobody can apply.
   *
   * An ERROR rather than a warning, and `lacks_status` is why: an unknown status is absent from every
   * creature, so `has_status` on one never fires (safe) while `lacks_status` on one ALWAYS fires. That
   * is the unsafe direction, and it is not hypothetical — the live cache holds
   * `apply_status: "sheathed in booming energy"`. The compiler is handed the legal list on the request,
   * so an unlisted value is a failure to follow an enumeration, exactly like an unlisted effect kind.
   *
   * A reserved status is exempt: `RESERVED_STATUSES` names things no world registers, and those rules
   * are deliberately VALID-but-inert so the sheet can show that the model read the sentence.
   */
  const checkStatus = (node: Record<string, unknown>, label: string): void => {
    if (!statuses.length || node.status === undefined) return;
    const wanted = String(node.status).toLowerCase();
    if (RESERVED_STATUSES.includes(wanted) || statuses.includes(wanted)) return;
    errors.push(
      `${label} status "${String(node.status)}" is not a status this world can apply; ` +
        `use one of the status ids on the request`,
    );
  };
  // Checked as it will RUN, not as it arrived: a guard filed under an alias is a real guard, and
  // validating the raw shape would report it missing and then run it anyway.
  const { capability: cap, notes: warnings } = normalizeCapability(input as Capability);
  if (typeof cap.id !== "string" || cap.id.trim() === "")
    errors.push("id must be a non-empty string");
  if (typeof cap.label !== "string" || cap.label.trim() === "") {
    errors.push("label must be a non-empty string");
  }
  if (!Array.isArray(cap.rules)) {
    errors.push("rules must be an array");
    return { ok: false, errors, warnings };
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
      checkParams(
        EFFECT_PARAMS[rule.effect.kind],
        rule.effect,
        `${at}.effect`,
        String(rule.effect.kind),
        errors,
      );
      checkStatus(rule.effect as Record<string, unknown>, `${at}.effect`);
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
        checkParams(
          PREDICATE_PARAMS[predicate.kind],
          predicate,
          pAt,
          String(predicate.kind),
          errors,
        );
        checkStatus(predicate as Record<string, unknown>, pAt);
        // The parameter the closed vocabulary forgot to close. An unresolvable `who` is not a near
        // miss: `subjectFor` returns nobody, the guard refuses, and the rule refuses with it — so a
        // descriptor that validated cleanly could still be a rule that can never fire on any turn.
        for (const key of ["who", "whom", "of"] as const) {
          const value = (predicate as Record<string, unknown>)[key];
          if (value !== undefined && !(SUBJECTS as readonly string[]).includes(String(value))) {
            errors.push(
              `${pAt}.${key} "${String(value)}" is not one of ${SUBJECTS.join(", ")} — ` +
                `the creature whose ability this is, is "self"`,
            );
          }
        }
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

  return { ok: errors.length === 0, errors, warnings };
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
    subjects: [...SUBJECTS],
    // Live, because it includes whatever the system and every installed module registered. Sent so the
    // compiler picks a real id the first time instead of inventing one and being corrected for it.
    statuses: knownStatuses(),
  };
}

/**
 * Statuses a compiled rule may never apply, whatever its guards say.
 *
 * FAIL-CLOSED PROTECTS AGAINST GUARDS WE CANNOT READ. IT DOES NOTHING AGAINST GUARDS THAT ARE WRONG,
 * and that is the hole a Troll fell through on 2026-08-14: its Regeneration compiled to a heal plus
 * `on_turn_start → apply_status dead`, and the death rule fired on a creature at full hit points.
 *
 * The prose is why, and the shape recurs across the whole bestiary. "The troll dies only if it starts
 * its turn with 0 Hit Points and doesn't regenerate" is a RESTRICTION on the ordinary rule, and a
 * limiting clause read as an instruction is the single likeliest misreading in monster text — "only
 * if", "unless", "doesn't". Nothing in the executor can tell a mis-read limit from a real save-or-die,
 * because both arrive as the same descriptor.
 *
 * What makes the refusal free rather than a trade: **the ordinary rule is already implemented.** A
 * creature at 0 hit points is handled by `rules/dying.ts`, so a death clause executed as an instruction
 * can only ever kill something the ordinary rule would have spared. There is no correct firing to lose.
 *
 * A static list rather than `CONFIG.specialStatusEffects.DEFEATED`, deliberately: this file is pure and
 * the tests depend on that, and a world that renamed its defeated status has not made "dead" safe.
 */
export const RESERVED_STATUSES: readonly string[] = ["dead", "defeated", "slain", "destroyed"];

/**
 * Every status id this world can actually apply, from `CONFIG.statusEffects`.
 *
 * Read live rather than listed, because the answer includes whatever the system and every installed
 * module registered — so a hardcoded list would reject a legitimate status the moment a table added a
 * module, and that rejection would look like our compiler being broken.
 *
 * **Empty means "could not tell", and every caller must treat it as permission.** This file is bundled
 * by the census scripts and by `node:test`, neither of which has a Foundry global; failing closed on an
 * unreadable list would reject every status-bearing descriptor in both.
 */
export function knownStatuses(): string[] {
  try {
    const list = (globalThis as any)?.CONFIG?.statusEffects;
    if (!Array.isArray(list)) return [];
    return list.map((s: any) => String(s?.id ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

/** Does this rule end a creature outright? See `RESERVED_STATUSES`. */
export function isTerminal(rule: CapabilityRule): boolean {
  if (rule.effect?.kind !== "apply_status") return false;
  return RESERVED_STATUSES.includes(String(rule.effect.status ?? "").toLowerCase());
}

/** Whether anything in this build actually runs the rule, for the sheet's inert/active badge. */
export function isExecutable(rule: CapabilityRule): boolean {
  if (rule.adjudication !== "engine") return false;
  if (isTerminal(rule)) return false;
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
