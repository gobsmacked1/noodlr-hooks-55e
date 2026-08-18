// Turning a new Active Effect into `on_condition_applied`.
//
// WHY THIS IS A FILE AND NOT FOUR LINES IN `executor.ts`. The event is ambiguous in the same way
// `on_hit` is: "when a condition is applied" is true of the creature that RECEIVED it and of a
// creature watching someone else (Melody of Sheltered Rest strips Surprise from allies in an aura).
// The compiler has one word for both. So the direction is decided here, once. A census of the live
// cache (`npm run census:trigger -- <cache> on_condition_applied`) found 8 rules; the engine ones
// that name `self` (Nature's Ward, Wild Shape, Mindless Rage) read "when THIS happens to me".
// **These fire from the afflicted creature's side and only from that side.**
//
// The watcher's reading — Melody, Krail's Rot — is a real rule and is NOT implemented. It needs
// `on_condition_applied_on`, or an `incoming` flag. Until then those compile, bind, and never fire
// usefully, which the capability sheet shows.
//
// A hook that names no status must not run every bound rule. `ruleMatchesApplied` is the filter:
// Nature's Ward strips poison only when poison is what landed, not when frightened is.

import { log } from "../constants";
import { ruleMatchesApplied } from "./applied";
import { fireTrigger, type TriggerContext } from "./executor";
import type { Subject } from "./predicates";

export { ruleMatchesApplied };

const dispatched = new Set<string>();
const DISPATCH_LIMIT = 64;

export function statusesOf(effect: any): string[] {
  return Array.from(effect?.statuses ?? [])
    .map((s) => String(s).toLowerCase())
    .filter(Boolean);
}

/**
 * Fire the afflicted creature's `on_condition_applied` rules for a new effect.
 *
 * Called from `createActiveEffect` after the effect exists, so a `has_status` guard on the same
 * status can see it — Nature's Ward is "when you are poisoned, you are not", and the poison has
 * to be on the actor for that guard to pass before the remove runs.
 */
export async function fireConditionTriggers(effect: any): Promise<void> {
  const applied = statusesOf(effect);
  if (!applied.length) return;

  const id = String(effect?.id ?? effect?.uuid ?? "");
  if (!id || dispatched.has(id)) return;
  dispatched.add(id);
  while (dispatched.size > DISPATCH_LIMIT) {
    const oldest = dispatched.values().next().value;
    if (oldest === undefined) break;
    dispatched.delete(oldest);
  }

  const actor = effect?.parent;
  if (!actor) return;
  const token = actor.token?.object ?? actor.getActiveTokens?.()?.[0] ?? null;
  const self: Subject = { actor, token };

  const ctx: TriggerContext = {
    self,
    trigger: self,
    appliedStatuses: applied,
  };
  try {
    await fireTrigger("on_condition_applied", ctx);
  } catch (err) {
    log(`condition triggers: on_condition_applied for ${String(actor?.name ?? "?")} failed:`, err);
  }
}

export function registerConditionTriggers(): void {
  Hooks.on("createActiveEffect", (effect: any) => {
    void fireConditionTriggers(effect);
  });
}

export function resetConditionDispatch(): void {
  dispatched.clear();
}
