// Sheet Speed as animation pace.
//
// Foundry animates every token at `CONFIG.Token.movement.defaultSpeed` (6 grid spaces per second),
// which is why a 30 ft walk and an 80 ft fly look identical and why a 30-foot drag finishes in about
// 2.5 seconds instead of the 6 the round is. dnd5e Speed is feet per 6 seconds; the conversion is
// `(feet / grid.distance) / 6` spaces per second. Haste and Slow already rewrite the live sheet
// number, so reading that number is the whole of those spells.
//
// Elevation is in scene units, not pixels. Core's duration helper ignores it; including it is what
// makes a 50-foot climb take the time the sheet says.
//
// Blink, displace and our own forced-movement action stay instant: they are not travel.

export const ROUND_SECONDS = 6;

const INSTANT = new Set(["blink", "displace", "noodlrforce"]);

/** Positive finite number, or null. */
function pos(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Feet this creature may cover in one round with the selected movement action.
 *
 * Jump spends walking Speed (the leap limit is a different question). Crawl is half a walk.
 * An action with no listed speed falls back to walk rather than claiming the creature cannot move.
 */
export function sheetFeetPerRound(input: {
  action: string;
  modes: Partial<Record<string, number>>;
}): number | null {
  const action = String(input.action || "walk").toLowerCase();
  if (INSTANT.has(action)) return null;
  if (action === "jump") return pos(input.modes.walk);
  if (action === "crawl") {
    const walk = pos(input.modes.walk);
    return walk === null ? null : walk / 2;
  }
  return pos(input.modes[action]) ?? pos(input.modes.walk);
}

/** Grid spaces per second from a round's worth of feet. */
export function sheetSpacesPerSecond(feetPerRound: number, gridDistance: number): number | null {
  if (!(feetPerRound > 0) || !(gridDistance > 0)) return null;
  return feetPerRound / gridDistance / ROUND_SECONDS;
}

export function gridDistanceOf(doc?: any): number {
  const n = Number(
    doc?.parent?.grid?.distance ?? (globalThis as any).canvas?.scene?.grid?.distance ?? 5,
  );
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/** Live sheet → spaces/sec, or null when the animation should stay Foundry's. */
export function sheetSpacesPerSecondOf(doc: any): number | null {
  const feet = sheetFeetPerRound({
    action: String(doc?.movementAction ?? "walk"),
    modes: doc?.actor?.system?.attributes?.movement ?? {},
  });
  if (feet === null) return null;
  return sheetSpacesPerSecond(feet, gridDistanceOf(doc));
}

/**
 * Milliseconds to animate from → to at a given spaces/sec, including elevation.
 *
 * `gridSize` is pixels per square. Elevation is converted through `gridDistance` so a 10-foot rise
 * on a 5-foot grid is two spaces, the same as walking 10 feet on the flat.
 */
export function animationDurationMs(
  from: { x?: number; y?: number; elevation?: number },
  to: { x?: number; y?: number; elevation?: number },
  spacesPerSec: number,
  gridSize: number,
  gridDistance: number,
): number {
  if (!(spacesPerSec > 0) || !(gridSize > 0) || !(gridDistance > 0)) return 1000;
  const dx = (from.x ?? 0) - (to.x ?? from.x ?? 0);
  const dy = (from.y ?? 0) - (to.y ?? from.y ?? 0);
  const fromE = Number(from.elevation ?? 0);
  const toE = Number(to.elevation ?? fromE);
  const de = ((Number.isFinite(fromE) ? fromE : 0) - (Number.isFinite(toE) ? toE : 0)) *
    (gridSize / gridDistance);
  const spaces = Math.hypot(dx, dy, de) / gridSize;
  // Whole milliseconds for the ticker. Rounding spaces/sec to a tenth is the wrong fix for
  // a jerky walk: Foundry restarts the animation at every grid square, and a rider used to
  // play a second walk on top of the mount. Those seams are visible at 1 space/sec and
  // invisible at Foundry's default 6. See motion-fx.ts and riding follow (`animate: false`).
  return Math.round((spaces / spacesPerSec) * 1000);
}
