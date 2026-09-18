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

/**
 * How far the hop may go, in the activity's own units.
 * Empty when the distance is unreadable — the click is still a map square.
 */
export function teleportDistanceLabel(activity: any): string {
  const n = Number(activity?.teleport?.value);
  const units = String(activity?.teleport?.units ?? "").trim() || "ft";
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${n} ${units}`;
}

/**
 * Book distance for a range check. Infinity when the activity states no cap.
 * Conversion to the scene's units happens at the click, not here.
 */
export function teleportMaxDistance(activity: any): number {
  const n = Number(activity?.teleport?.value);
  if (!Number.isFinite(n)) return Number.POSITIVE_INFINITY;
  return n > 0 ? n : 0;
}

/** Player-facing click. Never "drag the token" — walls make that a lie. */
export function teleportClickHint(distance: string): string {
  const reach = String(distance ?? "").trim();
  return reach
    ? `Click the map where you want to appear (within ${reach}). Teleports go through walls — do not drag the token.`
    : "Click the map where you want to appear. Teleports go through walls — do not drag the token.";
}

/** The clicked pixel becomes the top-left of that grid square. */
export function hopSquareFromClick(click: { x: number; y: number }, gridSize: number): { x: number; y: number } {
  const size = Number(gridSize);
  if (!Number.isFinite(size) || size <= 0) {
    return { x: Math.round(click.x), y: Math.round(click.y) };
  }
  return {
    x: Math.floor(click.x / size) * size,
    y: Math.floor(click.y / size) * size,
  };
}

export function hopCenterFromCorner(
  corner: { x: number; y: number },
  token: { width?: number; height?: number },
  gridSize: number,
): { x: number; y: number } {
  const size = Number(gridSize) || 100;
  return {
    x: corner.x + (size * (Number(token?.width) || 1)) / 2,
    y: corner.y + (size * (Number(token?.height) || 1)) / 2,
  };
}

export function hopWithinRange(distance: number, maxDistance: number): boolean {
  if (!Number.isFinite(maxDistance)) return true;
  if (maxDistance <= 0) return false;
  return distance <= maxDistance + 0.01;
}

export function hopIsSameSquare(
  origin: { x: number; y: number } | null,
  dest: { x: number; y: number } | null,
): boolean {
  if (!origin || !dest) return false;
  return origin.x === dest.x && origin.y === dest.y;
}

/** A hop click is on the board canvas, never a chat card or window. */
export function teleportClickIsOnBoard(target: EventTarget | null, board: EventTarget | null): boolean {
  if (!target || !board) return false;
  if (target === board) return true;
  const contains = (board as { contains?: (node: Node) => boolean }).contains;
  return typeof contains === "function" && target instanceof Node && contains.call(board, target);
}

/**
 * One flat line per hop gate. A nested object in the console is how four releases
 * looked "fine" while Misty never left the square.
 */
export function formatTeleportTrace(
  step: string,
  facts: Record<string, string | number | boolean | null | undefined> = {},
): string {
  const bits: string[] = [];
  for (const [key, value] of Object.entries(facts)) {
    if (value === undefined || value === "") continue;
    bits.push(`${key}=${value}`);
  }
  return bits.length ? `${step} | ${bits.join(" ")}` : step;
}

/** What dnd5e's `planTeleport` handed back — dest vs `moved`, never the promise. */
export function plannedHopSummary(results: unknown): {
  dest: string;
  movedFlag: string;
  rows: number;
} {
  if (results == null) return { dest: "none", movedFlag: "none", rows: 0 };
  if (!Array.isArray(results)) return { dest: "unreadable", movedFlag: "unreadable", rows: 0 };
  if (!results.length) return { dest: "empty", movedFlag: "empty", rows: 0 };
  const dests: string[] = [];
  const flags: string[] = [];
  for (const row of results) {
    const dest = plannedDestination(row);
    dests.push(dest ? `${Math.round(dest.x)},${Math.round(dest.y)}` : "none");
    flags.push(row?.moved === true ? "true" : row?.moved === false ? "false" : "unset");
  }
  return { dest: dests.join("+"), movedFlag: flags.join("+"), rows: results.length };
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
