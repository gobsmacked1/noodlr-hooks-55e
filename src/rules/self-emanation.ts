// Who an instant self emanation actually catches.
//
// Arms of Hadar is a 10-foot Emanation from the caster, not a sphere the player
// drops on a remote square. `template-targets` already stops the placement UI
// and wipes leftover Fire Bolt targets. This is the catch list that replaces
// them, so auto-saves have someone to roll for instead of waiting forever on a
// template that will never appear.

import { log } from "../constants";
import { tokenDistance } from "../core/positioning";
import { systemTargetsFromDocs } from "./cards";
import { emanationSize } from "./template-targets";

function elevationOf(token: any): number {
  const n = Number((token?.document ?? token)?.elevation);
  return Number.isFinite(n) ? n : 0;
}

function tokenIdOf(token: any): string {
  return String((token?.document ?? token)?.id ?? "");
}

function isOut(doc: any): boolean {
  if (!doc) return true;
  if (doc.hidden || doc.isSecret) return true;
  if (typeof doc.hasStatusEffect === "function" && doc.hasStatusEffect("dead")) return true;
  if (doc.combatant?.isDefeated) return true;
  return false;
}

/** Closest occupied squares, then |Δz| — the same cylinder melee reach uses. */
export function inSelfEmanation(caster: any, other: any, radius: number): boolean {
  if (!(radius > 0)) return false;
  if (tokenDistance(caster, other) > radius) return false;
  return Math.abs(elevationOf(caster) - elevationOf(other)) <= radius;
}

/** TokenDocuments on the viewed scene inside the emanation, excluding the caster. */
export function tokensInSelfEmanation(caster: any, radius: number): any[] {
  const origin = caster?.document ?? caster;
  if (!origin || !(radius > 0)) return [];
  const skip = tokenIdOf(origin);
  const out: any[] = [];
  const seen = new Set<string>();
  const tokens = (globalThis as any).canvas?.scene?.tokens;
  const list: any[] = tokens?.contents ?? (Array.isArray(tokens) ? tokens : []);
  for (const doc of list) {
    const id = tokenIdOf(doc);
    if (!id || id === skip || seen.has(id)) continue;
    if (isOut(doc)) continue;
    if (!inSelfEmanation(origin, doc, radius)) continue;
    seen.add(id);
    out.push(doc);
  }
  return out;
}

/**
 * Stamp `system.targets` on the usage card from the caster's position.
 *
 * Mutates the live message first so `noteTargets` / `targetsOf` can read it
 * without waiting on the update round-trip.
 */
export function applySelfEmanationCatch(message: any, activity: any): any[] {
  const speaker = message?.speaker;
  const sceneId = String(speaker?.scene ?? "");
  const tokenId = String(speaker?.token ?? "");
  let caster: any = null;
  if (sceneId && tokenId) {
    caster = (globalThis as any).game?.scenes?.get?.(sceneId)?.tokens?.get?.(tokenId) ?? null;
  }
  if (!caster) {
    const actorId = String(speaker?.actor ?? "");
    const actor = actorId ? (globalThis as any).game?.actors?.get?.(actorId) : null;
    const tokens: any[] = actor?.getActiveTokens?.() ?? [];
    caster = tokens.length === 1 ? (tokens[0]?.document ?? tokens[0]) : null;
  }
  const size = emanationSize(activity);
  const caught = tokensInSelfEmanation(caster, size);
  const stamped = systemTargetsFromDocs(caught);
  if (message?.system && typeof message.system === "object") {
    message.system.targets = stamped;
  }
  if (typeof message?.update === "function") {
    void Promise.resolve(message.update({ "system.targets": stamped })).catch(() => {
      /* the in-memory stamp is what fileUsage reads */
    });
  }
  log(
    `template: self emanation ${size} ft — ${caught.length} ` +
      (caught.length === 1 ? "creature" : "creatures") +
      (caught.length ? ` (${caught.map((d) => String(d?.name ?? "?")).join(" | ")})` : ""),
  );
  return caught;
}
