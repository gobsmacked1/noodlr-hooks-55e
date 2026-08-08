// Moving a creature that did not choose to move.
//
// A push is not a small variation on a walk; it is a different thing with different rules, and the
// differences are what this file is for:
//
//   * IT IS NOT PAID FOR BY THE VICTIM. A goblin shoved fifteen feet has lost none of its own Speed, so
//     none of it may reach `movementHistory` as cost — otherwise Noodlr's own movement budget would
//     charge the victim for being hit.
//   * IT PROVOKES NOTHING. Under the 2024 rules an opportunity attack triggers only when a creature
//     spends its own movement, action, bonus action or reaction. Forced movement is exempt, so the
//     reaction layer has to be able to recognise this as forced rather than as walking.
//   * IT STILL STOPS AT THINGS. A creature pushed into a wall stops at the wall; one pushed into an
//     occupied space stops beside it. That is the part everyone else's implementation gets thinnest on.
//
// HOW THE PLATFORM WANTS THIS EXPRESSED. Foundry v12's `forced` movement flag was replaced one-for-one
// by `action: "displace"` — core's own deprecation shim returns `action === "displace"` when the old
// property is read — so displacement is the platform's official way to say "involuntary". The catch is
// that core hard-wires `displace` to ignore walls entirely and to be instantaneous: it validates those
// properties at boot and then OVERWRITES the animation and cost functions, so they cannot be softened.
//
// So the shape here is two-phase, and it is the shape worth stealing from CAT's `slideToken`:
//
//   1. ASK, using a normal movement action. `constrainMovementPath` is pure and writes nothing, so we
//      can ask core exactly where a walked path would stop and get walls and impassable terrain for
//      free — work that Gambit's partly reimplements by marching a ray in tenth-of-a-square steps.
//      dnd5e overrides the same method to add creature blocking, with correct multi-space footprints and
//      elevation, which we inherit at no cost; note that it disables itself unless the table has dnd5e's
//      own "Movement Automation" setting on Full, which is why the occupancy check below is not
//      redundant.
//   2. MOVE, to that already-legal point, using a zero-cost action. `noodlrForce` is registered for this
//      and is preferred because it can be animated, so a shove visibly slides instead of snapping;
//      `displace` is the fallback if the registration did not take. Either way the cost recorded is
//      zero and both are recognised as forced.
//
// TWO CHECKS ARE DELIBERATELY REPEATED after core has answered, because its answer is not quite the one
// we need. Core's boundary test uses the PADDED canvas rectangle, so a creature can legally be shoved
// into the margin outside the visible map; and creature blocking belongs to the system rather than to
// core, so on a table that has not enabled it — or on any system other than dnd5e — nothing would stop a
// shove landing on top of somebody.

import { log } from "../../constants";
import { speakerFor } from "../../util/speaker";
import { getMoveSpeed } from "../config";
import { actionFor, readLocomotion } from "./locomotion";
import { cornerFor } from "./movement";
import { hazardsUnder } from "./hazards";
import { blocked, centerOf, insideScene, occupied, type Point } from "./positioning";
import type { Shift } from "../systems/dnd5e-forced-movement";

/** Our own movement action: respects walls, costs the victim nothing, and can be animated. */
export const FORCE_ACTION = "noodlrForce";

/** A height difference below this is rounding rather than a lift. */
const VERTICAL_TOLERANCE = 0.5;

export interface ShoveRequest {
  /** The creature being moved. Token placeable or TokenDocument; either is fine. */
  token: any;
  /** The creature doing it, when there is one. Supplies the direction and names the cause. */
  by?: any;
  /** Explicit origin to push away from or pull toward, when there is no pusher token (an area's centre). */
  from?: Point;
  direction: Shift;
  /** Scene units. */
  distance: number;
  /** What caused it, for the chat line: "Thunderwave", "Push mastery". */
  label: string;
  /** Post a chat line. On by default; off for probes and for callers that narrate themselves. */
  announce?: boolean;
}

