// A creature that flees has to actually leave, or the fight ends and starts again.
//
// The planner already walks toward the nearest scene edge (`moveOffField`). The encounter layer then
// recorded `fled`, counted that combatant as no longer standing, and — with auto-end on — deleted the
// Combat. Perception's 60-second peace is not enough: the token stays Hostile and visible, so the
// moment peace expires the same sentry starts a new fight. The Archmage vs Barb Arian fight (2026-08-21)
// did exactly that.
//
// So fleeing is a RUN-OFF, not an instant resolution. The first flee turn stamps a flag on the TOKEN
// (in-memory encounter state dies with the Combat). Subsequent turns keep running. After three of
// that creature's own turns, or as soon as it reaches the edge, the scene token is removed and then
// the encounter may end. Perception skips a fled token always, even after peace, even with no Combat.
//
// The token, not the world actor. A linked Archmage can be dropped again from the directory; deleting
// the actor would delete every future copy of that wizard.

import { MODULE_ID, log } from "../constants";
import { isPrimaryGM } from "../util/gm";
import { readFlag } from "../util/flags";
import { narrator, speakerFor } from "../util/speaker";
import { requestBehavior } from "../integration/contract";
import { readLocomotion } from "../core/locomotion";
import { centerOf } from "../core/positioning";
import { moveOffField } from "../core/movement";
import { standUp } from "../rules/prone";
import { crawlAction, isProne, standCost } from "../system/dnd5e-prone";
import { resolveCombatant } from "./encounter";

/** Own turns spent running before the token is taken off the scene. The first flee turn counts. */
export const FLEE_TURNS = 3;

export const FLED_FLAG = "fled";

export interface FledState {
  combatId: string;
  /** Own turns already spent fleeing, including the one that declared it. */
  turns: number;
  at: number;
}

export function fledState(token: any): FledState | null {
  const raw = readFlag(token?.document ?? token, FLED_FLAG);
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const combatId = String(rec.combatId ?? "");
  const turns = Number(rec.turns);
  if (!combatId || !Number.isFinite(turns) || turns < 1) return null;
  return { combatId, turns, at: Number(rec.at) || 0 };
}

export function isFleeing(token: any): boolean {
  return fledState(token) !== null;
}

export function isFleeingCombatant(combatant: any): boolean {
  return isFleeing(combatant?.token ?? combatant?.token?.object);
}

/** One grid square of the scene edge, in pixels. */
export function edgeBandPx(gridSize = 100): number {
  return Math.max(Number(gridSize) || 100, 1);
}

/** Is this token's centre already on the last square before the map runs out? */
export function nearSceneEdge(
  token: any,
  rect?: { x: number; y: number; width: number; height: number } | null,
  gridSize = 100,
): boolean {
  const origin = centerOf(token);
  const bounds = rect ?? null;
  if (!origin || !bounds) return false;
  const band = edgeBandPx(gridSize);
  return (
    origin.x - bounds.x <= band ||
    bounds.x + bounds.width - origin.x <= band ||
    origin.y - bounds.y <= band ||
    bounds.y + bounds.height - origin.y <= band
  );
}

export function shouldDespawn(state: FledState, atEdge: boolean): boolean {
  return atEdge || state.turns >= FLEE_TURNS;
}

function tokenDocOf(combatant: any): any {
  return combatant?.token?.document ?? combatant?.token ?? null;
}

function sceneRect(): { x: number; y: number; width: number; height: number } | null {
  const rect: any = (canvas as any)?.dimensions?.sceneRect;
  if (!rect) return null;
  return { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) };
}

function gridSize(): number {
  return Number((canvas as any)?.grid?.size ?? (canvas as any)?.dimensions?.size ?? 100) || 100;
}

async function stamp(doc: any, state: FledState): Promise<void> {
  if (!doc?.setFlag) return;
  await doc.setFlag(MODULE_ID, FLED_FLAG, state);
}

/**
 * First flee turn: the walk has already happened. Stamp the token and tell the table it is running,
 * but do NOT resolve the encounter yet — that is what ended combat and started a new one.
 */
export async function beginFlee(combatant: any): Promise<void> {
  const doc = tokenDocOf(combatant);
  const combat = game.combat;
  if (!doc || !combat) return;
  if (fledState(doc)) return;

  const state: FledState = {
    combatId: String(combat.id ?? ""),
    turns: 1,
    at: Date.now(),
  };
  try {
    await stamp(doc, state);
  } catch (err) {
    log(`flee: could not mark ${combatant?.name}:`, err);
  }

  await requestBehavior({
    verb: "FLEE",
    actor: combatant?.actor,
    token: combatant?.token,
    context: { outcome: "fled", combatantName: String(combatant?.name ?? "") },
  });

  if (await maybeFinishFlee(combatant)) return;

  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content:
      `<p><strong>${foundry.utils.escapeHTML(String(combatant?.name ?? "?"))}</strong> — ` +
      `${game.i18n.localize("NOODLRHOOKS.Combat.Resolution.Fleeing")}</p>`,
    speaker: speakerFor(combatant?.token ?? combatant?.actor, String(combatant?.name ?? "")),
    whisper: ChatMessage.getWhisperRecipients("GM").map((u: any) => u.id),
  });
}

