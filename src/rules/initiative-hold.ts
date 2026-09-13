// A player who has been asked to roll initiative must not walk or act until they have a number.
//
// Automatic engagement rolls the monsters and then waits. Until that wait ends, Foundry still
// accepts WASD, a drag, and an activity use — so a player who simply ignores the roll can close
// with the spotter, hide, or drink a potion before anyone has an order. That is circumventing
// turn order, not pacing. The hold stamps a combat flag the player client can read, vetoes that
// token's own walk and activity, and after 30 seconds rolls the remaining initiatives. Same
// doctrine as an owed save: the clock ROLLS, it never skips.
//
// The GM is exempt. Staging a token during the wait is not the hole; a player moving theirs is.

import { log, MODULE_ID } from "../constants";
import { initiativeSettled } from "../tactics/hooks";
import { isPrimaryGM } from "../util/gm";
import { narrator } from "../util/speaker";

/** Players get this long to roll before the remaining initiatives are cast for them. */
export const INITIATIVE_HOLD_MS = 30_000;

/** What the clock does. Exported so a test can pin that it is never "skip". */
export const INITIATIVE_HOLD_TIMEOUT_CHOICE = "roll" as const;

const FLAG = "initiativeHold";
const NOTIFY_MS = 2_000;

let hold: { combatId: string; timer: number; deadline: number } | null = null;
let lastNotify = 0;

export function combatantOwesInitiative(combatant: {
  isDefeated?: boolean;
  initiative?: unknown;
} | null): boolean {
  if (!combatant || combatant.isDefeated) return false;
  return combatant.initiative === null || combatant.initiative === undefined;
}

export function tokenOwesInitiative(combat: { combatants?: Iterable<unknown> } | null, tokenId: string): boolean {
  if (!combat || !tokenId) return false;
  for (const raw of combat.combatants ?? []) {
    const combatant = raw as { tokenId?: unknown; token?: { id?: unknown }; isDefeated?: boolean; initiative?: unknown };
    const id = String(combatant?.tokenId ?? combatant?.token?.id ?? "");
    if (id !== tokenId) continue;
    return combatantOwesInitiative(combatant);
  }
  return false;
}

export function holdingInitiative(combat: any): boolean {
  const raw = combat?.getFlag?.(MODULE_ID, FLAG) ?? combat?.flags?.[MODULE_ID]?.[FLAG];
  return Boolean(raw);
}

/** A player-driven walk or drag is frozen; forced / API movement is not. */
export function shouldFreezePlayerMove(input: {
  isGM: boolean;
  holding: boolean;
  owes: boolean;
  action?: string;
  method?: string;
}): boolean {
  if (input.isGM || !input.holding || !input.owes) return false;
  const action = String(input.action ?? "");
  if (action === "displace" || action === "noodlrForce") return false;
  const method = String(input.method ?? "");
  if (method && method !== "dragging" && method !== "keyboard") return false;
  return true;
}

export function shouldFreezePlayerActivity(input: { isGM: boolean; holding: boolean; owes: boolean }): boolean {
  if (input.isGM || !input.holding || !input.owes) return false;
  return true;
}

export function owingNames(combat: { combatants?: Iterable<unknown> } | null): string[] {
  const names: string[] = [];
  for (const raw of combat?.combatants ?? []) {
    const combatant = raw as { isDefeated?: boolean; initiative?: unknown; name?: unknown };
    if (!combatantOwesInitiative(combatant)) continue;
    names.push(String(combatant?.name ?? "?"));
  }
  return names;
}

/**
 * Start the 30 s clock and stamp the flag the player client reads.
 *
 * Idempotent per combat: a second call (Begin clicked while we were already waiting) must not
 * restart the clock, or a slow player is punished for the GM pressing the button.
 */
export async function beginInitiativeHold(combat: any): Promise<void> {
  if (!combat?.id) return;
  // The flag is what every client freezes from. The clock is what spends the remaining
  // dice, and that write belongs to one client — same reason only the primary GM rollAlls.
  if (!isPrimaryGM()) return;
  if (hold?.combatId === String(combat.id)) {
    if (!holdingInitiative(combat)) await stampHold(combat);
    return;
  }
  clearHoldTimer();
  const combatId = String(combat.id);
  hold = {
    combatId,
    timer: window.setTimeout(() => void rollStragglers(combatId), INITIATIVE_HOLD_MS),
    deadline: Date.now() + INITIATIVE_HOLD_MS,
  };
  await stampHold(combat);
  const names = owingNames(combat);
  log(`initiative-hold: waiting ${INITIATIVE_HOLD_MS / 1000}s for ${names.join(", ") || "stragglers"} to roll`);
}

export async function endInitiativeHold(combat: any): Promise<void> {
  if (hold && combat?.id && hold.combatId === String(combat.id)) clearHoldTimer();
  else if (!combat?.id) clearHoldTimer();
  if (!isPrimaryGM() || !combat) return;
  if (!holdingInitiative(combat)) return;
  try {
    await combat.unsetFlag(MODULE_ID, FLAG);
  } catch (err) {
    log("initiative-hold: could not clear the hold flag:", err);
  }
}

