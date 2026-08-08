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
import { isAutoEndEnabled } from "../config";
import { isPrimaryGM } from "../../util/gm";
import { narrator, speakerFor } from "../../util/speaker";
import { announceRuling, requestBehavior, type BehaviorVerb } from "../../integration/contract";
import { releaseCombatant } from "./registry";
import {
  awardExperience,
  forfeitPartyGear,
  isDnd5e,
  restoreForfeited,
  xpForActor,
} from "../systems/dnd5e-rewards";

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

  // The two ways a creature stops fighting without anyone announcing it: its hit points reach zero, or
  // somebody ticks the skull in the tracker. Both are checked one tick later, so the update that
  // triggered them has landed before the tally is read.
  Hooks.on("updateActor", (actor: any, changed: any) => {
    // `hpValue` is a list of candidate paths, because where hit points live is a per-system question.
    const touched = systemPaths().hpValue.some(
      (path) => foundry.utils.getProperty(changed ?? {}, path) !== undefined,
    );
    if (!touched) return;
    if (!actor?.getActiveTokens?.().some((t: any) => t?.combatant)) return;
    setTimeout(() => void endEncounterIfOver(game.combat), 0);
  });

  Hooks.on("updateCombatant", (combatant: any, changed: any) => {
    if (!("defeated" in (changed ?? {}))) return;
    setTimeout(() => void endEncounterIfOver(combatant?.parent), 0);
  });

  // Same version split as the artifact controls: registering the legacy name on v13 emits a
  // deprecation warning all by itself.
  const generation = Number((game as any)?.release?.generation ?? 13);
  Hooks.on(generation >= 13 ? "renderChatMessageHTML" : "renderChatMessage", wireRestoreButton);

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
  fled: "NOODLRHOOKS.Combat.Resolution.Fled",
  surrendered: "NOODLRHOOKS.Combat.Resolution.Surrendered",
  mercy: "NOODLRHOOKS.Combat.Resolution.Mercy",
};

/**
 * The three ways out of a fight that this module decides on its own, in the vocabulary a narrator
 * understands. The other seven verbs in the contract have no trigger yet.
 */
const VERB: Record<Outcome, BehaviorVerb> = {
  fled: "FLEE",
  surrendered: "SURRENDER",
  mercy: "MERCY",
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

  // Offer the moment to whoever can give it words, before the GM's bookkeeping card. The rules
  // consequence above has already happened either way — a narrator is a courtesy, not a dependency.
  await requestBehavior({
    verb: VERB[outcome],
    actor: combatant?.actor,
    token: combatant?.token,
    context: { outcome, combatantName: String(combatant?.name ?? "") },
  });

  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content:
      `<p><strong>${foundry.utils.escapeHTML(String(combatant?.name ?? "?"))}</strong> — ` +
      `${game.i18n.localize(CONSEQUENCE[outcome])}</p>`,
    speaker: speakerFor(combatant?.token ?? combatant?.actor, String(combatant?.name ?? "")),
    whisper: (globalThis as any).ChatMessage.getWhisperRecipients("GM").map((u: any) => u.id),
  });

  await announceRuling({
    kind: "encounter",
    summary: `${String(combatant?.name ?? "A creature")} — ${game.i18n.localize(CONSEQUENCE[outcome])}`,
    detail: { outcome },
    actor: combatant?.actor,
    token: combatant?.token,
    combat,
  });

  await announceEncounterEndIfOver(combat);
}

/** Guard against the several routes into the end-of-fight check racing each other. */
let closing = false;

/**
 * Check whether the fight is finished, from anywhere.
 *
 * Originally this ran only when a creature fled, surrendered or was spared, which meant the commonest
 * ending of all — the party killing everything — never reached it (user, 2026-08-05: "the combat
 * encounter didn't automatically end after all enemy NPCs had been slain"). Death is now a trigger too.
 */
