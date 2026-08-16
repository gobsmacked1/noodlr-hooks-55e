// Reading a completed rest. D&D 5e ONLY.
//
// `dnd5e.restCompleted` is a single hook for both rest lengths, and answering "which of our two rest
// triggers does this fire" turns out to be a question with two different right answers depending on
// what the answer is FOR.
//
// THE LEDGER AND THE TRIGGERS WANT DIFFERENT ANSWERS, AND CONFLATING THEM IS THE BUG WAITING HERE.
// `noteRest()` bumps a counter that makes a `1/day` use readable again, and being generous there costs
// a charge refreshed slightly early — which is the direction this module errs in everywhere. Firing a
// trigger runs a RULE: it heals, it summons, it announces. Being generous there means a long-rest
// ability going off after a nap. So the ledger reads `newDay` as a long rest (dnd5e recovers per-day
// uses on any rest flagged that way, so our counter has to follow suit or the two disagree) while the
// triggers read only what the rest genuinely was.
//
// A LONG REST FIRES BOTH EVENTS, and THE SYSTEM IS ASKED RATHER THAN TOLD. `CONFIG.DND5E.restTypes`
// gives each rest a `recoverPeriods`, and `long`'s is `["lr", "sr"]` — dnd5e stating in its own data
// that a long rest recovers everything a short rest does. So "regain all Pact Magic slots on a Short
// Rest" fires when the warlock sleeps, which a build dispatching only `on_long_rest` would silently
// break on the commonest recharge in the game. Reading the table rather than comparing strings also
// means a rest type registered by another module works: a homebrew night's sleep declaring
// `recoverPeriods: ["sr"]` fires our short-rest rules and nothing else, with no change here. Same
// reasoning as asking `CONFIG.DND5E.spellcasting[method].slots` whether a cast spends a slot.
//
// Residual hazard, stated rather than discovered later: a capability carrying a rule on BOTH events
// for ONE mechanic fires twice on a long rest. That is bounded — `adjustUses` clamps at the item's
// maximum and the executor reports "already at N" rather than a second success — so the only shape
// that genuinely doubles is a PARTIAL recovery ("regain 1 use") declared on both events, which is a
// compiler redundancy rather than a dispatch question. The same redundancy is reachable on every other
// trigger (two `on_hit` damage rules for one rider), so it earns no special machinery here.

import type { TriggerEvent } from "../integration/capability";

export interface RestReading {
  /** Which of our rest triggers this rest fires, in dispatch order. Empty for an unreadable rest. */
  triggers: TriggerEvent[];
  /** Whether the ledger's long/day counter should advance. Deliberately looser than the triggers. */
  long: boolean;
}

/** The recovery periods a rest type claims, or null when the table cannot be read. */
function periodsOf(type: string): Set<string> | null {
  if (!type) return null;
  try {
    const raw = (globalThis as any).CONFIG?.DND5E?.restTypes?.[type]?.recoverPeriods;
    if (!raw) return null;
    const list: string[] = Array.isArray(raw) ? raw : [...raw];
    return list.length ? new Set(list.map(String)) : null;
  } catch {
    return null;
  }
}

/**
 * What `dnd5e.restCompleted` just reported.
 *
 * `result` is the system's `RestResult` and `config` its `RestConfiguration`; both are read
 * defensively, because a module that re-enters `actor._rest()` (Rest Recovery does exactly this)
 * supplies its own objects and need not populate every field.
 */
export function readRest(result: any, config: any): RestReading {
  // `type` is the authored field — dnd5e's `_rest()` merges `config.type` into the result — and
  // `longRest` is the derived boolean beside it. Read both, because a re-entering module may set
  // either.
  const type = String(result?.type ?? config?.type ?? "");
  const newDay = result?.newDay === true || config?.newDay === true;

  // The system's own answer, where there is one. The fallback is name equality, which is what this
  // reduces to for the two rest types dnd5e ships — so an unreadable CONFIG (every unit test, and any
  // future version that renames the field) degrades to correct rather than to silent.
  const periods = periodsOf(type);
  const isLong = periods ? periods.has("lr") : type === "long" || result?.longRest === true;
  // The inclusion has to be restated in the fallback, or a long rest on a world whose CONFIG cannot be
  // read stops recharging short-rest abilities — the exact failure this event exists to prevent.
  const isShort = periods
    ? periods.has("sr")
    : isLong || type === "short" || result?.longRest === false;

  const triggers: TriggerEvent[] = [];
  // Short first: a long rest includes it, and a descriptor that recharges on a short rest and then
  // does something with the charge on a long one reads in that order.
  if (isShort) triggers.push("on_short_rest");
  if (isLong) triggers.push("on_long_rest");

  return { triggers, long: isLong || newDay };
}
