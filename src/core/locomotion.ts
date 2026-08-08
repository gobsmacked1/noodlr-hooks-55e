// How a creature gets about: walking, flying, swimming, burrowing, climbing.
//
// Two things depend on reading this properly, and both were wrong while only walk speed was consulted:
//
//   1. The MOVEMENT BUDGET. A wyvern was being given its 20 ft walk instead of its 80 ft fly, so it
//      shuffled and then complained it was out of range. A creature with no land speed at all — most
//      aquatic monsters, oozes that only burrow — read as speed 0 and could not move a foot.
//   2. The MOVEMENT ACTION handed to Foundry, which decides that mode's own rules: what counts as
//      difficult terrain, what it costs, and which walls apply. Flying over a bog is not the same
//      journey as wading through it, and core already knows that if it is told which one is happening.
//
// Deliberately conservative about the exotic modes. Foundry models no terrain types out of the box, so
// choosing "swim" for a land creature crossing a dungeon floor, or "burrow" to tunnel across the map,
// would be nonsense the rules would never allow. Those are used only by creatures that have no other
// way to travel. Flight is the exception: a creature that flies faster than it walks, flies.

import { pickNumber, systemPaths, type SystemPaths } from "../system/profiles";

/** The modes core models as movement actions, in the order a creature would fall back through them. */
const MODES = ["walk", "fly", "swim", "burrow", "climb"] as const;
export type Mode = (typeof MODES)[number];

export interface Locomotion {
  /** Every mode with a positive speed, in scene units. */
  modes: Partial<Record<Mode, number>>;
  /** What this creature uses for ordinary horizontal movement. */
  primary: Mode;
  /** Speed of `primary`, in scene units. 0 when the creature cannot move at all. */
  speed: number;
  /** Can it stay put in the air? Matters for whether flight is a position or a manoeuvre. */
  hover: boolean;
}

/**
 * Which mode a creature travels by when nothing special is going on.
 *
 * Flight wins over walking when it is faster, because that is simply what such a creature does — a
 * dragon crossing a battlefield does not jog. Swimming, burrowing and climbing are last resorts for
 * creatures that have nothing else: with no terrain data we cannot tell whether the water or the earth
 * they need is even there, and picking one speculatively would be inventing a rule.
 */
function choosePrimary(modes: Partial<Record<Mode, number>>): Mode {
  const walk = modes.walk ?? 0;
  const fly = modes.fly ?? 0;
  if (fly > walk) return "fly";
  if (walk > 0) return "walk";

  let best: Mode = "walk";
  let bestSpeed = 0;
  for (const mode of ["fly", "swim", "burrow", "climb"] as Mode[]) {
    const speed = modes[mode] ?? 0;
    if (speed > bestSpeed) {
      best = mode;
      bestSpeed = speed;
    }
  }
  return best;
}

export function readLocomotion(actor: any, P: SystemPaths = systemPaths()): Locomotion {
  const raw: any = actor?.system?.attributes?.movement ?? {};
  const modes: Partial<Record<Mode, number>> = {};
  for (const mode of MODES) {
    const speed = Number(raw?.[mode]);
    if (Number.isFinite(speed) && speed > 0) modes[mode] = speed;
  }
  // Systems that keep one speed rather than a set of modes, and dnd5e-shaped sheets that put it
  // somewhere else. Only consulted when the modes themselves yielded nothing for walking.
  if (modes.walk === undefined) {
    const fallback = pickNumber(actor, P.speed);
    if (fallback !== null && fallback > 0) modes.walk = fallback;
  }

  const primary = choosePrimary(modes);
  return {
    modes,
    primary,
    speed: modes[primary] ?? 0,
    hover: Boolean(raw?.hover),
  };
}

/**
 * The movement action to hand Foundry for one particular move, or undefined to accept core's default.
 *
 * `verticalChange` is the one case that overrides the primary mode: a creature that can fly and needs
 * to reach a different height flies, whatever it does on the flat. Anything core does not recognise is
 * omitted rather than guessed at — an unknown action makes `TokenDocument#move` throw.
 */
export function actionFor(loco: Locomotion, verticalChange: boolean): string | undefined {
  const actions: any = (globalThis as any).CONFIG?.Token?.movement?.actions;
  if (!actions) return undefined;

  const wanted = verticalChange && (loco.modes.fly ?? 0) > 0 ? "fly" : loco.primary;
  if (actions[wanted]) return wanted;
  return actions.walk ? "walk" : undefined;
}

/** Human-readable summary for logs and chat: "fly 80 ft (walk 20)". */
export function describeLocomotion(loco: Locomotion, units: string): string {
  const others = (Object.keys(loco.modes) as Mode[])
    .filter((m) => m !== loco.primary)
    .map((m) => `${m} ${loco.modes[m]}`);
  const main = `${loco.primary} ${loco.speed} ${units}`;
  return others.length ? `${main} (${others.join(", ")})` : main;
}
