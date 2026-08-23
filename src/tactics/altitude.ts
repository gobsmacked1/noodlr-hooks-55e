// Using the third axis on purpose: rise, pass, dive, emerge.
//
// Innate fly already wins as the primary mode when it is as fast as walking. What the planner did
// not do is ASK for a height. `reachableElevation` only rose to meet a target already up; kite was
// a 2D step-back; a grounded dragon fought on the floor and ate melee.
//
// The size tax is a COST, not a destination. A Huge dragon's first 10 ft of lift costs 30 ft of
// Speed; we do not send them to +30 just because they paid 30. Safe height is one reach + one
// square above the nearest melee. We do not invent a ceiling or a water table — the GM placed the
// token. Mode-traverse already honours the enclosure / floor flags they set.

import { elevationTaxOf, verticalCost } from "../core/elevation-cost";
import type { Board, BoardActor } from "../core/board";
import type { Locomotion } from "../core/locomotion";
import type { CreatureAction } from "./actions";
import type { PlanOption } from "./planner";

const EPS = 1;

function gridOf(): number {
  return Number((globalThis as any).canvas?.scene?.grid?.distance ?? 5) || 5;
}

function onTurn(u: CreatureAction): boolean {
  return u.economy === "action" || u.economy === "bonus";
}

/** 3D gap from here to a target standing at `targetElev`, us at `destElev`. */
export function gap3d(horizontal: number, destElev: number, targetElev: number): number {
  return Math.hypot(Math.max(0, horizontal), destElev - targetElev);
}

export function worksFrom(
  u: CreatureAction,
  horizontal: number,
  destElev: number,
  targetElev: number,
): boolean {
  if (!u.available || !onTurn(u)) return false;
  if (u.kind !== "attack" && u.kind !== "control") return false;
  const range = Number(u.range);
  if (!(range > 0)) return false;
  return gap3d(horizontal, destElev, targetElev) <= range + 0.01;
}

/**
 * Height that clears the nearest melee cylinder. Tax is not folded in — paying 30 to go to +10 is
 * the house rule working, not a reason to sit at +30 where a 30 ft breath only hits the square below.
 */
export function hoverHeight(meleeReach: number, grid: number): number {
  const reach = Number.isFinite(meleeReach) && meleeReach > 0 ? meleeReach : grid;
  return reach + grid;
}

/** Can this locomotion change height in the direction of `rise` (target − self)? */
export function canReachVertical(loco: Locomotion, rise: number): boolean {
  if (Math.abs(rise) <= EPS) return true;
  if (rise > 0) return (loco.modes.fly ?? 0) > 0 || (loco.modes.climb ?? 0) > 0;
  return (
    (loco.modes.fly ?? 0) > 0 ||
    (loco.modes.climb ?? 0) > 0 ||
    (loco.modes.burrow ?? 0) > 0 ||
    (loco.modes.swim ?? 0) > 0
  );
}

/**
 * Foundry action for a deliberate vertical step. Down + burrow is burrow (a landing dragon still
 * flies). Up prefers fly, then climb, then surfacing on swim/burrow.
 */
export function verticalAction(loco: Locomotion, from: number, to: number): string {
  if (to < from - EPS) {
    if ((loco.modes.burrow ?? 0) > 0) return "burrow";
    if ((loco.modes.swim ?? 0) > 0) return "swim";
    if ((loco.modes.fly ?? 0) > 0) return "fly";
    if ((loco.modes.climb ?? 0) > 0) return "climb";
  }
  if (to > from + EPS) {
    if ((loco.modes.fly ?? 0) > 0) return "fly";
    if ((loco.modes.climb ?? 0) > 0) return "climb";
    if (from < -EPS && (loco.modes.swim ?? 0) > 0) return "swim";
    if (from < -EPS && (loco.modes.burrow ?? 0) > 0) return "burrow";
  }
  return loco.primary;
}

function budgetOf(board: Board): number {
  return board.speed ?? 0;
}

function taxOf(board: Board): number {
  return elevationTaxOf(board.self.actor);
}

function engaged(board: Board, meleeOf: (e: BoardActor) => number): boolean {
  return board.enemies.some((e) => e.distance <= meleeOf(e) + 0.01);
}

function optionFor(
  u: CreatureAction,
  extra: Omit<PlanOption, "score" | "reasons" | "item" | "itemName" | "activity" | "range" | "attackMode">,
): Omit<PlanOption, "score" | "reasons"> & { score?: number; reasons?: string[] } {
  return {
    ...extra,
    item: u.item,
    itemName: u.name,
    activity: u.activity,
    range: u.range,
    attackMode: u.attackMode,
  };
}

/**
 * Rise (or dive on swim/burrow) and use something that still reaches from the new height.
 *
 * Absent when the creature is already at or above the safe height, cannot pay the tax, or has
 * nothing that works from up there (a 5 ft Bite is not a hover attack).
 */
export function hoverOptions(
  board: Board,
  kit: CreatureAction[],
  meleeOf: (e: BoardActor) => number,
): PlanOption[] {
  const loco = board.locomotion;
  if ((loco.modes.fly ?? 0) <= 0) return [];
  const from = board.self.elevation;
  const grid = gridOf();
  const nearest = board.enemies[0];
  if (!nearest) return [];

  const threat = Math.max(grid, ...board.enemies.map((e) => meleeOf(e) || 0));
  const dest = hoverHeight(threat, grid);
  if (from >= dest - EPS) return [];

  const action = verticalAction(loco, from, dest);
  const cost = verticalCost(from, dest, action, taxOf(board));
  if (!(budgetOf(board) >= cost) || cost <= 0) return [];

  const usable = kit.find((u) => worksFrom(u, nearest.distance, dest, nearest.elevation));
  if (!usable) return [];

  const inMelee = engaged(board, meleeOf);
  return [
    {
      ...optionFor(usable, {
        kind: "hover",
        target: nearest,
        elevation: dest,
        moveAction: action,
        approach: 0,
      }),
      score: inMelee ? 1.45 : 1.22,
      reasons: inMelee
        ? [`rises ${Math.round(dest - from)} ${board.units} out of melee`, `then ${usable.name}`]
        : [`takes off to ${Math.round(dest)} ${board.units}`, `then ${usable.name}`],
    },
  ];
}

