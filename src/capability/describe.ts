// Turning a compiled descriptor back into a sentence.
//
// The capability sheet is the only place a GM can tell whether a model read a stat block correctly,
// and raw JSON is not a review surface — a reviewer skims twenty of these looking for the one that is
// wrong, and `{"kind":"hp_fraction_at_most","fraction":0.5}` does not skim. So every rule renders as
// one line: when it fires, what has to be true, and what it does.
//
// DELIBERATELY ENGLISH, and deliberately not localised. Everything else this module shows a GM goes
// through `lang/en.json`; this does not, because it composes fragments into a sentence and a fragment
// table produces broken grammar in every language that does not order clauses the way English does.
// The vocabulary being described is itself a set of English identifiers. Translating the chrome around
// it and leaving the sentence in the source language is the honest split.
//
// Pure functions with no Foundry in them, so the tests can assert on real descriptors.

import type {
  Capability,
  CapabilityRule,
  Effect,
  Predicate,
  Quantity,
} from "../integration/capability";
import { isExecutable, isStanding } from "../integration/capability";
import { duplicatesItemDamage } from "./duplicate";

const TRIGGERS: Record<string, string> = {
  on_hit: "when it hits",
  on_miss: "when it misses",
  on_attack_roll: "when it rolls an attack",
  on_damage_taken: "when it takes damage",
  on_save_failed: "when a save is failed",
  on_save_succeeded: "when a save succeeds",
  on_activity_use: "when it uses an ability",
  on_turn_start: "at the start of its turn",
  on_turn_end: "at the end of its turn",
  on_move: "when it moves",
  on_enter_area: "when something enters the area",
  on_leave_reach: "when something leaves its reach",
  on_condition_applied: "when a condition is applied",
  on_zero_hp: "when it drops to 0 hit points",
  on_short_rest: "on a short rest",
  on_long_rest: "on a long rest",
  always: "always",
};

const NAMED: Record<string, string> = {
  speed: "its Speed",
  half_speed: "half its Speed",
  remaining_movement: "its remaining movement",
  reach: "its reach",
  proficiency_bonus: "its proficiency bonus",
  spell_level: "the spell's level",
  character_level: "its level",
  challenge_rating: "its challenge rating",
};

const UNIT_WORDS: Record<string, string> = {
  ft: "feet",
  mi: "miles",
  m: "metres",
  km: "kilometres",
  squares: "squares",
  hp: "hit points",
  temp_hp: "temporary hit points",
  rounds: "rounds",
  turns: "turns",
  minutes: "minutes",
  hours: "hours",
  days: "days",
  uses: "uses",
  level: "levels",
};

const WHO: Record<string, string> = {
  self: "it",
  target: "the target",
  attacker: "the attacker",
  trigger: "whatever triggered it",
};

function who(value: unknown, fallback = "it"): string {
  const key = String(value ?? "");
  return WHO[key] ?? (key ? key : fallback);
}

/** A number, a formula, or something only the creature knows — in words. */
export function describeQuantity(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "number" || typeof raw === "string") return String(raw);
  const q = raw as Quantity;

  let head = "";
  if (q.named) head = NAMED[q.named] ?? String(q.named).replace(/_/g, " ");
  else if (typeof q.dice === "string" && q.dice.trim()) head = q.dice.trim();
  else if (typeof q.value === "number") head = String(q.value);
  if (!head) return "";

  // Units are noise on a named quantity ("half its Speed feet" reads worse than "half its Speed") and
  // are the whole meaning on a bare number.
  if (!q.named && q.units) head += ` ${UNIT_WORDS[q.units] ?? q.units}`;

  const per = q.perLevelAbove;
  if (per) {
    const step = per.dice ?? (per.value === undefined ? "" : String(per.value));
    if (step) head += ` (+${step} per level above ${per.level})`;
  }
  return head;
}

/**
 * A quantity whose surrounding sentence already names the unit.
 *
 * "restore 15 hit points hit points" is what the naive version produces, because the compiler is
 * asked to state units and the phrase for `heal` says them too. Whichever one is dropped, it has to
 * be dropped in exactly one place: here.
 */