export interface ShoveResult {
  /** Scene units actually travelled. Zero means nothing happened, and `reason` says why. */
  moved: number;
  requested: number;
  /** True when something stopped it short of the full distance. */
  constrained: boolean;
  /** Harmful areas it has landed in, by name. */
  hazards: string[];
  reason?: string;
}

/** One undoable displacement. Kept in memory only; a reload forgets them, which is correct. */
interface Restore {
  uuid: string;
  name: string;
  x: number;
  y: number;
  elevation: number;
}

const undoStack: Restore[] = [];

/**
 * Register the forced-movement action. Must run during `init`.
 *
 * Core sorts and then DEEP-FREEZES `CONFIG.Token.movement.actions` inside `setupGame()`, before the
 * `setup` hook fires — so `init` works and `setup` is silently too late, since writing to a frozen
 * object is a no-op rather than an error in sloppy mode. Everything downstream feature-detects the key
 * instead of assuming this succeeded.
 *
 * A module-specific action key does travel on the wire, and core's animation path looks it up without a
 * fallback, unlike its measurement path. That is safe here because Foundry activates modules for the
 * whole world rather than per client, so either every client has this key or none of them do.
 */
export function registerForceAction(): void {
  try {
    const actions: any = (globalThis as any).CONFIG?.Token?.movement?.actions;
    if (!actions || actions[FORCE_ACTION]) return;
    actions[FORCE_ACTION] = {
      label: "NOODLRHOOKS.Combat.Forced.Action",
      icon: "fa-solid fa-hand-back-fist",
      // Sorted well after the built-ins so it lands at the end of any list core builds from these.
      order: 90,
      // The whole point of not using `displace`: walls still stop a shoved creature.
      walls: "move",
      measure: true,
      visualize: false,
      // Never offered to a human. This is not a way to travel.
      canSelect: () => false,
      // The victim pays nothing, which is what keeps the movement budget honest.
      getCostFunction: () => () => 0,
      getAnimationOptions: () => ({ movementSpeed: forceSpeed() }),
    };
  } catch (err) {
    log("could not register the forced-movement action; falling back to displacement:", err);
  }
}

/**
 * How fast a shove slides across the canvas, in grid squares per second.
 *
 * Faster than a walk on purpose — being shoved is abrupt — but not instant, because an instantaneous
 * jump is what made automated movement read as teleportation in the first place.
 */
function forceSpeed(): number {
  const configured = getMoveSpeed();
  return configured > 0 ? configured * 2 : 10;
}

function forceAction(): string {
  const actions: any = (globalThis as any).CONFIG?.Token?.movement?.actions;
  return actions?.[FORCE_ACTION] ? FORCE_ACTION : "displace";
}

/**
 * Was this movement forced?
 *
 * The reaction layer and the movement budget both need to answer this, and both should answer it the
 * same way. Displacement is included as well as our own action, so a shove from ANY module that uses
 * core's standard idiom is recognised — which is the entire benefit of core having standardised it.
 */
export function isForcedMovement(movement: any, operation?: any): boolean {
  if (operation?.noodlrForced) return true;
  const waypoints: any[] = movement?.passed?.waypoints ?? [];
  if (waypoints.length === 0) return false;
  return waypoints.some((w: any) => {
    const action = String(w?.action ?? "");
    return action === "displace" || action === FORCE_ACTION;
  });
}

function gridSize(): number {
  return Number((canvas as any)?.grid?.size) || 100;
}

function unitsPerSquare(): number {
  return Number((canvas as any)?.grid?.distance) || 5;
}

function toPixels(units: number): number {
  return (units / unitsPerSquare()) * gridSize();
}

function elevationOf(doc: any): number {
  const raw = Number(doc?._source?.elevation ?? doc?.elevation);
  return Number.isFinite(raw) ? raw : 0;
}

/**
 * Half a token's footprint, which is the whole of the difference between the two coordinate systems in
 * play: Foundry stores and returns a token's TOP-LEFT corner, while every measurement here is from its
 * centre. Conflating them puts a medium creature half a square out and a huge one two squares out.
 */
