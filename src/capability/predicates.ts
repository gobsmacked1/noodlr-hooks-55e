// Evaluating the guards on a compiled rule.
//
// Sixteen predicates, closed, derived from what actually recurred across the 73,546 conditions the
// corpus mined as free English. They answer a THREE-valued question — true, false, or "could not
// tell" — and the third value is the whole reason this file is separate from the executor.
//
// FAIL CLOSED, ALWAYS. A guard that cannot be evaluated stops the rule. The alternative is a troll
// that regenerates because nobody could work out whether it had been burned, and that is invisible at
// the table: the numbers look plausible, the fight is simply wrong. A rule that never fires shows up
// on the capability sheet as needing a human, which is a bug report rather than a mystery.

import type { Predicate, SubjectName } from "../integration/capability";
import { normalizeDamageWindow } from "../integration/capability";
import { hasStatus } from "../system/dnd5e-conditions";
import { damageTakenBy } from "./damage-log";
import { asQuantity, resolveQuantitySync } from "./quantity";

/** Who a predicate is asking about. `self` is the creature carrying the capability. */
export type Who = SubjectName;

export interface Subject {
  actor?: any;
  token?: any;
}

export interface EvalContext {
  self: Subject;
  target?: Subject;
  /**
   * Whoever swung, or whoever forced the save. On `on_damage_taken` that is the other creature; on
   * `on_hit` and the save triggers it is `self`, because those fire from the ability owner's side.
   */
  attacker?: Subject;
  /**
   * The creature the event is ABOUT, where that is neither of the above by default.
   *
   * Exists because `attacker` and `trigger` collapse onto the same creature the moment an event fires
   * from the ability owner's side, and the fallback below would then resolve `trigger` to the owner —
   * the opposite of what it means everywhere else. Set by the attack dispatch and the save dispatch;
   * every older call site keeps the behaviour it had.
   */
  trigger?: Subject;
  spellLevel?: number;
  combat?: any;
  combatant?: any;
}

export interface Verdict {
  /** False when the predicate could not be answered. `value` is then meaningless. */
  evaluable: boolean;
  value: boolean;
  /** Why, for the capability sheet and the debug log. Always populated on a refusal. */
  reason?: string;
}

const YES: Verdict = { evaluable: true, value: true };
const NO: Verdict = { evaluable: true, value: false };

function unknown(reason: string): Verdict {
  return { evaluable: false, value: false, reason };
}

/**
 * Resolve `who`. A Record rather than a switch so its keys are checked against `SUBJECTS` at compile
 * time: the vocabulary declares that list to whoever compiles for us, and a resolver that quietly
 * knew a fifth value — or stopped knowing a fourth — would make the declaration a lie.
 */
const RESOLVE: Record<SubjectName, (ctx: EvalContext) => Subject | undefined> = {
  self: (ctx) => ctx.self,
  target: (ctx) => ctx.target,
  attacker: (ctx) => ctx.attacker,
  trigger: (ctx) => ctx.trigger ?? ctx.attacker ?? ctx.target,
};

function subjectFor(who: unknown, ctx: EvalContext): Subject | undefined {
  return RESOLVE[String(who ?? "self") as SubjectName]?.(ctx);
}

function hpOf(actor: any): { value: number; max: number } | null {
  const hp = actor?.system?.attributes?.hp;
  const value = Number(hp?.value);
  const max = Number(hp?.max);
  if (!Number.isFinite(value)) return null;
  return { value, max: Number.isFinite(max) ? max : 0 };
}

/** Creature type, lower-cased. dnd5e keeps NPCs' at `details.type.value` and PCs' as a species. */
function creatureType(actor: any): string | null {
  const type = actor?.system?.details?.type;
  const value = String(type?.value ?? type ?? "").toLowerCase();
  if (value) return value;
  // A player character has no `type.value`; every PC in 5e is a creature, which is what the 434
  // `target is a creature` conditions in the corpus are actually asking.
  if (actor?.type === "character") return "humanoid";
  return null;
}

const SIZE_ORDER = [
  "tiny",
  "sm",
  "small",
  "med",
  "medium",
  "lg",
  "large",
  "huge",
  "grg",
  "gargantuan",
];
/** Canonical rank, so the two spellings dnd5e uses for each size compare equal. */
const SIZE_RANK: Record<string, number> = {
  tiny: 0,
  sm: 1,
  small: 1,
  med: 2,
  medium: 2,
  lg: 3,
  large: 3,
  huge: 4,
  grg: 5,
  gargantuan: 5,
};

function sizeRank(actor: any): number | null {
  const raw = String(actor?.system?.traits?.size ?? "").toLowerCase();
  if (!raw || !SIZE_ORDER.includes(raw)) return null;
  return SIZE_RANK[raw];
}

