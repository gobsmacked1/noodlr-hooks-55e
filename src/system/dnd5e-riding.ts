// Mounted combat — who may sit on whom, and what it costs. Pure.
//
// 2024 (PHB combat / dnd5e `content24`): a willing creature at least one size larger; mount or
// dismount during your move, costing half Speed (round down). Controlled vs Independent is a later
// slice. Gemini's "controlled mount gets a free Dash" is not in the 2024 text — Dash is one of three
// actions the mount may take, not an extra one.
//
// Willingness is a disposition proxy in v1, not a prompt. Anatomy stays the DM's.

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
export function carryingAllowsMount(mountMax: number | null, riderBurden: number | null): boolean {
  if (mountMax === null || riderBurden === null) return true;
  return riderBurden <= mountMax;
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
  if (stamp.combat !== combatId || stamp.combatant !== combatantId || stamp.round !== round) return 0;
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
  mountHasRider?: boolean;
  ridingOf: Record<string, string | undefined>;
  riderRank: number | null;
  mountRank: number | null;
  riderDisposition: number;
  mountDisposition: number;
  riderIsPlayer: boolean;
  mountMax?: number | null;
  riderBurden?: number | null;
  inReach: boolean;
  speed?: number | null;
  checkSpeed?: boolean;
}

export function judgeMount(input: MountJudgeInput): { ok: true } | { ok: false; reason: MountRefuse } {
  if (input.rideableActive) return { ok: false, reason: "rideable" };
  if (input.riderId === input.mountId) return { ok: false, reason: "same" };
  if (input.riderAlreadyOn) return { ok: false, reason: "already-riding" };
  if (input.mountHasRider) return { ok: false, reason: "occupied" };
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
  if (!carryingAllowsMount(input.mountMax ?? null, input.riderBurden ?? null)) {
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