function halfFootprint(doc: any): { x: number; y: number } {
  const size = gridSize();
  return {
    x: (size * (Number(doc?.width) || 1)) / 2,
    y: (size * (Number(doc?.height) || 1)) / 2,
  };
}

function toCorner(doc: any, centre: Point): Point {
  const half = halfFootprint(doc);
  return { x: centre.x - half.x, y: centre.y - half.y };
}

function toCentre(doc: any, corner: Point): Point {
  const half = halfFootprint(doc);
  return { x: corner.x + half.x, y: corner.y + half.y };
}

/** Distance between two canvas points in scene units, measured by the grid where it will answer. */
function span(from: Point, to: Point): number {
  try {
    const measured = (canvas as any)?.grid?.measurePath?.([from, to]);
    if (Number.isFinite(measured?.distance)) return Number(measured.distance);
  } catch {
    /* gridless scenes and unfamiliar grid shapes fall through to straight-line pixels */
  }
  return (Math.hypot(to.x - from.x, to.y - from.y) / gridSize()) * unitsPerSquare();
}

/**
 * Where the creature would end up if it walked this line, according to core.
 *
 * Returns null when the API could not be read at all, which is different from "it cannot go anywhere"
 * and is handled differently by the caller: an unreadable answer falls back to our own ray test rather
 * than cancelling the push.
 *
 * `ignoreCost` is left FALSE deliberately. It does not mean "do not charge" — in v13 it means "allow
 * movement through terrain of infinite cost" — and a creature shoved at a cliff face should stop at it.
 * Difficult terrain does not shorten a push either way, because no budget is passed.
 *
 * Takes and returns CENTRE points, converting at the boundary, because core deals exclusively in
 * top-left corners and every other measurement in this file is from the centre.
 */
function askCore(
  placeable: any,
  doc: any,
  targetCentre: Point,
  elevation: number,
  action: string | undefined,
): { point: Point; elevation: number; constrained: boolean } | null {
  if (typeof placeable?.constrainMovementPath !== "function") return null;
  try {
    const source = doc?._source ?? doc;
    const start: Record<string, unknown> = {
      x: Number(source?.x) || 0,
      y: Number(source?.y) || 0,
      elevation: elevationOf(doc),
      width: Number(source?.width) || 1,
      height: Number(source?.height) || 1,
      shape: source?.shape,
    };
    if (action) start.action = action;
    const targetCorner = toCorner(doc, targetCentre);

    const [path, constrained] = placeable.constrainMovementPath(
      [
        start,
        { ...start, x: Math.round(targetCorner.x), y: Math.round(targetCorner.y), elevation },
      ],
      { ignoreWalls: false, ignoreCost: false, preview: false, history: false },
    );
    const landing = path?.at?.(-1);
    // An empty path is core's way of saying the creature cannot leave the square it is in at all. That
    // is a real answer and must not be confused with the unreadable-API case below, which retries with
    // our own ray — retrying here would push through the very wall core just refused.
    if (!landing) {
      return {
        point: toCentre(doc, { x: Number(start.x), y: Number(start.y) }),
        elevation: elevationOf(doc),
        constrained: true,
      };
    }
    return {
      point: toCentre(doc, { x: Number(landing.x), y: Number(landing.y) }),
      elevation: Number(landing.elevation ?? elevation),
      constrained: Boolean(constrained),
    };
  } catch (err) {
    log("could not ask core where a shove would end up:", err);
    return null;
  }
}

/**
 * Walk back along the push until the destination is somewhere a creature may actually stand.
 *
 * Applied to whatever core returned, for the two things core's answer does not cover: its boundary test
 * uses the padded canvas rather than the visible map, and creature blocking is the system's business
 * rather than core's, so it may not have run at all. Half-square steps, because that is the resolution
 * at which a token either overlaps another or does not.
 */
