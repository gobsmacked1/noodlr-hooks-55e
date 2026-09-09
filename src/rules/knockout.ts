// Ask the attacker whether a qualifying killing blow knocks the target out.
//
// Dying owns the HP write and the Dead / Unconscious marks. This file owns the
// question: who is asked, on what clock, and what the card said about the swing.
// Applying Unconscious first (silent) is the caller's job — a 0 HP monster that
// is still unmarked can take a turn while the dialog is up. On Knock out, dying
// writes 1 HP (2024) through `writeKnockoutHp` so the heal hook does not clear
// Unconscious.
//
// THE CLOCK NEVER PICKS KNOCKOUT. Timeout and a missing answer are Kill, which is
// today's behaviour. Knockout is the deliberate click. A player-character attacker
// is still asked when the GM clock is 0 (solo table / GM driving the Monk).

import { log, MODULE_ID } from "../constants";
import { isKnockoutEnabled } from "../settings";
import { hasFlag } from "../util/flags";
import { isPrimaryGM, rollerForActor } from "../util/gm";
import { DEFAULT_SECONDS, promptChoice } from "../util/prompt";
import { askUser, registerQuery } from "../util/queries";
import { tokenFor } from "../util/tokens";
import { owedSecondsFor } from "./owed-roll";
import { attackMessageOf, damageParts, rollType } from "./cards";
import { shouldAutomate } from "../tactics/registry";
import { durationPayload, worldOf } from "../capability/duration";
import { effectForStatus, stampDuration } from "../capability/timed";
import {
  ESTIMATE_NOT_DEAD,
  ESTIMATE_NS,
  KNOCKOUT_FLAG,
  KNOCKOUT_HOURS,
  meleeFromParts,
} from "../system/dnd5e-knockout";

const QUERY = "knockout";
const KILL = "kill";
const OUT = "knockout";

export interface KnockoutSwing {
  types: string[];
  melee: boolean | null;
  attacker: any | null;
  automated: boolean;
}

export type KnockoutChoice = "kill" | "knockout";

interface KnockoutRequest {
  attackerUuid: string;
  attackerName: string;
  victimName: string;
  seconds: number;
}

function originatingDoc(message: any): any {
  if (message && typeof message === "object") return message;
  return null;
}

function attackCardOf(message: any): any {
  const doc = originatingDoc(message);
  if (!doc) return null;
  if (rollType(doc) === "attack") return doc;
  return attackMessageOf(doc) ?? doc;
}

/** Positive damage types only — "inflicting". Healing and zero parts do not count. */
export function typesFromMessage(message: any): string[] {
  const types: string[] = [];
  for (const part of damageParts(originatingDoc(message))) {
    if (!(part.value > 0)) continue;
    const type = String(part.type ?? "").trim();
    if (type) types.push(type);
  }
  return types;
}

export function meleeFromMessage(message: any): boolean | null {
  const card = attackCardOf(message);
  if (!card) return null;
  const mode = String(
    card?.flags?.dnd5e?.roll?.attackMode ?? card?.rolls?.[0]?.options?.attackMode ?? "",
  );
  const activity = card?.getAssociatedActivity?.();
  const item = card?.getAssociatedItem?.();
  return meleeFromParts({
    attackMode: mode,
    activityType: activity?.type,
    attackType: activity?.attack?.type?.value,
    actionType: item?.system?.actionType,
    rollType: rollType(card),
  });
}

function attackerOf(message: any): any | null {
  const card = attackCardOf(message) ?? originatingDoc(message);
  try {
    return card?.getAssociatedActor?.() ?? null;
  } catch {
    return null;
  }
}

function attackerIsAutomated(attacker: any): boolean {
  if (!attacker) return false;
  const combat = (globalThis as any).game?.combat;
  const list =
    combat?.getCombatantsByActor?.(attacker) ??
    (combat?.combatants ?? []).filter(
      (c: any) => c?.actor === attacker || c?.actorId === attacker?.id,
    );
  return list.some((c: any) => shouldAutomate(c));
}

