// How often a compiled rule may fire, and when that allowance comes back.
//
// Modelled on `rules/economy/ledger.ts`, and for the same reason it works there: **nothing is ever
// reset.** A tally carries the stamp of the period it belongs to, and a stale stamp reads as zero. No
// scheduled clear to get wrong, no client racing another to perform it, and a use spent before a
// reload is still spent after one.
//
// The exception is `recharge`, which is not a period at all — it is a die rolled at the start of the
// creature's turn. That one clears explicitly, when the roll says so.

import { MODULE_ID, debug, warn } from "../constants";
import { readFlag } from "../util/flags";
import { stampFor } from "../rules/economy/ledger";
import type { UsePeriod } from "../integration/capability";

const FLAG = "capUses";

interface Record_ {
  stamp: string;
  count: number;
}

type Ledger = Record<string, Record_>;

/**
 * Same-client shadow of what has been written.
 *
 * `setFlag` is a round trip, and two rules resolving in the same tick both read the pre-write value
 * without this. The flag stays the shared truth; this only stops one client racing itself.
 */
const shadow = new Map<string, Ledger>();

export function usesKey(capabilityId: string, ruleIndex: number): string {
  return `${capabilityId}:${ruleIndex}`;
}

/**
 * Which period the allowance currently belongs to.
 *
 * Derived rather than stored, so every client agrees without anyone writing anything.
 */
export function periodStamp(period: UsePeriod, actor: any, combat: any, combatant: any): string {
  switch (period) {
    case "turn":
      // Outside combat there are no turns. A constant stamp means the limit applies once rather than
      // resetting on a schedule that does not exist — permissive enough to be usable, tight enough
      // that a once-per-turn rule is not once-per-click.
      return combat?.id ? `t:${stampFor(combat, combatant)}` : "t:nocombat";
    case "round":
      return combat?.id ? `r:${combat.id}:${Number(combat.round) || 0}` : "r:nocombat";
    case "encounter":
      return combat?.id ? `e:${combat.id}` : "e:nocombat";
    case "short_rest":
      // Both counters bump on a long rest, because a long rest includes everything a short one gives.
      return `s:${restCount(actor, "short")}`;
    case "day":
    case "long_rest":
      return `l:${restCount(actor, "long")}`;
    case "recharge":
      // Not a period: cleared by a successful die roll, not by time passing.
      return "recharge";
    default:
      return "?";
  }
}

function restCount(actor: any, kind: "short" | "long"): number {
  const counters = readFlag(actor, "restCounters") as any;
  return Number(counters?.[kind]) || 0;
}

function readLedger(actor: any): Ledger {
  let ledger: Ledger = {};
  try {
    const stored = readFlag(actor, FLAG);
    if (stored && typeof stored === "object") ledger = { ...(stored as Ledger) };
  } catch {
    // An unreadable flag is an empty ledger, which errs towards letting the rule fire. That is the
    // right direction here: a creature that loses a limited ability nobody can see it lost is worse
    // than one that gets an extra use of it.
  }
  const local = shadow.get(String(actor?.uuid ?? ""));
  if (local) {
    for (const [key, entry] of Object.entries(local)) {
      const existing = ledger[key];
      if (!existing || existing.stamp !== entry.stamp || entry.count > existing.count) {
        ledger[key] = entry;
      }
    }
  }
  return ledger;
}

export interface UsesState {
  spent: number;
  remaining: number;
  max: number;
}

/** How much of a rule's allowance is left in the current period. */
export function usesLeft(
  actor: any,
  key: string,
  uses: { max: number; per: UsePeriod } | undefined,
  combat: any,
  combatant: any,
): UsesState {
  const max = Number(uses?.max);
  if (!uses || !Number.isFinite(max) || max <= 0) {
    return { spent: 0, remaining: Number.POSITIVE_INFINITY, max: Number.POSITIVE_INFINITY };
  }
  const stamp = periodStamp(uses.per, actor, combat, combatant);
  const entry = readLedger(actor)[key];
  const spent = entry && entry.stamp === stamp ? Number(entry.count) || 0 : 0;
  return { spent, remaining: Math.max(0, max - spent), max };
}