export async function endEncounterIfOver(combat: any): Promise<void> {
  if (!combat?.started || !isPrimaryGM() || closing) return;
  closing = true;
  try {
    await announceEncounterEndIfOver(combat);
  } catch (err) {
    log("could not check whether the fight is over:", err);
  } finally {
    closing = false;
  }
}

/**
 * A fight is over when no hostile creature is still willing and able to fight. At that point the
 * addendum's arithmetic runs: full experience for the slain and the surrendered, half for those that
 * escaped, and nothing at all if the party accepted mercy.
 *
 * Awarding experience is not reversible in any tidy way, so it happens once, at the end, from a tally
 * the GM can read in the same card. Clearing the tracker afterwards is governed by a setting, because
 * a GM who wants to loot the bodies in initiative order should be allowed to.
 */
async function announceEncounterEndIfOver(combat: any): Promise<void> {
  const P = systemPaths();
  let hostiles = 0;
  let standing = 0;
  let xp = 0;
  let spared = false;

  for (const c of combat.combatants ?? []) {
    const any = c as any;
    if (any?.hasPlayerOwner ?? any?.actor?.hasPlayerOwner) continue;
    hostiles++;
    const hp = pickNumber(any.actor, P.hpValue);
    const dead = any.isDefeated || (hp !== null && hp <= 0);
    const outcome = outcomeOf(String(any.id ?? ""));
    if (!dead && !outcome) standing++;

    if (outcome === "mercy") spared = true;
    // Revised 2026-08-02: escaping is worth nothing, not half. A creature that got away leaves no
    // body to count, and a party often drives enemies off ON PURPOSE — intimidation, pity, keeping a
    // faction's regard — so paying them for it would be paying them for a fight they chose not to
    // have. The tally is now literally what is left on the field: the dead, and those who yielded.
    if (dead || outcome === "surrendered") xp += isDnd5e() ? xpForActor(any.actor) : 0;
  }
  if (hostiles === 0 || standing > 0) return;

  const lines = [game.i18n.localize("NOODLRHOOKS.Combat.Resolution.Over")];

  if (spared) {
    // A party that accepted mercy earns nothing and pays for it, per the addendum.
    const taken = await forfeitPartyGear();
    lines.push(
      game.i18n.format("NOODLRHOOKS.Combat.Resolution.Forfeit", {
        actors: taken.actors,
        items: taken.items,
      }),
    );
  } else if (xp > 0) {
    const award = await awardExperience(xp);
    if (award.each > 0) {
      lines.push(
        game.i18n.format("NOODLRHOOKS.Combat.Resolution.Xp", {
          total: xp,
          each: award.each,
          heads: award.heads,
        }),
      );
    }
  }

  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content:
      lines.map((l) => `<p>${l}</p>`).join("") +
      (spared
        ? `<button type="button" data-action="noodlr-restore-forfeit">${game.i18n.localize(
            "NOODLRHOOKS.Combat.Resolution.Undo",
          )}</button>`
        : ""),
    speaker: narrator(),
    whisper: ChatMessage.getWhisperRecipients("GM").map((u: any) => u.id),
  });

  if (!isAutoEndEnabled()) return;
  // Deleted rather than ended: `Combat#endCombat` raises a confirmation dialog, and a prompt is exactly
  // the click this is meant to save. Losing the tracker loses nothing that is not on the sheets.
  try {
    await combat.delete();
  } catch (err) {
    log("could not clear the encounter after it ended:", err);
  }
}

/** The undo button on the mercy card. GM only — it writes to player-owned sheets. */
function wireRestoreButton(_message: unknown, html: unknown): void {
  if (!game.user?.isGM) return;
  const root: HTMLElement | undefined =
    html instanceof HTMLElement ? html : ((html as any)?.[0] as HTMLElement | undefined);
  const button = root?.querySelector<HTMLButtonElement>('[data-action="noodlr-restore-forfeit"]');
  if (!button) return;
  button.addEventListener("click", async () => {
    button.disabled = true;
    const restored = await restoreForfeited();
    ui.notifications?.info(game.i18n.format("NOODLRHOOKS.Combat.Resolution.Restored", { restored }));
  });
}