/** Distance in scene units between two tokens, or null when either is not placed. */
function distanceBetween(a: any, b: any): number | null {
  const docA = a?.document ?? a;
  const docB = b?.document ?? b;
  const grid: any = (canvas as any)?.grid;
  const size = Number(grid?.size) || 0;
  if (!size) return null;

  const centre = (doc: any) => {
    const x = Number(doc?.x);
    const y = Number(doc?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return {
      x: x + (size * (Number(doc?.width) || 1)) / 2,
      y: y + (size * (Number(doc?.height) || 1)) / 2,
    };
  };
  const p1 = centre(docA);
  const p2 = centre(docB);
  if (!p1 || !p2) return null;

  try {
    if (typeof grid?.measurePath === "function") {
      const result = grid.measurePath([p1, p2]);
      const d = Number(result?.distance ?? result);
      if (Number.isFinite(d)) return d;
    }
  } catch {
    // fall through to the geometric estimate
  }
  const perSquare = Number(grid?.distance) || 5;
  return (Math.hypot(p2.x - p1.x, p2.y - p1.y) / size) * perSquare;
}

/**
 * Evaluate one predicate. Never throws: an exception here would take a turn down.
 *
 * `negate` is applied here rather than inside each case, and only to an answer that exists. Inverting
 * "could not tell" into "true" would turn every guard we cannot evaluate into a rule that fires, which
 * is precisely backwards.
 */
export function evaluatePredicate(predicate: Predicate, ctx: EvalContext): Verdict {
  let verdict: Verdict;
  try {
    verdict = evaluateInner(predicate, ctx);
  } catch (err) {
    return unknown(`${predicate?.kind} threw: ${String(err)}`);
  }
  if (!verdict.evaluable || !predicate.negate) return verdict;
  return { evaluable: true, value: !verdict.value };
}

function evaluateInner(predicate: Predicate, ctx: EvalContext): Verdict {
  const who = subjectFor(predicate.who, ctx);
  const kind = predicate.kind;

  // A predicate about somebody who is not in this trigger — "the target", on a trigger with no target
  // — is unanswerable, not false. The distinction matters: false would let a `lacks_status` guard pass.
  if (!who?.actor && kind !== "in_combat") {
    return unknown(`no ${String(predicate.who ?? "self")} in this context`);
  }
  const actor = who?.actor;

  switch (kind) {
    case "has_status":
      return hasStatus(actor, String(predicate.status).toLowerCase()) ? YES : NO;
    case "lacks_status":
      return hasStatus(actor, String(predicate.status).toLowerCase()) ? NO : YES;

    case "hp_at_least": {
      const hp = hpOf(actor);
      const amount = resolveQuantitySync(asQuantity(predicate.amount), {
        actor,
        token: who?.token,
      });
      if (!hp || amount === null) return unknown("hit points or the threshold are unreadable");
      return hp.value >= amount ? YES : NO;
    }
    case "hp_at_most": {
      const hp = hpOf(actor);
      const amount = resolveQuantitySync(asQuantity(predicate.amount), {
        actor,
        token: who?.token,
      });
      if (!hp || amount === null) return unknown("hit points or the threshold are unreadable");
      return hp.value <= amount ? YES : NO;
    }
    case "hp_fraction_at_most": {
      // Bloodied lives here: `fraction: 0.5`. Named for the arithmetic rather than the 2024 word, so
      // the vocabulary survives a system that does not use it.
      const hp = hpOf(actor);
      const fraction = Number(predicate.fraction);
      if (!hp || hp.max <= 0 || !Number.isFinite(fraction)) {
        return unknown("no maximum hit points to take a fraction of");
      }
      return hp.value / hp.max <= fraction ? YES : NO;
    }

    case "damage_taken": {
      const uuid = String(actor?.uuid ?? "");
      // Resolved, never cast. The cast this replaces is what let three spellings of one window into
      // the cache and read every one of them as a window the ledger had never heard of — which
      // `damageTakenBy` answered honestly and nothing above it reported. An unreadable window is
      // unevaluable, which fails the guard closed and names the offending string on the sheet.
      const window = normalizeDamageWindow(predicate.window);
      if (window === null) {
        return unknown(`"${String(predicate.window)}" is not a damage window this can read`);
      }
      const minimum = resolveQuantitySync(asQuantity(predicate.minimum), { actor });
      const answer = damageTakenBy(uuid, {
        window,
        damageTypes: Array.isArray(predicate.damageTypes)
          ? (predicate.damageTypes as unknown[]).map(String)
          : undefined,
        minimum: minimum ?? undefined,
      });
      // The ledger reports its own unevaluable case — out of combat there are no turns, so a
      // turn-scoped window has no referent and must not read as "took nothing".
      if (!answer.evaluable) return unknown(`the "${window}" window cannot be evaluated right now`);
      const floor = minimum ?? 1;
      return answer.matched.length > 0 && answer.total >= floor ? YES : NO;
    }

    case "target_type": {
      const actual = creatureType(actor);
      if (!actual) return unknown("the sheet states no creature type");
      const wanted = (Array.isArray(predicate.types) ? predicate.types : [predicate.types]).map(
        (t) => String(t).toLowerCase(),
      );
      // "creature" is the corpus's most common condition by a distance and is a category rather than
      // a type: anything with a type at all satisfies it.
      if (wanted.includes("creature")) return YES;
      return wanted.includes(actual) ? YES : NO;
    }

    case "size_at_most": {
      const rank = sizeRank(actor);
      const wanted = SIZE_RANK[String(predicate.size).toLowerCase()];
      if (rank === null || wanted === undefined) return unknown("size is unreadable");
      return rank <= wanted ? YES : NO;
    }
    case "size_at_least": {
      const rank = sizeRank(actor);
      const wanted = SIZE_RANK[String(predicate.size).toLowerCase()];
      if (rank === null || wanted === undefined) return unknown("size is unreadable");
      return rank >= wanted ? YES : NO;
    }

    case "within_distance": {
      const feet = resolveQuantitySync(asQuantity(predicate.feet), { actor });
      const other = subjectFor(predicate.of ?? "self", ctx);
      if (feet === null) return unknown("the distance is unreadable");
      if (!who?.token || !other?.token) return unknown("one of the two is not on the scene");
      const apart = distanceBetween(who.token, other.token);
      if (apart === null) return unknown("the scene has no grid to measure on");
      return apart <= feet ? YES : NO;
    }

    case "can_see": {
      // Deliberately delegated: `rules/perception.ts` builds a vision source for the observing
      // creature and runs the real detection modes, which is the only way to get magical darkness,
      // invisibility and every vision module right. Re-implementing it here would disagree with what
      // the table sees on screen.
      const observer = subjectFor(predicate.who ?? "self", ctx);
      const seen = subjectFor(predicate.whom ?? "target", ctx);
      if (!observer?.token || !seen?.token) return unknown("one of the two is not on the scene");
      const answer = perceives(observer.token, seen.token);
      return answer === null ? unknown("perception could not be computed") : answer ? YES : NO;
    }

    case "own_turn": {
      const combat = ctx.combat ?? (game as any)?.combat;
      if (!combat?.started) return NO;
      const current = combat.combatant?.actor?.uuid;
      return current && current === actor?.uuid ? YES : NO;
    }

    case "in_combat":
      return (ctx.combat ?? (game as any)?.combat)?.started ? YES : NO;

    case "spell_level_at_least": {
      const level = Number(ctx.spellLevel);
      const wanted = Number(predicate.level);
      if (!Number.isFinite(level) || !Number.isFinite(wanted)) {
        return unknown("no spell level in this context");
      }
      return level >= wanted ? YES : NO;
    }

    case "has_capability":
      // Needs a capability registry keyed by name, which the executor does not have yet: capabilities
      // are keyed by prose hash, not by what they are called. Unevaluable rather than guessed.
      return unknown("capability lookup by name is not implemented");

    case "custom":
      return unknown(`unstructured guard: ${String(predicate.text ?? "")}`);

    default:
      return unknown(`unknown predicate "${String(kind)}"`);
  }
}

/**
 * Whether an observer can see a token, using the real detection modes.
 *
 * Late-bound through the module API rather than imported, so this file does not drag the perception
 * machinery — and its canvas dependencies — into every test that touches a predicate.
 */
function perceives(observer: any, seen: any): boolean | null {
  try {
    const api: any = (game as any)?.modules?.get?.("noodlr-hooks-55e")?.api;
    if (typeof api?.canPerceive === "function") return Boolean(api.canPerceive(observer, seen));
  } catch {
    /* fall through */
  }
  return null;
}

export interface ConditionResult {
  met: boolean;
  /** Populated when a guard could not be answered, which is why the rule did not fire. */
  blockedBy?: string;
}

/**
 * Evaluate a rule's guards, ANDed.
 *
 * Short-circuits on the first false, but reports an UNEVALUABLE guard distinctly, because the two mean
 * different things to a GM reading the capability sheet: one is "the rule correctly did not apply",
 * the other is "this rule can never apply and somebody needs to look at it".
 */
export function conditionsMet(
  condition: Predicate[] | undefined,
  ctx: EvalContext,
): ConditionResult {
  for (const predicate of condition ?? []) {
    const verdict = evaluatePredicate(predicate, ctx);
    if (!verdict.evaluable) {
      return { met: false, blockedBy: `${predicate.kind}: ${verdict.reason ?? "unevaluable"}` };
    }
    if (!verdict.value) return { met: false };
  }
  return { met: true };
}
