// Making a d20 that has already been rolled worse, and leaving an honest card behind.
//
// Silvery Barbs is the only thing that needs this, and it is the whole reason the spell was refused twice:
// "it needs a d20 we did not roll to be rerolled after the fact". The die is in a chat message, evaluated,
// serialized and rendered. So the question is not how to roll a d20 — it is how to put a second one beside
// the first without the card going on to claim the first one is what happened.
//
// THE ANSWER IS THE SHAPE dnd5e ALREADY HAS FOR DISADVANTAGE. A d20 with two results, the higher struck
// through, is not a hack: it is exactly what the tooltip draws for every rolled-with-disadvantage attack at
// the table, so a reader recognises it without being taught anything. That also means every downstream
// reading comes right for free — `D20Roll#isCritical` asks `this.d20.isCriticalSuccess`, which asks the
// DIE's total, which is the sum of its ACTIVE results. Discard the 19 and keep the 3 and the roll stops
// being a critical by itself, with nothing here saying so.
//
// PATCHED THROUGH JSON RATHER THAN ON THE LIVE ROLL, deliberately. `Roll#total` is a cached `_total` that is
// only recomputed by evaluation, and re-evaluating an evaluated roll is not a supported operation — it would
// either throw or reroll every die in the formula, including the ones nobody touched. `Roll.toJSON` carries
// `total` and `evaluated`, and `fromData` restores both, so writing the new total into the serialized form is
// the one path that does not depend on internals.
//
// WHAT IS NOT DONE HERE: deciding whether the new result changes anything. The die is a number; whether that
// number still beats an AC or a DC is the caller's question, because the caller is the one holding the
// verdict. See `rules/barbs.ts`.

import { log } from "../constants";

/** What a reroll did. `changed` is false when the fresh die was no better for the barber. */
export interface Reroll {
  /** The result that had been kept before this. */
  was: number;
  /** The fresh d20. */
  rolled: number;
  /** Whichever of the two is now standing. */
  kept: number;
  /** The roll's new total, modifiers unchanged. */
  total: number;
  /** True when the kept die actually moved, i.e. the fresh one was lower. */
  changed: boolean;
  /**
   * Is the kept die now a critical success, a critical failure, or neither?
   *
   * Reported rather than left to the caller because the thresholds are not always 20 and 1 — a Champion
   * fighter crits on 19, and a Hexblade's Curse moves it again — and they live in the die's own options where
   * dnd5e's configuration put them. `null` means the option was not numeric, which is what `D20Die` reads as
   * "this roll has no critical", and it must be distinguishable from "did not reach the threshold".
   */
  crit: boolean | null;
  fumble: boolean | null;
}

/**
 * Reroll the d20 on an evaluated chat message and keep the lower result.
 *
 * Returns null when there is nothing to reroll — no roll, not a d20, unevaluated, unreadable. Null is not a
 * failure to report loudly: the caller has already spent somebody's spell slot by the time it gets here, so
 * what it needs is a clear "the die did not move", which is also what a fresh 20 produces.
 */
export async function rerollLower(message: any): Promise<Reroll | null> {
  const roll: any = message?.rolls?.[0];
  const die: any = roll?.terms?.[0];
  const before = Number(roll?.total);
  const kept = Number(die?.total);
  if (!Number.isFinite(before) || !Number.isFinite(kept)) return null;
  if (Number(die?.faces) !== 20) return null;

  const fresh = await rollD20();
  if (fresh === null) return null;

  const now = Math.min(kept, fresh);
  const success = threshold(die?.options?.criticalSuccess);
  const failure = threshold(die?.options?.criticalFailure);
  const result: Reroll = {
    was: kept,
    rolled: fresh,
    kept: now,
    total: before + (now - kept),
    changed: fresh < kept,
    crit: success === null ? null : now >= success,
    fumble: failure === null ? null : now <= failure,
  };

  try {
    await message.update({ rolls: [patched(roll, fresh, kept, result.total)] });
  } catch (err) {
    // The arithmetic is still correct and the caller can still act on it; what is lost is the card telling
    // the truth about it. Worth a line, not worth abandoning the reaction somebody just paid for.
    log("reroll: the message could not be rewritten, so the card still shows the first die:", err);
  }
  return result;
}

