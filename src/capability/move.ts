// Turning a token's position change into `on_move`.
//
// WHY THIS IS A FILE AND NOT FOUR LINES IN `executor.ts`. "When a creature moves" is true of the
// creature that walked AND of a creature waiting for someone else to walk near it (Crown of
// Radiance, Booming Blade). The compiler has one word for both. A census of the live cache
// (`npm run census:trigger -- <cache> on_move`) found 9 rules; Ashardalon's Stride is the mover's
// reading, Crown of Radiance is the watcher's. **These fire from the mover's side and only from
// the mover's side.** The watcher's reading needs `on_move_by`. Until then those compile, bind,
// and never fire usefully, which the capability sheet shows.
//
// FORCED MOVEMENT FIRES. Ashardalon's fire does not care why the caster moved, and opportunity-
// attack-style riders are the other reading, which this file does not implement. `isForcedMovement`
// is not consulted.
//
// UNSET DAMAGE TARGETS ARE REFUSED, not defaulted to the mover. `subjectOf` treats a missing
// `effect.target` as `self`, and Ashardalon's Stride in the live cache left the target unset with
// a `within_distance` guard that compares the mover to itself (0 ft ≤ 5). Wiring that without a
// refusal burns the caster for 1d6 fire every turn they walk. "I could not name who" is not
// "damage the person who moved".
//
// ONE FIRE PER SETTLE. A drag or a multi-waypoint `move()` can emit several `updateToken`s; the
// Ready layer coalesces those, and so do we. Keyed on token + destination so walking to A, then
// B, then back to A is three events, not one.

import { log } from "../constants";
import { fireTrigger, type TriggerContext } from "./executor";
import type { Subject } from "./predicates";

const last = new Map<string, { x: number; y: number; elev: number; at: number }>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const SETTLE_MS = 400;
const DEBOUNCE_MS = 150;

function docOf(token: any): any {
  return token?.document ?? token;
}

function destinationOf(token: any): { id: string; x: number; y: number; elev: number } {
  const doc = docOf(token);
  return {
    id: String(doc?.id ?? ""),
    x: Number(doc?.x) || 0,
    y: Number(doc?.y) || 0,
    elev: Number(doc?.elevation) || 0,
  };
}

export function alreadyMoved(token: any, now = Date.now()): boolean {
  const dest = destinationOf(token);
  if (!dest.id) return true;
  const prev = last.get(dest.id);
  if (
    prev &&
    prev.x === dest.x &&
    prev.y === dest.y &&
    prev.elev === dest.elev &&
    now - prev.at < SETTLE_MS
  ) {
    return true;
  }
  last.set(dest.id, { x: dest.x, y: dest.y, elev: dest.elev, at: now });
  return false;
}

/**
 * Fire the mover's `on_move` rules for a settled position change.
 *
 * `token` is a TokenDocument or a placeable; either is accepted because `updateToken` hands the
 * document and tests hand whichever is convenient.
 */
export async function fireMoveTriggers(token: any): Promise<void> {
  const doc = docOf(token);
  const actor = doc?.actor;
  if (!actor) return;
  if (alreadyMoved(doc)) return;

  const self: Subject = { actor, token: doc?.object ?? doc };
  const ctx: TriggerContext = {
    self,
    trigger: self,
  };
  try {
    await fireTrigger("on_move", ctx);
  } catch (err) {
    log(`move triggers: on_move for ${String(doc?.name ?? "?")} failed:`, err);
  }
}

/** Coalesce a burst of `updateToken`s for one token into a single fire. */
export function scheduleMove(token: any): void {
  const id = String(docOf(token)?.id ?? "");
  if (!id) return;
  const prev = timers.get(id);
  if (prev) clearTimeout(prev);
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      void fireMoveTriggers(token);
    }, DEBOUNCE_MS),
  );
}

export function registerMoveTriggers(): void {
  Hooks.on("updateToken", (doc: any, changes: any) => {
    if (changes?.x === undefined && changes?.y === undefined && changes?.elevation === undefined) {
      return;
    }
    scheduleMove(doc);
  });
}

export function resetMoveDispatch(): void {
  last.clear();
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
