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
  try {
    const Roll: any = (globalThis as any).Roll;
    const roll = await new Roll("1d20").evaluate();
    const value = Number(roll?.total);
    return Number.isFinite(value) ? value : null;
  } catch (err) {
    log("reroll: could not roll a fresh d20:", err);
    return null;
  }
}
