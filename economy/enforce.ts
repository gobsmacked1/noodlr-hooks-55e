// Stopping a creature spending an action it does not have.
//
// The veto point is dnd5e's own `dnd5e.preUseActivity` hook, which fires before the usage dialog and
// before any chat card, and cancels the use cleanly when a handler returns false (verified in 5.3.3,
// `Activity#use`). Nothing is patched and no other module's pipeline is displaced, which matters because
// midi-qol's activity `use()` calls `super.use()` and so runs this hook too — the same veto works with
// midi, without midi, and alongside anything else listening on it.
//
// WHO GETS STOPPED, AND HOW HARD. Three audiences, deliberately not treated alike (user, 2026-08-05):
//
//   Creatures Noodlr is playing are hard-blocked, always. Automation that cheats is worse than no
//   automation, because nobody at the table is watching the monster's turn closely enough to catch it.
//
//   Players are governed by a GM setting: hard-block, or prompt. Prompt is the default and the
//   interesting one — it asks, and then writes every "continue" to the public chat log. That shape was
//   chosen over a straight block because the rules are full of features that legitimately break the
//   general rule. Haste grants a whole extra action; a dozen other things grant slots the base economy
//   says you do not have. A system that cannot be overridden makes those features unusable, and one that
//   can be overridden silently gets abused. Asking in private and answering in public is what makes the
//   override safe: the table sees it, so nobody needs to police it.
//
//   The GM is never hard-blocked, only ever asked. A GM overruling the rules is not a bug to be
//   prevented, it is the job.
//
// The prompt cannot happen inside the hook, because the hook is synchronous and a dialog is not. So an
// over-budget use is cancelled first and re-issued afterwards if the answer is yes, carrying a one-shot
// token that this file recognises and consumes on the way back through.

import { log } from "../../constants";
import { getEconomyMode, isConditionAutomationEnabled } from "../config";
import { shouldAutomate } from "../auto/registry";
import { ac5eOwnsIncapacitatedUse, isIncapacitated } from "../systems/dnd5e-conditions";
import { isDnd5e } from "../systems/dnd5e-rewards";
import { check, slotFor, spend, type Slot } from "./ledger";

/** Uses already approved by their owner, waiting to come back round through the hook. */
const cleared = new Set<string>();

/** Depth counter rather than a boolean: reactions can fire while an automated turn is mid-flight. */
let automating = 0;

/**
 * Mark everything a callback does as Noodlr driving a creature, so it is held to the rules exactly.
 *
 * A counter rather than a flag because the reaction layer can resolve an opportunity attack inside
 * another creature's automated turn, and the inner call finishing must not un-mark the outer one.
 */
export async function duringAutomation<T>(fn: () => Promise<T>): Promise<T> {
  automating += 1;
  try {
    return await fn();
  } finally {
    automating -= 1;
  }
}

export function isAutomating(): boolean {
  return automating > 0;
}

export function registerEconomyHooks(): void {
  Hooks.on(
    "dnd5e.preUseActivity",
    (activity: any, usageConfig: any, dialogConfig: any, messageConfig: any) => {
      try {
        return police(activity, usageConfig, dialogConfig, messageConfig);
      } catch (err) {
        // A ledger that throws must never be the reason somebody cannot take their turn.
        log("action economy check failed; allowing the use:", err);
        return true;
      }
    },
  );
}

/** The combatant this actor is fighting as, if it is in the fight at all. */
function combatantFor(combat: any, actor: any): any {
  const uuid = String(actor?.uuid ?? "");
  const id = String(actor?.id ?? "");
  return (combat?.combatants ?? []).find?.(
    (c: any) => String(c?.actor?.uuid ?? "") === uuid || String(c?.actor?.id ?? "") === id,
  );
}