function amountOf(raw: unknown, implied: string[]): string {
  const q = raw as Quantity;
  if (!q || typeof q !== "object" || !q.units || !implied.includes(String(q.units))) {
    return describeQuantity(raw);
  }
  const { units: _units, ...rest } = q;
  return describeQuantity(rest);
}

function list(value: unknown): string {
  const items = Array.isArray(value) ? value.map(String) : [String(value ?? "")];
  const clean = items.filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? "";
  return `${clean.slice(0, -1).join(", ")} or ${clean[clean.length - 1]}`;
}

const WINDOWS: Record<string, string> = {
  this_turn: "during this turn",
  this_round: "during this round",
  since_last_turn: "since its last turn",
  ever: "at any point",
};

/** One guard, as a clause. Negation wraps rather than rephrases — see the note in the header. */
export function describePredicate(predicate: Predicate): string {
  const clause = predicateClause(predicate);
  return predicate.negate ? `not (${clause})` : clause;
}

function predicateClause(p: Predicate): string {
  const subject = who(p.who);
  switch (p.kind) {
    case "has_status":
      return `${subject} is ${String(p.status)}`;
    case "lacks_status":
      return `${subject} is not ${String(p.status)}`;
    case "hp_at_least":
      return `${subject} has at least ${describeQuantity(p.amount)} hit points`;
    case "hp_at_most":
      return `${subject} has at most ${describeQuantity(p.amount)} hit points`;
    case "hp_fraction_at_most":
      return `${subject} is at or below ${Math.round(Number(p.fraction) * 100)}% of its hit points`;
    case "damage_taken": {
      const types = p.damageTypes ? `${list(p.damageTypes)} ` : "";
      const floor = p.minimum ? `${describeQuantity(p.minimum)} or more ` : "";
      const when = WINDOWS[String(p.window)] ?? String(p.window);
      return `${subject} took ${floor}${types}damage ${when}`;
    }
    case "target_type":
      return `${who(p.who, "the target")} is ${list(p.types)}`;
    case "size_at_most":
      return `${who(p.who, "the target")} is ${String(p.size)} or smaller`;
    case "size_at_least":
      return `${who(p.who, "the target")} is ${String(p.size)} or larger`;
    case "within_distance":
      return `${who(p.who, "the target")} is within ${describeQuantity(p.feet)}${p.of ? ` of ${who(p.of)}` : ""}`;
    case "can_see":
      return `${who(p.who)} can see ${who(p.whom, "the target")}`;
    case "own_turn":
      return `it is ${subject === "it" ? "its" : `${subject}'s`} turn`;
    case "in_combat":
      return "a fight is running";
    case "spell_level_at_least":
      return `the spell is cast at level ${String(p.level)} or higher`;
    case "has_capability":
      return `${subject} has ${String(p.capability)}`;
    case "custom":
      return `${String(p.text)} — needs a human`;
    default:
      return String(p.kind).replace(/_/g, " ");
  }
}

