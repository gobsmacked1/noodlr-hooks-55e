// The Diviner's Portent (2024), discovered from the sheet.
//
// After a Long Rest you roll two d20s (three with Greater Portent) and record them.
// You may replace any D20 Test made by you or a creature you can see with one of
// those numbers. You must choose BEFORE the roll. Once per turn. Each recorded
// number is spent once. Unused numbers are lost on the next Long Rest.
//
// THE BANK IS OURS. dnd5e stores uses, not faces. The two (or three) numbers live
// on `flags.<ns>.portent.faces` of the Portent item. A long rest replaces them.
//
// MONSTER PORTENT IS A DIFFERENT FEATURE. The MM / Adventures Faerûn trait shares
// identifier `portent` but is a reaction: roll 1d20 when you see a D20 Test and
// choose whether to use it. That prose is Trigger / Response. Matching it here
// would offer a bank the creature never rolled.
//
// GREATER PORTENT is identifier `greater-portent` and only changes the count.
// It is never the spendable item.
//
// Do not put Portent in `DICE_MOD_SPECS`. That table is after the die.

import { FLAG_NAMESPACE, hasFlag, numberFlag, readFlag } from "../util/flags";
import { isDnd5e } from "./dnd5e-rewards";
import { luckyRollKind, type LuckyRollKind } from "./dnd5e-lucky";

const NAME = /^\s*portent\s*$/i;
const GREATER_NAME = /^\s*greater\s+portent\s*$/i;
const MONSTER_SHAPE = /trigger:/i;
const MONSTER_RESPONSE = /response:/i;

const FACES_KEY = "portent";
const TURN_KEY = "portentTurn";

export type PortentRollKind = LuckyRollKind | "initiative";

/** Is this the Diviner feature, and not the monster reaction? */
export function isPortentItem(item: any): boolean {
  if (!item) return false;
  const flagged = String(readFlag(item, "diceMod") ?? "");
  if (flagged === "portent") return true;
  if (hasFlag(item, "diceMod") && flagged !== "portent") return false;
  if (String(item.type ?? "") !== "feat") return false;
  if (isMonsterPortent(item)) return false;
  const identifier = String(item.system?.identifier ?? "").trim();
  if (identifier) return identifier === "portent";
  return NAME.test(String(item.name ?? ""));
}

/** Greater Portent only raises the bank to three. It is never spent. */
export function isGreaterPortentItem(item: any): boolean {
  if (!item) return false;
  const flagged = String(readFlag(item, "diceMod") ?? "");
  if (flagged === "greater-portent") return true;
  if (String(item.type ?? "") !== "feat") return false;
  const identifier = String(item.system?.identifier ?? "").trim();
  if (identifier) return identifier === "greater-portent";
  return GREATER_NAME.test(String(item.name ?? ""));
}

/** MM / Faerûn reaction-shaped Portent. */
export function isMonsterPortent(item: any): boolean {
  const text = String(item?.system?.description?.value ?? item?.system?.description ?? "");
  return MONSTER_SHAPE.test(text) && MONSTER_RESPONSE.test(text);
}

/** How many d20s a Long Rest records for this creature. */
export function portentDiceCount(actor: any): number {
  const item = portentItem(actor);
  const flagged = item ? numberFlag(item, "portentDice") : null;
  if (flagged === 2 || flagged === 3) return flagged;
  for (const it of actor?.items ?? []) {
    if (isGreaterPortentItem(it)) return 3;
  }
  return 2;
}

/** The Portent feature on this creature, even with an empty bank. */
export function portentItem(actor: any): any | null {
  if (!actor || !isDnd5e()) return null;
  for (const item of actor.items ?? []) {
    if (isPortentItem(item)) return item;
  }
  return null;
}

/** Recorded faces still on the item, each an integer 1–20. */
export function facesOf(item: any): number[] {
  return parseFaces(readFlag(item, FACES_KEY));
}

export function parseFaces(raw: unknown): number[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { faces?: unknown }).faces)
      ? (raw as { faces: unknown[] }).faces
      : [];
  const out: number[] = [];
  for (const entry of list) {
    const n = Number(entry);
    if (Number.isInteger(n) && n >= 1 && n <= 20) out.push(n);
  }
  return out;
}

export function portentHasFace(item: any): boolean {
  return facesOf(item).length > 0;
}

/** Clock default: a banked number spent forever is unrecoverable. */
export function portentTimeoutId(): string {
  return "decline";
}

/**
 * Which D20 Test this preRoll is.
 *
 * Initiative is a D20 Test and Portent may replace it. Replay must call
 * `rollInitiativeDialog`, not `rollAbilityCheck` — that is why Lucky skips
 * this hook name and this file does not.
 */
export function portentRollKind(hookNames: unknown): PortentRollKind | null {
  const names = Array.isArray(hookNames) ? hookNames.map((n) => String(n)) : [];
  if (names.includes("initiativeDialog")) return "initiative";
  return luckyRollKind(hookNames);
}

export async function writePortentFaces(item: any, faces: number[]): Promise<void> {
  const clean = parseFaces(faces);
  if (typeof item?.setFlag === "function") {
    await item.setFlag(FLAG_NAMESPACE, FACES_KEY, { faces: clean });
    return;
  }
  item.flags ??= {};
  item.flags[FLAG_NAMESPACE] ??= {};
  item.flags[FLAG_NAMESPACE][FACES_KEY] = { faces: clean };
}

/** Remove the face at `index` and write the rest back. Returns the spent number, or null. */
export async function spendPortentFace(item: any, index: number): Promise<number | null> {
  const faces = facesOf(item);
  if (index < 0 || index >= faces.length) return null;
  const [spent] = faces.splice(index, 1);
  await writePortentFaces(item, faces);
  return spent ?? null;
}

export function portentTurnStamp(): string {
  const combat: any = (globalThis as any).game?.combat;
  if (!combat?.started) return "ooc";
  return `${String(combat.id ?? "")}:${Number(combat.round ?? 0)}:${Number(combat.turn ?? 0)}`;
}

export function portentSpentThisTurn(actor: any): boolean {
  const stamp = portentTurnStamp();
  return String(readFlag(actor, TURN_KEY) ?? "") === stamp;
}

export async function notePortentSpent(actor: any): Promise<void> {
  if (!actor) return;
  const stamp = portentTurnStamp();
  if (typeof actor.setFlag === "function") {
    await actor.setFlag(FLAG_NAMESPACE, TURN_KEY, stamp);
    return;
  }
  actor.flags ??= {};
  actor.flags[FLAG_NAMESPACE] ??= {};
  actor.flags[FLAG_NAMESPACE][TURN_KEY] = stamp;
}

export async function clearPortentTurn(actor: any): Promise<void> {
  if (!actor) return;
  if (typeof actor.unsetFlag === "function") {
    try {
      await actor.unsetFlag(FLAG_NAMESPACE, TURN_KEY);
      return;
    } catch {
      /* a missing flag is already clear */
    }
  }
  if (actor.flags?.[FLAG_NAMESPACE]) delete actor.flags[FLAG_NAMESPACE][TURN_KEY];
}

export async function rollPortentFaces(count: number): Promise<number[]> {
  const n = Math.max(0, Math.round(count));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const face = await rollD20();
    if (face !== null) out.push(face);
  }
  return out;
}

async function rollD20(): Promise<number | null> {
  try {
    const Roll: any = (globalThis as any).Roll;
    if (!Roll) return null;
    const roll = await new Roll("1d20").evaluate();
    const value = Number(roll?.total);
    return Number.isInteger(value) && value >= 1 && value <= 20 ? value : null;
  } catch {
    return null;
  }
}
