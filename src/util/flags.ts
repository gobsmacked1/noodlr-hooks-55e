// Reading flags across the split.
//
// Every escape hatch this module documents — `extraAction`, `extraBonus`, `extraReaction`,
// `attacksPerAction`, `bonusDash`, `damageRider`, `sniper`, `bonusHide` — was documented under
// `flags.noodlr.*` before the automation moved out of that module, and GMs have Active Effects and
// homebrew items built against those paths. A flag path a user was told to write is a contract, and
// renaming the namespace out from under it would break worlds silently: an Active Effect targeting a
// flag nobody reads produces no error, just a feature that quietly stops working.
//
// So reads check this module's namespace first and fall back to `noodlr`, and writes only ever go to
// this module's own. The fallback is permanent rather than a migration window — there is no way to
// rewrite an Active Effect someone will author next year against the older documentation, and the
// cost of keeping it is one extra property lookup.

import { LEGACY_MODULE_ID, MODULE_ID } from "../constants";

/**
 * Read a module flag off any document, preferring this module's namespace.
 *
 * Deliberately reads the raw `flags` object as well as calling `getFlag`: Active Effects apply to the
 * flags object directly, and on a synthetic (unlinked) actor `getFlag` has been seen to answer from a
 * stale prepared copy. Whichever answers first wins, with the modern namespace ahead of the legacy one
 * in both passes.
 */
export function readFlag(doc: any, key: string): unknown {
  if (!doc) return undefined;
  for (const ns of [MODULE_ID, LEGACY_MODULE_ID]) {
    const direct = doc?.flags?.[ns]?.[key];
    if (direct !== undefined && direct !== null) return direct;
    try {
      const got = doc?.getFlag?.(ns, key);
      if (got !== undefined && got !== null) return got;
    } catch {
      // An unregistered namespace throws on some Foundry builds; the other pass still answers.
    }
  }
  return undefined;
}

/** `readFlag` as a yes/no, for the several hatches that are bare presence markers. */
export function hasFlag(doc: any, key: string): boolean {
  return Boolean(readFlag(doc, key));
}

/**
 * `readFlag` as a finite number, or null.
 *
 * Null rather than 0 on purpose: every numeric hatch here means "instead of what was calculated", and
 * a malformed value must fall through to the calculation rather than override it with zero.
 */
export function numberFlag(doc: any, key: string): number | null {
  const value = Number(readFlag(doc, key));
  return Number.isFinite(value) ? value : null;
}

/** Where a flag write goes. Always this module's namespace — the fallback is for reading only. */
export const FLAG_NAMESPACE = MODULE_ID;