function backOff(token: any, origin: Point, landing: Point): { point: Point; shortened: boolean } {
  const step = gridSize() / 2;
  const dx = landing.x - origin.x;
  const dy = landing.y - origin.y;
  const total = Math.hypot(dx, dy);
  if (total < 1) return { point: landing, shortened: false };

  for (let travelled = total; travelled > 0; travelled -= step) {
    const candidate = {
      x: origin.x + (dx / total) * travelled,
      y: origin.y + (dy / total) * travelled,
    };
    if (!insideScene(candidate)) continue;
    if (occupied(candidate, token)) continue;
    return { point: candidate, shortened: travelled < total - 1 };
  }
  return { point: origin, shortened: true };
}

/**
 * Push, pull or lift a creature.
 *
 * Reports the distance it ACTUALLY travelled rather than the distance requested, because a shove that
 * stops against a wall is a different event at the table from one that lands cleanly, and the caller
 * has to be able to say which happened.
 */
export async function shove(request: ShoveRequest): Promise<ShoveResult> {
  const doc = request.token?.document ?? request.token;
  const placeable = doc?.object ?? request.token;
  const requested = Math.max(0, Number(request.distance) || 0);
  const nothing = (reason: string): ShoveResult => ({
    moved: 0,
    requested,
    constrained: false,
    hazards: [],
    reason,
  });

  if (!doc || typeof doc.move !== "function") return nothing("no movable token");
  if (requested <= 0) return nothing("no distance to move");

  const origin = centerOf(doc);
  if (!origin) return nothing("the token has no position");

  const startElevation = elevationOf(doc);
  const locomotion = readLocomotion(doc?.actor);

  // Straight up is its own case: nothing horizontal changes, and core measures elevation as a third
  // axis, so this needs no geometry at all.
  if (request.direction === "up") {
    const arrived = await commit(doc, origin, startElevation + requested);
    if (!arrived) return nothing("core refused the lift");
    const lifted = Math.abs(elevationOf(doc) - startElevation);
    return finish(doc, request, lifted, requested, lifted + VERTICAL_TOLERANCE < requested);
  }

  const anchor = request.from ?? centerOf(request.by);
  if (!anchor) return nothing("nothing to push away from");
  const separation = Math.hypot(origin.x - anchor.x, origin.y - anchor.y);
  if (separation < 1) return nothing("the two are in the same space");

  // Away from the anchor, or toward it. A pull is clamped so it can never end up on top of whoever is
  // pulling: one grid space is kept between them, which is where a creature dragged into contact stops.
  const outward = request.direction === "away" ? 1 : -1;
  const wanted =
    request.direction === "toward"
      ? Math.min(toPixels(requested), Math.max(0, separation - gridSize()))
      : toPixels(requested);
  if (wanted < gridSize() * 0.1) return nothing("already as close as a pull can bring it");

  const unitX = ((origin.x - anchor.x) / separation) * outward;
  const unitY = ((origin.y - anchor.y) / separation) * outward;

  return landAt(
    doc,
    placeable,
    origin,
    { x: origin.x + unitX * wanted, y: origin.y + unitY * wanted },
    startElevation,
    actionFor(locomotion, false),
    requested,
    request,
  );
}

/**
 * Take a creature to a destination that has not yet been proved legal, and report what happened.
 *
 * Shared by the directional push and by the grapple drag, because the two differ only in how the
 * destination is chosen — everything after that (ask core, second-guess core, commit, measure, announce)
 * is identical, and letting them drift apart is how one of them would quietly stop respecting walls.
 */
