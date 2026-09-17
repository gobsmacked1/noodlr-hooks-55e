// Self-range teleport activities (Misty Step), and whether a plan actually moved anyone.
//
// dnd5e's TeleportActivity consumes the slot in `use()`, then `#planTeleport` only runs if
// a token is already controlled. The system's own `_triggerSubsequentActions` is a TODO:
// "Automatically plan teleport movement, but only when the spell specifically targets Self."
// Dimension Door (a ranged point) is not this.

export function isTeleportActivity(activity: any): boolean {
  return String(activity?.type ?? "").toLowerCase() === "teleport";
}

/** Activity range when it overrides; otherwise the item. */
export function teleportRangeUnits(activity: any): string {
  const own = activity?.range;
  const item = activity?.item?.system?.range ?? activity?.item?.range;
  if (own?.override === true) return String(own.units ?? "").toLowerCase();
  return String(own?.units || item?.units || "").toLowerCase();
}

export function isSelfTeleport(activity: any): boolean {
  return isTeleportActivity(activity) && teleportRangeUnits(activity) === "self";
}

/** Misty Step blinks the caster. A leftover multi-select must not steal the hop. */
export function shouldReplaceTeleportTokens(currentIds: string[], casterId: string): boolean {
  if (!casterId) return false;
  return currentIds.length !== 1 || currentIds[0] !== casterId;
}

/**
 * The slot the table spent. Misty Step's activity ships `activation.type: action`
 * with `override: false` — the item is bonus.
 */
export function teleportActivationType(activity: any): string {
  const own = activity?.activation;
  const item = activity?.item?.system?.activation ?? activity?.item?.activation;
  if (own?.override === true) return String(own.type ?? "");
  return String(item?.type || own?.type || "");
}

export function tokenOrigin(token: any): { x: number; y: number } | null {
  const doc = token?.document ?? token;
  const src = doc?._source;
  const x = Number(src?.x ?? doc?.x);
  const y = Number(src?.y ?? doc?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export function originMoved(
  before: { x: number; y: number } | null,
  after: { x: number; y: number } | null,
): boolean {
  if (!before || !after) return false;
  return before.x !== after.x || before.y !== after.y;
}

/**
 * Did any planned teleport actually change a token's committed position?
 *
 * `startMovement` / `move()` returning true is not evidence — core sets that flag
 * before `preUpdateToken`, and Movement Automation Full can constrain a blink
 * back to the origin (occupied destination). Compare `_source`.
 */
export function teleportLanded(
  before: Map<string, { x: number; y: number }>,
  results: unknown,
): boolean {
  if (!Array.isArray(results) || results.length === 0) return false;
  for (const row of results) {
    const token = row?.token;
    const id = String(token?.id ?? token?.document?.id ?? "");
    const prev = id ? before.get(id) : undefined;
    if (originMoved(prev ?? null, tokenOrigin(token))) return true;
  }
  return false;
}
