// Who may act at this distance.
//
// dnd5e does not enforce reach or range. "Range, reach, & cover" is an unshipped roadmap item;
// the system stores the numbers and colours the ruler. Midi QoL's Check Range is live at stock
// and cancels with only a log line — we researched that so we would not copy the hole, not so
// we would stand aside. Midi is not a supported install.
//
// Flurry of Blows 2024 is the specimen that an attack-only gate misses: `type: utility`,
// `range.units: self`, `target.affects.type: creature`. Patient Defense is the same Self
// range with `affects.type: self` and must be skipped. Never read `range.value` as melee
// reach — a thrown spear's 20 is not a 20-foot poke (Assassin, 2026-08-20).

export type RangeKind = "melee" | "ranged" | "skip";

export interface RangeClass {
  kind: RangeKind;
  /** Why this classification, for the survey and the log. */
  reason: string;
  /** Melee reach, or ranged long range, in scene units. */
  limit?: number;
  /** Ranged short range, informational. */
  short?: number;
}

export interface ClassifyOpts {
  grid?: number;
  /** Reach of a pointed item (`[[/item Unarmed Strike]]`), when the activity itself has none. */
  pointedReach?: number;
  /** `usageConfig.attackMode` — thrown / ranged / melee — when the player has already chosen. */
  attackMode?: string;
}

/**
 * Triggers whose offer already decided the creature could reach.
 *
 * Opportunity / enter fire as the mover leaves or arrives; incoming / hurt fire because
 * they just hit or damaged you. Re-measuring after they walk away is the Beholder
 * "ranged Bite" toast: Redirect and Goading Damage classified as 5 ft ranged against
 * a square the leftover cover walk had already vacated.
 *
 * Ready is deliberately absent — a readied shot still has to reach from here.
 */
export const REACTION_RANGE_ALREADY_CHECKED = ["opportunity", "enter", "incoming", "hurt"] as const;

export function reactionRangeAlreadyChecked(usage: { noodlrReaction?: unknown } | null | undefined): boolean {
  const trigger = String(usage?.noodlrReaction ?? "");
  return (REACTION_RANGE_ALREADY_CHECKED as readonly string[]).includes(trigger);
}

function unitsOf(range: unknown): string {
  return String((range as { units?: unknown } | undefined)?.units ?? "").toLowerCase();
}

function rangeBlock(activity: any, item: any): any {
  const a = activity?.range ?? {};
  if (a.units || Number.isFinite(Number(a.value)) || Number.isFinite(Number(a.reach))) return a;
  return item?.system?.range ?? {};
}

function hasProp(item: any, key: string): boolean {
  const props = item?.system?.properties;
  if (!props) return false;
  if (typeof props.has === "function") return Boolean(props.has(key));
  if (Array.isArray(props)) return props.includes(key);
  return false;
}

/** Item `system.range.reach`, else one grid square. NEVER `range.value`. */
export function itemMeleeReach(item: any, grid = 5): number {
  const reach = Number(item?.system?.range?.reach);
  if (Number.isFinite(reach) && reach > 0) return reach;
  return grid > 0 ? grid : 5;
}

function toSceneUnits(n: number, units: string): number | null {
  if (!Number.isFinite(n) || n < 0) return null;
  if (units === "mi") return n * 5280;
  if (units === "km") return n * 3280.84;
  if (units === "m") return n * (5 / 1.5);
  return n;
}

function rangedFrom(item: any, range: any): RangeClass {
  const src = item?.system?.range ?? range ?? {};
  const units = unitsOf(src);
  const short = toSceneUnits(Number(src.value), units);
  const longRaw = Number(src.long);
  const long =
    Number.isFinite(longRaw) && longRaw > 0 ? toSceneUnits(longRaw, units) : short;
  if (long == null) return { kind: "skip", reason: "unreadable" };
  return { kind: "ranged", reason: "attack", limit: long, short: short ?? long };
}

/**
 * What kind of reach this activity has, from its type and range block — no D&D names.
 *
 * `self` + a creature target is melee (Flurry). `self` + a self target is a skip
 * (Patient Defense / Step of the Wind). A dual-mode weapon with no `attackMode` yet
 * is a skip: refusing it as melee would block a legal throw from 20 feet.
 */
