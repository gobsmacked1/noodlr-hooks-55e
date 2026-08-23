// Actually moving the token.
//
// Up to v0.4.23 the planner only ever *announced* movement ("closes 15 ft on Hobocop"), which the GM
// then had to perform by hand — the single loudest complaint from the first play test: "no NPCs moved".
// This module performs it.
//
// Deliberate limits, so the behaviour is predictable rather than clever:
//   - Single steps, not paths. No pathfinding: when the direct line is blocked the step is shortened and
//     then fanned out to either side, and whichever candidate closes the most ground and is actually legal
//     is the one taken. A creature that cannot get there this turn simply gets closer and tries again —
//     what it must never do is stop dead against a wall, which is exactly what "straight line only" did.
//   - Never moves further than the budget it was given, and never onto an occupied square.
//   - Snapped to the grid where the scene has one, so tokens land in squares like a player's would.
//   - Nothing here touches hit points, resources, or the turn — movement is the only side effect.

import { log } from "../constants";
import { getMoveSpeed } from "../settings";
import { actionFor, readLocomotion } from "./locomotion";
import {
  affordableElevation,
  elevationTaxOf,
  verticalCost,
} from "./elevation-cost";
import {
  blocked,
  centerOf,
  insideScene,
  measureBetween,
  occupied,
  type Point,
} from "./positioning";

/** Optional detail a caller knows and `moveTo` cannot work out for itself. */
export interface MoveIntent {
  /** Height to arrive at. Omitted means "stay at the height you are". */
  elevation?: number;
  /** Movement remaining, in scene units, so core can stop the path when the cost runs out. */
  budget?: number;
  /**
   * Movement action to hand Foundry. Callers that know the creature is Prone pass `crawl`;
   * omitted means `actionFor` (walk / fly / …). Core only charges crawl rates when this is crawl.
   */
  action?: string;
}

function gridSize(): number {
  return Number((canvas as any)?.grid?.size) || 100;
}

function unitsPerSquare(): number {
  return Number((canvas as any)?.grid?.distance) || 5;
}

/** False on a gridless scene, where any distance is a legal destination. */
function isGridded(): boolean {
  return Number((canvas as any)?.grid?.type ?? 0) !== 0;
}

/**
 * Canvas pixels per scene unit ALONG ONE PARTICULAR LINE.
 *
 * The flat `toPixels` conversion is only correct on an orthogonal move. At the EQUIDISTANT default a
 * diagonal square costs 5 ft and spans 212 px, so converting a wanted distance by the grid scale alone
 * undershoots every diagonal approach by 30% — the creature closes two thirds of what it meant to and
 * then reports the shortfall as if a wall had stopped it. Dividing the real pixel span by the measured
 * cost gives the right ratio for whichever bearing is in play, including the gridless case.
 */
function pixelsPerUnit(from: Point, to: Point, measured: number): number {
  if (!(measured > 0)) return gridSize() / unitsPerSquare();
  return Math.hypot(to.x - from.x, to.y - from.y) / measured;
}

/** Scene units → canvas pixels. */
function toPixels(units: number): number {
  return (units / unitsPerSquare()) * gridSize();
}

/** Canvas pixels → scene units. */
function toUnits(pixels: number): number {
  return (pixels / gridSize()) * unitsPerSquare();
}

/**
 * Top-left document coordinates for a token whose CENTRE should sit at `point`, snapped to the grid.
 *
 * Foundry stores token position as the top-left corner, while every measurement here is centre-based;
 * conflating the two puts large creatures half a square off, which is exactly the sort of error that
 * looks like "the AI moved it somewhere stupid".
 *
 * Reports whether snapping actually happened, because the waypoint's `snapped` field is pure metadata:
 * it records a claim for the ruler and undo history and snaps nothing itself, so setting it on an
 * unaligned coordinate just files a false statement.
 */