async function landAt(
  doc: any,
  placeable: any,
  origin: Point,
  desired: Point,
  startElevation: number,
  action: string | undefined,
  requested: number,
  request: ShoveRequest,
): Promise<ShoveResult> {
  const answered = askCore(placeable, doc, desired, startElevation, action);
  let landing = answered?.point ?? desired;
  let constrained = answered?.constrained ?? false;

  // No usable answer from core means falling back to our own ray, which is what the rest of the module
  // uses for reachability. Conservative: an unreadable collision API stops the push rather than pushing
  // a creature through a wall we could not see.
  if (!answered && blocked(origin, landing, "move") !== false) {
    const halfway = { x: (origin.x + landing.x) / 2, y: (origin.y + landing.y) / 2 };
    if (blocked(origin, halfway, "move") !== false) {
      return {
        moved: 0,
        requested,
        constrained: true,
        hazards: [],
        reason: "a wall is in the way",
      };
    }
    landing = halfway;
    constrained = true;
  }

  const settled = backOff(doc, origin, landing);
  if (settled.shortened) constrained = true;

  if (span(origin, settled.point) < unitsPerSquare() / 4) {
    return { moved: 0, requested, constrained: true, hazards: [], reason: "nowhere to go" };
  }

  const arrived = await commit(doc, settled.point, answered?.elevation ?? startElevation);
  if (!arrived) {
    return {
      moved: 0,
      requested,
      constrained: false,
      hazards: [],
      reason: "core refused the move",
    };
  }

  const actual = span(origin, centerOf(doc) ?? settled.point);
  return finish(doc, request, actual, requested, constrained || actual + 0.5 < requested);
}

/**
 * Shift a creature by the same vector somebody else just travelled — a grappler dragging its captive.
 *
 * Distinct from a push because there is no anchor to be pushed away from: the direction is whichever way
 * the grappler went. Walls and occupied spaces still apply, so a captive dragged into a doorway stops in
 * it rather than being towed through the frame.
 */
export async function dragAlong(
  token: any,
  dx: number,
  dy: number,
  by: any,
  label: string,
): Promise<ShoveResult> {
  const doc = token?.document ?? token;
  const placeable = doc?.object ?? token;
  const origin = centerOf(doc);
  const requested = Math.round(span({ x: 0, y: 0 }, { x: dx, y: dy }));
  if (!doc || typeof doc.move !== "function" || !origin) {
    return { moved: 0, requested, constrained: false, hazards: [], reason: "no movable token" };
  }

  const request: ShoveRequest = {
    token,
    by,
    direction: "away",
    distance: requested,
    label,
    announce: false,
  };
  return landAt(
    doc,
    placeable,
    origin,
    { x: origin.x + dx, y: origin.y + dy },
    elevationOf(doc),
    actionFor(readLocomotion(doc?.actor), false),
    requested,
    request,
  );
}

/**
 * Perform the move and wait for the slide to finish.
 *
 * `noodlrForced` rides on the operation as well as being implied by the action, because it is the one
 * signal that survives regardless of which action ends up being used, and it is what our own
 * `preMoveToken` handlers key off.
 */
async function commit(doc: any, centre: Point, elevation: number): Promise<boolean> {
  const { point: corner, snapped } = cornerFor(doc, centre);
  const before = { x: Number(doc?._source?.x) || 0, y: Number(doc?._source?.y) || 0 };
  const beforeElevation = elevationOf(doc);

  try {
    await doc.move(
      {
        x: Math.round(corner.x),
        y: Math.round(corner.y),
        elevation,
        action: forceAction(),
        snapped,
        explicit: true,
        checkpoint: true,
      },
      {
        method: "api",
        // The destination has already been proved legal against walls, so re-litigating them here would
        // only risk a second, differently-rounded verdict refusing a move we know is fine.
        constrainOptions: { ignoreWalls: true, ignoreCost: true },
        autoRotate: false,
        showRuler: false,
        noodlrForced: true,
      },
    );
  } catch (err) {
    log(`forced movement: move() threw for ${String(doc?.name ?? "a token")}:`, err);
    return false;
  }

  const after = { x: Number(doc?._source?.x) || 0, y: Number(doc?._source?.y) || 0 };
  const shifted =
    Math.hypot(after.x - before.x, after.y - before.y) > 1 ||
    Math.abs(elevationOf(doc) - beforeElevation) > VERTICAL_TOLERANCE;
  if (!shifted) return false;

  undoStack.push({
    uuid: String(doc?.uuid ?? ""),
    name: String(doc?.name ?? "?"),
    x: before.x,
    y: before.y,
    elevation: beforeElevation,
  });

  await settle(doc);
  return true;
}