export function registerInitiativeHold(): void {
  Hooks.on("deleteCombat", (combat: any) => {
    if (hold && combat?.id && hold.combatId === String(combat.id)) clearHoldTimer();
  });

  Hooks.on("updateCombatant", (combatant: any, changed: any) => {
    if (!("initiative" in (changed ?? {}))) return;
    const combat = combatant?.parent;
    if (!combat || !holdingInitiative(combat)) return;
    if (!initiativeSettled(combat)) return;
    void endInitiativeHold(combat);
  });

  // A GM who presses Begin while someone is still unrolled is the same hole as auto-engage.
  Hooks.on("updateCombat", (combat: any, changed: any) => {
    if (changed?.started && !initiativeSettled(combat)) void beginInitiativeHold(combat);
    if (!game.user?.isGM && holdFlagArrived(changed) && holdingInitiative(combat)) {
      notifyOnce("NOODLRHOOKS.Combat.InitiativeHold.Waiting");
    }
  });

  Hooks.on("preMoveToken", (document: any, movement: any) => {
    const combat = sceneCombat();
    if (
      !shouldFreezePlayerMove({
        isGM: Boolean(game.user?.isGM),
        holding: holdingInitiative(combat),
        owes: tokenOwesInitiative(combat, String(document?.id ?? "")),
        action: String(movement?.action ?? ""),
        method: String(movement?.method ?? ""),
      })
    ) {
      return;
    }
    notifyOnce("NOODLRHOOKS.Combat.InitiativeHold.Blocked");
    return false;
  });

  Hooks.on("dnd5e.preUseActivity", (activity: any) => {
    const actor = activity?.actor;
    if (!actor) return;
    const combat = sceneCombat();
    if (
      !shouldFreezePlayerActivity({
        isGM: Boolean(game.user?.isGM),
        holding: holdingInitiative(combat),
        owes: actorOwes(combat, actor),
      })
    ) {
      return;
    }
    notifyOnce("NOODLRHOOKS.Combat.InitiativeHold.Blocked");
    return false;
  });
}

export function surveyInitiativeHold(): unknown {
  const combat = sceneCombat();
  const owing = owingNames(combat);
  const armed = Boolean(hold && combat?.id && hold.combatId === String(combat.id));
  const remainingMs = armed && hold ? Math.max(0, hold.deadline - Date.now()) : 0;
  const report = {
    holding: holdingInitiative(combat),
    owing,
    clockMs: INITIATIVE_HOLD_MS,
    timeout: INITIATIVE_HOLD_TIMEOUT_CHOICE,
    armed,
    remainingMs,
  };
  const lines = [
    `holding: ${report.holding ? "yes" : "no"}`,
    `owing: ${owing.length ? owing.join(" | ") : "none"}`,
    `timeout: ${INITIATIVE_HOLD_TIMEOUT_CHOICE} after ${INITIATIVE_HOLD_MS / 1000}s`,
    `armed: ${armed ? "yes" : "no"}`,
    `remaining: ${Math.ceil(remainingMs / 1000)}s`,
  ];
  console.log(`[${MODULE_ID}] initiative hold\n${lines.join("\n")}`);
  return report;
}

function actorOwes(combat: any, actor: any): boolean {
  const tokens: any[] = actor.getActiveTokens?.() ?? [];
  return tokens.some((t: any) => tokenOwesInitiative(combat, String(t?.id ?? t?.document?.id ?? "")));
}

function sceneCombat(): any {
  const scene: any = (globalThis as any).canvas?.scene;
  const combats = (game as any).combats;
  if (scene?.id && typeof combats?.find === "function") {
    const found = combats.find((c: any) => c?.scene?.id === scene.id);
    if (found) return found;
  }
  return (game as any).combat ?? null;
}

function holdFlagArrived(changed: any): boolean {
  const flags = changed?.flags?.[MODULE_ID];
  return Boolean(flags && FLAG in flags);
}

async function stampHold(combat: any): Promise<void> {
  if (holdingInitiative(combat)) return;
  try {
    await combat.setFlag(MODULE_ID, FLAG, { at: Date.now() });
  } catch (err) {
    log("initiative-hold: could not stamp the hold flag:", err);
  }
}

function clearHoldTimer(): void {
  if (!hold) return;
  window.clearTimeout(hold.timer);
  hold = null;
}

async function rollStragglers(combatId: string): Promise<void> {
  hold = null;
  if (!isPrimaryGM()) return;
  const combat = (game.combats as any)?.get?.(combatId);
  if (!combat) return;
  if (initiativeSettled(combat)) {
    await endInitiativeHold(combat);
    return;
  }

  const names = owingNames(combat);
  log(`initiative-hold: nobody rolled in time; rolling ${names.join(", ") || "the stragglers"}`);
  const ChatMessage = (globalThis as any).ChatMessage;
  try {
    await ChatMessage.create({
      content: `<p><em>${game.i18n.localize("NOODLRHOOKS.Combat.AutoEngage.RolledFor")}</em></p>`,
      speaker: narrator(),
    });
  } catch (err) {
    log("initiative-hold: could not announce the auto-roll:", err);
  }
  try {
    await combat.rollAll();
  } catch (err) {
    log("could not roll the remaining initiatives:", err);
  }
  if (initiativeSettled(combat)) await endInitiativeHold(combat);
}

function notifyOnce(key: string): void {
  if (Date.now() - lastNotify < NOTIFY_MS) return;
  lastNotify = Date.now();
  const text = game.i18n.localize(key);
  try {
    ui.notifications?.warn(text);
  } catch {
    log(`initiative-hold: ${text}`);
  }
}