export function cornerFor(token: any, point: Point): { point: Point; snapped: boolean } {
  const doc = token?.document ?? token;
  const size = gridSize();
  const corner = {
    x: point.x - (size * (Number(doc?.width) || 1)) / 2,
    y: point.y - (size * (Number(doc?.height) || 1)) / 2,
  };

  // The document's own snapper understands the token's footprint; the raw grid snapper does not.
  for (const snap of [
    () => doc?.getSnappedPosition?.(corner),
    () => (canvas as any)?.grid?.getSnappedPoint?.(corner),
  ]) {
    try {
      const snapped = snap();
      if (Number.isFinite(snapped?.x) && Number.isFinite(snapped?.y))
        return { point: { x: snapped.x, y: snapped.y }, snapped: true };
    } catch {
      // gridless scenes and unfamiliar grid APIs keep the unsnapped position
    }
  }
  return { point: corner, snapped: false };
}

/**
 * How this creature travels, as one of the movement actions the core config declares.
 *
 * Matters because each action carries its own wall rule: a flyer told to "walk" is tested against walls
 * it should be crossing. An action the core does not recognise makes `move()` throw, so anything
 * unrecognised is omitted and the core default applies.
 */
function movementAction(token: any, verticalChange: boolean): string | undefined {
  const doc = token?.document ?? token;
  return actionFor(readLocomotion(doc?.actor), verticalChange);
}

/** A height difference smaller than this is rounding, not a climb. */
const VERTICAL_TOLERANCE = 1;

/**
 * The token's current elevation, carried through every move.
 *
 * Waypoints default any field they omit, so leaving elevation out is *usually* harmless — but "usually"
 * is not good enough for a party fighting on top of a barbican, where a move that silently lands at
 * elevation 0 puts a creature inside the structure rather than on it. Stating it costs nothing.
 */
function elevationOf(doc: any): number {
  const raw = Number(doc?._source?.elevation ?? doc?.elevation);
  return Number.isFinite(raw) ? raw : 0;
}

/**
 * Whether this GM has core's "Unconstrained Movement" switched on.
 *
 * Core reads that setting ONLY in the drag workflow, so a GM who has turned it on can drag a token
 * through a wall all day while an identical programmatic move is silently refused. Mirroring it here is
 * what makes Noodlr's moves behave the way the GM's own hands do — which is the whole promise of "the
 * module moves the token for you". Off by default, so a table that enforces walls keeps enforcing them.
 */
function unconstrained(): boolean {
  try {
    return Boolean(game.user?.isGM && game.settings.get("core", "unconstrainedMovement"));
  } catch {
    return false;
  }
}

/**
 * How long a move may make no visible progress before it is abandoned.
 *
 * A movement PAUSED by a region behaviour (Terrain Mapper's stairs and elevators do this) never
 * resolves its promise at all — so an unguarded await would hang the creature's turn, and with it the
 * whole automated initiative chain, for the rest of the session.
 *
 * This is a STALL watchdog, not a deadline. The first version was a flat 8-second timeout, which was
 * fine until the movement-speed setting arrived: a creature crossing twelve squares at one square per
 * second takes twelve seconds legitimately, and a deadline would have killed the walk mid-stride and
 * reported it as a hang. Time spent visibly animating does not count against this.
 */
const MOVE_STALL_MS = 15000;

/**
 * Move a token so its centre lands at `point`. Returns the distance travelled in scene units.
 *
 * Uses `TokenDocument#move` (Foundry v13+), which walks the token through the intervening grid spaces,
 * constrains the path against walls, and records the move in the token's history — everything a player
 * dragging the token would get. `update({x, y})` is NOT a fallback: since v13 it is routed through the
 * identical pipeline and is just as refusable, while hiding the outcome behind a truthy return.
 *
 * The distance returned is measured from where the token ACTUALLY ended up, not from where it was asked
 * to go, so a creature stopped short by a wall reports the shorter distance — and 0 means it did not
 * move at all, which the caller is expected to act on rather than assume away.
 */