/**
 * Reroll the d20 and keep the new result, even when it is worse.
 *
 * RAW for Heroic Inspiration, Indomitable, Disciplined Survivor and Seeking Spell: "you must use the
 * new roll". That is the opposite of Silvery Barbs, and the card still shows both faces — the first
 * struck through — so a reader can see what was spent.
 */
export async function rerollKeepNew(message: any): Promise<Reroll | null> {
  const roll: any = message?.rolls?.[0];
  const die: any = roll?.terms?.[0];
  const before = Number(roll?.total);
  const kept = Number(die?.total);
  if (!Number.isFinite(before) || !Number.isFinite(kept)) return null;
  if (Number(die?.faces) !== 20) return null;

  const fresh = await rollD20();
  if (fresh === null) return null;
  return writeKept(message, roll, die, before, kept, fresh);
}

/**
 * Replace the standing d20 face with a stated number (Stroke of Luck's 20).
 *
 * Same card shape as a keep-new reroll: the original face is struck through and the replacement
 * stands, so the tooltip does not look like the player simply rolled a 20.
 */
export async function replaceD20(message: any, face: number): Promise<Reroll | null> {
  const roll: any = message?.rolls?.[0];
  const die: any = roll?.terms?.[0];
  const before = Number(roll?.total);
  const kept = Number(die?.total);
  if (!Number.isFinite(before) || !Number.isFinite(kept)) return null;
  if (Number(die?.faces) !== 20) return null;
  if (!Number.isFinite(face) || face < 1) return null;
  return writeKept(message, roll, die, before, kept, Math.round(face));
}

/**
 * Roll a formula and add it to the card's total (Bardic Inspiration, Peerless Skill).
 *
 * The d20 face is left alone — this is a modifier, not a replacement. A zero or unreadable
 * roll is a no-op rather than a rewrite, so a failed `Roll` cannot invent a +0 that looks
 * like a spent die.
 */
export async function addRoll(
  message: any,
  formula: string,
  rollData?: Record<string, unknown>,
): Promise<{ was: number; rolled: number; total: number; changed: boolean } | null> {
  return adjustByRoll(message, formula, 1, rollData);
}

/**
 * Roll a formula and subtract it from the card's total (Cutting Words).
 *
 * A damage card uses the same write: `rolls[0].total` is what `damageParts` reads.
 * Multi-type cards (1d8 piercing + 1d6 fire) subtract from the first roll only,
 * clamped at 0 — that is the displayed total's first term, not a second chat roll.
 */
export async function subtractRoll(
  message: any,
  formula: string,
  rollData?: Record<string, unknown>,
): Promise<{ was: number; rolled: number; total: number; changed: boolean } | null> {
  return adjustByRoll(message, formula, -1, rollData);
}

async function adjustByRoll(
  message: any,
  formula: string,
  sign: 1 | -1,
  rollData?: Record<string, unknown>,
): Promise<{ was: number; rolled: number; total: number; changed: boolean } | null> {
  const before = Number(message?.rolls?.[0]?.total);
  if (!Number.isFinite(before)) return null;
  const text = String(formula ?? "").trim();
  if (!text) return null;
  const rolled = await rollFormula(text, rollData);
  if (rolled === null || !Number.isFinite(rolled) || rolled === 0) return null;
  const total = await addToTotal(message, sign * rolled);
  return {
    was: before,
    rolled,
    total: total ?? before + sign * rolled,
    changed: true,
  };
}

