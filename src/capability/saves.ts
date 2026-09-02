// Turning a settled save into `on_save_failed` / `on_save_succeeded`.
//
// WHY THIS IS A FILE AND NOT FOUR LINES IN `rules/saves.ts`. Both events are ambiguous in the same
// way `on_hit` is: "when a save fails" is true of the creature that forced the save AND of the
// creature that rolled it, and the compiler has one word for both. So the direction is decided here,
// once, on evidence. A census of the live cache (`npm run census:trigger -- <cache> on_save_failed
// on_save_succeeded`) over 1,105 wordings found 328 rules on these two events; of the 249 that are
// `engine`, **188 point `effect.target` at `target`** (52 unset, 7 `self`, 2 `trigger`). Every common
// one reads "when I force a save and it fails, do this TO the creature that failed": Hold Person
// restrains, Charm Person charms, Thunderwave shoves. **These fire from the CASTER's side and only
// from the caster's side.**
//
// The saver's reading — Evasion, Avoidance, "when I fail a save I become enraged" — is a real rule
// and is NOT implemented, deliberately. It inverts every subject, so running both off one event
// would have `target` mean the saver on some rules and the caster on others with nothing on the
// descriptor to tell them apart. That needs `on_save_failed_by` / `on_save_succeeded_by`, or an
// `incoming` flag of the shape `noodlrHooks.behavior` already carries. Until then such a rule
// compiles, is bound, and never fires — which the capability sheet shows, rather than firing
// backwards. The seven `self` engine rules are not a counter-example: Contact Other Plane is a
// caster saving against their own spell (`target === self`), and the rest are the saver-side
// traits named above.
//
// SUBJECTS match the attack dispatch on purpose. `self` and `attacker` are the creature that forced
// the save; `target` and `trigger` are the creature that rolled it. Leaving `trigger` to its
// `attacker ?? target` fallback would resolve it to the caster — the same silent inversion
// `EvalContext.trigger` exists to stop.
//
// THE ACTIVITY IS NOT OPTIONAL, for the same reason it is not on `on_hit`. A Fireball compiled to
// "on a failed save, deal 8d6 fire" is the restated `damage.parts` line, and `duplicatesActivityDamage`
// can only refuse it when `ctx.activity` is set. Dispatching without it doubles every save-for-half
// spell in the world, silently, because doubling is arithmetic and nothing throws.
//
// A SAVE WITH NO DAMAGE STILL FIRES. Hold Person is the specimen: `deals === false`, no damage
// roll is coming, and the restrain is the whole of the spell. The early `if (!act.damage) return`
// in `settle()` is why this cannot be tacked onto the damage-apply loop.

import { log } from "../constants";
import { activityOf, itemOf, speakerToken } from "../rules/cards";
import { fireTrigger, type TriggerContext } from "./executor";
import type { Subject } from "./predicates";
import type { TriggerEvent } from "../integration/capability";

/** One creature, and what its save did. */
export interface SaveDispatch {
  event: Extract<TriggerEvent, "on_save_failed" | "on_save_succeeded">;
  /** The TokenDocument that saved or failed. */
  doc: any;
  /** The save's own chat message — the idempotency key. */
  saveMessage: any;
}

/**
 * One target's verdict, as `rules/saves.ts` holds it after Barbs and legendary resistance.
 *
 * Split out so a test can assert the wait without a Foundry world. `pendingResistance` is the
 * legendary-resistance window still open: a failure that `canResist` and has not been
 * *settled* yet. `offered` is set BEFORE the dialog await, so it is not the final-verdict
 * flag — `resistanceSettled` is. Firing `on_save_failed` during that await, then
 * `on_save_succeeded` when the Resist lands, would apply both halves of a Hold Person.
 */
export interface SaveVerdict {
  doc: any;
  success: boolean | null;
  saveMessage: any;
  pendingResistance: boolean;
}

/**
 * Saves already dispatched, so a re-render or a second `settle` cannot fire a rule twice.
 *
 * Keyed by the SAVE message, not the usage card: one Fireball is five saves and five events, and
 * each save can arrive (and be re-rendered) on its own. Bounded for the same reason the attack
 * set is — nothing older than the last few exchanges can be asked about again.
 */
const dispatched = new Set<string>();
const DISPATCH_LIMIT = 64;

/**
 * Who gets an event, and which.
 *
 * `success === null` is "we cannot judge this" — no DC on the roll — and is the one outcome that
 * must never be treated as a failure. `pendingResistance` waits: the verdict is not final until
 * the resistance was settled or is inapplicable.
 */
export function dispatchesFor(verdicts: SaveVerdict[]): SaveDispatch[] {
  const out: SaveDispatch[] = [];
  for (const v of verdicts) {
    if (v.success === null || !v.saveMessage || v.pendingResistance) continue;
    out.push({
      event: v.success ? "on_save_succeeded" : "on_save_failed",
      doc: v.doc,
      saveMessage: v.saveMessage,
    });
  }
  return out;
}

/**
 * Fire the caster's `on_save_failed` / `on_save_succeeded` rules for settled saves.
 *
 * Called from `rules/saves.ts` after `spoilAndResist`, so a spoiled success has already become a
 * failure and a bought failure has already become a success. Called whether or not damage has
 * arrived — a Hold Person has none coming.
 *
 * ONE EVENT PER CREATURE, not one per spell. An area save that three goblins fail restrains three
 * of them.
 */
export async function fireSaveTriggers(usage: any, verdicts: SaveVerdict[]): Promise<void> {
  if (!usage) return;
  const dispatches = dispatchesFor(verdicts);
  if (dispatches.length === 0) return;

  const token = speakerToken(usage?.speaker);
  const caster: Subject | null = token?.actor
    ? { actor: token.actor, token: token.object ?? token }
    : null;
  if (!caster) {
    // No creature to carry the capability. A save rolled against a trap or a sheet with no token on
    // the scene is ordinary, and a whisper per save would be noise on the busiest event there is.
    return;
  }

  const item = itemOf(usage);
  const raw = activityOf(usage, item);
  // `usedItemOf` reads `activity.item`. A Foundry activity usually has it; a test fake and
  // some imported items do not, so stamp the usage item on a thin wrapper rather than
  // mutating the document. `damage` is copied so `duplicatesActivityDamage` still sees it.
  const activity = raw
    ? raw.item
      ? raw
      : { ...raw, item: raw.item ?? item }
    : item
      ? { item }
      : raw;
  const spellLevel = Number(item?.system?.level) || undefined;

  for (const { event, doc, saveMessage } of dispatches) {
    const id = String(saveMessage?.id ?? "");
    if (!id || dispatched.has(id)) continue;
    dispatched.add(id);
    while (dispatched.size > DISPATCH_LIMIT) {
      const oldest = dispatched.values().next().value;
      if (oldest === undefined) break;
      dispatched.delete(oldest);
    }

    const subject: Subject = { actor: doc?.actor, token: doc?.object ?? doc };
    const ctx: TriggerContext = {
      self: caster,
      attacker: caster,
      target: subject,
      trigger: subject,
      activity,
      spellLevel,
    };
    try {
      await fireTrigger(event, ctx);
    } catch (err) {
      log(`save triggers: ${event} for ${String(token?.name ?? "?")} failed:`, err);
    }
  }
}

/** Test seam: forget what has been dispatched. */
export function resetSaveDispatch(): void {
  dispatched.clear();
}