/** Record one use. Awaited, so two rules in the same tick cannot both spend the last charge. */
export async function spendUse(
  actor: any,
  key: string,
  uses: { max: number; per: UsePeriod } | undefined,
  combat: any,
  combatant: any,
): Promise<void> {
  if (!uses || !actor) return;
  const stamp = periodStamp(uses.per, actor, combat, combatant);
  const ledger = readLedger(actor);
  const existing = ledger[key];
  const next: Record_ = {
    stamp,
    count: (existing && existing.stamp === stamp ? Number(existing.count) || 0 : 0) + 1,
  };
  ledger[key] = next;

  const uuid = String(actor?.uuid ?? "");
  shadow.set(uuid, { ...(shadow.get(uuid) ?? {}), [key]: next });

  try {
    await actor.setFlag?.(MODULE_ID, FLAG, ledger);
  } catch (err) {
    // The shadow already holds it, so the acting client stays correct for this fight even when the
    // write fails — which is the case that matters, since that client is the one about to fire again.
    warn(`could not record a capability use on ${actor?.name}:`, err);
  }
}

/** Give a use back, for an effect that turned out not to happen. */
export async function refundUse(actor: any, key: string): Promise<void> {
  const ledger = readLedger(actor);
  const entry = ledger[key];
  if (!entry || entry.count <= 0) return;
  const next = { ...entry, count: entry.count - 1 };
  ledger[key] = next;
  const uuid = String(actor?.uuid ?? "");
  shadow.set(uuid, { ...(shadow.get(uuid) ?? {}), [key]: next });
  try {
    await actor.setFlag?.(MODULE_ID, FLAG, ledger);
  } catch {
    /* the shadow holds it */
  }
}

/** Clear one rule's record outright — what a successful recharge roll does. */
export async function clearUse(actor: any, key: string): Promise<void> {
  const ledger = readLedger(actor);
  if (!(key in ledger)) return;
  delete ledger[key];
  const uuid = String(actor?.uuid ?? "");
  const local = { ...(shadow.get(uuid) ?? {}) };
  delete local[key];
  shadow.set(uuid, local);
  try {
    await actor.setFlag?.(MODULE_ID, FLAG, { ...ledger, [`-=${key}`]: null });
  } catch {
    /* the shadow holds it */
  }
}

/**
 * Roll a recharge die. `spec` is the stat-block notation: "5-6", "6", or "4-6".
 *
 * A real Foundry roll, because every die in this project is. Returns null when the notation cannot be
 * read, which the caller treats as "no recharge" rather than as success.
 */
export async function rollRecharge(actor: any, spec: string): Promise<boolean | null> {
  const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(String(spec ?? ""));
  if (!match) return null;
  const low = Number(match[1]);
  if (!Number.isFinite(low)) return null;
  try {
    const Roll = (globalThis as any).Roll;
    if (!Roll) return null;
    const roll = new Roll("1d6");
    await roll.evaluate();
    const total = Number(roll.total);
    debug("recharge roll", { actor: actor?.name, spec, total });
    return total >= low;
  } catch (err) {
    warn("could not roll a recharge die:", err);
    return null;
  }
}

/** Bump a rest counter, which is what makes every rest-scoped stamp go stale at once. */
export async function noteRest(actor: any, longRest: boolean): Promise<void> {
  const counters = (readFlag(actor, "restCounters") as any) ?? {};
  const next = {
    short: (Number(counters.short) || 0) + 1,
    long: (Number(counters.long) || 0) + (longRest ? 1 : 0),
  };
  try {
    await actor.setFlag?.(MODULE_ID, "restCounters", next);
  } catch (err) {
    warn(`could not record a rest for ${actor?.name}:`, err);
  }
}

/** Test seam, and what a `deleteCombat` clears: the per-client shadow only, never the flags. */
export function __clearShadow(): void {
  shadow.clear();
}