export function readKnockoutSwing(message: any): KnockoutSwing {
  const attacker = attackerOf(message);
  return {
    types: typesFromMessage(message),
    melee: meleeFromMessage(message),
    attacker,
    automated: attackerIsAutomated(attacker),
  };
}

function isPlayerCharacter(attacker: any): boolean {
  return Boolean(attacker?.type === "character" || attacker?.hasPlayerOwner);
}

function secondsFor(attacker: any): number {
  const owed = owedSecondsFor(attacker);
  if (owed > 0) return owed;
  // GM clock defaults to 0 so a Fireball on goblins still rolls. Knockout is the
  // opposite: a PC attacker must still be asked, even when the GM is the roller.
  return isPlayerCharacter(attacker) ? DEFAULT_SECONDS : 0;
}

export function registerKnockoutOffers(): void {
  registerQuery(QUERY, async (data) => resolveHere(data?.request as KnockoutRequest | undefined));
}

/**
 * Ask the attacker. Returns `"kill"` when nobody should be asked, the clock is 0
 * for a non-PC, the query is unanswered, or they pick Kill / time out.
 */
export async function askKnockout(input: {
  attacker: any;
  victimName: string;
}): Promise<KnockoutChoice> {
  if (!isKnockoutEnabled()) return KILL;
  const attacker = input.attacker;
  if (!attacker) return KILL;
  const seconds = secondsFor(attacker);
  if (!(seconds > 0)) {
    log(`knockout: no prompt for ${String(attacker.name ?? "someone")} — clock is 0`);
    return KILL;
  }

  const owner = rollerForActor(attacker) ?? String((game.users as any)?.activeGM?.id ?? "");
  if (!owner) return KILL;

  const request: KnockoutRequest = {
    attackerUuid: String(attacker.uuid ?? ""),
    attackerName: String(attacker.name ?? ""),
    victimName: input.victimName,
    seconds,
  };
  const timeout = Math.max(30_000, seconds * 1000 + 5_000);
  const answer = await askUser<{ choice: KnockoutChoice }>(owner, QUERY, { request }, { timeout });
  return answer?.choice === OUT ? OUT : KILL;
}

async function resolveHere(request: KnockoutRequest | undefined): Promise<{ choice: KnockoutChoice }> {
  if (!request) return { choice: KILL };
  const picked = await promptChoice({
    title: game.i18n.format("NOODLRHOOKS.Combat.Knockout.Title", { name: request.attackerName }),
    body: game.i18n.format("NOODLRHOOKS.Combat.Knockout.Body", { target: request.victimName }),
    choices: [
      {
        id: OUT,
        label: game.i18n.localize("NOODLRHOOKS.Combat.Knockout.KnockOut"),
        hint: game.i18n.localize("NOODLRHOOKS.Combat.Knockout.KnockOutHint"),
      },
      {
        id: KILL,
        label: game.i18n.localize("NOODLRHOOKS.Combat.Knockout.Kill"),
        hint: game.i18n.localize("NOODLRHOOKS.Combat.Knockout.KillHint"),
      },
    ],
    defaultId: KILL,
    seconds: request.seconds,
  });
  return { choice: picked === OUT ? OUT : KILL };
}

function tokenDocsOf(actor: any): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  const add = (t: any) => {
    const doc = t?.document ?? t;
    const id = String(doc?.id ?? "");
    if (!doc?.setFlag || !id || seen.has(id)) return;
    seen.add(id);
    out.push(doc);
  };
  add(tokenFor(actor));
  try {
    for (const t of actor?.getActiveTokens?.(true, true) ?? []) add(t);
  } catch {
    /* getActiveTokens is Foundry-shaped; missing is zero tokens */
  }
  return out;
}

/**
 * Tell Health Estimate this token is not a corpse. No-op when nothing is placed.
 * `on` writes the flag; `off` unsets it so a later kill can show Dead again.
 */
