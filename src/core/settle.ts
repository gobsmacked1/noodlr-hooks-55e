// Wait until combatants have stopped sliding before anyone else acts.
//
// Foundry commits the TokenDocument (and advances the tracker) before the placeable
// finishes its animation. Sheet pace makes a Dash take several seconds on screen after
// the document is already at the destination. Acting in that window is the other
// creature taking a turn while this one is still visibly walking — a deal-breaker.
//
// A second, narrower hole: the last waypoint of a drag can arrive a few hundred
// milliseconds AFTER nextTurn() has already run. A grace tick at the start of the
// wait is what catches that; looking only at "is anyone sliding right now" misses it.

export const REST_GRACE_MS = 400;
export const REST_STALE_MS = 3000;
export const REST_DEADLINE_MS = 60_000;

export function tokenIsMoving(token: any): boolean {
  if (!token) return false;
  const doc = token.document ?? token;
  const placeable = token.object ?? doc?.object ?? token;
  if ((placeable?.animationContexts?.size ?? 0) > 0) return true;
  const state = String(doc?.movement?.state ?? placeable?.document?.movement?.state ?? "");
  return state === "pending" || state === "planned";
}

export function combatantsAreMoving(combatants: Iterable<any> | null | undefined): boolean {
  if (!combatants) return false;
  for (const combatant of combatants) {
    if (tokenIsMoving(combatant?.token)) return true;
  }
  return false;
}

/** Snapshot of committed positions, so a hung animation context cannot look like a walk. */
export function combatantPositions(combatants: Iterable<any> | null | undefined): string {
  if (!combatants) return "";
  const parts: string[] = [];
  for (const combatant of combatants) {
    const doc = combatant?.token?.document ?? combatant?.token;
    if (!doc) continue;
    const src = doc._source ?? doc;
    parts.push(
      `${String(doc.id ?? "")}:${src.x ?? ""},${src.y ?? ""},${src.elevation ?? ""}`,
    );
  }
  return parts.join("|");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve when every combatant token is at rest, or when the wait is no longer useful.
 *
 * `grace` covers a waypoint that has been sent but has not landed yet. `stale` covers
 * animationContexts that never clear (WebGL loss): if nobody's document has moved for
 * that long, they are not walking. The deadline is a runaway guard, not a pace.
 */
export async function waitForCombatantsToRest(
  combat: { combatants?: Iterable<any> } | null | undefined,
  opts: { graceMs?: number; staleMs?: number; deadlineMs?: number; now?: () => number } = {},
): Promise<"rest" | "stale" | "timeout"> {
  const grace = opts.graceMs ?? REST_GRACE_MS;
  const stale = opts.staleMs ?? REST_STALE_MS;
  const deadline = opts.deadlineMs ?? REST_DEADLINE_MS;
  const now = opts.now ?? Date.now;
  if (grace > 0) await sleep(grace);

  const started = now();
  let last = combatantPositions(combat?.combatants);
  let idleAt = started;
  while (now() - started < deadline) {
    if (!combatantsAreMoving(combat?.combatants)) return "rest";
    const snap = combatantPositions(combat?.combatants);
    if (snap !== last) {
      last = snap;
      idleAt = now();
    } else if (now() - idleAt >= stale) {
      return "stale";
    }
    await sleep(50);
  }
  return "timeout";
}
