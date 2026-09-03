// 2024 Sentinel. PHB, not SRD — dnd5e 5.3.3 ships `sentinel-shield` only.
//
// Discover by `system.identifier === "sentinel"`, or the name `/^\s*sentinel\s*$/i` only when
// there is no identifier, or `flags.<ns>.sentinel`. Never match `sentinel-shield`. A weapon
// named Sentinel is not the feat.

import { isDnd5e } from "./dnd5e-rewards";
import { hasFlag } from "../util/flags";
import { tokenDistance } from "../core/positioning";

const NAME = /^\s*sentinel\s*$/i;

function identifierOf(doc: any): string {
  return String(doc?.system?.identifier ?? "")
    .trim()
    .toLowerCase();
}

function elevationOf(token: any): number {
  const n = Number(
    token?.document?._source?.elevation ??
      token?._source?.elevation ??
      token?.document?.elevation ??
      token?.elevation,
  );
  return Number.isFinite(n) ? n : 0;
}

export function isSentinelItem(item: any): boolean {
  if (!item) return false;
  if (hasFlag(item, "sentinel")) return true;
  const identifier = identifierOf(item);
  if (identifier) return identifier === "sentinel";
  return String(item?.type ?? "") === "feat" && NAME.test(String(item?.name ?? ""));
}

export function hasSentinel(actor: any): boolean {
  if (!isDnd5e() || !actor) return false;
  if (hasFlag(actor, "sentinel")) return true;
  for (const item of actor?.items ?? []) {
    if (isSentinelItem(item)) return true;
  }
  return false;
}

/** Guardian / Halt reach: 5 ft of closest squares, cylinder. */
export function withinSentinelReach(a: any, b: any): boolean {
  const step = Number((globalThis as any).canvas?.grid?.distance) || 5;
  const gap = tokenDistance(a, b);
  if (!Number.isFinite(gap) || gap > step + 0.05) return false;
  return Math.abs(elevationOf(a) - elevationOf(b)) <= step + 0.05;
}

/** Guardian fires on the Disengage *action*, never on granted Withdraw / Flyby. */
export function guardianDisengageApplies(granted: boolean, isDisengage: boolean): boolean {
  return !granted && isDisengage;
}