export async function moveTo(token: any, point: Point, intent: MoveIntent = {}): Promise<number> {
  const origin = centerOf(token);
  const doc = token?.document ?? token;
  if (!origin) {
    log("movement: no position for the token; cannot move it");
    return 0;
  }
  if (typeof doc?.move !== "function") {
    log("movement: this token document has no move(); Foundry v13 or newer is required");
    return 0;
  }

  const { point: corner, snapped } = cornerFor(token, point);
  const before = sourcePosition(doc);

  const from = elevationOf(doc);
  const wantedElev = Number.isFinite(intent.elevation as number) ? (intent.elevation as number) : from;
  const climbing = Math.abs(wantedElev - from) > VERTICAL_TOLERANCE;
  const actions: any = (globalThis as any).CONFIG?.Token?.movement?.actions;
  const wanted = intent.action && actions?.[intent.action] ? intent.action : movementAction(token, climbing);
  const budget = Number(intent.budget);
  const to =
    Number.isFinite(budget) && budget >= 0
      ? affordableElevation(from, wantedElev, budget, wanted ?? "walk", elevationTaxOf(doc?.actor))
      : wantedElev;
  if (to !== wantedElev) {
    log(
      `movement: ${describe(doc)} can only change elevation ${from} → ${to} (wanted ${wantedElev}) on a ${budget} budget`,
    );
  }

  const waypoint: Record<string, unknown> = {
    // Top-left pixel coordinates, as integers. Not centres, not grid offsets.
    x: Math.round(corner.x),
    y: Math.round(corner.y),
    elevation: to,
    snapped,
    explicit: true,
    checkpoint: true,
  };
  if (wanted) waypoint.action = wanted;
  const ignoreWalls = unconstrained();
  const speed = getMoveSpeed();
  const animation = speed > 0 ? { movementSpeed: speed } : undefined;

  // Let core enforce the budget in COST rather than distance, when it is known. That is the only way
  // difficult terrain is honoured: 30 ft of movement buys 15 ft of bog, and core already knows the
  // multipliers for every movement action — including that a flyer is not paying them. The previous
  // `ignoreCost: true` bought immunity from that accounting, which was quietly a rules violation.
  const constrainOptions: Record<string, unknown> = { ignoreWalls };
  if (Number.isFinite(intent.budget as number) && (intent.budget as number) > 0) {
    constrainOptions.maxCost = intent.budget;
  }

  let completed: unknown;
  try {
    completed = await awaitMove(
      doc,
      doc.move(waypoint, {
        method: "api",
        constrainOptions,
        autoRotate: false,
        showRuler: false,
        ...(animation ? { animation } : {}),
      }),
    );
  } catch (err) {
    log("movement: move() threw:", err);
    return 0;
  }

  if (completed === TIMED_OUT) {
    // Almost certainly paused by a region behaviour. Stop it, so the creature's turn — and the whole
    // automated initiative chain behind it — is not left awaiting a promise that will never settle.
    log(`movement: ${describe(doc)} stalled mid-move (state: ${state(doc)}); abandoning it`);
    try {
      doc.stopMovement?.();
    } catch {
      // nothing more to do; the turn continues either way
    }
  }

  const after = sourcePosition(doc);
  // A pixel of drift is rounding, not movement.
  if (Math.hypot(after.x - before.x, after.y - before.y) > 1) {
    await settleAnimation(doc);
    const landed = centerOf(token) ?? point;
    // Measured the way the scene measures it, not by Pythagoras: this number is what the "advances
    // N ft" card prints, and a diagonal square reported as 7 ft rather than 5 makes a correct move
    // read as a rules error.
    return Math.round(measureBetween(origin, landed));
  }

  reportRefusal(doc, completed, waypoint);
  return 0;
}

/**
 * Wait for the token to finish sliding before the turn carries on.
 *
 * The document's coordinates update before the sprite arrives, so without this the attack card and the
 * spoken line land while the creature is still visibly mid-stride, and the turn-pace floor measures a
 * turn that has not finished happening. Bounded, and silent about APIs it does not recognise: an
 * unknown animation shape means no wait, which is exactly the behaviour before this existed.
 */