async function rollFormula(formula: string, rollData?: Record<string, unknown>): Promise<number | null> {
  try {
    const Roll: any = (globalThis as any).Roll;
    const roll = await new Roll(formula, rollData ?? {}).evaluate();
    const value = Number(roll?.total);
    return Number.isFinite(value) ? value : null;
  } catch (err) {
    log(`reroll: could not roll ${formula}:`, err);
    return null;
  }
}

/**
 * Add a flat number to the roll's total without touching the die.
 *
 * Indomitable's Fighter-level bonus rides on the NEW d20 (`rerollKeepNew` first, then this).
 * Indomitable Might uses `setTotal` instead — that replaces the whole check, not a modifier.
 */
export async function addToTotal(message: any, delta: number): Promise<number | null> {
  const roll: any = message?.rolls?.[0];
  const before = Number(roll?.total);
  if (!Number.isFinite(before) || !Number.isFinite(delta) || !delta) return Number.isFinite(before) ? before : null;
  const total = before + Math.round(delta);
  try {
    const json = roll.toJSON();
    json.total = total;
    json.evaluated = true;
    await message.update({ rolls: [json] });
  } catch (err) {
    log("reroll: could not add to the total, so the card is stale:", err);
  }
  return total;
}

/**
 * Overwrite the roll's total (Indomitable Might: use the Strength score in place of the check).
 *
 * The die is left alone. The number that matters for a DC is `rolls[0].total`, and rewriting the
 * face would invent a d20 the creature never rolled.
 */
export async function setTotal(message: any, total: number): Promise<number | null> {
  const roll: any = message?.rolls?.[0];
  if (!roll || !Number.isFinite(total)) return null;
  try {
    const json = roll.toJSON();
    json.total = Math.round(total);
    json.evaluated = true;
    await message.update({ rolls: [json] });
  } catch (err) {
    log("reroll: could not replace the total, so the card is stale:", err);
  }
  return Math.round(total);
}

/** The standing d20 face, or NaN when there is no readable die. */
export function standingD20(message: any): number {
  const value = Number(message?.rolls?.[0]?.terms?.[0]?.total);
  return Number.isFinite(value) ? value : NaN;
}

async function writeKept(
  message: any,
  roll: any,
  die: any,
  before: number,
  kept: number,
  fresh: number,
): Promise<Reroll> {
  const success = threshold(die?.options?.criticalSuccess);
  const failure = threshold(die?.options?.criticalFailure);
  const result: Reroll = {
    was: kept,
    rolled: fresh,
    kept: fresh,
    total: before + (fresh - kept),
    changed: fresh !== kept,
    crit: success === null ? null : fresh >= success,
    fumble: failure === null ? null : fresh <= failure,
  };
  try {
    await message.update({ rolls: [patchedKeepNew(roll, fresh, result.total)] });
  } catch (err) {
    log("reroll: the message could not be rewritten, so the card still shows the first die:", err);
  }
  return result;
}

/** Keep-new / replace: the previous standing result is always discarded. */
function patchedKeepNew(roll: any, fresh: number, total: number): any {
  const json = roll.toJSON();
  const term: any = json?.terms?.[0];
  if (!term) return json;

  const results: any[] = Array.isArray(term.results) ? term.results : [];
  for (const entry of results) {
    if (entry?.active !== true) continue;
    entry.active = false;
    entry.discarded = true;
  }
  results.push({ result: fresh, active: true, discarded: false });
  term.results = results;
  json.total = total;
  json.evaluated = true;
  return json;
}

/**
 * The original roll's JSON with a second die result in it.
 *
 * The fresh result is appended rather than substituted, and the loser is marked `discarded` rather than
 * deleted, because both of those are what make the tooltip legible: a struck-through 19 beside a live 3 says
 * what happened, and a bare 3 says a wizard rolled badly.
 *
 * `active` is what the die sums, so it is the only field that has to be exactly right. Everything else here
 * is presentation.
 */
