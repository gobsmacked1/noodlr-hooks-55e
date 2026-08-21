// Standing up from Prone, and crawling when a creature stays down.
//
// Two failures, one report: the Archmage was knocked Prone and never stood, then walked his
// full Speed on later turns. Core will charge crawl rates only if Crawl is selected, and it
// never charges the stand-up. The Speed ledger already exists; this is a charge on the status
// coming off, plus a refusal to walk/fly/jump while the status is still on.
//
// The planner decides WHETHER to stand (`shouldStand`). This file does the arithmetic and the
// vetoes. Staying Prone is legal — ranged attackers have Disadvantage — and is not refused.

import { MODULE_ID, log } from "../constants";
import { isMovementCapEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  PRONE_STATUS,
  cannotStandReason,
  crawlAction,
  isProne,
  standCost,
} from "../system/dnd5e-prone";
import { isAutomating } from "./economy/enforce";
import { dashesTaken, stampFor } from "./economy/ledger";
import { isForcedMovement } from "./shove";
import { readFlag } from "../util/flags";

const FLAG = "stood";

interface Stood {
  stamp: string;
  cost: number;
}

/** Same-client shadow — `setFlag` is a round trip and the next drag is this client. */
const local = new Map<string, Stood>();

function keyOf(actor: any): string {
  return String(actor?.uuid ?? "");
}

function readStood(actor: any, stamp: string): number {
  const shadow = local.get(keyOf(actor));
  if (shadow?.stamp === stamp) return shadow.cost;
  const stored = readFlag(actor, FLAG) as Stood | undefined;
  if (stored && stored.stamp === stamp && Number.isFinite(Number(stored.cost))) {
    return Number(stored.cost);
  }
  return 0;
}

/** Movement already spent standing this turn. 0 when they have not, or the stamp moved on. */
export function stoodThisTurn(actor: any, combat: any, combatant: any): number {
  if (!actor || !combat || !combatant) return 0;
  return readStood(actor, stampFor(combat, combatant));
}

function noteStand(actor: any, combat: any, combatant: any, cost: number): void {
  const stamp = stampFor(combat, combatant);
  const next: Stood = { stamp, cost };
  local.set(keyOf(actor), next);
  void Promise.resolve(actor?.setFlag?.(MODULE_ID, FLAG, next)).catch(() => {
    /* the shadow already has it for this client */
  });
}

function remainingMovement(doc: any): { speed: number; left: number; need: number } | null {
  const actor = doc?.actor;
  const modes = actor?.system?.attributes?.movement;
  const speed = Number(modes?.walk ?? modes?.speed);
  if (!Number.isFinite(speed) || speed <= 0) return { speed: 0, left: 0, need: 0 };

  const need = standCost(speed);
  const combat = (globalThis as any).game?.combat;
  const combatant = doc?.combatant;
  if (!combat?.started || !combatant) return { speed, left: speed, need };

  let spent = 0;
  for (const waypoint of doc?.movementHistory ?? []) {
    const cost = Number(waypoint?.cost);
    if (Number.isFinite(cost)) spent += cost;
  }
  const dashes = dashesTaken(actor, combat, combatant);
  const allowance = speed * (1 + dashes) - readStood(actor, stampFor(combat, combatant));
  return { speed, left: Math.max(0, allowance - spent), need };
}

function units(): string {
  return String((globalThis as any).canvas?.scene?.grid?.units ?? "ft");
}

function actionOf(doc: any, movement: any): string {
  const pending = movement?.pending?.waypoints ?? [];
  const passed = movement?.passed?.waypoints ?? [];
  const last = pending[pending.length - 1] ?? passed[passed.length - 1];
  const named = String(last?.action ?? movement?.destination?.action ?? doc?.movementAction ?? "");
  return named || "walk";
}

function isProneOnly(effect: any): boolean {
  const statuses: Set<string> | string[] | undefined = effect?.statuses;
  if (statuses instanceof Set) return statuses.size === 1 && statuses.has(PRONE_STATUS);
  if (Array.isArray(statuses)) return statuses.length === 1 && statuses[0] === PRONE_STATUS;
  return String(effect?.flags?.core?.statusId ?? "") === PRONE_STATUS;
}

/**
 * Take Prone off. Same delete-by-statuses pattern as Dodge: `toggleStatusEffect` misses a
 * Convenient Effects copy that carries the same status under a different id.
 */