/** Later turns of a creature already running. */
export async function continueFlee(combatant: any): Promise<void> {
  const doc = tokenDocOf(combatant);
  const prev = fledState(doc);
  if (!doc || !prev) return;

  const next: FledState = { ...prev, turns: prev.turns + 1, at: Date.now() };
  try {
    await stamp(doc, next);
  } catch (err) {
    log(`flee: could not update ${combatant?.name}:`, err);
  }

  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content: `<p>${foundry.utils.escapeHTML(String(combatant?.name ?? "?"))} ${game.i18n.localize("NOODLRHOOKS.Combat.Resolution.KeepsRunning")}</p>`,
    speaker: speakerFor(combatant?.token ?? combatant?.actor, String(combatant?.name ?? "")),
  });

  const token = combatant?.token?.object ?? combatant?.token;
  const actor = combatant?.actor;
  let budget = readLocomotion(actor).speed;
  if (isProne(actor)) {
    const stood = await standUp(actor);
    if (stood.ok) budget = Math.max(0, budget - standCost(budget));
  }
  const action = isProne(actor) ? crawlAction() : undefined;
  if (token && budget > 0) {
    await moveOffField(token, budget, action ? { action } : {});
  }

  await maybeFinishFlee(combatant);
}

export async function maybeFinishFlee(combatant: any): Promise<boolean> {
  const doc = tokenDocOf(combatant);
  const state = fledState(doc);
  if (!doc || !state) return false;
  const token = combatant?.token?.object ?? combatant?.token ?? doc;
  const atEdge = nearSceneEdge(token, sceneRect(), gridSize());
  if (!shouldDespawn(state, atEdge)) return false;
  await finishFlee(combatant, atEdge ? "edge" : "turns");
  return true;
}

/**
 * Take the scene token off the map, then record the outcome so the encounter may end.
 *
 * Player-owned tokens are never deleted — a PC who somehow flees is resolved in place.
 */
export async function finishFlee(combatant: any, why: "edge" | "turns" | "combat-ended"): Promise<void> {
  const doc = tokenDocOf(combatant);
  const name = String(combatant?.name ?? doc?.name ?? "?");
  const playerOwned = Boolean(combatant?.hasPlayerOwner ?? combatant?.actor?.hasPlayerOwner);

  log(`flee: ${name} escapes (${why}${playerOwned ? ", player — token kept" : ""})`);

  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content:
      `<p><strong>${foundry.utils.escapeHTML(name)}</strong> — ` +
      `${game.i18n.localize("NOODLRHOOKS.Combat.Resolution.Escaped")}</p>`,
    speaker: playerOwned
      ? speakerFor(combatant?.token ?? combatant?.actor, name)
      : narrator(),
    whisper: ChatMessage.getWhisperRecipients("GM").map((u: any) => u.id),
  });

  // Record first, while the combatant still exists. Deleting the token may drop it from the tracker.
  // Words and the whisper already went out on the first flee turn / the Escaped card above.
  await resolveCombatant(combatant, "fled", { announce: false, narrate: false });

  if (playerOwned || !doc?.delete) return;
  try {
    await doc.delete();
  } catch (err) {
    log(`flee: could not remove ${name} from the scene:`, err);
  }
}

/** Combat was wiped while someone was still running — take those tokens off so they cannot re-spot. */
export async function despawnFledOnCombatEnd(combat: any): Promise<void> {
  const id = String(combat?.id ?? "");
  if (!id) return;
  const tokens: any[] = (canvas as any)?.tokens?.placeables ?? [];
  for (const token of tokens) {
    const state = fledState(token);
    if (!state || state.combatId !== id) continue;
    if (token?.actor?.hasPlayerOwner) continue;
    const name = String(token?.name ?? "?");
    log(`flee: ${name} still running when combat ended — removing the token`);
    try {
      await token.document?.delete?.();
    } catch (err) {
      log(`flee: could not remove ${name} after combat ended:`, err);
    }
  }
}

export function registerFleeHooks(): void {
  Hooks.on("deleteCombat", (combat: any) => {
    if (!isPrimaryGM()) return;
    void despawnFledOnCombatEnd(combat);
  });
}

export function surveyFlee(): Record<string, unknown> {
  const tokens: any[] = (canvas as any)?.tokens?.placeables ?? [];
  const rows = tokens
    .map((token) => {
      const state = fledState(token);
      if (!state) return null;
      return {
        name: String(token?.name ?? "?"),
        turns: state.turns,
        remaining: Math.max(0, FLEE_TURNS - state.turns),
        atEdge: nearSceneEdge(token, sceneRect(), gridSize()),
        combatId: state.combatId,
      };
    })
    .filter(Boolean);
  return { cap: FLEE_TURNS, fleeing: rows };
}
