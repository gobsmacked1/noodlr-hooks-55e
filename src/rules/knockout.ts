// Ask the attacker whether a qualifying killing blow knocks the target out.
//
// Dying owns the HP write and the Dead / Unconscious marks. This file owns the
// question: who is asked, on what clock, and what the card said about the swing.
// Applying Unconscious first (silent) is the caller's job — a 0 HP monster that
// is still unmarked can take a turn while the dialog is up.
//
// THE CLOCK NEVER PICKS KNOCKOUT. Timeout and a missing answer are Kill, which is
// today's behaviour. Knockout is the deliberate click. A player-character attacker
// is still asked when the GM clock is 0 (solo table / GM driving the Monk).

import { log } from "../constants";
import { isKnockoutEnabled } from "../settings";
import { rollerForActor } from "../util/gm";
import { DEFAULT_SECONDS, promptChoice } from "../util/prompt";
import { askUser, registerQuery } from "../util/queries";
import { owedSecondsFor } from "./owed-roll";
import { attackMessageOf, damageParts, rollType } from "./cards";
import { shouldAutomate } from "../tactics/registry";
import { durationPayload, worldOf } from "../capability/duration";
import { effectForStatus, stampDuration } from "../capability/timed";
import {
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