export async function standUp(actor: any): Promise<{ ok: boolean; cost: number; reason?: string }> {
  if (!actor || !isProne(actor)) return { ok: true, cost: 0 };

  const blocked = cannotStandReason(actor);
  if (blocked) return { ok: false, cost: 0, reason: blocked };

  const token = actor.token ?? actor.getActiveTokens?.()?.[0]?.document;
  const remaining = remainingMovement(token ?? { actor, combatant: actor.combatant });
  if (remaining && remaining.speed <= 0) {
    return { ok: false, cost: 0, reason: "no-speed" };
  }
  const cost = remaining?.need ?? 0;
  if (remaining && remaining.left + 0.01 < cost) {
    return { ok: false, cost, reason: "spent" };
  }

  try {
    const stale: string[] = [];
    for (const effect of (actor.effects ?? []) as any[]) {
      if (isProneOnly(effect)) stale.push(String(effect.id));
    }
    if (!stale.length) return { ok: true, cost: 0 };
    await actor.deleteEmbeddedDocuments?.("ActiveEffect", stale);
  } catch (err) {
    log(`prone: could not stand ${String(actor?.name)}:`, err);
    return { ok: false, cost, reason: "write" };
  }

  const combat = (globalThis as any).game?.combat;
  const combatant = token?.combatant ?? actor.combatant;
  if (combat?.started && combatant && cost > 0) noteStand(actor, combat, combatant, cost);
  log(`prone: ${String(actor?.name)} stands (${cost} ${units()})`);
  return { ok: true, cost };
}

function warn(key: string, data: Record<string, unknown>): void {
  try {
    (globalThis as any).ui?.notifications?.warn(
      (globalThis as any).game?.i18n?.format?.(key, data) ?? key,
    );
  } catch {
    /* a missing toast is not a rules failure */
  }
}

export function registerProneWatch(): void {
  if (!isDnd5e()) return;

  // Walk / fly / jump while Prone is the crawl rule, not the Speed cap. Forced movement is exempt.
  // Automation passes `crawl` itself. The GM is exempt the same way the Speed cap is — staging.
  Hooks.on("preMoveToken", (doc: any, movement: any) => {
    try {
      const game = (globalThis as any).game;
      if (game?.user?.isGM || isAutomating()) return true;
      if (isForcedMovement(movement)) return true;
      if (!isProne(doc?.actor)) return true;
      const action = actionOf(doc, movement);
      if (action === "crawl") return true;
      log(`prone: refused ${action} while Prone for ${String(doc?.name)}`);
      warn("NOODLRHOOKS.Combat.Prone.Crawl", { name: String(doc?.name ?? "") });
      return false;
    } catch (err) {
      log("prone: could not check a move:", err);
      return true;
    }
  });

  // Standing is a status coming off, not a move. Charge it on the acting client.
  Hooks.on("preDeleteActiveEffect", (effect: any) => {
    try {
      const game = (globalThis as any).game;
      if (game?.user?.isGM) return true;
      if (!isProneOnly(effect)) return true;
      const actor = effect.parent;
      if (!actor || !isDnd5e()) return true;

      const blocked = cannotStandReason(actor);
      if (blocked) {
        warn("NOODLRHOOKS.Combat.Prone.Incapacitated", {
          name: String(actor?.name ?? ""),
          status: blocked,
        });
        return false;
      }

      if (!isMovementCapEnabled()) return true;

      const combat = game.combat;
      const token = actor.token ?? actor.getActiveTokens?.()?.[0]?.document;
      const combatant = token?.combatant ?? actor.combatant;
      if (!combat?.started) return true;
      if (!combatant || String(combatant.id) !== String(combat.combatant?.id ?? "")) {
        warn("NOODLRHOOKS.Combat.Prone.OffTurn", { name: String(actor?.name ?? "") });
        return false;
      }

      const remaining = remainingMovement(token ?? { actor, combatant });
      if (!remaining) return true;
      if (remaining.left + 0.01 < remaining.need) {
        warn("NOODLRHOOKS.Combat.Prone.CannotStand", {
          name: String(actor?.name ?? ""),
          need: remaining.need,
          left: Math.round(remaining.left),
          units: units(),
        });
        return false;
      }
      if (remaining.need > 0) noteStand(actor, combat, combatant, remaining.need);
      return true;
    } catch (err) {
      log("prone: could not check standing:", err);
      return true;
    }
  });
}

export function surveyProne(): unknown {
  const token: any = (globalThis as any).canvas?.tokens?.controlled?.[0];
  if (!token) return { error: "select a token" };
  const actor = token.actor;
  const remaining = remainingMovement(token.document);
  return {
    token: String(token.document?.name ?? "?"),
    prone: isProne(actor),
    crawlAction: crawlAction() ?? "— none —",
    standCost: remaining?.need ?? null,
    remaining: remaining?.left ?? null,
    stoodThisTurn: actor
      ? stoodThisTurn(actor, (globalThis as any).game?.combat, token.document?.combatant)
      : 0,
    cannotStand: cannotStandReason(actor),
  };
}
