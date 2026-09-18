// Later-turn damage on a concentration bolt (Witch Bolt), and who it is still on.
//
// The first hit names a creature. The later Damage activity names nobody, so
// auto-apply reads `NoTargets` and the AA beam is the only thing still up.
// Inherit the last attack's target from that item.
//
// The 1d12 is a Bonus Action the caster MAY take. Auto-firing it at the START
// of their turn spent that bonus before they could Misty Step (Empowered Sorc,
// 2026-09-17). Fire when their turn ENDS, and only if the bonus is still free.
//
// Printed Witch Bolt ends if they use their Action to do anything else. A killed
// target is how the table expects the beam to drop — dnd5e does not, and AA's
// concentration-delete listener often misses a Sequencer persistent that failed
// to decode. We end the spell and mop the persistents.

import { log } from "../constants";
import { isDnd5e } from "../system/dnd5e-rewards";
import { actionDeclarationOf } from "../system/dnd5e-declarations";
import {
  followOnDamageOf,
  followOnTargetOut,
  isFollowOnDamage,
  killFollowOnAnims,
  otherActionEndsFollowOn,
  shouldContinueFollowOn,
  startedOnSlot,
} from "../system/dnd5e-ongoing";
import { concentratingOn, concentrationDurationOf } from "../capability/live-item";
import { isRollerFor } from "../util/gm";
import { shouldAutomate } from "../tactics/registry";
import { check } from "./economy/ledger";
import { endConcentrationOn } from "./concentration";
import { itemOf, readHits, rollType, targetsOf, tokenFromTargetUuid, type CardTarget } from "./cards";

export { isFollowOnDamage };

let lastNote = "ongoing: no follow-on damage has been settled this session";

type SlotStamp = { combatId: string; combatantId: string; round: number; turn: number };

let prevSlot: SlotStamp | null = null;

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

