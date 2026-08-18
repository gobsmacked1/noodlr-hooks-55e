// Skip the system's roll-configuration dialogs on a turn nobody is sitting in front of.
//
// dnd5e's AttackActivity#_triggerSubsequentActions calls `rollAttack` with an empty dialog
// config after `activity.use()`. `D20Roll.applyKeybindings` then sets `dialog.configure`
// unless a skip-dialog key was held — so a planned Light Crossbow posts its usage card and
// waits on the Attack Roll window. That is what "the Assassin needed a GM to roll" was
// (2026-08-18). It is a different bug from the Hold Person save gate: the save never
// started; the attack started and then paused for a human.
//
// THE SUBSEQUENT CALL IS ALSO NOT AWAITED. `Activity#use` returns as soon as the usage
// card exists, so `duringAutomation` can drop to zero before the attack dialog is built.
// The hook therefore cannot rely on that flag alone: it also asks whether we are playing
// this creature. A player's own roll is never touched.

import { log } from "../constants";
import { isAutomating } from "../rules/economy/enforce";
import { shouldAutomate } from "./registry";

export function skipRollDialogWhen(input: {
  automating: boolean;
  hasPlayerOwner: boolean;
  automatedCombatant: boolean;
}): boolean {
  if (input.hasPlayerOwner) return false;
  return input.automating || input.automatedCombatant;
}

function actorOf(config: any): any {
  return config?.subject?.actor ?? config?.subject?.item?.actor ?? null;
}

function actorIsAutomated(actor: any): boolean {
  if (!actor) return false;
  const combat: any = game.combat;
  const combatant = (combat?.combatants ?? []).find?.(
    (c: any) => c?.actor === actor || String(c?.actor?.id ?? "") === String(actor.id ?? ""),
  );
  return Boolean(combatant && shouldAutomate(combatant));
}

function silenceDialog(config: any, dialog: any): void {
  if (!dialog) return;
  const actor = actorOf(config);
  if (
    !skipRollDialogWhen({
      automating: isAutomating(),
      hasPlayerOwner: Boolean(actor?.hasPlayerOwner),
      automatedCombatant: actorIsAutomated(actor),
    })
  ) {
    return;
  }
  dialog.configure = false;
}

export function registerAutoRoll(): void {
  // One hook each, not the V2 twin — both fire for the same roll (`basic-roll.mjs`), and
  // setting `configure` twice is harmless but listening twice is the rollSkill trap.
  Hooks.on("dnd5e.preRollAttack", (config: any, dialog: any) => {
    try {
      silenceDialog(config, dialog);
    } catch (err) {
      log("auto-roll: preRollAttack failed:", err);
    }
  });
  Hooks.on("dnd5e.preRollDamage", (config: any, dialog: any) => {
    try {
      silenceDialog(config, dialog);
    } catch (err) {
      log("auto-roll: preRollDamage failed:", err);
    }
  });
}
