// Prone: standing costs half Speed, and staying down means crawling.
//
// Quarantined with the other 5e tables. Core charges the crawl multiplier only when the Crawl
// action is selected, and never charges standing at all — so both halves of the printed rule are
// ours. The planner's "should I stand?" is here too, because that judgement is the same in every
// campaign: melee within 5 feet is Advantage against you, and walking while Prone is a crawl.

import { hasStatus, isIncapacitated } from "./dnd5e-conditions";

export const PRONE_STATUS = "prone";

export function isProne(actor: any): boolean {
  return hasStatus(actor, PRONE_STATUS);
}

/** Half Speed, rounded down. Speed 0 or unreadable is 0 — you cannot stand without movement. */
export function standCost(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 0;
  return Math.floor(speed / 2);
}

/** The movement action Foundry uses for a creature that stays Prone. Undefined when core has none. */
export function crawlAction(): string | undefined {
  const actions: any = (globalThis as any).CONFIG?.Token?.movement?.actions;
  return actions?.crawl ? "crawl" : undefined;
}

export interface StandDecision {
  prone: boolean;
  /** Known Speed. `null` means unreadable — still stand, because a missing number must not trap them. */
  speed: number | null;
  /** Tier 4+: the creature can choose to stay down against ranged attackers. */
  keepDistance: boolean;
  /** An enemy within 5 feet — melee Advantage against a Prone target. */
  meleeWithin5: boolean;
  /** This plan spends movement. */
  travels: boolean;
  /** A melee swing from the ground is at Disadvantage. */
  meleeAttack: boolean;
  /** Flight is zeroed while Prone (`conditionEffects.crawl`). They have to stand to fly. */
  flies: boolean;
}

/**
 * Stand unless staying down is a real tactic.
 *
 * Default is stand. The one exception is an intelligent creature that can act from here against
 * only ranged threats — Disadvantage on shots at them is the reason anyone ever stays Prone on
 * purpose. An Archmage with a barbarian in its face is not that case.
 */
export function shouldStand(input: StandDecision): boolean {
  if (!input.prone) return false;
  if (input.speed === 0) return false;
  if (input.meleeWithin5 || input.flies || input.travels || input.meleeAttack) return true;
  if (input.keepDistance) return false;
  return true;
}

export function cannotStandReason(actor: any): string | null {
  if (!isProne(actor)) return null;
  if (isIncapacitated(actor)) return "incapacitated";
  return null;
}
