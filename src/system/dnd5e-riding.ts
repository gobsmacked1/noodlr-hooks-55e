// Mounted combat — who may sit on whom, and what it costs. Pure.
//
// 2024 (PHB combat / dnd5e `content24`): a willing creature at least one size larger; mount or
// dismount during your move, costing half Speed (round down). Controlled vs Independent is a later
// slice. Gemini's "controlled mount gets a free Dash" is not in the 2024 text — Dash is one of three
// actions the mount may take, not an extra one.
//
// Willingness is a disposition proxy, not a prompt. The printed rule is written for *a* rider and
// never says "one seat". Tables play horses as two-up and a Wild Shaped Brontosaurus as a party
// wagon, so capacity is the token's grid footprint plus remaining carry weight — not a seat lock.

import { MODULE_ID } from "../constants";
import { sizeRank } from "./dnd5e-forced-movement";
import { moduleActive } from "../util/modules";

/** Unique status. Token HUD skips `hud: false`, same as the Paladin host badge and Wild Shape. */
export const RIDING_STATUS_ID = "noodlr-mounted";

export const RIDING_STATUS_IMG = "icons/svg/pawprint.svg";

export const RIDING_BADGE_FLAG = "ridingBadge";

export const RIDING_SHOW_ICON_ALWAYS = 2;

export const RIDING_AA_FLAGS = { killAnim: true, isEnabled: false, version: 99 } as const;

/** Token flag: this token is sitting on `mount`. */
export const RIDING_FLAG = "riding";

export const DISP = { SECRET: -2, HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 } as const;

export function ridingStatusEntry(): { id: string; name: string; img: string; hud: false } {
  return {
    id: RIDING_STATUS_ID,
    name: "Dismount",
    img: RIDING_STATUS_IMG,
    hud: false,
  };
}

export function registerRidingStatus(): void {
  const list = (globalThis as any).CONFIG?.statusEffects;
  if (!Array.isArray(list)) return;
  if (list.some((s: any) => s?.id === RIDING_STATUS_ID)) return;
  list.push(ridingStatusEntry());
}

export function rideableOwns(): boolean {
  return moduleActive("Rideable");
}

export function isOurRidingBadge(effect: any): boolean {
  return effect?.flags?.[MODULE_ID]?.[RIDING_BADGE_FLAG] === true;
}

export function ridingBadgePayload(rider: any): Record<string, unknown> {
  return {
    name: "Dismount",
    img: RIDING_STATUS_IMG,
    origin: String(rider?.uuid ?? ""),
    transfer: false,
    disabled: false,
    showIcon: RIDING_SHOW_ICON_ALWAYS,
    statuses: [RIDING_STATUS_ID],
    changes: [],
    flags: {
      [MODULE_ID]: { [RIDING_BADGE_FLAG]: true },
      autoanimations: { ...RIDING_AA_FLAGS },
    },
  };
}

export function dispositionAllowsMount(opts: {
  riderDisposition: number;
  mountDisposition: number;
  riderIsPlayer: boolean;
}): boolean {
  const { riderDisposition, mountDisposition, riderIsPlayer } = opts;
  if (mountDisposition === DISP.NEUTRAL) return true;
  if (riderDisposition === mountDisposition) return true;
  if (riderIsPlayer && mountDisposition === DISP.FRIENDLY) return true;
  return false;
}

/** Mount must be at least one size larger. Unreadable size is a refusal — do not guess a Fine-on-Fine. */
export function sizeAllowsMount(riderRank: number | null, mountRank: number | null): boolean {
  if (riderRank === null || mountRank === null) return false;
  return mountRank >= riderRank + 1;
}

/** Unreadable encumbrance allows — size already passed. Do not invent body-weight tables. */
export function carryingAllowsMount(
  mountMax: number | null,
  riderBurden: number | null,
  already = 0,
): boolean {
  if (mountMax === null || riderBurden === null) return true;
  const prior = Number.isFinite(already) && already > 0 ? already : 0;
  return prior + riderBurden <= mountMax;
}