/**
 * Height to hold while closing for a melee pass. Stay put when the 3D gap after closing still fits
 * the reach; otherwise drop to the target. A second takeoff the same turn is a second tax and is
 * not part of this plan.
 */
export function strikeElevation(
  from: number,
  targetElev: number,
  horizontal: number,
  reach: number,
): number {
  // After closing into reach the leftover horizontal is `min(distance, reach)`, not zero.
  // Using zero taught a 15 ft tail it could stay at +10 against someone 15 ft away (3D gap 18).
  const after = Math.min(Math.max(0, horizontal), Math.max(0, reach));
  if (gap3d(after, from, targetElev) <= reach + 0.01) return from;
  return targetElev;
}

/**
 * Close, strike, keep going. Offered to innate flyers with a melee attack they can reach this turn
 * after the vertical they chose. Stay-high scores above a dive so a dragon that can tail from +10
 * does not land every pass.
 */
export function flybyOptions(
  board: Board,
  kit: CreatureAction[],
  _meleeOf: (e: BoardActor) => number,
): PlanOption[] {
  const loco = board.locomotion;
  if ((loco.modes.fly ?? 0) <= 0) return [];
  const speed = budgetOf(board);
  if (!(speed > 0)) return [];

  const from = board.self.elevation;
  const tax = taxOf(board);
  const options: PlanOption[] = [];

  for (const u of kit) {
    if (!u.available || !onTurn(u) || u.kind !== "attack" || !u.melee || u.ranged) continue;
    if (!(u.range > 0)) continue;

    for (const enemy of board.enemies) {
      const dest = strikeElevation(from, enemy.elevation, enemy.distance, u.range);
      const action = verticalAction(loco, from, dest);
      const z = verticalCost(from, dest, action, tax);
      if (z > speed) continue;

      const leftover = speed - z;
      const horizGap = Math.max(0, enemy.distance - u.range);
      if (horizGap > leftover + 0.01) continue;
      const after = Math.min(enemy.distance, u.range);
      if (!worksFrom(u, after, dest, enemy.elevation)) continue;

      const stayed = Math.abs(dest - from) <= EPS;
      const airborne = from > EPS;
      options.push({
        ...optionFor(u, {
          kind: "flyby",
          target: enemy,
          elevation: dest,
          moveAction: action,
          approach: horizGap,
        }),
        score: stayed && airborne ? 1.28 : stayed ? 1.12 : 0.98,
        reasons: stayed
          ? [`flies past at ${Math.round(dest)} ${board.units}`, u.name]
          : [`dives to strike with ${u.name}`, "then keeps going"],
      });
    }
  }
  return options;
}

/**
 * Burrow or swim on the Z axis. Going under is the escape; coming up is the attack.
 *
 * Two taxes in one turn (down and up) is usually the whole Speed for Large+, so those are two
 * plans on two turns, not one clever path. We do not ask whether the floor is dirt.
 */
export function emergeOptions(
  board: Board,
  kit: CreatureAction[],
  meleeOf: (e: BoardActor) => number,
): PlanOption[] {
  const loco = board.locomotion;
  const canDown = (loco.modes.burrow ?? 0) > 0 || (loco.modes.swim ?? 0) > 0;
  if (!canDown) return [];
  const speed = budgetOf(board);
  if (!(speed > 0)) return [];

  const from = board.self.elevation;
  const grid = gridOf();
  const tax = taxOf(board);
  const options: PlanOption[] = [];

  if (from > -EPS) {
    const dest = -grid;
    const action = verticalAction(loco, from, dest);
    if (action !== "burrow" && action !== "swim") return options;
    const cost = verticalCost(from, dest, action, tax);
    if (cost > 0 && cost <= speed && engaged(board, meleeOf)) {
      options.push({
        kind: "emerge",
        elevation: dest,
        moveAction: action,
        approach: 0,
        score: 1.18,
        reasons: [
          action === "burrow"
            ? `tunnels ${Math.round(from - dest)} ${board.units} down`
            : `dives ${Math.round(from - dest)} ${board.units}`,
        ],
      });
    }
    return options;
  }

  const target = board.enemies[0];
  if (!target) return options;
  const dest = target.elevation;
  const action = verticalAction(loco, from, dest);
  const z = verticalCost(from, dest, action, tax);
  if (z > speed) return options;
  const leftover = speed - z;
  const usable =
    kit.find((u) => worksFrom(u, Math.max(0, target.distance - leftover), dest, target.elevation)) ??
    kit.find((u) => u.available && onTurn(u) && u.kind === "attack");
  const horizGap = usable ? Math.max(0, target.distance - usable.range) : target.distance;
  options.push({
    ...(usable
      ? optionFor(usable, {
          kind: "emerge",
          target,
          elevation: dest,
          moveAction: action,
          approach: Math.min(horizGap, leftover),
        })
      : {
          kind: "emerge" as const,
          target,
          elevation: dest,
          moveAction: action,
          approach: Math.min(target.distance, leftover),
        }),
    score: 1.32,
    reasons: usable
      ? [`emerges and uses ${usable.name}`]
      : [`emerges ${Math.round(dest - from)} ${board.units}`],
  });
  return options;
}