function patched(roll: any, fresh: number, kept: number, total: number): any {
  const json = roll.toJSON();
  const term: any = json?.terms?.[0];
  if (!term) return json;

  const freshWins = fresh < kept;
  const results: any[] = Array.isArray(term.results) ? term.results : [];
  for (const entry of results) {
    // Anything already struck out — the loser of a real advantage roll — stays struck out. Only the result
    // that was standing is at stake.
    if (entry?.active !== true) continue;
    entry.active = !freshWins;
    entry.discarded = freshWins;
  }
  results.push({ result: fresh, active: freshWins, discarded: !freshWins });
  term.results = results;

  // Named so it reads as ours in the tooltip rather than as a disadvantage nobody applied.
  json.total = total;
  json.evaluated = true;
  return json;
}

/** `D20Die` treats a non-numeric threshold as "no critical at all", and so does this. */
function threshold(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function rollD20(): Promise<number | null> {
  return rollDie(20);
}

async function rollDie(faces: number): Promise<number | null> {
  try {
    const Roll: any = (globalThis as any).Roll;
    const roll = await new Roll(`1d${faces}`).evaluate();
    const value = Number(roll?.total);
    return Number.isFinite(value) ? value : null;
  } catch (err) {
    log(`reroll: could not roll a fresh d${faces}:`, err);
    return null;
  }
}

/** One active face on a damage (or healing) card, identified so it can be rewritten. */
export interface DamageDiePick {
  rollIndex: number;
  termIndex: number;
  resultIndex: number;
  faces: number;
  value: number;
}

/**
 * Reroll specific damage-die faces and keep the new results.
 *
 * Same JSON patch as a d20 keep-new: the old face is struck through, the fresh
 * one is appended, and `rolls[i].total` moves by the delta. `damageParts` reads
 * those totals, so this has to finish before anyone applies hit points.
 */
export async function rerollDamageDice(
  message: any,
  picks: DamageDiePick[],
): Promise<{ was: number; rolled: number; total: number; changed: boolean } | null> {
  if (!message || !picks.length) return null;
  const rolls: any[] = Array.isArray(message.rolls) ? [...message.rolls] : [];
  if (!rolls.length) return null;

  const jsons = rolls.map((roll) => rollJson(roll));
  let was = 0;
  let rolled = 0;

  for (const pick of picks) {
    const json = jsons[pick.rollIndex];
    const term: any = json?.terms?.[pick.termIndex];
    const entry: any = term?.results?.[pick.resultIndex];
    if (!json || !term || !entry || entry.active !== true) continue;
    const faces = Number(pick.faces || term.faces);
    if (!Number.isFinite(faces) || faces < 2) continue;
    const old = Number(entry.result ?? pick.value);
    if (!Number.isFinite(old)) continue;
    const fresh = await rollDie(faces);
    if (fresh === null) return null;
    entry.active = false;
    entry.discarded = true;
    term.results.push({ result: fresh, active: true, discarded: false });
    json.total = Number(json.total) + (fresh - old);
    json.evaluated = true;
    was += old;
    rolled += fresh;
  }

  if (!was && !rolled) return null;

  try {
    await message.update({ rolls: jsons });
  } catch (err) {
    log("reroll: the damage card could not be rewritten, so the faces still show the first roll:", err);
  }

  let total = 0;
  for (const json of jsons) {
    const n = Number(json?.total);
    if (Number.isFinite(n)) total += n;
  }
  return { was, rolled, total, changed: rolled !== was };
}

function rollJson(roll: any): any {
  if (typeof roll?.toJSON === "function") {
    const json = roll.toJSON();
    if (json && typeof json === "object") return json;
  }
  return {
    total: roll?.total,
    evaluated: true,
    options: roll?.options,
    terms: (roll?.terms ?? []).map((term: any) => ({
      faces: term?.faces,
      number: term?.number,
      options: term?.options,
      results: Array.isArray(term?.results) ? term.results.map((entry: any) => ({ ...entry })) : [],
    })),
  };
}
