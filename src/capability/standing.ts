// Asking a compiled capability a question, instead of waiting for it to fire.
//
// THE NUMBER THAT MADE THIS NECESSARY. Of the 77,039 atoms the corpus mined from nine books, **27,425
// carry `trigger.event: "always"`** — 35.6%, the largest bucket by a wide margin, and 26,493 of them
// are `engine`-adjudicated. `always` is not in `WIRED_TRIGGERS` and never will be, because there is no
// hook for "this is permanently true". Correct, and it left the capability sheet badging a third of
// everything the operator paid to compile as **inert**, which reads as the compiler having wasted the
// money rather than as the executor asking the wrong question.
//
// A standing property is not a rule that fails to fire. It is a fact, and facts are queried. So this
// file is the read side of the compiler: `standingGrants()` answers "what is permanently true about
// this creature", and the typed accessors below answer the three specific questions real code asks.
//
// WHY IT IS NOT AN APPLY. A grant is reported and consumed at the point of use, never written onto the
// actor. Writing an Active Effect from a descriptor would mean the model's reading of a sentence
// silently editing a sheet the GM owns, and it would double whatever the sheet already says — dnd5e
// applies `system.traits.dr` on its own, so a compiled resistance that also wrote one would halve the
// damage twice. Consumers read; they do not merge.
//
// THE FAIL-CLOSED RULE IS THE SAME ONE THE EXECUTOR FOLLOWS, and it matters more here rather than less.
// A guard on an `always` rule is the qualifier that makes it true — "resistance to nonmagical damage",
// "while it is not Incapacitated" — so a grant whose guard cannot be evaluated is a grant that might
// be false right now. It is returned with `active: false` and the reason, which puts it on the
// capability sheet as needing a human rather than in the accessors as a fact.

// `STANDING_EFFECTS` lives beside `WIRED_TRIGGERS` rather than here, so the capability sheet's badge
// and this file's answer come from one list. Its own comment records the corpus counts that chose the
// membership, and why `other` (10,059 `always` atoms, the largest bucket of all) is excluded along
// with `restrict_action` and `require_prerequisite`.
import {
  isStanding,
  type Capability,
  type CapabilityRule,
  type EffectKind,
} from "../integration/capability";
import { bindingsFor } from "./bindings";
import { itemIsInPlay } from "./live-item";
import { conditionsMet } from "./predicates";

export interface StandingGrant {
  capability: string;
  capabilityId: string;
  ruleIndex: number;
  kind: EffectKind;
  /** The effect's own parameters, exactly as compiled. Consumers read the ones they understand. */
  params: Record<string, unknown>;
  /** False when a guard is unmet, or could not be answered at all. */
  active: boolean;
  /** Why not, when `active` is false. Populated for both cases; the sheet shows it. */
  reason?: string;
}

function grantsOf(capability: Capability, rule: CapabilityRule, index: number, actor: any) {
  const guards = conditionsMet(rule.condition, { self: { actor, token: tokenOf(actor) } });
  return {
    capability: capability.label,
    capabilityId: capability.id,
    ruleIndex: index,
    kind: rule.effect.kind,
    params: { ...(rule.effect as Record<string, unknown>) },
    active: guards.met,
    reason: guards.met ? undefined : (guards.blockedBy ?? "a condition is not currently met"),
  } satisfies StandingGrant;
}

function tokenOf(actor: any): any {
  return actor?.token?.object ?? actor?.getActiveTokens?.()?.[0] ?? null;
}

/**
 * Every permanently-true property a compiled capability states about this creature.
 *
 * Includes inactive grants on purpose: "you have resistance while raging" is a real answer to "what
 * does this creature have", and hiding it would make the survey disagree with the sheet.
 */
export function standingGrants(actor: any): StandingGrant[] {
  const out: StandingGrant[] = [];
  for (const binding of bindingsFor(actor)) {
    const capability = binding.capability;
    if (capability.status === "rejected") continue;
    if (!itemIsInPlay(binding.item, actor)) continue;
    const rules = capability.rules ?? [];
    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index];
      if (!isStanding(rule)) continue;
      out.push(grantsOf(capability, rule, index, actor));
    }
  }
  return out;
}

/** The active ones only, which is what every consumer below wants. */
function activeOfKind(actor: any, kind: EffectKind): StandingGrant[] {
  return standingGrants(actor).filter((g) => g.active && g.kind === kind);
}

/**
 * Senses a compiled capability grants, as `{name, range}` in scene units.
 *
 * Returned raw rather than mapped onto this module's capability tags, because the tag vocabulary
 * (`truesight`, `devilsSight`, `seeInvisible` …) is a D&D concept and belongs to `src/system/`. The
 * mapping happens in `dnd5e-concealment.ts`, which is also the only consumer.
 *
 * A range of `Infinity` means the descriptor said the sense is unlimited; a missing range means the
 * model read a sense with no distance, which for our purposes is the same as unlimited — a creature
 * that "sees in magical darkness" does so as far as it can see.
 */
export function capabilitySenses(actor: any): Array<{ sense: string; range: number }> {
  const out: Array<{ sense: string; range: number }> = [];
  for (const grant of activeOfKind(actor, "grant_sense")) {
    const sense = String(grant.params.sense ?? "")
      .trim()
      .toLowerCase();
    if (!sense) continue;
    // Only a literal number is taken. A `grant_sense` range may be a quantity expression, and
    // resolving one needs the async quantity layer — a sense with an unreadable range is reported as
    // unlimited rather than dropped, which is the generous direction for a detection question.
    const raw = grant.params.range;
    const range = typeof raw === "number" && Number.isFinite(raw) ? raw : Infinity;
    out.push({ sense, range });
  }
  return out;
}

/** Senses a compiled capability says this creature does NOT have, by name. */
export function capabilityNegatedSenses(actor: any): string[] {
  return activeOfKind(actor, "negate_sense")
    .map((g) =>
      String(g.params.sense ?? "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

/**
 * Free-text capabilities the creature has always — "breathes water", "cannot be surprised".
 *
 * The largest standing bucket and the one with no consumer yet, deliberately. `grant_capability` is
 * where the corpus put everything that is a true statement about a creature and not a mechanic anyone
 * has wired, so it is exposed for the survey and for the companion module's prompt rather than acted
 * on. Wiring one means picking a phrase and owning the match, which is a decision per capability.
 */
export function capabilityGrants(actor: any): string[] {
  return activeOfKind(actor, "grant_capability")
    .map((g) => String(g.params.capability ?? "").trim())
    .filter(Boolean);
}

/** Console diagnostic: everything permanently true about the selected creatures. */
export function surveyStanding(): Record<string, unknown> {
  const tokens: any[] = (canvas as any)?.tokens?.controlled ?? [];
  const report = tokens.map((token) => {
    const actor = token?.actor;
    const grants = standingGrants(actor);
    return {
      name: String(actor?.name ?? token?.name ?? "?"),
      active: grants.filter((g) => g.active).length,
      conditional: grants.filter((g) => !g.active).length,
      senses: capabilitySenses(actor),
      negated: capabilityNegatedSenses(actor),
      capabilities: capabilityGrants(actor),
      grants,
    };
  });
  return { selected: report.length, report };
}
