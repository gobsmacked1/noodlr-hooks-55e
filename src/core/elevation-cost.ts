// How much of a turn's Speed a change in elevation costs.
//
// Core already folds some height into `waypoint.cost` (EQUIDISTANT is Chebyshev-like: max(dx, dy, dz)),
// so adding |Δz| on top of that cost double-counts a pure climb and under-counts a diagonal 3D step
// that the table wants as XY + |Z|. We add only the vertical that core did not already charge, and a
// size tax when the token leaves or meets the zero plane.
//
// Walk and crawl do not get our Z line — stairs stay whatever core already charged. Fly, climb, swim,
// burrow and jump do. Forced / displace never does. We do not classify the scene (indoor, water,
// astral…): the GM placed the token, so the elevation they set is the one we price.

/** Height changes smaller than this are rounding, not travel. Same idea as `VERTICAL_TOLERANCE` in movement. */
export const ELEVATION_EPS = 1;

/** Actions whose |Δelevation| spends Speed, plus the size tax on a zero-plane crossing. */
export const Z_ACTIONS = new Set(["fly", "climb", "swim", "burrow", "jump"]);

/**
 * House-rule floor, in scene units, when a token leaves or meets elevation 0.
 *
 * Tiny 5 / Small-Medium 10 / Large 20 / Huge 30 / Gargantuan 40. Unreadable size is 0 — inventing a
 * Gargantuan tax is the worse failure.
 */
export const ELEVATION_TAX: Record<string, number> = {
  tiny: 5,
  sm: 10,
  small: 10,
  med: 10,
  medium: 10,
  lg: 20,
  large: 20,
  huge: 30,
  grg: 40,
  gargantuan: 40,
};

export interface TravelSegment {
  action: string;
  /** Core's `waypoint.cost` for this step. Terrain is already inside it. */
  cost: number;
  fromElev: number;
  toElev: number;
  /** Horizontal-only distance, scene units. Omit when it cannot be measured. */
  horizontal?: number;
}

export interface TravelSpend {
  total: number;
  /** Sum of the core costs we were handed. */
  core: number;
  /** Extra we added so the spend is XY + vertical (tax included). */
  surcharge: number;
}

export function nearElevation(value: number, target = 0): boolean {
  return Math.abs(value - target) < ELEVATION_EPS;
}

/** Takeoff, landing, diving, surfacing, or passing through 0. Airborne 20→15 is not this. */
export function crossesZeroPlane(from: number, to: number): boolean {
  const a = nearElevation(from);
  const b = nearElevation(to);
  if (a !== b) return true;
  return from * to < 0;
}

export function elevationTaxFromSize(size: string | null | undefined): number {
  if (!size) return 0;
  const n = ELEVATION_TAX[String(size).trim().toLowerCase()];
  return n ?? 0;
}

export function elevationTaxOf(actor: any): number {
  return elevationTaxFromSize(actor?.system?.traits?.size);
}

/**
 * Feet of Speed this elevation change costs, before it is reconciled with core's 3D blend.
 *
 * Zero when the action is not a Z-mode or the height did not move. Otherwise |Δz|, raised to the
 * size tax when the token crosses the zero plane.
 */
export function verticalCost(from: number, to: number, action: string, tax: number): number {
  if (!Z_ACTIONS.has(String(action ?? ""))) return 0;
  const delta = Math.abs(to - from);
  if (delta < ELEVATION_EPS) return 0;
  if (crossesZeroPlane(from, to) && tax > 0) return Math.max(delta, tax);
  return delta;
}

/**
 * Largest height we can reach toward `to` without spending more than `budget`.
 *
 * A Medium creature with 9 ft left cannot take off (tax 10). A Large flyer at 20 with 15 ft left
 * can drop to 5 but cannot land (landing is max(20, 20) = 20).
 */
export function affordableElevation(
  from: number,
  to: number,
  budget: number,
  action: string,
  tax: number,
): number {
  if (verticalCost(from, to, action, tax) <= budget) return to;
  const dir = Math.sign(to - from);
  if (dir === 0 || !(budget > 0)) return from;

  const span = Math.abs(to - from);
  let best = from;
  for (let d = 1; d <= span; d++) {
    const dest = from + dir * d;
    if (verticalCost(from, dest, action, tax) <= budget) best = dest;
    else break;
  }
  return best;
}

/**
 * What one recorded step actually spends.
 *
 * Flat / walk: core's cost, unchanged. Pure vertical: at least our vertical charge. Mixed: core's
 * cost plus the vertical core did not already fold in (and any tax overflow).
 */
export function segmentTravelCost(seg: TravelSegment, tax: number): TravelSpend {
  const core = Number.isFinite(seg.cost) ? Math.max(0, seg.cost) : 0;
  const z = verticalCost(seg.fromElev, seg.toElev, seg.action, tax);
  if (z <= 0) return { total: core, core, surcharge: 0 };

  const dz = Math.abs(seg.toElev - seg.fromElev);
  const xy = seg.horizontal;
  if (xy === undefined) {
    const surcharge = Math.max(0, z - dz);
    return { total: core + surcharge, core, surcharge };
  }
  if (xy < ELEVATION_EPS) {
    const total = Math.max(core, z);
    return { total, core, surcharge: total - core };
  }

  const zInCore = clamp(core - xy, 0, dz);
  const surcharge = Math.max(0, z - zInCore);
  return { total: core + surcharge, core, surcharge };
}

/** Spend of dest waypoints measured from an explicit origin (this move's `movement.origin`). */
export function pathTravelCost(
  start: { elevation?: number; action?: string; x?: number; y?: number },
  dests: any[],
  tax: number,
  measure?: (from: any, to: any) => number,
): TravelSpend {
  let total = 0;
  let core = 0;
  let surcharge = 0;
  let prev = start;
  for (const dest of dests ?? []) {
    const cost = Number(dest?.cost);
    const coreSeg = Number.isFinite(cost) ? cost : 0;
    let horizontal: number | undefined;
    if (measure) {
      try {
        const n = Number(measure(prev, dest));
        if (Number.isFinite(n)) horizontal = n;
      } catch {
        horizontal = undefined;
      }
    }
    const seg = segmentTravelCost(
      {
        action: String(dest?.action ?? (prev as any)?.action ?? "walk"),
        cost: coreSeg,
        fromElev: finiteElev(prev?.elevation),
        toElev: finiteElev(dest?.elevation),
        horizontal,
      },
      tax,
    );
    total += seg.total;
    core += coreSeg;
    surcharge += seg.surcharge;
    prev = dest;
  }
  return { total, core, surcharge };
}

/**
 * Spend of a turn's `movementHistory`.
 *
 * Foundry prepends the turn-start origin as a cost-0 waypoint. That marker is the previous elevation
 * for the first real step; its cost is not travel.
 */
export function historyTravelCost(
  waypoints: any[],
  tax: number,
  measure?: (from: any, to: any) => number,
): TravelSpend {
  const list = waypoints ?? [];
  if (!list.length) return { total: 0, core: 0, surcharge: 0 };

  const firstCost = Number(list[0]?.cost);
  const originIsMarker = !Number.isFinite(firstCost) || firstCost === 0;
  if (originIsMarker) return pathTravelCost(list[0], list.slice(1), tax, measure);

  const rest = pathTravelCost(list[0], list.slice(1), tax, measure);
  const core0 = Number.isFinite(firstCost) ? firstCost : 0;
  return { total: core0 + rest.total, core: core0 + rest.core, surcharge: rest.surcharge };
}

function finiteElev(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
