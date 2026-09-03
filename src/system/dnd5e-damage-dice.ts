// Features that reroll a damage (or healing) die after the card has posted.
//
// D&D 5e (2024) ONLY. Discovery lives here so the executor never learns a creature
// name. Identifier first, name only when the item has no identifier and is a feat,
// `flags.<ns>.diceMod` as the hatch. Re-identified items are never matched by name.
//
// NOT IN DICE_MOD_SPECS. That table is d20-verdict shaped, and `rerollKeepNew`
// refuses anything that is not a d20. Cutting Words on a damage roll IS that table
// (`kinds` includes `damage`); this file is Piercer, Empowered Spell, and Inspiration
// on the damage card itself.
//
// `empowered-spells` (2014) and `empowered-evocation` are different features and
// must not match.

import { hasFlag, readFlag } from "../util/flags";
import { usesRemaining } from "../capability/primitives";
import { hasInspiration, sorceryItem } from "./dnd5e-dice-mods";
import { isDnd5e } from "./dnd5e-rewards";

const PIERCER_NAME = /^\s*(piercer|puncture)\s*$/i;
const EMPOWERED_NAME = /^\s*empowered\s+spell\s*$/i;

export type DamageDieId = "piercer" | "empowered-spell" | "inspiration";

export interface ListedDie {
  rollIndex: number;
  termIndex: number;
  resultIndex: number;
  faces: number;
  value: number;
  type: string;
}

export interface DamageDieOffer {
  id: DamageDieId;
  depleting: boolean;
  item: any | null;
  pool: any | null;
  picks: ListedDie[];
  labelKey: string;
  hintKey: string;
}

/** Every active die face on the card, one row per result. Inactive (already struck) faces are skipped. */
export function listDamageDice(message: any): ListedDie[] {
  const out: ListedDie[] = [];
  const rolls: any[] = Array.isArray(message?.rolls) ? message.rolls : [];
  for (let rollIndex = 0; rollIndex < rolls.length; rollIndex++) {
    const roll = rolls[rollIndex];
    const type = String(roll?.options?.type ?? "").toLowerCase();
    const terms: any[] = Array.isArray(roll?.terms) ? roll.terms : [];
    for (let termIndex = 0; termIndex < terms.length; termIndex++) {
      const term = terms[termIndex];
      const faces = Number(term?.faces);
      if (!Number.isFinite(faces) || faces < 2) continue;
      const results: any[] = Array.isArray(term?.results) ? term.results : [];
      for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
        const entry = results[resultIndex];
        if (entry?.active !== true) continue;
        const value = Number(entry.result);
        if (!Number.isFinite(value)) continue;
        out.push({ rollIndex, termIndex, resultIndex, faces, value, type });
      }
    }
  }
  return out;
}

/** Lowest faces that are not already maxed — keep-new on a maxed die can only stay or get worse. */
export function lowestUnmaxed(dice: ListedDie[], count: number): ListedDie[] {
  const eligible = dice
    .filter((die) => die.value < die.faces)
    .slice()
    .sort((a, b) => a.value - b.value || a.faces - b.faces);
  const n = Math.max(0, Math.trunc(count));
  return eligible.slice(0, n);
}

/** Cha modifier, floored at 1 (RAW), or 1 when the score cannot be read. Capped at how many dice there are. */
export function empoweredCount(actor: any, diceCount: number): number {
  const mod = Number(actor?.system?.abilities?.cha?.mod);
  const n = Number.isFinite(mod) ? Math.max(1, Math.trunc(mod)) : 1;
  return Math.min(Math.max(0, diceCount), n);
}

export function isSpellDamage(message: any): boolean {
  if (String(message?.flags?.dnd5e?.item?.type ?? "") === "spell") return true;
  if (String(message?.flags?.dnd5e?.activity?.type ?? "") === "cast") return true;
  return false;
}

export function isHealingRoll(message: any): boolean {
  return String(message?.flags?.dnd5e?.roll?.type ?? "") === "healing";
}

export function hasPiercing(dice: ListedDie[]): boolean {
  return dice.some((die) => die.type === "piercing");
}

/**
 * Once-per-turn stamp. Empty means out of combat — Piercer is unlimited there,
 * same as Sneak Attack (there is no turn to lock). Not Portent's `"ooc"`.
 */