/**
 * Squares this token covers. Tiny is often 0.5×0.5. Null when the dimensions cannot be read —
 * do not invent a 1×1 that would seat a Brontosaurus as a pony.
 */
export function footprintSquares(width: unknown, height: unknown): number | null {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return w * h;
}

/**
 * Default squares from the size ladder when the token width/height is missing.
 * tiny/sm/med 1, Large 4, Huge 9, Gargantuan 16 (20 ft).
 */
export function defaultFootprintSquares(rank: number | null): number | null {
  if (rank === null || !Number.isFinite(rank)) return null;
  if (rank <= 2) return 1;
  if (rank === 3) return 4;
  if (rank === 4) return 9;
  return 16;
}

export function footprintSquaresOf(
  width: unknown,
  height: unknown,
  rank: number | null,
): number | null {
  return footprintSquares(width, height) ?? defaultFootprintSquares(rank);
}

/**
 * How many Medium-equivalent seats the mount has.
 *
 * Half the footprint, at least one: a Large 2×2 horse is 2 (two human riders), Huge 3×3 is 4,
 * Gargantuan 4×4 is 8 (a Brontosaurus and a party of 6). The divisor is the horse, not a printed
 * rule. Token squares win over the size-category default.
 */
export function seatCapacityFromSquares(squares: number): number {
  if (!Number.isFinite(squares) || squares <= 0) return 1;
  return Math.max(1, Math.floor(squares / 2));
}

/** Small and Medium are both 1 square on the board. Weight is what distinguishes them. */
export function seatCostFromSquares(squares: number): number {
  if (!Number.isFinite(squares) || squares <= 0) return 1;
  return Math.max(1, Math.round(squares));
}

export function seatPlan(opts: {
  mountSquares?: number | null;
  riderSquares?: number | null;
  mountRank: number | null;
  riderRank: number | null;
  seatsUsed?: number;
}): { capacity: number; used: number; cost: number } | null {
  const mountSq = opts.mountSquares ?? defaultFootprintSquares(opts.mountRank);
  const riderSq = opts.riderSquares ?? defaultFootprintSquares(opts.riderRank);
  if (mountSq == null || riderSq == null) return null;
  return {
    capacity: seatCapacityFromSquares(mountSq),
    used: Math.max(0, Number(opts.seatsUsed) || 0),
    cost: seatCostFromSquares(riderSq),
  };
}

export function seatsAllowMount(
  plan: { capacity: number; used: number; cost: number } | null,
): boolean {
  if (!plan) return true;
  return plan.used + plan.cost <= plan.capacity;
}

/** Fractional centre of seat `index` inside the mount, for packing several riders. */
export function seatCellCenter(index: number, count: number): { fx: number; fy: number } {
  const n = Math.max(1, Math.floor(count) || 1);
  const i = Math.min(Math.max(0, Math.floor(index) || 0), n - 1);
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  return { fx: ((i % cols) + 0.5) / cols, fy: (Math.floor(i / cols) + 0.5) / rows };
}

/** Half Speed, rounded down. Speed 0 is not a cost of 0 that we then allow — see `canAffordMount`. */
export function mountCostFeet(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 0;
  return Math.floor(speed / 2);
}

export function canAffordMount(speed: number): boolean {
  return Number.isFinite(speed) && speed > 0;
}

export interface MountCostStamp {
  combat: string;
  combatant: string;
  round: number;
  cost: number;
}

export function mountCostFromStamp(
  stamp: MountCostStamp | null | undefined,
  combatId: string,
  combatantId: string,
  round: number,
): number {
  if (!stamp) return 0;
  if (stamp.combat !== combatId || stamp.combatant !== combatantId || stamp.round !== round)
    return 0;
  const cost = Number(stamp.cost);
  return cost > 0 ? cost : 0;
}

/** Walk the mount chain. A horse on the rider, or A→B→A, is a loop. */
export function wouldLoop(
  riderId: string,
  mountId: string,
  ridingOf: Record<string, string | undefined>,
): boolean {
  if (!riderId || !mountId) return true;
  if (riderId === mountId) return true;
  const seen = new Set<string>([riderId]);
  let cur: string | undefined = mountId;
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = ridingOf[cur];
  }
  return false;
}