function reason(key: string, fallback: string): string {
  const i18n = (globalThis as any).game?.i18n;
  return i18n?.localize?.(key) || fallback;
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

function targetStatus(target: CardTarget): {
  missing?: boolean;
  defeated?: boolean;
  dead?: boolean;
  hp?: number | null;
} {
  const token = tokenFromTargetUuid(target.uuid);
  const actor = token?.actor ?? token;
  if (!token && !actor) return { missing: true };
  const statuses: any = actor?.statuses;
  const has = (id: string): boolean =>
    typeof statuses?.has === "function" ? statuses.has(id) : Array.isArray(statuses) && statuses.includes(id);
  const hpRaw = actor?.system?.attributes?.hp?.value;
  const hp = Number(hpRaw);
  return {
    defeated: Boolean(token?.combatant?.defeated || token?.document?.combatant?.defeated),
    dead: has("dead") || has("defeated"),
    hp: Number.isFinite(hp) ? hp : null,
  };
}

function followOnTargetsGone(item: any): boolean {
  const named = inheritFollowOnTargets(item);
  if (!named.length) return false;
  return named.every((t) => followOnTargetOut(targetStatus(t)));
}

function heldFollowOns(actor: any): any[] {
  const held: any[] = [...(actor?.concentration?.items ?? [])];
  return held.filter((item) => concentratingOn(actor, item) && followOnDamageOf(item));
}

async function dropFollowOn(actor: any, item: any, why: string, fallback: string): Promise<void> {
  note(`ongoing: ${item?.name ?? "follow-on"} ends — ${why}`);
  await endConcentrationOn(actor, item, reason(why, fallback));
  killFollowOnAnims(actor, item);
}

async function dropIfTargetGone(actor: any): Promise<boolean> {
  let dropped = false;
  for (const item of heldFollowOns(actor)) {
    if (!followOnTargetsGone(item)) continue;
    await dropFollowOn(
      actor,
      item,
      "NOODLRHOOKS.Combat.Concentration.Reason.TargetGone",
      "the target was slain",
    );
    dropped = true;
  }
  return dropped;
}

function bonusFree(actor: any, combat: any, combatant: any): boolean {
  try {
    return check(actor, combat, combatant, "bonus", false).allowed;
  } catch {
    return true;
  }
}

async function maybeContinueEnded(combatant: any, combat: any, slot: SlotStamp): Promise<void> {
  const actor = combatant?.actor;
  if (!actor || !isRollerFor(actor)) return;
  if (shouldAutomate(combatant)) return;
  if (await dropIfTargetGone(actor)) return;
  for (const item of heldFollowOns(actor)) {
    const activity = followOnDamageOf(item);
    if (!activity || typeof activity.use !== "function") continue;
    const start = concentrationDurationOf(actor, item);
    if (
      !shouldContinueFollowOn({
        startedThisSlot: startedOnSlot(start, slot),
        targetOut: followOnTargetsGone(item),
        bonusFree: bonusFree(actor, combat, combatant),
      })
    ) {
      note(`ongoing: ${actor.name} kept the bonus — ${item.name} waits`);
      continue;
    }
    try {
      note(`ongoing: ${actor.name} continues ${item.name}`);
      await activity.use({ configure: false }, { configure: false });
    } catch (err) {
      log(`ongoing: ${actor.name} could not continue ${item.name}:`, err);
    }
  }
}

function onTurnAdvanced(combat: any, changed: any): void {
  if (!combat?.started) return;
  if (!("turn" in (changed ?? {})) && !("round" in (changed ?? {}))) return;
  const ended = prevSlot && prevSlot.combatId === String(combat.id ?? "") ? prevSlot : null;
  prevSlot = {
    combatId: String(combat.id ?? ""),
    combatantId: String(combat.combatant?.id ?? ""),
    round: Number(combat.round ?? 0),
    turn: Number(combat.turn ?? 0),
  };
  if (!ended?.combatantId) return;
  const endedCombatant =
    combat.combatants?.get?.(ended.combatantId) ??
    combat.combatants?.find?.((c: any) => String(c?.id ?? "") === ended.combatantId);
  if (!endedCombatant) return;
  void maybeContinueEnded(endedCombatant, combat, ended);
}

function onOtherAction(activity: any): void {
  const actor = activity?.actor ?? activity?.item?.actor;
  if (!actor || !isRollerFor(actor)) return;
  const used = activity?.item;
  for (const held of heldFollowOns(actor)) {
    if (
      !otherActionEndsFollowOn({
        activationType: activity?.activation?.type,
        declaration: Boolean(actionDeclarationOf(used, activity)),
        usedItem: used,
        heldItem: held,
      })
    ) {
      continue;
    }
    void dropFollowOn(
      actor,
      held,
      "NOODLRHOOKS.Combat.Concentration.Reason.OtherAction",
      "they used their Action on something else",
    );
  }
}

function itemFromConcentrationEffect(actor: any, effect: any): any {
  const flagged = effect?.flags?.dnd5e?.item ?? effect?.getFlag?.("dnd5e", "item");
  const uuid = typeof flagged === "string" ? flagged : String(flagged?.uuid ?? flagged?.data?.uuid ?? "");
  if (uuid) {
    try {
      const doc = (globalThis as any).fromUuidSync?.(uuid);
      if (doc) return doc;
    } catch {
      /* resolve from the actor next */
    }
  }
  const id = String(flagged?.id ?? flagged?._id ?? flagged?.data?._id ?? "");
  if (id && actor?.items?.get) return actor.items.get(id) ?? null;
  const origin = String(effect?.origin ?? "");
  if (origin && actor?.items) {
    const list: any[] = [...(actor.items ?? [])];
    return list.find((it) => String(it?.uuid ?? "") === origin) ?? null;
  }
  return null;
}

function mopPersistents(actor: any, effect: any): void {
  const item = itemFromConcentrationEffect(actor, effect);
  if (item && !followOnDamageOf(item)) return;
  killFollowOnAnims(actor, item, String(effect?.origin ?? ""));
}

export function registerOngoing(): void {
  if (!isDnd5e()) return;
  const game = (globalThis as any).game;
  for (const actor of game?.actors ?? []) {
    try {
      if (!isRollerFor(actor)) continue;
      void dropIfTargetGone(actor);
      for (const item of actor.items ?? []) {
        if (!followOnDamageOf(item)) continue;
        if (concentratingOn(actor, item)) continue;
        killFollowOnAnims(actor, item);
      }
    } catch {
      /* catch-up must not block ready */
    }
  }
  Hooks.on("updateCombat", (combat: any, changed: any) => {
    try {
      onTurnAdvanced(combat, changed);
    } catch (err) {
      log("ongoing:", err);
    }
  });
  Hooks.on("deleteCombat", (combat: any) => {
    try {
      prevSlot = null;
      for (const c of combat?.combatants ?? []) {
        const actor = c?.actor;
        if (!actor || !isRollerFor(actor)) continue;
        void dropIfTargetGone(actor);
      }
    } catch (err) {
      log("ongoing:", err);
    }
  });
  Hooks.on("updateActor", (_actor: any, changed: any) => {
    try {
      const hp = changed?.system?.attributes?.hp;
      if (hp === undefined && changed?.system?.attributes === undefined) return;
      const game = (globalThis as any).game;
      const pool = game?.combat?.started
        ? [...(game.combat.combatants ?? [])].map((c: any) => c?.actor)
        : [...(game?.actors ?? [])];
      for (const other of pool) {
        if (!other || !isRollerFor(other)) continue;
        if (!heldFollowOns(other).length) continue;
        void dropIfTargetGone(other);
      }
    } catch (err) {
      log("ongoing:", err);
    }
  });
  Hooks.on("dnd5e.postUseActivity", (activity: any) => {
    try {
      onOtherAction(activity);
    } catch (err) {
      log("ongoing:", err);
    }
  });
  Hooks.on("dnd5e.endConcentration", (actor: any, effect: any) => {
    try {
      mopPersistents(actor, effect);
    } catch (err) {
      log("ongoing:", err);
    }
  });
}

export function surveyOngoing(): { report: string } {
  log(lastNote);
  return { report: lastNote };
}