async function settleAnimation(doc: any): Promise<void> {
  const contexts = doc?.object?.animationContexts;
  if (!(contexts?.size > 0)) return;
  // Generous, because the movement-speed setting can legitimately make a long walk take many seconds.
  // This waits for a slide that is genuinely happening; it is not a budget for one.
  const deadline = Date.now() + 60000;
  while (contexts.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const TIMED_OUT = Symbol("timed-out");

/** True while the token is visibly sliding, or core still considers the movement live. */
function moveInProgress(doc: any): boolean {
  if ((doc?.object?.animationContexts?.size ?? 0) > 0) return true;
  const state = String(doc?.movement?.state ?? "");
  return state === "pending" || state === "planned";
}

/**
 * Await a move, giving up only once it stops making progress.
 *
 * Resolves with whatever `move()` returned, or TIMED_OUT if the movement paused or went quiet. A paused
 * movement is abandoned at once rather than waited out, because its promise is never going to settle.
 */
function awaitMove<T>(doc: any, promise: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let settled = false;
  const tracked = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      settled = true;
      throw error;
    },
  );

  const watchdog = (async (): Promise<typeof TIMED_OUT> => {
    let idle = 0;
    while (!settled) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (settled) break;
      if (String(doc?.movement?.state ?? "") === "paused") return TIMED_OUT;
      idle = moveInProgress(doc) ? 0 : idle + 250;
      if (idle >= MOVE_STALL_MS) return TIMED_OUT;
    }
    // The real result won the race. Never resolve, so this cannot overtake it.
    return new Promise<never>(() => {});
  })();

  return Promise.race([tracked, watchdog]);
}

/**
 * The token's stored position, not its animated one.
 *
 * `_source` is the only honest reading: the prepared `x`/`y` are interpolated during the move animation,
 * so comparing them can report movement that is only a frame of tweening — or none at all, because the
 * animation has not started yet. This is why v0.4.24's "verify it moved" check could not be trusted.
 */
function sourcePosition(doc: any): { x: number; y: number } {
  const source = doc?._source ?? doc;
  return { x: Number(source?.x) || 0, y: Number(source?.y) || 0 };
}

function describe(doc: any): string {
  return String(doc?.name ?? "token");
}

function state(doc: any): string {
  return String(doc?.movement?.state ?? "unknown");
}

/**
 * Explain a move that did not happen, in the terms its cause actually has.
 *
 * `move()` returning false and `move()` returning true are two DIFFERENT failures, and conflating them
 * is what kept this invisible for two releases:
 *
 *  - `false` means core refused: the path was constrained to nothing (a wall, or a destination inside
 *    one), or a `preMoveToken` handler vetoed it. Note that the GM's "Unconstrained Movement" toggle does
 *    not apply to programmatic moves — core reads it only in the drag workflow — so "I can drag the token
 *    there myself" proves nothing about this call.
 *  - `true` with the token still in place means something removed the position from the update after core
 *    had already approved it (`preUpdateToken`), or the destination snapped back onto this square (a
 *    sub-square step under the scene's diagonal rule does that). The old advice named Rideable and
 *    Monk's Active Tiles; those were installed-and-disabled in the world that produced the residue, so
 *    `strippedAdvice` names what is actually active and what statuses/regions are on the token.
 */
/**
 * What actually looks able to have stripped a move, rather than a stale shortlist.
 *
 * Rideable / Monk's Active Tiles / Token Warp / NotYourTurn were the original suspects and are
 * still named when they are *active*. When they are not, the line used to keep blaming them —
 * which is how a world with all four disabled still printed that advice. Terrain Mapper region
 * behaviours are the first remaining suspect on this table; a same-square snap is the other.
 */