export type MountRefuse =
  | "rideable"
  | "same"
  | "already-riding"
  | "occupied"
  | "loop"
  | "size"
  | "disposition"
  | "carrying"
  | "too-far"
  | "speed";

export interface MountJudgeInput {
  rideableActive: boolean;
  riderId: string;
  mountId: string;
  riderAlreadyOn?: string;
  ridingOf: Record<string, string | undefined>;
  riderRank: number | null;
  mountRank: number | null;
  riderDisposition: number;
  mountDisposition: number;
  riderIsPlayer: boolean;
  mountMax?: number | null;
  riderBurden?: number | null;
  carriedAlready?: number;
  mountSquares?: number | null;
  riderSquares?: number | null;
  seatsUsed?: number;
  inReach: boolean;
  speed?: number | null;
  checkSpeed?: boolean;
}

export function judgeMount(
  input: MountJudgeInput,
): { ok: true } | { ok: false; reason: MountRefuse } {
  if (input.rideableActive) return { ok: false, reason: "rideable" };
  if (input.riderId === input.mountId) return { ok: false, reason: "same" };
  if (input.riderAlreadyOn) return { ok: false, reason: "already-riding" };
  if (wouldLoop(input.riderId, input.mountId, input.ridingOf)) return { ok: false, reason: "loop" };
  if (!sizeAllowsMount(input.riderRank, input.mountRank)) return { ok: false, reason: "size" };
  if (
    !dispositionAllowsMount({
      riderDisposition: input.riderDisposition,
      mountDisposition: input.mountDisposition,
      riderIsPlayer: input.riderIsPlayer,
    })
  ) {
    return { ok: false, reason: "disposition" };
  }
  const plan = seatPlan({
    mountSquares: input.mountSquares,
    riderSquares: input.riderSquares,
    mountRank: input.mountRank,
    riderRank: input.riderRank,
    seatsUsed: input.seatsUsed,
  });
  if (!seatsAllowMount(plan)) return { ok: false, reason: "occupied" };
  if (
    !carryingAllowsMount(
      input.mountMax ?? null,
      input.riderBurden ?? null,
      input.carriedAlready ?? 0,
    )
  ) {
    return { ok: false, reason: "carrying" };
  }
  if (!input.inReach) return { ok: false, reason: "too-far" };
  if (input.checkSpeed) {
    const speed = input.speed;
    if (speed !== null && speed !== undefined && !canAffordMount(speed)) {
      return { ok: false, reason: "speed" };
    }
  }
  return { ok: true };
}

/**
 * Already sitting on this mount. Reach, Speed, and "already riding" are doors for getting ON,
 * not for staying. Size, seats, carrying and disposition still apply — a Medium revert dumps
 * Medium riders, and a full seat plan dumps the overflow.
 */
export function judgeStayMounted(
  input: Omit<MountJudgeInput, "inReach" | "checkSpeed" | "speed" | "riderAlreadyOn">,
): ReturnType<typeof judgeMount> {
  return judgeMount({
    ...input,
    inReach: true,
    checkSpeed: false,
  });
}

export function sizeRankOf(actor: any): number | null {
  return sizeRank(actor);
}

export function encumbranceMaxOf(actor: any): number | null {
  const n = Number(actor?.system?.attributes?.encumbrance?.max);
  return Number.isFinite(n) ? n : null;
}

export function encumbranceValueOf(actor: any): number | null {
  const n = Number(actor?.system?.attributes?.encumbrance?.value);
  return Number.isFinite(n) ? n : null;
}

export function walkSpeedOf(actor: any): number | null {
  const n = Number(actor?.system?.attributes?.movement?.walk);
  return Number.isFinite(n) && n > 0 ? n : n === 0 ? 0 : null;
}

/** Hostile mounts keep their own initiative. Neutral/Friendly are treated as trained. */
export function defaultControlled(mountDisposition: number): boolean {
  return mountDisposition === DISP.NEUTRAL || mountDisposition === DISP.FRIENDLY;
}