function police(activity: any, usageConfig: any, dialogConfig: any, messageConfig: any): boolean {
  const key = String(activity?.uuid ?? "");
  if (key && cleared.has(key)) {
    cleared.delete(key);
    return true;
  }

  const actor = activity?.actor;
  if (!actor) return true;

  // Incapacitated (and everything that nests it) forbids actions/bonus/reactions. Stock applies the
  // status and never consults it. Check before slot accounting so a stunned creature cannot spend
  // its one action on a swing that should never have started. Runs outside combat too — the
  // condition does not care whether initiative is up.
  //
  // This survives the AC5e stand-down that switches the rest of the condition rules off, because
  // AC5e's own refusal is gated behind a setting that ships disabled. Ours is the only one at stock
  // settings; it steps aside only once the GM has asked AC5e to enforce.
  if (
    isDnd5e() &&
    isConditionAutomationEnabled() &&
    !ac5eOwnsIncapacitatedUse() &&
    isIncapacitated(actor) &&
    slotFor(activity?.activation?.type)
  ) {
    const name = String(actor.name ?? "This creature");
    log(`conditions: ${name} is incapacitated; refused ${String(activity?.name ?? "an activity")}`);
    ui.notifications?.warn(
      game.i18n.format("NOODLR.Combat.Conditions.Incapacitated", { name }),
    );
    return false;
  }

  const slot = slotFor(activity?.activation?.type);
  if (!slot) return true;

  // Outside a fight there is no turn to be over budget in, and nothing here should touch downtime.
  const combat: any = game.combat;
  if (!combat?.started) return true;

  const combatant = combatantFor(combat, actor);
  if (!combatant) return true;

  const isAttack = String(activity?.type ?? "") === "attack";
  const verdict = check(actor, combat, combatant, slot, isAttack);

  if (verdict.allowed) {
    spend(actor, combat, combatant, slot, isAttack);
    return true;
  }

  // Noodlr playing a monster gets no say and no dialog: there is nobody to answer it.
  if (isAutomating() || (shouldAutomate(combatant) && !actor?.hasPlayerOwner)) {
    log(`action economy: ${combatant?.name} has no ${label(slot)} left; the use was refused`);
    return false;
  }

  const mode = getEconomyMode();
  if (mode === "off") {
    spend(actor, combat, combatant, slot, isAttack);
    return true;
  }

  if (mode === "block" && !game.user?.isGM) {
    ui.notifications?.warn(
      game.i18n.format("NOODLR.Combat.Economy.Blocked", {
        name: String(actor?.name ?? "This creature"),
        slot: label(slot),
      }),
    );
    return false;
  }

  void askThenRetry(activity, usageConfig, dialogConfig, messageConfig, {
    actor,
    combat,
    combatant,
    slot,
    isAttack,
    spent: verdict.spent,
    max: verdict.max,
  });
  return false;
}

interface Overrun {
  actor: any;
  combat: any;
  combatant: any;
  slot: Slot;
  isAttack: boolean;
  spent: number;
  max: number;
}

/**
 * Ask the person who clicked, and put their answer on the record.
 *
 * The retry carries a one-shot token rather than a "skip checks" setting, so an approval can only ever
 * license the single use it was given for.
 */
async function askThenRetry(
  activity: any,
  usageConfig: any,
  dialogConfig: any,
  messageConfig: any,
  over: Overrun,
): Promise<void> {
  const what = over.isAttack
    ? game.i18n.localize("NOODLR.Combat.Economy.Attack")
    : label(over.slot);
  const proceed = await confirm(
    game.i18n.localize("NOODLR.Combat.Economy.Title"),
    game.i18n.format("NOODLR.Combat.Economy.Ask", {
      name: String(over.actor?.name ?? "This creature"),
      slot: what,
      spent: String(over.spent),
      max: String(over.max),
      activity: String(activity?.name ?? activity?.item?.name ?? "this"),
    }),
  );
  if (!proceed) return;

  spend(over.actor, over.combat, over.combatant, over.slot, over.isAttack);
  await announce(over, activity, what);

  const key = String(activity?.uuid ?? "");
  if (key) {
    cleared.add(key);
    // Never left lying around: an approval that outlived its retry would license an unrelated use later.
    setTimeout(() => cleared.delete(key), 10000);
  }
  try {
    await activity.use(usageConfig, dialogConfig, messageConfig);
  } catch (err) {
    log("action economy: the approved use did not resolve:", err);
  } finally {
    if (key) cleared.delete(key);
  }
}

/**
 * Say so, publicly.
 *
 * This is the entire safeguard. The override exists so that Haste and its like remain playable, and it
 * stays honest only because nobody can use it quietly.
 */
async function announce(over: Overrun, activity: any, what: string): Promise<void> {
  const ChatMessage = (globalThis as any).ChatMessage;
  const esc = foundry.utils.escapeHTML;
  const name = String(over.actor?.name ?? "Someone");
  const used = String(activity?.name ?? activity?.item?.name ?? "an ability");
  try {
    await ChatMessage.create({
      content:
        `<p><strong>${esc(game.i18n.localize("NOODLR.Combat.Economy.Override"))}</strong> ` +
        game.i18n.format("NOODLR.Combat.Economy.Logged", {
          name: esc(name),
          slot: esc(what),
          activity: esc(used),
          user: esc(String(game.user?.name ?? "")),
        }) +
        `</p>`,
      speaker: { alias: name },
    });
  } catch (err) {
    log("action economy: could not log the override to chat:", err);
  }
}

/** DialogV2 where it exists, with a plain confirm behind it so a missing API is never a hard stop. */
async function confirm(title: string, content: string): Promise<boolean> {
  const DialogV2: any = (foundry as any)?.applications?.api?.DialogV2;
  if (typeof DialogV2?.confirm === "function") {
    try {
      return Boolean(
        await DialogV2.confirm({
          window: { title },
          content: `<p>${content}</p>`,
          yes: { label: game.i18n.localize("NOODLR.Combat.Economy.Continue") },
          no: { label: game.i18n.localize("NOODLR.Combat.Economy.Abort"), default: true },
          rejectClose: false,
          modal: true,
        }),
      );
    } catch {
      return false;
    }
  }
  return false;
}

function label(slot: Slot): string {
  return game.i18n.localize(
    slot === "action"
      ? "NOODLR.Combat.Economy.Action"
      : slot === "bonus"
        ? "NOODLR.Combat.Economy.Bonus"
        : "NOODLR.Combat.Economy.Reaction",
  );
}