export async function markEstimateNotDead(actor: any, on: boolean): Promise<number> {
  let n = 0;
  for (const doc of tokenDocsOf(actor)) {
    try {
      if (on) await doc.setFlag(ESTIMATE_NS, ESTIMATE_NOT_DEAD, true);
      else await doc.unsetFlag(ESTIMATE_NS, ESTIMATE_NOT_DEAD);
      n += 1;
    } catch (err) {
      log(`knockout: could not ${on ? "set" : "clear"} ${ESTIMATE_NS}.${ESTIMATE_NOT_DEAD}:`, err);
    }
  }
  return n;
}

function actorKey(actor: any): string {
  return String(actor?.uuid ?? actor?.id ?? "");
}

/** True while a 2024 knockout is in effect (1 HP + Unconscious + this flag). */
export function isKnockedOut(actor: any): boolean {
  return hasFlag(actor, KNOCKOUT_FLAG);
}

export async function setKnockedOut(actor: any, on: boolean): Promise<void> {
  try {
    if (on) await actor?.setFlag?.(MODULE_ID, KNOCKOUT_FLAG, true);
    else await actor?.unsetFlag?.(MODULE_ID, KNOCKOUT_FLAG);
  } catch (err) {
    log(`knockout: could not ${on ? "set" : "clear"} ${KNOCKOUT_FLAG}:`, err);
  }
}

/** HP writes that establish or undo a knockout must not look like a heal / drop. */
const hpWrites = new Set<string>();

export function isKnockoutHpWrite(actor: any): boolean {
  const key = actorKey(actor);
  return Boolean(key) && hpWrites.has(key);
}

export async function writeKnockoutHp(actor: any, value: number): Promise<void> {
  const key = actorKey(actor);
  if (!key || !actor?.update) return;
  hpWrites.add(key);
  try {
    await actor.update({ "system.attributes.hp.value": value });
  } finally {
    hpWrites.delete(key);
  }
}

function effectHasUnconscious(effect: any): boolean {
  const statuses = effect?.statuses;
  if (!statuses) return false;
  if (typeof statuses.has === "function") return statuses.has("unconscious");
  if (Array.isArray(statuses)) return statuses.includes("unconscious");
  return false;
}

function maybeWakeFromUnconscious(
  effect: any,
  wake: (actor: any) => Promise<unknown>,
  why: string,
): void {
  try {
    if (!isPrimaryGM()) return;
    const actor = effect?.parent;
    if (!actor || !isKnockedOut(actor) || !effectHasUnconscious(effect)) return;
    void Promise.resolve(wake(actor)).catch((err) => {
      log(`knockout: wake after Unconscious ${why} failed:`, err);
    });
  } catch (err) {
    log(`knockout: ${why} failed:`, err);
  }
}

/**
 * When the one-hour Unconscious stamp expires (or a GM clicks it off), wake them.
 * Primary GM only — the hook fires everywhere. Expiry may delete or only disable.
 */
export function registerKnockoutWatch(wake: (actor: any) => Promise<unknown>): void {
  Hooks.on("deleteActiveEffect", (effect: any) => {
    maybeWakeFromUnconscious(effect, wake, "ended");
  });
  Hooks.on("updateActiveEffect", (effect: any, changes: any) => {
    const expired =
      changes?.disabled === true ||
      changes?.["duration.expired"] === true ||
      changes?.duration?.expired === true;
    if (!expired && !effect?.disabled && !effect?.duration?.expired) return;
    if (effect?.disabled || effect?.duration?.expired || expired) {
      maybeWakeFromUnconscious(effect, wake, "expired");
    }
  });
}

/** Stamp the Unconscious effect to one hour. Missing effect is logged, not thrown. */
export async function stampKnockoutHour(actor: any): Promise<boolean> {
  const effect = effectForStatus(actor, "unconscious");
  if (!effect) {
    log(`knockout: ${String(actor?.name)} has no Unconscious effect to stamp`);
    return false;
  }
  const payload = durationPayload(
    { value: KNOCKOUT_HOURS, units: "hours" },
    undefined,
    worldOf({ target: { actor } }),
  );
  return stampDuration(effect, payload);
}
