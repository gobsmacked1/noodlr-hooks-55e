// The Lucky feat (2024), discovered from the sheet.
//
// 2024 spends a Luck Point *with* the roll: Advantage on your own D20 Test, or
// Disadvantage on an attack against you. 2014 was "see the roll, add a d20, pick".
// Implementing the older sentence against a 2024 sheet would popup after the die
// and teach the wrong moment.
//
// IDENTIFIER COLLISION. The shipped Halfling 2014 race trait is `identifier: lucky`
// on `type: race`. The Lucky *feat* is also `lucky`, on `type: feat`. Matching the
// identifier alone would offer Halfling Luck (the system already rerolls a 1 via
// `flags.dnd5e.halflingLucky`) and steal the feat. 2024 species is identifier `luck`.
// Neither of those is this file.
//
// A Luck Point is a limited use. Unreadable uses are a refusal — offering a pool
// we cannot spend would popup and then change nothing.

import { hasFlag, readFlag } from "../util/flags";
import { usesRemaining } from "../capability/primitives";
import { isDnd5e } from "./dnd5e-rewards";

const NAME = /^\s*lucky\s*$/i;

export type LuckyMode = "self" | "incoming";

/** Is this the Lucky feat, and not Halfling Luck / species Luck? */
export function isLuckyItem(item: any): boolean {
  if (!item) return false;
  const flagged = String(readFlag(item, "diceMod") ?? "");
  if (flagged === "lucky") return true;
  if (hasFlag(item, "diceMod") && flagged !== "lucky") return false;
  if (String(item.type ?? "") !== "feat") return false;
  const identifier = String(item.system?.identifier ?? "").trim();
  if (identifier) return identifier === "lucky";
  return NAME.test(String(item.name ?? ""));
}

/** Remaining Luck Points, or null when the pool cannot be read. */
export function luckyCharges(item: any): number | null {
  if (!isLuckyItem(item)) return null;
  return usesRemaining(item);
}

export function luckyHasCharge(item: any): boolean {
  const left = luckyCharges(item);
  return left !== null && left > 0;
}

/** The Lucky feat on this creature that still has a point, or null. */
export function luckyItem(actor: any): any | null {
  if (!actor || !isDnd5e()) return null;
  for (const item of actor.items ?? []) {
    if (isLuckyItem(item) && luckyHasCharge(item)) return item;
  }
  return null;
}

/** Clock default: a Luck Point is depleting, so a timeout never spends it. */
export function luckyTimeoutId(): string {
  return "decline";
}

export type LuckyRollKind = "attack" | "save" | "check" | "skill" | "tool" | "concentration" | "death";

/**
 * Which D20 Test this preRoll is, or null when Lucky must not hold it.
 *
 * Initiative carries `d20Test` but replaying `rollAbilityCheck` would break the
 * tracker. Formula / damage / recharge are not D20 Tests.
 */
export function luckyRollKind(hookNames: unknown): LuckyRollKind | null {
  const names = Array.isArray(hookNames) ? hookNames.map((n) => String(n)) : [];
  if (names.includes("initiativeDialog")) return null;
  if (names.includes("attack")) return "attack";
  if (names.includes("deathSave")) return "death";
  if (names.includes("concentration")) return "concentration";
  if (names.includes("SavingThrow")) return "save";
  if (names.includes("skill")) return "skill";
  if (names.includes("tool")) return "tool";
  if (names.includes("AbilityCheck") || names.includes("abilityCheck")) return "check";
  if (names.includes("d20Test")) return "check";
  return null;
}

export function alreadyHasAdvantage(config: any): boolean {
  if (config?.advantage === true) return true;
  return modeOf(config) === 1;
}

export function alreadyHasDisadvantage(config: any): boolean {
  if (config?.disadvantage === true) return true;
  return modeOf(config) === -1;
}

function modeOf(config: any): number | null {
  const raw = config?.rolls?.[0]?.options?.advantageMode;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Self Lucky is wasted if Advantage is already on the config. */
export function shouldOfferSelf(config: any): boolean {
  return !alreadyHasAdvantage(config);
}

/** Incoming Lucky is wasted if Disadvantage is already on the attack. */
export function shouldOfferIncoming(config: any): boolean {
  return !alreadyHasDisadvantage(config);
}
