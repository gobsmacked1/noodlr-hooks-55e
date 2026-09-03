// In-flight reaction work the planner must not walk out from under.
//
// A Bite that then falls back 14 feet into cover (or a fly-by that keeps going) used to move
// before the player finished Redirect / Goading / Shield. The offer fired against the square
// they were bitten in; `police()` then measured the new square and toasted "Out of range."
//
// `offerReaction` and the damage-layer window both register here. `performPlan` awaits this
// before leftover movement. A settle gap catches a `createChatMessage` hook that has not yet
// pushed its promise — Foundry does not await those listeners.
//
// Leaf: nothing here imports execute, offer, or damage.

const pending = new Set<Promise<void>>();

/** How long to wait after the last known reaction before assuming none is coming. */
export const REACTION_SETTLE_MS = 400;

/** Wall-clock cap so a stuck dialog cannot freeze an automated turn forever. */
const BUDGET_MS = 35_000;

/**
 * Track a reaction-shaped promise so leftover movement can wait on it.
 *
 * The original promise is returned unchanged. Failures are swallowed for the waiter
 * only — the caller still sees its own rejection.
 */
export function trackReaction<T>(work: Promise<T>): Promise<T> {
  const done: Promise<void> = work.then(
    () => undefined,
    () => undefined,
  ).then(() => {
    pending.delete(done);
  });
  pending.add(done);
  return work;
}

export function pendingReactionCount(): number {
  return pending.size;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wait until no reaction window or offer is in flight, plus a quiet settle.
 *
 * Returns immediately when nothing is pending and the settle has elapsed.
 */
export async function awaitPendingReactions(settleMs = REACTION_SETTLE_MS): Promise<void> {
  const started = Date.now();
  let quietSince = Date.now();
  while (Date.now() - started < BUDGET_MS) {
    if (pending.size > 0) {
      await Promise.all([...pending]);
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= settleMs) return;
    await sleep(50);
  }
}
