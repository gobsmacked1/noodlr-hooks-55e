/**
 * One reach reaction per (watcher, mover, kind) until the watcher's next turn.
 *
 * `moveToken` fires once per waypoint. Two overlapping `provoke()` both see an enter
 * and both pass `hasReaction`, because the ledger spends only after the player answers.
 * This set is claimed synchronously at detection so the second pass is a no-op.
 *
 * Enter and leave are separate keys: declining Reactive Strike must not eat the
 * Opportunity Attack if the same creature then walks out. The one-reaction cap is
 * `hasReaction` / the ledger, not this set.
 */

export type ProvokeKind = "enter" | "leave";

const claimed = new Set<string>();

export function provokeKey(watcherId: string, moverId: string, kind: ProvokeKind): string {
  return `${watcherId}|${moverId}|${kind}`;
}

/**
 * True if this is the first claim (or we cannot key it). False if already taken.
 *
 * Empty ids return true: a missing identity must not silently swallow the only swing.
 */
export function claimProvoke(watcherId: string, moverId: string, kind: ProvokeKind): boolean {
  if (!watcherId || !moverId) return true;
  const key = provokeKey(watcherId, moverId, kind);
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
}

export function alreadyProvoked(watcherId: string, moverId: string, kind: ProvokeKind): boolean {
  if (!watcherId || !moverId) return false;
  return claimed.has(provokeKey(watcherId, moverId, kind));
}

/** The watcher's reaction refreshes at the start of their turn — so do these claims. */
export function forgetProvokesFor(watcherId: string): void {
  if (!watcherId) return;
  const prefix = `${watcherId}|`;
  for (const key of [...claimed]) {
    if (key.startsWith(prefix)) claimed.delete(key);
  }
}

export function clearAllProvokes(): void {
  claimed.clear();
}

/** Actor UUIDs with a live dialog, so a second query cannot open a second window. */
const offering = new Set<string>();

/**
 * First synchronous claim for this actor. A second in-flight query returns false
 * instead of stacking another six-second prompt.
 */
export function claimOffer(actorUuid: string): boolean {
  if (!actorUuid) return true;
  if (offering.has(actorUuid)) return false;
  offering.add(actorUuid);
  return true;
}

export function releaseOffer(actorUuid: string): void {
  offering.delete(actorUuid);
}

export function resetOfferLock(): void {
  offering.clear();
}
