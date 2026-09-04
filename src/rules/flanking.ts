// 2014 DMG optional flanking — Advantage on melee attacks from opposite sides or corners.
//
// Own setting, default OFF. Not split by audience: the geometry is a physical fact, and the
// printed rule applies to every creature. Not gated on the condition matrix — a table can want
// this house rule and nothing else. Advantage is merged into `applyAttackFlags` so one pre-roll
// hook stamps the die; a second listener would be the V1/V2 double-apply this repo keeps finding.
//
// Ally = same token disposition, not Incapacitated, not defeated. SECRET is never an ally.
// Both the attacker and the ally must see the target (`unseenBy`). Fail toward no Advantage:
// a spurious hit is already applied.

import { COMBAT_SETTINGS, MODULE_ID } from "../constants";
import { isFlankingEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import { isIncapacitated } from "../system/dnd5e-conditions";
import { unseenBy } from "./unseen";
import { cellCenters, footprintOf, type Footprint } from "../core/positioning";
import {
  hexFlanks,
  offsetToCube,
  squareFlanks,
  type Cube,
  type Pt,
  type Rect,
} from "../core/flank";

export interface FlankReading {
  flanked: boolean;
  reason: string;
  allyName: string | null;
}

export interface FlankModifiers {
  advantage: string[];
}

function gridSize(): number {
  return Number((globalThis as any).canvas?.grid?.size) || 0;
}

function gridDistance(): number {
  return Number((globalThis as any).canvas?.grid?.distance) || 5;
}

function gridType(): number {
  return Number((globalThis as any).canvas?.grid?.type) || 1;
}

function isHexGrid(): boolean {
  const grid: any = (globalThis as any).canvas?.grid;
  if (grid?.isHexagonal === true) return true;
  return gridType() >= 2;
}

function elevationOf(token: any): number {
  const n = Number((token?.document ?? token)?.elevation ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function samePlane(a: any, b: any): boolean {
  return Math.abs(elevationOf(a) - elevationOf(b)) <= gridDistance() + 0.01;
}

function rectOf(fp: Footprint, size: number): Rect | null {
  if (!(size > 0)) return null;
  const w = Math.max(1, Math.round(Number(fp.width) || 1));
  const h = Math.max(1, Math.round(Number(fp.height) || 1));
  return { x: fp.x, y: fp.y, w: w * size, h: h * size };
}

function cellsOf(token: any): Pt[] {
  const fp = footprintOf(token);
  const size = gridSize();
  if (!fp || !(size > 0)) return [];
  return cellCenters(fp, size);
}

function cubesOf(token: any): Cube[] | null {
  const grid: any = (globalThis as any).canvas?.grid;
  if (typeof grid?.getOffset !== "function") return null;
  const cells = cellsOf(token);
  if (!cells.length) return null;
  const type = gridType();
  const out: Cube[] = [];
  for (const p of cells) {
    let off: { i: number; j: number } | null = null;
    try {
      off = grid.getOffset(p);
    } catch {
      return null;
    }
    const cube = off ? offsetToCube(off, type) : null;
    if (!cube) return null;
    out.push(cube);
  }
  return out;
}

function tokenId(token: any): string {
  return String(token?.id ?? token?.document?.id ?? "");
}

function tokenName(token: any): string {
  return String(token?.name ?? token?.document?.name ?? "?");
}

function dispositionOf(token: any): number {
  return Number((token?.document ?? token)?.disposition ?? 0);
}

/** Same-disposition, conscious, on the plane, able to see the target, adjacent in the grid sense. */
function flankingAllies(attacker: any, target: any): any[] {
  const mine = dispositionOf(attacker);
  const SECRET = (globalThis as any).CONST?.TOKEN_DISPOSITIONS?.SECRET ?? -2;
  if (mine === SECRET) return [];
  const defeated = (globalThis as any).CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
  const out: any[] = [];
  for (const other of (globalThis as any).canvas?.tokens?.placeables ?? []) {
    if (!other?.actor) continue;
    if (tokenId(other) === tokenId(attacker) || tokenId(other) === tokenId(target)) continue;
    if (dispositionOf(other) !== mine) continue;
    try {
      if (other.document?.hasStatusEffect?.(defeated)) continue;
    } catch {
      /* unreadable defeat is not a reason to drop an ally */
    }
    if (isIncapacitated(other.actor)) continue;
    if (!samePlane(other, target)) continue;
    if (unseenBy(other, target)) continue;
    out.push(other);
  }
  return out;
}

function pairFlanks(attacker: any, ally: any, target: any): boolean {
  const size = gridSize();
  const fp = footprintOf(target);
  if (!fp || !(size > 0)) return false;
  if (isHexGrid()) {
    const a = cubesOf(attacker);
    const b = cubesOf(ally);
    const t = cubesOf(target);
    if (a && b && t) {
      const span = Math.max(Math.round(Number(fp.width) || 1), Math.round(Number(fp.height) || 1));
      return hexFlanks(a, b, t, span);
    }
    return false;
  }
  const rect = rectOf(fp, size);
  const targetCells = cellCenters(fp, size);
  if (!rect || !targetCells.length) return false;
  return squareFlanks(cellsOf(attacker), cellsOf(ally), targetCells, rect, size);
}

/**
 * Would this melee swing have Advantage from flanking? Empty reason when yes.
 *
 * Sight and adjacency are re-checked here rather than trusted from the caller: the pre-roll
 * hook is cheap and a stale board is the failure that looks like a free hit.
 */
export function readFlank(input: {
  attackerToken: any;
  targetToken: any;
  melee: boolean;
}): FlankReading {
  const no = (reason: string): FlankReading => ({ flanked: false, reason, allyName: null });
  if (!isDnd5e()) return no("not dnd5e");
  if (!isFlankingEnabled()) return no("setting off");
  if (!input.melee) return no("ranged");
  const attacker = input.attackerToken;
  const target = input.targetToken;
  if (!attacker || !target) return no("no tokens");
  if (!samePlane(attacker, target)) return no("not on the same plane");
  if (unseenBy(attacker, target)) return no("attacker cannot see the target");
  if (isIncapacitated(attacker?.actor)) return no("attacker is Incapacitated");

  const allies = flankingAllies(attacker, target);
  if (!allies.length) return no("no conscious ally who can see the target");

  for (const ally of allies) {
    if (pairFlanks(attacker, ally, target)) {
      return { flanked: true, reason: "", allyName: tokenName(ally) };
    }
  }
  return no("no ally on the opposite side or corner");
}

export function flankModifiers(input: {
  attackerToken: any;
  targetToken: any;
  melee: boolean;
}): FlankModifiers {
  const mods: FlankModifiers = { advantage: [] };
  if (!isFlankingEnabled()) return mods;
  const reading = readFlank(input);
  if (reading.flanked) mods.advantage.push("flanking");
  return mods;
}

export function surveyFlanking(): unknown {
  const token: any = (globalThis as any).canvas?.tokens?.controlled?.[0];
  const targets = [...((globalThis as any).game?.user?.targets ?? [])];
  const target = targets[0] ?? null;
  const reading =
    token && target
      ? readFlank({ attackerToken: token, targetToken: target, melee: true })
      : null;
  const lines = [
    `module: ${MODULE_ID}`,
    `setting (${COMBAT_SETTINGS.flanking}): ${isFlankingEnabled() ? "on" : "off"}`,
    `grid: ${isHexGrid() ? "hex" : "square"} type=${gridType()}`,
    `creature: ${token ? tokenName(token) : "— select a token —"}`,
    `target: ${target ? tokenName(target) : "none"}`,
  ];
  if (reading) {
    lines.push(
      reading.flanked
        ? `FLANK with ${reading.allyName}`
        : `no flank — ${reading.reason}`,
    );
  }
  if (token && target) {
    const allies = flankingAllies(token, target);
    lines.push(
      `allies considered: ${allies.map(tokenName).join(" | ") || "none"}`,
    );
  }
  console.log(lines.join("\n"));
  return {
    enabled: isFlankingEnabled(),
    hex: isHexGrid(),
    selected: token ? tokenName(token) : "",
    target: target ? tokenName(target) : "",
    reading,
  };
}
