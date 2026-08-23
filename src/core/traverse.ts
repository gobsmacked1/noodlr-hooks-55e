// When a movement mode is even trying to cross a wall.
//
// Core treats every action except blink/displace as blocked by `walls: "move"`. Elevation is
// animated and stored, and it does not lift that test: a flyer at 10 feet still stops at a maze
// wall. Tiles are not walls. A painted chasm or a lake with no wall is already walkable.
//
// This file answers only "is this mode in a crossing posture?" — fly/climb/jump above 0, burrow
// below 0, or a jump whose long jump could cover the span. Whether a *particular* wall is
// cleared is `core/wall-height.ts` (default 10 ft, indoor ceiling, man-made floors). A walk at
// elevation 10 is still a walk. A flyer that never leaves the ground is still blocked.
//
// Every XY-moving segment of a path must qualify. Ignoring walls for the whole drag the moment
// any waypoint is airborne is what made a 10 ft hedge and a keep one answer.

export interface TraverseSegment {
  action: string;
  fromElevation: number;
  toElevation: number;
  hasFly: boolean;
  hasClimb: boolean;
  hasBurrow: boolean;
  /** Max long jump in scene units, when the action is jump. */
  jumpLong?: number | null;
  /** Horizontal distance of this segment in scene units. */
  horizontal?: number;
}

export interface TraverseWaypoint {
  x?: number;
  y?: number;
  elevation?: number;
  action?: string;
}

export interface TraverseFacts {
  hasFly: boolean;
  hasClimb: boolean;
  hasBurrow: boolean;
  jumpLong: number | null;
  defaultAction: string;
}

export function modeClearsWalls(segment: TraverseSegment): boolean {
  const action = String(segment.action || "walk").toLowerCase();
  const from = Number(segment.fromElevation);
  const to = Number(segment.toElevation);
  const high = Math.max(Number.isFinite(from) ? from : 0, Number.isFinite(to) ? to : 0);
  const low = Math.min(Number.isFinite(from) ? from : 0, Number.isFinite(to) ? to : 0);

  if (action === "fly" && segment.hasFly && high > 0) return true;
  if (action === "climb" && segment.hasClimb && high > 0) return true;
  if (action === "burrow" && segment.hasBurrow && low < 0) return true;
  if (action === "jump") {
    if (high > 0) return true;
    const long = segment.jumpLong;
    const horiz = segment.horizontal;
    if (long != null && horiz != null && long >= horiz && horiz > 0) return true;
  }
  return false;
}

/** True only when every XY-moving segment qualifies and at least one such segment exists. */
export function pathClearsWalls(segments: TraverseSegment[]): boolean {
  let anyMove = false;
  for (const segment of segments) {
    if (!((segment.horizontal ?? 0) > 0)) continue;
    anyMove = true;
    if (!modeClearsWalls(segment)) return false;
  }
  return anyMove;
}

export function horizontalSceneUnits(
  from: TraverseWaypoint,
  to: TraverseWaypoint,
  gridSize: number,
  gridDistance: number,
): number {
  if (!(gridSize > 0) || !(gridDistance > 0)) return 0;
  const dx = Number(to.x ?? from.x ?? 0) - Number(from.x ?? 0);
  const dy = Number(to.y ?? from.y ?? 0) - Number(from.y ?? 0);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
  return (Math.hypot(dx, dy) / gridSize) * gridDistance;
}

export function segmentsOf(
  waypoints: TraverseWaypoint[],
  facts: TraverseFacts,
  measure: (from: TraverseWaypoint, to: TraverseWaypoint) => number,
): TraverseSegment[] {
  const segments: TraverseSegment[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    const from = waypoints[i - 1];
    const to = waypoints[i];
    const action = String(to.action ?? facts.defaultAction ?? "walk");
    segments.push({
      action,
      fromElevation: Number(from.elevation ?? 0),
      toElevation: Number(to.elevation ?? from.elevation ?? 0),
      hasFly: facts.hasFly,
      hasClimb: facts.hasClimb,
      hasBurrow: facts.hasBurrow,
      jumpLong: action.toLowerCase() === "jump" ? facts.jumpLong : null,
      horizontal: measure(from, to),
    });
  }
  return segments;
}
