// Actually moving the token.
//
// Up to v0.4.23 the planner only ever *announced* movement ("closes 15 ft on Hobocop"), which the GM
// then had to perform by hand — the single loudest complaint from the first play test: "no NPCs moved".
// This module performs it.
//
// Deliberate limits, so the behaviour is predictable rather than clever:
//   - Straight-line steps only. No pathfinding: if a wall blocks the direct line, we shorten the step
//     and try again rather than route around. A creature that cannot get there simply gets closer.
//   - Never moves further than the budget it was given, and never onto an occupied square.
//   - Snapped to the grid where the scene has one, so tokens land in squares like a player's would.
//   - Nothing here touches hit points, resources, or the turn — movement is the only side effect.

import { log } from "../../constants";
import { getMoveSpeed } from "../config";
import { blocked, centerOf, insideScene, occupied, type Point } from "./positioning";

function gridSize(): number {
  return Number((canvas as any)?.grid?.size) || 100;
}

function unitsPerSquare(): number {
  return Number((canvas as any)?.grid?.distance) || 5;
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
function cornerFor(token: any, point: Point): { point: Point; snapped: boolean } {
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
function movementAction(token: any): string | undefined {
  const actions: any = (globalThis as any).CONFIG?.Token?.movement?.actions;
  if (!actions) return undefined;

  const doc = token?.document ?? token;
  const modes: any = doc?.actor?.system?.attributes?.movement;
  if (modes) {
    if (Number(modes.walk) > 0) return actions.walk ? "walk" : undefined;
    // No walk speed: whatever it does instead, in the order a creature would prefer it.
    for (const mode of ["fly", "swim", "burrow", "climb"]) {
      if (Number(modes[mode]) > 0 && actions[mode]) return mode;
    }
  }
  return actions.walk ? "walk" : undefined;
}

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
export async function moveTo(token: any, point: Point): Promise<number> {
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

  const waypoint: Record<string, unknown> = {
    // Top-left pixel coordinates, as integers. Not centres, not grid offsets.
    x: Math.round(corner.x),
    y: Math.round(corner.y),
    elevation: elevationOf(doc),
    snapped,
    explicit: true,
    checkpoint: true,
  };
  const action = movementAction(token);
  if (action) waypoint.action = action;
  const ignoreWalls = unconstrained();
  const speed = getMoveSpeed();
  const animation = speed > 0 ? { movementSpeed: speed } : undefined;

  let completed: unknown;
  try {
    // `ignoreCost` because the planner already budgeted this creature's movement in scene units;
    // letting terrain cost truncate the path as well would silently halve every move across rough
    // ground. Walls are enforced unless this GM has told Foundry they should not be.
    completed = await awaitMove(
      doc,
      doc.move(waypoint, {
        method: "api",
        constrainOptions: { ignoreCost: true, ignoreWalls },
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
    return Math.round(toUnits(Math.hypot(landed.x - origin.x, landed.y - origin.y)));
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
 *    had already approved it, which is a `preUpdateToken` handler: a grappled or mounted creature
 *    (Rideable), or one on a teleport cooldown (Monk's Active Tiles).
 */
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
      `movement: core allowed ${describe(doc)}'s move but its position was stripped before saving — is ` +
        `it grappled, mounted, or on a teleport cooldown?`,
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
): Promise<number> {
  const who = describe(token?.document ?? token);
  const origin = centerOf(token);
  const goal = centerOf(target);
  if (!origin || !goal) {
    log(`movement: ${who} cannot step toward a target with no position`);
    return 0;
  }
  if (!(budget > 0)) {
    log(`movement: ${who} has no movement budget (speed read as ${budget})`);
    return 0;
  }

  const separation = Math.hypot(goal.x - origin.x, goal.y - origin.y);
  const stopShort = toPixels(Math.max(desired, 0));
  // How far along the line we would LIKE to travel: enough to be in range, no further.
  const wanted = Math.min(toPixels(budget), Math.max(0, separation - stopShort));
  if (wanted < gridSize() * 0.25) return 0;

  const ux = (goal.x - origin.x) / separation;
  const uy = (goal.y - origin.y) / separation;

  return stepTo(
    token,
    origin,
    [1, 0.75, 0.5, 0.25].map((fraction) => ({
      label: `${Math.round(toUnits(wanted * fraction))} ft`,
      point: {
        x: origin.x + ux * wanted * fraction,
        y: origin.y + uy * wanted * fraction,
      },
    })),
    `toward ${describe(target?.document ?? target)}`,
  );
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
): Promise<number> {
  const who = describe(token?.document ?? token);
  const rejected: string[] = [];

  for (const { label, point } of candidates) {
    if (!insideScene(point)) {
      rejected.push(`${label}: outside the scene`);
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
    const travelled = await moveTo(token, point);
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

  const separation = Math.hypot(origin.x - threat.x, origin.y - threat.y) || 1;
  const needed = Math.max(0, toPixels(desired) - separation);
  const distance = Math.min(toPixels(budget), needed || toPixels(budget));
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
  );
}

/**
 * Leave the field. A creature that flees walks to the nearest scene edge under its own speed; it is
 * removed from play by the encounter layer, not here.
 */
export async function moveOffField(token: any, budget: number): Promise<number> {
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
  );
}
