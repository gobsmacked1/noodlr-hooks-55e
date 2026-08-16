// Turning a settled attack into `on_hit` / `on_miss`.
//
// WHY THIS IS A FILE AND NOT FOUR LINES IN `rules/damage.ts`. Both events are ambiguous in the one way
// the vocabulary cannot express: "on a hit" is true of the creature swinging AND of the creature being
// hit, and the compiler has one word for both. So the direction has to be decided here, once, in the
// open, rather than inferred at each call site — and it is decided on evidence. A census of the live
// cache's 187 attack-triggered rules (`npm run census:trigger -- <cache> on_hit on_miss`) puts 44 of the
// 47 engine-adjudicated ones at `effect.target: "target"`, i.e. the ability's owner does something to
// the creature it just hit: a bite that poisons, a claw that grapples, a tentacle that restrains.
// **These fire from the ATTACKER's side and only from the attacker's side.**
//
// The defender's reading — "when a creature hits me, it takes 1d6 fire" — is a real rule and is NOT
// implemented, deliberately. It is not a wider dispatch of the same event: it inverts every subject, so
// running both off one event would have `target` mean the attacker on some rules and the defender on
// others with nothing on the descriptor to tell them apart. That needs `on_hit_by`, or an `incoming`
// flag of the shape `noodlrHooks.behavior` already carries. Until then such a rule compiles, is bound,
// and never fires — which the capability sheet shows, rather than firing backwards.
//
// SUBJECTS, and all four resolve on purpose. `self` and `attacker` are the creature that swung;
// `target` and `trigger` are the creature it hit or missed. Leaving `attacker` unset would fail a guard
// closed on the commonest thing a rule could ask about itself, and leaving `trigger` to its usual
// `attacker ?? target` fallback would resolve it to the swinger — which is why `EvalContext.trigger`
// exists.
//
// THE ACTIVITY IS NOT OPTIONAL. `duplicatesActivityDamage` is what stops a compiled "on a hit, deal
// 1d10 fire" from re-rolling a cantrip's own printed damage line, and it can only refuse when
// `ctx.activity` is set. Dispatching without it doubles the damage of every attack in the world,
// silently, because doubling is arithmetic and nothing throws.

import { log } from "../constants";
import { activityOf, itemOf, speakerToken, type HitReading } from "../rules/cards";
import { fireTrigger, type TriggerContext } from "./executor";
import type { Subject } from "./predicates";
import type { TriggerEvent } from "../integration/capability";

/** One creature, and what the attack did to it. */
export interface AttackDispatch {
  event: Extract<TriggerEvent, "on_hit" | "on_miss">;
  /** The TokenDocument that was hit or missed. */
  doc: any;
}

/**
 * Attacks already dispatched, so a re-render cannot fire a rule twice.
 *
 * THIS IS THE ONLY GUARD, which is worth knowing before deciding it is redundant. `consider()` in
 * `rules/damage.ts` marks a message `handled` on the damage and healing branches and NOT on the attack
 * branch, so a second `renderChatMessageHTML` for the same attack — which midi produces routinely, and
 * which any flag write on the card produces — re-reads the verdict and reaches `settleAttack` again.
 * Everything else down that path is idempotent by construction (a verdict is rewritten to the same
 * value, a graze is `applied`-flagged); a compiled rider is not, because applying a poison twice spends
 * two uses and stacks two effects.
 *
 * Keyed by the message rather than by the message-and-creature pair: an attack is one event however
 * many creatures it named, and `dispatchesFor` already fans it out. Bounded for the same reason
 * `verdicts` is — nothing older than the last few exchanges can be asked about again.
 */
const dispatched = new Set<string>();
const DISPATCH_LIMIT = 64;

/**
 * Who gets an event, and which.
 *
 * `unresolved` targets get neither, and that is the same refusal every other reading in this module
 * makes: "there are two of these on the scene and the target record cannot say which was hit" is
 * exactly as unanswerable for a poison as it is for the damage. Applying a condition to a guess is
 * worse than applying nothing, because nothing is visible and a wrong one is not.
 *
 * Split out from the dispatch so a test can assert the direction without a Foundry world.
 */
export function dispatchesFor(reading: HitReading): AttackDispatch[] {
  return [
    ...reading.hits.map((doc) => ({ event: "on_hit" as const, doc })),
    ...reading.missed.map((doc) => ({ event: "on_miss" as const, doc })),
  ];
}

/**
 * Fire the attacker's `on_hit` / `on_miss` rules for a settled attack.
 *
 * Called from `rules/damage.ts` after the reaction window and after graze, so a Shield that turned a
 * hit into a miss has already moved the creature between the two lists and the rider follows the
 * verdict rather than the die. Before the gate flag is written, so every world mutation this causes has
 * landed by the time the Damage button is released.
 *
 * ONE EVENT PER CREATURE, not one per attack. An attack that hits three targets poisons three of them.
 */
export async function fireAttackTriggers(message: any, reading: HitReading): Promise<void> {
  const dispatches = dispatchesFor(reading);
  if (dispatches.length === 0) return;

  const id = String(message?.id ?? "");
  if (!id || dispatched.has(id)) return;
  dispatched.add(id);
  while (dispatched.size > DISPATCH_LIMIT) {
    const oldest = dispatched.values().next().value;
    if (oldest === undefined) break;
    dispatched.delete(oldest);
  }

  const token = speakerToken(message?.speaker);
  const attacker: Subject | null = token?.actor
    ? { actor: token.actor, token: token.object ?? token }
    : null;
  if (!attacker) {
    // No creature to carry the capability. Nothing to report: an attack rolled from a sheet with no
    // token on the scene is ordinary, and a whisper per swing would be noise on the busiest event there
    // is.
    return;
  }

  const item = itemOf(message);
  const activity = activityOf(message, item);
  // Read the same way `on_activity_use` reads it, deliberately: two answers to "what level was this
  // cast at" is the divergence this repo keeps finding. Base level only — an upcast is not recorded on
  // the attack roll — so a rule scaling off the slot is under-served rather than wrong.
  const spellLevel = Number(item?.system?.level) || undefined;

  for (const { event, doc } of dispatches) {
    const subject: Subject = { actor: doc?.actor, token: doc?.object ?? doc };
    const ctx: TriggerContext = {
      self: attacker,
      attacker,
      target: subject,
      trigger: subject,
      activity,
      spellLevel,
    };
    try {
      await fireTrigger(event, ctx);
    } catch (err) {
      // `fireTrigger` already swallows per-rule failures; this is the outer belt, because a capability
      // must never take an attack down with it.
      log(`attack triggers: ${event} for ${String(token?.name ?? "?")} failed:`, err);
    }
  }
}

/** Test seam: forget what has been dispatched. */
export function resetAttackDispatch(): void {
  dispatched.clear();
}