function strippedAdvice(doc: any): string {
  const clues: string[] = [];
  const actor = doc?.actor;
  const statuses = [...(actor?.statuses ?? [])].map((s) => String(s).toLowerCase());
  for (const status of ["grappled", "restrained", "dead", "unconscious", "stunned", "paralyzed"]) {
    if (statuses.includes(status)) clues.push(status);
  }

  const regions = doc?.regions ?? doc?.object?.document?.regions;
  const regionCount = Number(regions?.size ?? regions?.length ?? 0);
  if (regionCount > 0) {
    clues.push(`standing in ${regionCount} region(s) — Terrain Mapper stairs pause a move`);
  }

  const named: Array<[string, string]> = [
    ["terrainmapper", "Terrain Mapper"],
    ["rideable", "Rideable"],
    ["monks-active-tiles", "Monk's Active Tiles"],
    ["tokenwarp", "Token Warp"],
    ["NotYourTurn", "NotYourTurn"],
    ["patrol", "Patrol"],
    ["about-face", "About Face"],
    ["item-piles", "Item Piles"],
    ["routinglib", "routinglib"],
  ];
  const live: string[] = [];
  try {
    const modules = (game as any)?.modules;
    for (const [id, label] of named) {
      if (modules?.get?.(id)?.active) live.push(label);
    }
  } catch {
    // Reading the module list is not worth taking the log line down for.
  }
  if (live.length) clues.push(`active modules that touch movement: ${live.join(", ")}`);

  if (clues.length) return clues.join("; ");
  return (
    "no known movement interceptor is active — the destination may have snapped back onto this " +
    "square (a sub-square step under the scene's diagonal rule does that), or a region behaviour " +
    "paused the move"
  );
}

function reportRefusal(doc: any, completed: unknown, waypoint: Record<string, unknown>): void {
  const movement: any = doc?.movement;
  const detail = {
    completed,
    constrained: movement?.constrained,
    state: movement?.state,
    destination: `${waypoint.x},${waypoint.y}`,
    action: waypoint.action ?? "(core default)",
  };

  if (completed === true) {
    log(
      `movement: core allowed ${describe(doc)}'s move but its position was stripped before saving — ${strippedAdvice(doc)}`,
      detail,
    );
    return;
  }
  if (movement?.constrained) {
    log(
      `movement: ${describe(doc)}'s path hit walls or terrain and was shortened to nothing`,
      detail,
    );
    return;
  }
  log(
    `movement: ${describe(doc)} was refused — either a preMoveToken handler vetoed it (NotYourTurn and ` +
      `Token Warp both do this) or the destination is unreachable`,
    detail,
  );
}

/**
 * Step toward a target, stopping once within `desired` scene units of it.
 *
 * Tries the full step first and then progressively shorter ones, so a wall or a crowded square costs
 * distance rather than the whole move. Returns the distance actually travelled.
 */
export async function moveToward(
  token: any,
  target: any,
  budget: number,
  desired: number,
  extra: Pick<MoveIntent, "action" | "elevation"> = {},
): Promise<number> {
  const goal = centerOf(target);
  if (!goal) {
    log(
      `movement: ${describe(token?.document ?? token)} cannot step toward a target with no position`,
    );
    return 0;
  }
  return moveTowardPoint(token, goal, budget, desired, {
    label: describe(target?.document ?? target),
    elevation: extra.elevation ?? reachableElevation(token, target),
    action: extra.action,
  });
}

/**
 * Step toward a place rather than a creature, stopping once within `desired` scene units of it.
 *
 * The whole of `moveToward` except for reading the goal off a token, split out for the searching
 * creature: an enemy that has broken line of sight is not a token the planner may aim at any more —
 * that is the entire point of it having hidden — so what remains is a remembered point on the floor.
 * Two copies of the fan, the sub-square guard and the pixel conversion would be two chances to fix a
 * measurement bug in one of them, which is the mistake `measureBetween` exists to have stopped making.
 */