export function piercerStamp(combat: any): string {
  if (!combat?.started) return "";
  const id = String(combat.id ?? "");
  const round = Number(combat.round);
  const turn = Number(combat.turn);
  if (!id || !Number.isFinite(round) || !Number.isFinite(turn)) return "";
  return `${id}:${round}:${turn}`;
}

export function piercerSpent(actor: any, combat: any): boolean {
  const stamp = piercerStamp(combat);
  if (!stamp) return false;
  return String(readFlag(actor, "piercerTurn") ?? "") === stamp;
}

export function isPiercerItem(item: any): boolean {
  return matchesDieItem(item, "piercer", PIERCER_NAME);
}

export function isEmpoweredSpellItem(item: any): boolean {
  return matchesDieItem(item, "empowered-spell", EMPOWERED_NAME);
}

function matchesDieItem(item: any, id: string, name: RegExp): boolean {
  if (!item) return false;
  const flagged = String(readFlag(item, "diceMod") ?? "");
  if (flagged === id) return true;
  if (hasFlag(item, "diceMod") && flagged !== id) return false;
  const identifier = String(item.system?.identifier ?? "").trim();
  if (identifier) return identifier === id;
  if (String(item.type ?? "") !== "feat") return false;
  return name.test(String(item.name ?? ""));
}

export function piercerItem(actor: any): any | null {
  if (!actor || !isDnd5e()) return null;
  for (const item of actor.items ?? []) {
    if (isPiercerItem(item)) return item;
  }
  return null;
}

export function empoweredReady(actor: any): { item: any; pool: any } | null {
  if (!actor || !isDnd5e()) return null;
  let item: any = null;
  for (const row of actor.items ?? []) {
    if (isEmpoweredSpellItem(row)) {
      item = row;
      break;
    }
  }
  if (!item) return null;
  const pool = sorceryItem(actor);
  if (!pool) return null;
  const left = usesRemaining(pool);
  if (left !== null && left <= 0) return null;
  return { item, pool };
}

/** Clock: Piercer is free; Empowered and Inspiration never fire on a timeout. */
export function damageDieTimeoutId(options: Array<{ id: string; depleting: boolean }>): string {
  return options.find((option) => !option.depleting)?.id ?? "decline";
}

/**
 * Self offers on this damage card. Order is Piercer, Empowered, Inspiration.
 *
 * `hit` is required for Piercer: true only. A null (could not read the attack) fails closed.
 */
export function selfDamageOffers(
  actor: any,
  message: any,
  combat: any,
  hit: boolean | null,
): DamageDieOffer[] {
  if (!actor || !isDnd5e()) return [];
  const dice = listDamageDice(message);
  if (!dice.length) return [];
  const healing = isHealingRoll(message);
  const out: DamageDieOffer[] = [];

  if (!healing && hit === true && !piercerSpent(actor, combat)) {
    const item = piercerItem(actor);
    const picks = item ? lowestUnmaxed(dice.filter((die) => die.type === "piercing"), 1) : [];
    if (item && picks.length) {
      out.push({
        id: "piercer",
        depleting: false,
        item,
        pool: null,
        picks,
        labelKey: "NOODLRHOOKS.DiceMod.Piercer",
        hintKey: "NOODLRHOOKS.DiceMod.PiercerHint",
      });
    }
  }

  if (!healing && isSpellDamage(message)) {
    const ready = empoweredReady(actor);
    const picks = ready ? lowestUnmaxed(dice, empoweredCount(actor, dice.length)) : [];
    if (ready && picks.length) {
      out.push({
        id: "empowered-spell",
        depleting: true,
        item: ready.item,
        pool: ready.pool,
        picks,
        labelKey: "NOODLRHOOKS.DiceMod.EmpoweredSpell",
        hintKey: "NOODLRHOOKS.DiceMod.EmpoweredSpellHint",
      });
    }
  }

  if (hasInspiration(actor)) {
    const picks = lowestUnmaxed(dice, 1);
    if (picks.length) {
      out.push({
        id: "inspiration",
        depleting: true,
        item: null,
        pool: null,
        picks,
        labelKey: "NOODLRHOOKS.DiceMod.Inspiration",
        hintKey: "NOODLRHOOKS.DiceMod.InspirationDamageHint",
      });
    }
  }

  return out;
}