/** What the rule does, as a clause. */
export function describeEffect(effect: Effect): string {
  const target = effect.target ? ` to ${who(effect.target)}` : "";
  switch (effect.kind) {
    case "damage":
      return `deal ${amountOf(effect.amount, ["hp"])} ${String(effect.damageType ?? "")} damage${target}`.replace(
        /\s+/g,
        " ",
      );
    case "heal":
      return `${effect.temporary ? "grant" : "restore"} ${amountOf(effect.amount, ["hp", "temp_hp"])}${
        effect.temporary ? " temporary" : ""
      } hit points${target || " to itself"}`;
    case "displace":
      return `push ${who(effect.target, "the target")} ${String(effect.direction)} ${describeQuantity(effect.distance)}`;
    case "teleport":
      return `teleport ${who(effect.target)} to ${String(effect.destination)}`;
    case "apply_status":
      return `make ${who(effect.target, "the target")} ${String(effect.status)}`;
    case "remove_status":
      return `end ${String(effect.status)} on ${who(effect.target)}`;
    case "summon_creature": {
      const count = describeQuantity(effect.count) || "1";
      return `summon ${count} × ${String(effect.creature)}${
        effect.placement ? ` (${String(effect.placement).replace(/_/g, " ")})` : ""
      }`;
    }
    case "extra_attack":
      return `attack ${String(effect.attacks)} times with one Attack action`;
    case "initiative_position":
      return `act ${String(effect.position)}${effect.relativeTo ? ` ${who(effect.relativeTo)}` : ""} in the order`;
    case "spend_resource":
      return `spend ${describeQuantity(effect.amount)} of ${String(effect.resource)}`;
    case "recover_resource":
      return `recover ${describeQuantity(effect.amount)} of ${String(effect.resource)}`;
    case "grant_advantage":
      return `grant advantage on ${String(effect.rollType)}${target}`;
    case "impose_disadvantage":
      return `impose disadvantage on ${String(effect.rollType)}${target}`;
    case "modify_speed":
      return `change ${who(effect.target)} Speed${effect.amount ? ` by ${describeQuantity(effect.amount)}` : ""}`;
    case "resist_damage":
      return `${String(effect.treatment)} ${list(effect.damageTypes)} damage`;
    case "voice_entity":
      return `speak as ${String(effect.speaker)}`;
    case "other":
      return String(effect.note ?? "something this vocabulary cannot say");
    default: {
      // Everything without a hand-written phrase still renders honestly: the kind, then its own
      // parameters. Better a plain reading than a missing line the GM cannot see at all.
      const params = Object.entries(effect)
        .filter(([key]) => key !== "kind")
        .map(([key, value]) => `${key} ${plain(value)}`)
        .join(", ");
      return `${String(effect.kind).replace(/_/g, " ")}${params ? `: ${params}` : ""}`;
    }
  }
}

function plain(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return list(value);
  if (typeof value === "object") return describeQuantity(value) || JSON.stringify(value);
  return String(value);
}

/** "3 per short rest", "recharge 5-6", or nothing at all. */
export function describeUses(uses: CapabilityRule["uses"]): string {
  if (!uses) return "";
  if (uses.per === "recharge") return `recharge ${uses.recharge ?? "?"}`;
  return `${uses.max} per ${String(uses.per).replace(/_/g, " ")}`;
}

/** The whole rule in one line. */
export function describeRule(rule: CapabilityRule): string {
  const when = TRIGGERS[String(rule.trigger?.event)] ?? String(rule.trigger?.event ?? "?");
  const guards = (rule.condition ?? []).map(describePredicate).filter(Boolean);
  const head = guards.length ? `${when}, if ${guards.join(" and ")}` : when;
  return `${head} → ${describeEffect(rule.effect)}`;
}

export interface RuleView {
  index: number;
  text: string;
  event: string;
  effect: string;
  adjudication: string;
  uses: string;
  /** False when nothing in this build runs it. Shown as a badge, not hidden. */
  runs: boolean;
  /** A permanently-true property, read on demand rather than fired. Also not inert. */
  standing: boolean;
  /** Neither fired nor readable: the only state that is honestly wasted money. */
  inert: boolean;
  note: string;
  /**
   * Why the executor will decline this at runtime, when it can be known without a turn.
   *
   * Today that is one thing: a damage rule restating damage the platform already rolls. It belongs on
   * this sheet rather than only in a console, because the failure it prevents is arithmetic — an
   * ability that hits twice as hard as the book says, with nothing thrown and nothing logged — so a
   * refusal nobody can see reads as the rule having stopped working.
   */
  refused: string;
}

export function describeCapability(capability: Capability, item?: unknown): RuleView[] {
  return (capability.rules ?? []).map((rule, index) => {
    const runs = isExecutable(rule);
    const standing = isStanding(rule);
    return {
      index,
      text: describeRule(rule),
      event: String(rule.trigger?.event ?? "?"),
      effect: String(rule.effect?.kind ?? "?"),
      adjudication: String(rule.adjudication ?? "?"),
      uses: describeUses(rule.uses),
      runs,
      standing,
      inert: !runs && !standing,
      note: String(rule.note ?? ""),
      // Only askable when the caller has the feature in hand. Absent is "not checked", never "clear".
      refused: item ? (duplicatesItemDamage(rule, item) ?? "") : "",
    };
  });
}