export async function moveTowardPoint(
  token: any,
  goal: Point,
  budget: number,
  desired: number,
  intent: { label?: string; elevation?: number; action?: string } = {},
): Promise<number> {
  const who = describe(token?.document ?? token);
  const origin = centerOf(token);
  const label = intent.label ?? "that spot";
  if (!origin) {
    log(`movement: ${who} cannot step anywhere without a position of its own`);
    return 0;
  }
  if (!(budget > 0)) {
    log(`movement: ${who} has no movement budget (speed read as ${budget})`);
    return 0;
  }

  const doc = token?.document ?? token;
  const from = elevationOf(doc);
  const wantedElev = Number.isFinite(intent.elevation as number) ? (intent.elevation as number) : from;
  const climbing = Math.abs(wantedElev - from) > VERTICAL_TOLERANCE;
  const actions: any = (globalThis as any).CONFIG?.Token?.movement?.actions;
  const action =
    intent.action && actions?.[intent.action] ? intent.action : movementAction(token, climbing);
  const tax = elevationTaxOf(doc?.actor);
  const destElev = affordableElevation(from, wantedElev, budget, action ?? "walk", tax);
  const reserved = verticalCost(from, destElev, action ?? "walk", tax);
  const leftover = Math.max(0, budget - reserved);

  // Measured the way the planner measured it when it decided this creature was out of reach. These
  // used to be two different answers — see `measureBetween`.
  const separation = measureBetween(origin, goal);
  // How far we would LIKE to travel: enough to be in range, no further. Elevation is reserved first
  // so a landing dragon does not also spend those feet walking.
  const wanted = Math.min(leftover, Math.max(0, separation - Math.max(desired, 0)));
  if (wanted <= 0) {
    if (Math.abs(destElev - from) > VERTICAL_TOLERANCE) {
      return moveTo(token, origin, { budget, elevation: destElev, action });
    }
    return 0;
  }

  // A gap smaller than one square has nowhere to stand in the middle of it, so every candidate would
  // snap back to the square the creature already holds and be refused. Saying so once is honest;
  // attempting it eight times, each behind a stall watchdog, is what a creature "stuck in place next
  // to its target" actually looked like. Only reachable on a scene whose diagonal rule disagrees with
  // its reaches — Foundry's EXACT setting makes a diagonal neighbour 7.07 ft away and a 5 ft reach
  // unable to touch it — and there the honest answer is that the grid offers nothing nearer.
  if (isGridded() && wanted < unitsPerSquare()) {
    log(
      `movement: ${who} is ${Math.round(separation)} from ${label} and needs to close only ` +
        `${wanted.toFixed(1)} — less than one square, so there is no nearer square to stand in`,
    );
    return 0;
  }

  const bearing = Math.atan2(goal.y - origin.y, goal.x - origin.x);
  const wantedPixels = wanted * pixelsPerUnit(origin, goal, separation);

  return stepTo(token, origin, approaches(origin, bearing, wantedPixels), `toward ${label}`, {
    budget,
    elevation: destElev,
    action: intent.action ?? action,
  });
}

/** How far off the direct line a creature will step to get past something. */
const FAN = [0, Math.PI / 5, -Math.PI / 5, (2 * Math.PI) / 5, (-2 * Math.PI) / 5];

/** How much of the wanted distance to try, straight ahead. */
const SHORTER = [1, 0.75, 0.5, 0.25];

/**
 * Destinations to try, best first, for a creature walking toward something.
 *
 * Straight ahead and then progressively shorter used to be the whole list, and it is why a creature that
 * met a wall stopped dead: every one of the four candidates lay on the same blocked line, so shortening
 * the step only moved the refusal closer. `moveAwayFrom` had had a fan of bearings since it was written
 * and this did not, which is the whole of the bug — a Troll walked into a wall and stood there for the
 * rest of the fight rather than taking one step sideways (reported 2026-08-15).
 *
 * Ordered by how much ground the step actually closes (`cos` of the angle times the fraction), so the
 * direct route always wins when it is open, a shallow detour beats a short shuffle forward, and a
 * sidestep that barely gains anything is the last resort. That single rule replaces having to reason
 * about which is preferable in each case, and it keeps the list to eight attempts — each one is a real
 * `move()` with a stall watchdog behind it, so this is not a search space to be generous with.
 *
 * Deliberately NOT pathfinding. A creature that has to go round three corners still gets closer and tries
 * again next turn, which is the behaviour this file promises at the top; what it must never do is stop.
 *
 * Exported only so `test/movement.test.ts` can pin the ordering without a canvas, the same precedent as
 * `timeoutChoice` and `survivalOptions`.
 */