export function classifyActivityRange(
  activity: any,
  item?: any,
  opts: ClassifyOpts = {},
): RangeClass {
  const grid = opts.grid && opts.grid > 0 ? opts.grid : 5;
  const template = String(activity?.target?.template?.type ?? "").trim();
  if (template) return { kind: "skip", reason: "template" };

  const affects = String(activity?.target?.affects?.type ?? "").toLowerCase();
  if (affects === "self") return { kind: "skip", reason: "self" };

  const type = String(activity?.type ?? "").toLowerCase();
  const range = rangeBlock(activity, item);
  const units = unitsOf(range);
  const mode = String(opts.attackMode ?? "").toLowerCase();
  const attackType = String(activity?.attack?.type?.value ?? "").toLowerCase();

  if (type === "attack") {
    const typedRanged = attackType === "ranged";
    const thrown = hasProp(item, "thr");
    const itemValue = Number(item?.system?.range?.value);
    const itemReach = Number(item?.system?.range?.reach);
    const innate =
      Number.isFinite(itemValue) &&
      itemValue > 0 &&
      (!Number.isFinite(itemReach) || itemValue > itemReach) &&
      !thrown;

    if (mode === "thrown" || mode === "ranged" || typedRanged) {
      return rangedFrom(item, range);
    }
    if ((thrown || innate) && !mode) return { kind: "skip", reason: "ambiguous-mode" };
    return { kind: "melee", reason: "attack", limit: itemMeleeReach(item, grid) };
  }

  const creature =
    affects === "creature" || affects === "any" || affects === "enemy" || affects === "ally";
  if (!creature) return { kind: "skip", reason: "no-creature-target" };

  if (units === "self" || units === "touch") {
    const pointed = Number(opts.pointedReach);
    const limit = Number.isFinite(pointed) && pointed > 0 ? pointed : grid;
    return {
      kind: "melee",
      reason: units === "touch" ? "touch" : "self-creature",
      limit,
    };
  }

  if (units === "any") return { kind: "skip", reason: "any" };
  if (!units || units === "spec") return { kind: "skip", reason: "unreadable" };

  const stated = toSceneUnits(Number(range.value), units);
  if (stated == null) return { kind: "skip", reason: "unreadable" };
  // A utility or damage rider that says "5 feet" is melee reach, not a 5-foot
  // ranged attack. Redirect Attack and Goading Attack Damage ship that shape;
  // classifying them `ranged` used 3D hypot, so a Large token 5.8 ft away
  // (or one that had already taken its leftover step) toasted "Out of range."
  // A thrown spear's `range.value` is still never melee — that path is `type:
  // "attack"` above. `range.long` is a real missile and stays ranged.
  const longRaw = Number(range.long);
  if (Number.isFinite(longRaw) && longRaw > 0) {
    const long = toSceneUnits(longRaw, units);
    if (long == null) return { kind: "skip", reason: "unreadable" };
    return { kind: "ranged", reason: "stated-range", limit: long, short: stated };
  }
  return { kind: "melee", reason: "stated-reach", limit: stated };
}

/**
 * Melee is a cylinder (same geometry as `inMeleeReach`): closest-square XY and |Δz|
 * each ≤ reach. Ranged is 3D hypot. 0.01 of slack so a square that measures 5.0001
 * does not refuse a 5-foot punch.
 */
export function meleeInRange(xy: number, rise: number, reach: number): boolean {
  if (!Number.isFinite(xy) || !Number.isFinite(rise) || !Number.isFinite(reach) || reach <= 0) {
    return false;
  }
  return xy <= reach + 0.01 && Math.abs(rise) <= reach + 0.01;
}

export function rangedInRange(distance3d: number, long: number): boolean {
  if (!Number.isFinite(distance3d) || !Number.isFinite(long) || long <= 0) return false;
  return distance3d <= long + 0.01;
}

export function isTooFar(classified: RangeClass, xy: number, rise: number): boolean {
  if (classified.kind === "skip" || classified.limit == null) return false;
  if (classified.kind === "melee") return !meleeInRange(xy, rise, classified.limit);
  return !rangedInRange(Math.hypot(xy, rise), classified.limit);
}

export function distanceOf(classified: RangeClass, xy: number, rise: number): number {
  if (classified.kind === "ranged") return Math.hypot(xy, rise);
  return Math.max(xy, Math.abs(rise));
}
