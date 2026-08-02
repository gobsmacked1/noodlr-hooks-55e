// What the battlefield looks like right now, from one creature's point of view.
//
// Everything here is measurement, not judgement: who is where, how far, how hurt, how big, how
// dangerous-looking. The planner decides what to make of it, and the tier ladder decides which of
// these facts a given creature is even capable of noticing — an insect-brained thing gets the same
// board as a lich, and simply cannot act on most of it.
//
// Deliberately tolerant: Foundry's grid API has changed shape across versions and scenes can be
// gridless, so every measurement has a fallback and an unreadable value drops the combatant from
// consideration rather than poisoning the plan with a wrong number.

import { readHp } from "../tracker";
import { pickNumber, systemPaths } from "../system-profiles";

export interface BoardActor {
  combatantId: string;
  tokenId: string;
  name: string;
  /** Token object, for distance work and targeting. */
  token: any;
  actor: any;
  /** True when this combatant is on the acting creature's side. */
  ally: boolean;
  isPC: boolean;
  /** 0-1; null when the sheet doesn't report hit points. */
  hpFraction: number | null;
  hpValue: number | null;
  /** Grid squares occupied (width x height) — the crude "how big does it look" signal. */
  footprint: number;
  /** Distance from the acting creature, in the scene's own units. */
  distance: number;
  defeated: boolean;
  /** How many spell-like items the creature carries: the proxy for "that one is artillery". */
  spellCount: number;
}

export interface Board {
  self: BoardActor;
  enemies: BoardActor[];
  allies: BoardActor[];
  /** Scene distance units ("ft"), for readable log lines. */
  units: string;
  /** How far the acting creature can move this turn, in the same units; null when unknown. */
  speed: number | null;
}

function tokenOf(combatant: any): any {
  return combatant?.token?.object ?? combatant?.token ?? null;
}

function centerOf(token: any): { x: number; y: number } | null {
  const doc = token?.document ?? token;
  const x = Number(doc?.x);
  const y = Number(doc?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const grid = Number((canvas as any)?.grid?.size) || 0;
  const w = Number(doc?.width) || 1;
  const h = Number(doc?.height) || 1;
  return { x: x + (grid * w) / 2, y: y + (grid * h) / 2 };
}

/**
 * Distance between two tokens in scene units. Prefers Foundry's own measurement (which honors grid
 * type and diagonal rules) and falls back to straight-line pixels converted by the grid scale.
 */
function measure(a: any, b: any): number {
  const p1 = centerOf(a);
  const p2 = centerOf(b);
  if (!p1 || !p2) return Number.POSITIVE_INFINITY;

  const grid: any = (canvas as any)?.grid;
  try {
    if (typeof grid?.measurePath === "function") {
      const result = grid.measurePath([p1, p2]);
      const d = Number(result?.distance ?? result);
      if (Number.isFinite(d)) return d;
    }
  } catch {
    // fall through to the geometric estimate
  }

  const px = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const size = Number(grid?.size) || 100;
  const perSquare = Number(grid?.distance) || 5;
  return (px / size) * perSquare;
}

/** Hostility is read from the token's disposition, which is what the GM actually set. */
function dispositionOf(token: any): number {
  const raw = Number(token?.document?.disposition ?? token?.disposition);
  return Number.isFinite(raw) ? raw : 0;
}

function describeActor(combatant: any, selfToken: any, selfDisposition: number): BoardActor | null {
  const token = tokenOf(combatant);
  const actor = combatant?.actor;
  if (!token || !actor) return null;

  const hp = readHp(actor);
  const doc = token?.document ?? token;
  const width = Number(doc?.width) || 1;
  const height = Number(doc?.height) || 1;

  // "Carries a lot of spells" stands in for "is a caster", which stands in for "hits hard from far
  // away". Crude, but it needs no rules knowledge and it is the signal tier 6 actually wants.
  let spellCount = 0;
  try {
    for (const item of actor.items ?? []) {
      if (item?.type === "spell") spellCount++;
    }
  } catch {
    spellCount = 0;
  }

  return {
    combatantId: String(combatant?.id ?? ""),
    tokenId: String(doc?.id ?? ""),
    name: String(combatant?.name ?? actor?.name ?? "?"),
    token,
    actor,
    ally: dispositionOf(token) === selfDisposition,
    isPC: Boolean(combatant?.hasPlayerOwner ?? actor?.hasPlayerOwner),
    hpFraction: hp && hp.max > 0 ? Math.max(0, Math.min(1, hp.value / hp.max)) : null,
    hpValue: hp ? hp.value : null,
    footprint: width * height,
    distance: selfToken === token ? 0 : measure(selfToken, token),
    defeated: Boolean(combatant?.isDefeated),
    spellCount,
  };
}

/** Read the battlefield from `combatant`'s point of view. Null when it isn't placed on a scene. */
export function readBoard(combatant: any): Board | null {
  const selfToken = tokenOf(combatant);
  if (!selfToken || !combatant?.actor) return null;

  const P = systemPaths();
  const selfDisposition = dispositionOf(selfToken);
  const self = describeActor(combatant, selfToken, selfDisposition);
  if (!self) return null;

  const enemies: BoardActor[] = [];
  const allies: BoardActor[] = [];
  for (const other of game.combat?.combatants ?? []) {
    if (String((other as any)?.id ?? "") === self.combatantId) continue;
    const described = describeActor(other, selfToken, selfDisposition);
    // A downed combatant is not a consideration; nothing here should be kicking corpses.
    if (!described || described.defeated || described.hpValue === 0) continue;
    (described.ally ? allies : enemies).push(described);
  }

  enemies.sort((a, b) => a.distance - b.distance);
  allies.sort((a, b) => a.distance - b.distance);

  return {
    self,
    enemies,
    allies,
    units: String((canvas as any)?.scene?.grid?.units ?? "ft"),
    speed: pickNumber(combatant.actor, P.speed),
  };
}