export function approaches(
  origin: { x: number; y: number },
  bearing: number,
  wanted: number,
): Array<{ label: string; point: { x: number; y: number } }> {
  const candidates: Array<{ gain: number; offset: number; fraction: number }> = [];
  for (const offset of FAN) {
    // Sideways steps are tried at full stretch only. Half of a wide detour gains almost nothing and would
    // crowd out the shorter straight steps, which are better moves.
    for (const fraction of offset === 0 ? SHORTER : [1]) {
      candidates.push({ gain: Math.cos(offset) * fraction, offset, fraction });
    }
  }
  candidates.sort((a, b) => b.gain - a.gain);

  return candidates.map(({ offset, fraction }) => {
    const distance = wanted * fraction;
    const degrees = Math.round((offset * 180) / Math.PI);
    return {
      label: `${Math.round(toUnits(distance))} ft${degrees === 0 ? "" : ` at ${degrees}\u00b0`}`,
      point: {
        x: origin.x + Math.cos(bearing + offset) * distance,
        y: origin.y + Math.sin(bearing + offset) * distance,
      },
    };
  });
}

/**
 * The height to arrive at when moving to meet something, or undefined to stay put vertically.
 *
 * Only a creature that can fly rises to meet a target above it — a wolf cannot climb into the air to
 * bite a hovering wizard, and pretending otherwise would move a token somewhere the rules forbid. When
 * the difference is small enough to be a stair rather than a flight, it is matched regardless, so a
 * creature does not refuse to step up onto the barbican it is standing beside.
 */
function reachableElevation(token: any, target: any): number | undefined {
  const selfDoc = token?.document ?? token;
  const targetDoc = target?.document ?? target;
  const mine = elevationOf(selfDoc);
  const theirs = elevationOf(targetDoc);
  if (Math.abs(theirs - mine) <= VERTICAL_TOLERANCE) return undefined;

  const loco = readLocomotion(selfDoc?.actor);
  return (loco.modes.fly ?? 0) > 0 || (loco.modes.climb ?? 0) > 0 ? theirs : undefined;
}

/**
 * Try each candidate destination in turn, and say out loud why the ones that failed did.
 *
 * Every rejection used to be a bare `continue`. That silence is the reason this bug survived three
 * releases: `moveTo` reports refusals in detail, but nothing ever reached `moveTo` — the candidates
 * were all discarded first, and a creature that never attempted to move looked exactly like a creature
 * whose move was ignored.
 */
async function stepTo(
  token: any,
  origin: Point,
  candidates: Array<{ label: string; point: Point }>,
  intent: string,
  move: MoveIntent = {},
): Promise<number> {
  const doc = token?.document ?? token;
  const who = describe(doc);
  const here = sourcePosition(doc);
  const height = elevationOf(doc);
  const rejected: string[] = [];

  for (const { label, point } of candidates) {
    if (!insideScene(point)) {
      rejected.push(`${label}: outside the scene`);
      continue;
    }
    // A destination that snaps back to the square the creature already holds is not a move, and asking
    // core to perform it costs a real `move()` round trip with a stall watchdog behind it to be told so.
    // Elevation is part of the test: a flyer rising within its own square IS going somewhere.
    const { point: corner } = cornerFor(token, point);
    const climbing =
      Number.isFinite(move.elevation as number) &&
      Math.abs((move.elevation as number) - height) > VERTICAL_TOLERANCE;
    if (!climbing && Math.hypot(corner.x - here.x, corner.y - here.y) < 1) {
      rejected.push(`${label}: snaps back to the square it is already in`);
      continue;
    }
    if (occupied(point, token)) {
      rejected.push(`${label}: square already taken`);
      continue;
    }
    // ADVISORY ONLY. This used to veto the candidate, which made our own 2-D wall test a second, silent
    // authority competing with core's — and core is the one that decides. It matters on a scene with
    // elevation: tokens on top of a structure read as blocked by the walls of the rooms beneath them,
    // so every candidate was discarded before core ever got a say. Core is asked regardless now.
    const wall = blocked(origin, point, "move") === true ? " (our wall test says blocked)" : "";
    const travelled = await moveTo(token, point, move);
    if (travelled > 0) return travelled;
    rejected.push(`${label}: refused${wall}`);
  }

  log(`movement: ${who} could not step ${intent} — ${rejected.join("; ")}`);
  return 0;
}

