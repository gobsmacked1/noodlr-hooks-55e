// Roll a spent Recharge 5–6 at the start of an NPC's turn.
//
// dnd5e already does this (`UsesField.rollRecharge`, called from `recoverUses` when
// `autoRecharge !== "no"`), and it ships that switch OFF and hidden (`config: false`, Combat
// Settings → Monsters). A spent breath then stays spent for the rest of the fight, and the planner
// correctly stops offering it — which reads as the planner having forgotten the dragon can breathe.
//
// We do not write dnd5e's setting. Writing another module's settings is how two modules become
// impossible to reason about, and yes-versus-silent is a real preference. This file is our own
// switch, default `silent`, calling the system's own roller so the die, the card and the spend
// update are theirs. When theirs is already on we stand aside: two d6s on a failure would let the
// second succeed where the first did not.
//
// NPCs only, matching dnd5e. A PC with a recharge item is rare and the printed rule is a GM roll.

import { getAutoRecharge, type AutoRechargeMode } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import { isPrimaryGM } from "../util/gm";
import { log, warn } from "../constants";

export type RechargeDecision =
  | { roll: false; reason: string }
  | { roll: true; announce: boolean; reason: string };

/**
 * Who would roll, given only the two switches and the event.
 *
 * Exported so a test can pin the stand-aside without a Foundry combat. `systemMode` is what
 * `dnd5e.autoRecharge` currently holds, or `null` when that setting cannot be read — unreadable
 * is treated as "they might already be rolling", because a double die is the destructive failure.
 */
export function decideRecharge(input: {
  ourMode: AutoRechargeMode;
  systemMode: string | null;
  isNpc: boolean;
  periods: readonly string[];
}): RechargeDecision {
  if (!input.periods.includes("turnStart")) {
    return { roll: false, reason: "not the start of this creature's turn" };
  }
  if (!input.isNpc) {
    return { roll: false, reason: "recharge is an NPC recovery, matching dnd5e" };
  }
  if (systemOwnsMode(input.systemMode)) {
    return { roll: false, reason: "dnd5e autoRecharge is already rolling it" };
  }
  if (input.ourMode === "no") {
    return { roll: false, reason: "this module's recharge switch is off" };
  }
  return {
    roll: true,
    announce: input.ourMode === "yes",
    reason: input.ourMode === "yes" ? "announce" : "silent",
  };
}

function systemOwnsMode(systemMode: string | null): boolean {
  // null = could not read. Standing aside is the recoverable direction: one missed recharge is a
  // breath the GM can press; two dice on a failure is a recharge nobody earned.
  if (systemMode === null) return true;
  return systemMode === "yes" || systemMode === "silent";
}

/** Is dnd5e's own Auto-recharge already doing this? */
export function systemOwnsRecharge(): boolean {
  return systemOwnsMode(readSystemRecharge());
}

function readSystemRecharge(): string | null {
  try {
    return String(game.settings.get("dnd5e", "autoRecharge"));
  } catch {
    return null;
  }
}

function isNpc(actor: any): boolean {
  if (actor?.system?.isNPC === true) return true;
  return String(actor?.type ?? "") === "npc";
}

/**
 * Item or Activity documents that currently have a spent recharge recovery.
 *
 * Walks both levels because dnd5e stores the die on either: a breath is usually the item, a
 * multi-activity feature can put it on one activity. `uses.spent` is the same gate
 * `UsesField.rollRecharge` uses — a charged ability is not rolled.
 */
export function rechargeSubjects(actor: any): any[] {
  const out: any[] = [];
  for (const item of actor?.items ?? []) {
    if (hasSpentRecharge(item.system?.uses ?? item.uses)) out.push(item);
    for (const activity of activitiesOf(item)) {
      if (hasSpentRecharge(activity.uses ?? activity.system?.uses)) out.push(activity);
    }
  }
  return out;
}

function activitiesOf(item: any): any[] {
  const acts = item?.system?.activities ?? item?.activities;
  if (!acts) return [];
  if (typeof acts[Symbol.iterator] === "function") return [...acts];
  if (typeof acts.contents !== "undefined") return [...(acts.contents ?? [])];
  return Object.values(acts);
}

function hasSpentRecharge(uses: any): boolean {
  if (!uses || !uses.spent) return false;
  const recovery = uses.recovery;
  if (!Array.isArray(recovery)) return false;
  return recovery.some((row: any) => row?.period === "recharge");
}

async function rollSubject(subject: any, announce: boolean): Promise<void> {
  const method = subject?.system?.uses?.rollRecharge ?? subject?.uses?.rollRecharge;
  if (typeof method !== "function") return;
  await method.call(subject, {}, { configure: false }, { create: announce });
}

const seen = new Set<string>();

function stampOf(combatant: any): string {
  const combat = combatant?.combat ?? game.combat;
  return `${String(combat?.id ?? "?")}:${String(combat?.round ?? 0)}:${String(combat?.turn ?? 0)}:${String(combatant?.id ?? "?")}`;
}

function firstTime(stamp: string): boolean {
  if (seen.has(stamp)) return false;
  seen.add(stamp);
  if (seen.size > 64) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

async function recover(combatant: any, periods: readonly string[]): Promise<void> {
  if (!isPrimaryGM() || !isDnd5e()) return;
  const actor = combatant?.actor;
  const decision = decideRecharge({
    ourMode: getAutoRecharge(),
    systemMode: readSystemRecharge(),
    isNpc: isNpc(actor),
    periods,
  });
  if (!decision.roll) return;
  if (!firstTime(stampOf(combatant))) return;

  const subjects = rechargeSubjects(actor);
  if (subjects.length === 0) return;

  for (const subject of subjects) {
    try {
      await rollSubject(subject, decision.announce);
    } catch (err) {
      warn("recharge: could not roll", subject?.name ?? subject?.id, err);
    }
  }
}

/**
 * Listen after dnd5e's own combat recovery, so a world that turned theirs on has already rolled
 * and we see `uses.spent === 0` even if the stand-aside were ever skipped.
 */
export function registerRecharge(): void {
  Hooks.on("dnd5e.postCombatRecovery", (combatant: any, periods: string[]) => {
    void recover(combatant, Array.isArray(periods) ? periods : []).catch((err) => {
      log("recharge: postCombatRecovery failed:", err);
    });
  });
  Hooks.on("deleteCombat", () => seen.clear());
}

/** Flat report: who would roll, and what on the selected creature is spent. */
export function surveyRecharge(): Record<string, unknown> {
  const our = getAutoRecharge();
  const system = readSystemRecharge();
  const actor = (canvas as any)?.tokens?.controlled?.[0]?.actor ?? null;
  const subjects = actor ? rechargeSubjects(actor) : [];
  const decision = decideRecharge({
    ourMode: our,
    systemMode: system,
    isNpc: isNpc(actor),
    periods: ["turnStart"],
  });
  const lines = [
    `ours: ${our}`,
    `dnd5e.autoRecharge: ${system ?? "unreadable"}`,
    `owner: ${systemOwnsRecharge() ? "dnd5e" : our === "no" ? "nobody" : "us"}`,
    actor
      ? `${actor.name}: ${decision.roll ? `would roll (${decision.reason})` : decision.reason}`
      : "select a token",
    ...subjects.map((s) => {
      const uses = s.system?.uses ?? s.uses;
      return `  ${s.name ?? s.id}: spent ${uses?.spent ?? "?"} / ${uses?.max ?? "?"}`;
    }),
  ];
  const report = lines.join("\n");
  log(report);
  return { our, system, decision, subjects: subjects.length, report };
}