/** Wait for the token to stop sliding, so a chat line does not land mid-flight. */
async function settle(doc: any): Promise<void> {
  const contexts = doc?.object?.animationContexts;
  if (!(contexts?.size > 0)) return;
  const deadline = Date.now() + 10000;
  while (contexts.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Look at where it landed, say so, and report. */
async function finish(
  doc: any,
  request: ShoveRequest,
  moved: number,
  requested: number,
  constrained: boolean,
): Promise<ShoveResult> {
  // Being pushed into a fire is the whole reason the rules care where a creature lands. Nobody else's
  // implementation checks this — Gambit's posts a chat line asking the GM to fix it by hand — and we
  // already own the answer, so it costs nothing to say it out loud.
  const hazards = hazardsUnder(doc).map((h) => h.label);
  const result: ShoveResult = { moved: Math.round(moved), requested, constrained, hazards };
  if (request.announce !== false) await announce(doc, request, result);
  return result;
}

async function announce(doc: any, request: ShoveRequest, result: ShoveResult): Promise<void> {
  try {
    const ChatMessage = (globalThis as any).ChatMessage;
    const escape = foundry.utils.escapeHTML;
    const units = String((canvas as any)?.scene?.grid?.units ?? "");
    const key =
      request.direction === "toward"
        ? "NOODLRHOOKS.Combat.Forced.Pulled"
        : request.direction === "up"
          ? "NOODLRHOOKS.Combat.Forced.Lifted"
          : "NOODLRHOOKS.Combat.Forced.Pushed";

    let line = game.i18n.format(key, {
      name: escape(String(doc?.name ?? "?")),
      cause: escape(request.label),
      distance: String(result.moved),
      units,
    });
    if (result.constrained && result.moved < result.requested) {
      line += ` ${game.i18n.format("NOODLRHOOKS.Combat.Forced.Short", {
        requested: String(result.requested),
        units,
      })}`;
    }
    if (result.hazards.length > 0) {
      line += ` ${game.i18n.format("NOODLRHOOKS.Combat.Forced.Hazard", {
        hazard: escape(result.hazards.join(", ")),
      })}`;
    }

    await ChatMessage.create({
      content:
        `<p>${line}</p>` +
        `<button type="button" data-action="noodlr-undo-shove">${game.i18n.localize(
          "NOODLRHOOKS.Combat.Forced.Undo",
        )}</button>`,
      // Through the helper rather than a bare alias: an empty alias string is no better than no speaker
      // at all, because core's renderer falls through both to the author's assigned character.
      speaker: speakerFor(request.by ?? doc, String(request.by?.name ?? doc?.name ?? "")),
    });
  } catch (err) {
    log("could not announce a forced move:", err);
  }
}

/**
 * Put everything back where it was, newest first.
 *
 * The GM's escape hatch, because these rules are permissive ("you CAN push") rather than compulsory,
 * and applying them automatically is only reasonable if reversing one is a single click. Displacement is
 * used for the return trip and walls are ignored on it: whatever the creature was pushed through, it can
 * be put back through.
 */
export async function undoForcedMovement(): Promise<number> {
  let restored = 0;
  while (undoStack.length > 0) {
    const entry = undoStack.pop()!;
    try {
      const doc: any = await (globalThis as any).fromUuid?.(entry.uuid);
      if (!doc?.move) continue;
      await doc.move(
        { x: entry.x, y: entry.y, elevation: entry.elevation, action: "displace", explicit: true },
        {
          method: "api",
          constrainOptions: { ignoreWalls: true, ignoreCost: true },
          autoRotate: false,
          showRuler: false,
          noodlrForced: true,
        },
      );
      restored += 1;
    } catch (err) {
      log(`could not put ${entry.name} back:`, err);
    }
  }
  return restored;
}

/** Forget the undo history. Called when a fight ends; a new one starts with a clean slate. */
export function clearForcedHistory(): void {
  undoStack.length = 0;
}

/** How many displacements are currently undoable, for diagnostics. */
export function pendingUndoCount(): number {
  return undoStack.length;
}
