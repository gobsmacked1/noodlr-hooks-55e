// Later-turn damage on a concentration bolt (Witch Bolt), and who it is still on.
//
// The first hit names a creature. The later Damage activity names nobody, so
// auto-apply reads `NoTargets` and the AA beam is the only thing still up.
// Inherit the last attack's target from that item; on later turns of the
// caster, use the follow-on activity on the owner's client.

import { log } from "../constants";
import { isDnd5e } from "../system/dnd5e-rewards";
import { followOnDamageOf, isFollowOnDamage } from "../system/dnd5e-ongoing";
import { concentratingOn, concentrationDurationOf } from "../capability/live-item";
import { isRollerFor } from "../util/gm";
import { shouldAutomate } from "../tactics/registry";
import { itemOf, readHits, rollType, targetsOf, type CardTarget } from "./cards";

export { isFollowOnDamage };

let lastNote = "ongoing: no follow-on damage has been settled this session";

function note(line: string): void {
  lastNote = line;
  log(line);
}

function sameItem(a: any, b: any): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const aId = String(a.id ?? "");
  const bId = String(b.id ?? "");
  if (aId && aId === bId) return true;
  const aUuid = String(a.uuid ?? "");
  const bUuid = String(b.uuid ?? "");
  return Boolean(aUuid) && aUuid === bUuid;
}

/** Last attack from this item that named someone — preferably the ones that hit. */
export function inheritFollowOnTargets(item: any, _message?: any): CardTarget[] {
  const messages: any[] = (globalThis as any).game?.messages?.contents ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (rollType(m) !== "attack") continue;
    if (!sameItem(itemOf(m), item)) continue;
    const reading = readHits(m);
    if (reading.hits.length) {
      return reading.hits.map((doc: any) => ({
        name: String(doc?.name ?? "?"),
        uuid: String(doc?.uuid ?? ""),
        ac: null,
      }));
    }
    const named = targetsOf(m);
    if (named.length) return named;
  }
  return [];
}

function startedThisTurn(actor: any, item: any, combat: any): boolean {
  const dur = concentrationDurationOf(actor, item);
  if (!dur || !combat) return false;
  const round = Number(dur.startRound ?? dur.start?.round);
  const turn = Number(dur.startTurn ?? dur.start?.turn);
  return Number.isFinite(round) && round === Number(combat.round) && Number.isFinite(turn) && turn === Number(combat.turn);
}

async function maybeUseOngoing(combat: any): Promise<void> {
  const combatant = combat?.combatant;
  const actor = combatant?.actor;
  if (!actor || !isRollerFor(actor)) return;
  if (shouldAutomate(combatant)) return;
  const held: any[] = [...(actor.concentration?.items ?? [])];
  for (const item of held) {
    if (!concentratingOn(actor, item)) continue;
    const activity = followOnDamageOf(item);
    if (!activity) continue;
    if (startedThisTurn(actor, item, combat)) {
      note(`ongoing: ${item.name} started this turn — waiting`);
      continue;
    }
    if (typeof activity.use !== "function") continue;
    try {
      note(`ongoing: ${actor.name} continues ${item.name}`);
      await activity.use({ configure: false }, { configure: false });
    } catch (err) {
      log(`ongoing: ${actor.name} could not continue ${item.name}:`, err);
    }
  }
}

export function registerOngoing(): void {
  if (!isDnd5e()) return;
  Hooks.on("updateCombat", (combat: any, changed: any) => {
    try {
      if (!combat?.started) return;
      if (!("turn" in (changed ?? {})) && !("round" in (changed ?? {}))) return;
      void maybeUseOngoing(combat);
    } catch (err) {
      log("ongoing:", err);
    }
  });
}

export function surveyOngoing(): { report: string } {
  log(lastNote);
  return { report: lastNote };
}
