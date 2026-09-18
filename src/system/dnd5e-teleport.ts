// Caster-hop TeleportActivities, and whether a plan actually moved anyone.
//
// dnd5e's TeleportActivity consumes the slot in `use()`, then `#planTeleport` only runs if
// a token is already controlled. The system's own `_triggerSubsequentActions` is a TODO:
// "Automatically plan teleport movement, but only when the spell specifically targets Self."
// Destination / group rituals (Dimension Door, Teleport, Plane Shift, …) are not this.
//
// Activity `range.units` INITIAL is `"self"`. `override === false` means use the item —
// the same trap as a bite's reach. Leftover activity `units: self` on Teleport / Plane
// Shift / Word of Recall / Transport via Plants / Teleportation Circle is schema, not a
// caster hop. Prefer the item unless the activity overrides. A hop is then: item range
// Self, or an overridden activity range Self, or resolved `target.affects` Self
// (2014 / DDB Misty Step; sphinx Reposition).

export function isTeleportActivity(activity: any): boolean {
  return String(activity?.type ?? "").toLowerCase() === "teleport";
}

/** Activity range when it overrides; otherwise the item. Leftover `units: self` loses. */
export function teleportRangeUnits(activity: any): string {
  const own = activity?.range;
  const item = activity?.item?.system?.range ?? activity?.item?.range;
  if (own?.override === true) return String(own.units ?? "").toLowerCase();
  return String(item?.units || own?.units || "").toLowerCase();
}

function itemRangeUnits(activity: any): string {
  const item = activity?.item?.system?.range ?? activity?.item?.range;
  return String(item?.units ?? "").toLowerCase();
}

/** Who the hop is about — activity when it overrides; otherwise the item. */
export function teleportAffects(activity: any): string {
  const own = activity?.target;
  const item = activity?.item?.system?.target ?? activity?.item?.target;
  if (own?.override === true) return String(own?.affects?.type ?? "").toLowerCase();
  return String(item?.affects?.type || own?.affects?.type || "").toLowerCase();
}

/**
 * The caster hops. Encoding varies; the name does not.
 *
 * Stock 2024 Misty Step / Tree Stride: item range Self, leftover activity `units: self`.
 * 2014 stock and DDB Misty Step: item Self, activity range `30 ft` override, target Self.
 * Sphinx Reposition: activity 120 ft, target Self.
 * Teleport / Plane Shift / Word of Recall / Door / Circle keep leftover activity
 * `units: self` with override false — that is not a hop.
 */
export function isSelfTeleport(activity: any): boolean {
  if (!isTeleportActivity(activity)) return false;
  if (itemRangeUnits(activity) === "self") return true;
  if (activity?.range?.override === true && teleportRangeUnits(activity) === "self") return true;
  return teleportAffects(activity) === "self";
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

/** Where the player asked the blink to go. `moved === true` is not this. */
export function plannedDestination(row: any): { x: number; y: number; elevation?: number } | null {
  const dest = row?.plan?.destination;
  if (Number.isFinite(dest?.x) && Number.isFinite(dest?.y)) {
    const elevation = Number(dest.elevation);
    return Number.isFinite(elevation) ? { x: dest.x, y: dest.y, elevation } : { x: dest.x, y: dest.y };
  }
  const path = row?.plan?.waypoints ?? row?.plan?.path;
  if (Array.isArray(path) && path.length) {
    const last = path[path.length - 1];
    if (Number.isFinite(last?.x) && Number.isFinite(last?.y)) {
      const elevation = Number(last.elevation);
      return Number.isFinite(elevation) ? { x: last.x, y: last.y, elevation } : { x: last.x, y: last.y };
    }
  }
  return null;
}

export function plannedDestinations(results: unknown): { token: any; dest: { x: number; y: number; elevation?: number } }[] {
  if (!Array.isArray(results)) return [];
  const out: { token: any; dest: { x: number; y: number; elevation?: number } }[] = [];
  for (const row of results) {
    const dest = plannedDestination(row);
    if (dest && row?.token) out.push({ token: row.token, dest });
  }
  return out;
}