/**
 * Back away from a target until at least `desired` units separate them.
 *
 * Used for withdrawing out of reach. Retreat is fanned across nearby bearings, because the direct
 * line away is frequently the one thing a wall is standing on.
 */
export async function moveAwayFrom(
  token: any,
  target: any,
  budget: number,
  desired: number,
  extra: Pick<MoveIntent, "action" | "elevation"> = {},
): Promise<number> {
  const who = describe(token?.document ?? token);
  const origin = centerOf(token);
  const threat = centerOf(target);
  if (!origin || !threat) {
    log(`movement: ${who} cannot back away from a threat with no position`);
    return 0;
  }
  if (!(budget > 0)) {
    log(`movement: ${who} has no movement budget (speed read as ${budget})`);
    return 0;
  }

  const separation = measureBetween(threat, origin);
  const needed = Math.max(0, desired - separation);
  // Nothing to gain means "just go", which is what a rout is; the budget is the whole answer there.
  const distance =
    Math.min(budget, needed || budget) * pixelsPerUnit(threat, origin, separation || 1);
  if (distance < gridSize() * 0.25) return 0;

  const base = Math.atan2(origin.y - threat.y, origin.x - threat.x);
  // Straight back first, then fan out to either side.
  const offsets = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3];
  return stepTo(
    token,
    origin,
    offsets.map((offset) => ({
      label: `${Math.round((offset * 180) / Math.PI)}\u00b0`,
      point: {
        x: origin.x + Math.cos(base + offset) * distance,
        y: origin.y + Math.sin(base + offset) * distance,
      },
    })),
    `away from ${describe(target?.document ?? target)}`,
    { budget, action: extra.action, elevation: extra.elevation },
  );
}

/**
 * Leave the field. A creature that flees walks to the nearest scene edge under its own speed; the
 * token is taken off the scene by `tactics/flee.ts` after three of its own turns or once it reaches
 * the edge. Resolving the encounter on the first flee step is what started a new fight the moment
 * the same token was spotted again.
 */
export async function moveOffField(
  token: any,
  budget: number,
  extra: Pick<MoveIntent, "action"> = {},
): Promise<number> {
  const who = describe(token?.document ?? token);
  const origin = centerOf(token);
  const rect: any = (canvas as any)?.dimensions?.sceneRect;
  if (!origin || !rect) {
    log(`movement: ${who} cannot flee — no position or no scene bounds`);
    return 0;
  }
  if (!(budget > 0)) {
    log(`movement: ${who} has no movement budget to flee with (speed read as ${budget})`);
    return 0;
  }

  const exits: Point[] = [
    { x: rect.x, y: origin.y },
    { x: rect.x + rect.width, y: origin.y },
    { x: origin.x, y: rect.y },
    { x: origin.x, y: rect.y + rect.height },
  ];
  exits.sort(
    (a, b) =>
      Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y),
  );

  const distance = toPixels(budget);
  return stepTo(
    token,
    origin,
    exits.map((exit, i) => {
      const span = Math.hypot(exit.x - origin.x, exit.y - origin.y) || 1;
      const step = Math.min(distance, span);
      return {
        label: `exit ${i + 1}`,
        point: {
          x: origin.x + ((exit.x - origin.x) / span) * step,
          y: origin.y + ((exit.y - origin.y) / span) * step,
        },
      };
    }),
    "off the field",
    { budget, action: extra.action },
  );
}
