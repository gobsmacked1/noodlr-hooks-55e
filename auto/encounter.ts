// The state a fight carries that no single sheet holds: who has stopped fighting, who ran, who gave
// up, and whether the party has put its weapons down.
//
// Combat resolution addendum (user, 2026-08-02): a fight can end without a total party kill or a
// wiped enemy line. Creatures that flee, surrender, or spare a beaten party each end the encounter on
// different terms, and each carries different consequences for loot and experience.
//
// WHAT THIS MODULE DOES AND DOES NOT DO. It records outcomes, flips token disposition from hostile to
// neutral (one reversible token field), and posts a resolution card telling the GM what the addendum
// says each outcome is worth. It does NOT award experience, distribute loot, or strip a player's
// currency, weapons, and armour. Experience and loot are system-specific arithmetic, and reaching
// into player-owned sheets to confiscate their gear is exactly the kind of irreversible, table-
// upsetting action that must be a human decision. We count; the GM applies.

import { log } from "../../constants";
import { pickNumber, pickString, systemPaths } from "../system-profiles";
import { releaseCombatant } from "./registry";

export type Outcome = "fled" | "surrendered" | "mercy";

interface EncounterState {
  combatId: string;
  /** Round in which a player last did something aggressive. */
  lastAggressionRound: number;
  outcomes: Map<string, Outcome>;
}

let state: EncounterState | null = null;

function stateFor(combat: any): EncounterState {
  const id = String(combat?.id ?? "");
  if (!state || state.combatId !== id) {
    state = { combatId: id, lastAggressionRound: Number(combat?.round ?? 0), outcomes: new Map() };
  }
  return state;
}

export function registerEncounterTracking(): void {
  Hooks.on("deleteCombat", () => {
    state = null;
  });

  // Aggression is inferred from players rolling dice while a fight is running. It is a proxy, and a
  // deliberately generous one: a party that is talking, healing, or backing away rolls far less than
  // a party that is attacking, and the cost of a false positive (mercy withheld) is much cheaper than
  // a false negative (a creature spares a party that is still stabbing it).
  Hooks.on("createChatMessage", (message: any) => {
    const combat = game.combat;
    if (!combat?.started || !state) return;
    const rolls = message?.rolls ?? [];
    if (rolls.length === 0) return;

    const actorId = message?.speaker?.actor;
    const actor = actorId ? game.actors?.get(actorId) : null;
    const fromPlayer = Boolean(
      actor?.hasPlayerOwner ?? !game.users?.get(message?.author?.id)?.isGM,
    );
    if (!fromPlayer) return;

    stateFor(combat).lastAggressionRound = Number(combat.round ?? 0);
  });
}

/** Has the party held its fire for at least one complete round? */
export function partyHasCeasedAggression(): boolean {
  const combat = game.combat;
  if (!combat?.started || !state) return false;
  const round = Number(combat.round ?? 0);
  // Needs a full round to have elapsed, so this cannot fire on the first round of a fight.
  return round >= 2 && round - state.lastAggressionRound >= 1;
}

/** Is the player side beaten — most of them down or out of the fight? */
export function partyIsDefeated(): boolean {
  const combat = game.combat;
  if (!combat?.started) return false;
  const P = systemPaths();
  let total = 0;
  let down = 0;
  for (const c of combat.combatants ?? []) {
    const any = c as any;
    if (!(any?.hasPlayerOwner ?? any?.actor?.hasPlayerOwner)) continue;
    total++;
    const hp = pickNumber(any.actor, P.hpValue);
    if (any.isDefeated || (hp !== null && hp <= 0)) down++;
  }
  return total > 0 && down / total > 0.5;
}

/**
 * Would this creature spare anyone? The addendum's test is alignment: lawful anything, or anything
 * that is not evil. A sheet with no readable alignment is treated as not merciful — inventing a
 * conscience for a creature the GM never gave one is the worse error.
 */
export function isMercifulSort(actor: any): boolean {
  const alignment = pickString(actor, systemPaths().alignment).toLowerCase();
  if (!alignment) return false;
  return alignment.includes("lawful") || !alignment.includes("evil");
}

export function outcomeOf(combatantId: string): Outcome | undefined {
  return state?.outcomes.get(combatantId);
}

/** True once a creature has left the fight one way or another. */
export function hasResolved(combatantId: string): boolean {
  return Boolean(state?.outcomes.get(combatantId));
}

const CONSEQUENCE: Record<Outcome, string> = {
  fled: "NOODLR.Combat.Resolution.Fled",
  surrendered: "NOODLR.Combat.Resolution.Surrendered",
  mercy: "NOODLR.Combat.Resolution.Mercy",
};

/**
 * Record how a creature left the fight, flip its disposition when the addendum calls for it, and tell
 * the GM what the outcome is worth.
 */
export async function resolveCombatant(combatant: any, outcome: Outcome): Promise<void> {
  const combat = game.combat;
  if (!combat) return;
  const id = String(combatant?.id ?? "");
  const current = stateFor(combat);
  if (current.outcomes.has(id)) return;
  current.outcomes.set(id, outcome);

  // A creature that has stopped fighting is no longer Noodlr's to play.
  releaseCombatant(id);

  if (outcome === "surrendered" || outcome === "mercy") {
    try {
      const NEUTRAL = (globalThis as any).CONST?.TOKEN_DISPOSITIONS?.NEUTRAL ?? 0;
      await combatant?.token?.update?.({ disposition: NEUTRAL });
    } catch (err) {
      log("could not change disposition:", err);
    }
  }

  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content:
      `<p><strong>${foundry.utils.escapeHTML(String(combatant?.name ?? "?"))}</strong> — ` +
      `${game.i18n.localize(CONSEQUENCE[outcome])}</p>`,
    whisper: (globalThis as any).ChatMessage.getWhisperRecipients("GM").map((u: any) => u.id),
  });

  await announceEncounterEndIfOver(combat);
}

/**
 * A fight is over when no hostile creature is still willing and able to fight. Noodlr says so and
 * stops there: ending the encounter, handing out experience, and dividing loot stay with the GM.
 */
async function announceEncounterEndIfOver(combat: any): Promise<void> {
  const P = systemPaths();
  let hostiles = 0;
  let standing = 0;
  for (const c of combat.combatants ?? []) {
    const any = c as any;
    if (any?.hasPlayerOwner ?? any?.actor?.hasPlayerOwner) continue;
    hostiles++;
    const hp = pickNumber(any.actor, P.hpValue);
    const dead = any.isDefeated || (hp !== null && hp <= 0);
    if (!dead && !hasResolved(String(any.id ?? ""))) standing++;
  }
  if (hostiles === 0 || standing > 0) return;

  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content: `<p>${game.i18n.localize("NOODLR.Combat.Resolution.Over")}</p>`,
    whisper: ChatMessage.getWhisperRecipients("GM").map((u: any) => u.id),
  });
}
