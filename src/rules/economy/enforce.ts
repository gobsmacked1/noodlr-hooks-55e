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
import { speakerFor } from "../../util/speaker";
import { getEconomyMode, isConditionAutomationEnabled } from "../../settings";
import { shouldAutomate } from "../../tactics/registry";
import { ac5eOwnsIncapacitatedUse, isIncapacitated } from "../../system/dnd5e-conditions";
import { isDashActivity } from "../../system/dnd5e-dash";
import { actionDeclarationOf } from "../../system/dnd5e-declarations";
import { damageRiderOf } from "../../system/dnd5e-riders";
import { isDnd5e } from "../../system/dnd5e-rewards";
import { lightExtraAttackCost } from "../../system/dnd5e-two-weapon";
import { interceptHideActivity } from "../hide";
import { interceptStabilizeActivity } from "../dying";
import { interceptInfluenceActivity } from "../influence";
import { holdForCounterspell, useReplay } from "../counterspell";
import { captureReadied, interceptReadyActivity } from "../ready";
import { check, lightSwings, slotFor, spend, takeDash, takeLightSwing, type Slot } from "./ledger";

/** Uses already approved by their owner, waiting to come back round through the hook. */
const cleared = new Set<string>();

/**
 * Let one use through untouched.
 *
 * The Ready action's release is the caller: the Reaction was billed when the trigger fired, and the held
 * activity still claims whatever its sheet says it claims — usually an Action, which on somebody else's
 * turn would be checked against the tally from the turn the creature spent readying and refused as over
 * budget. Same `cleared` bookkeeping as the over-budget approval and Counterspell's replay, exposed
 * rather than duplicated for the reason stated on `replayCleared`.
 */
export function clearNextUse(activity: any): void {
  const key = String(activity?.uuid ?? "");
  if (!key) return;
  cleared.add(key);
  setTimeout(() => cleared.delete(key), 10000);
}

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
  // Counterspell's window cancels a cast and resumes it if nobody counters, and the resumed cast must not be
  // charged a second time. `cleared` is the only thing that can express that, and it lives here — so the
  // replay is handed over rather than the set being exported for somebody else to write into.
  useReplay(replayCleared);

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

/**
 * Take the slot, and record what it bought.
 *
 * Everything goes through `spend` except a Dash, which has to be recorded as a Dash so that the movement
 * cap knows the extra Speed has already been paid for. Without this the two layers charge separately for
 * one Dash: pressing the button spends the slot, and then the movement it was bought for spends another —
 * which for a rogue means Cunning Action takes its bonus action AND its Action (census, 2026-08-07).
 */
function charge(
  actor: any,
  combat: any,
  combatant: any,
  slot: Slot,
  isAttack: boolean,
  activity: any,
): void {
  if (slot !== "reaction" && isDashActivity(activity?.item, activity)) {
    takeDash(actor, combat, combatant, slot);
    log(`action economy: charged ${combatant?.name}'s ${slot} for a Dash`);
    return;
  }
  spend(actor, combat, combatant, slot, isAttack);
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

  // A Ready declaration is waiting for its second half: the player has been asked what they are holding,
  // and the next thing they press from the sheet is the answer rather than a use. Checked before every
  // other rule here, including the rider and Incapacitated ones, because none of them are about to
  // happen — the activity is being NAMED, not used.
  if (captureReadied(activity)) return false;

  // Extra damage on a hit that has already happened is not a second action. Checked before everything
  // else, including the Incapacitated refusal: a rider is never used on its own, so if the attack it
  // rides on was legal then so is it, and there is nothing here worth having an opinion about.
  //
  // Sneak Attack is why this is here. A rogue hit, was offered its Sneak Attack, and was told it had
  // already used its action — because something in that world had given the feature a real activation,
  // which stock dnd5e does not. See `system/dnd5e-riders.ts` for why this is a table and not a rule.
  const rider = damageRiderOf(activity?.item, activity);
  if (rider) {
    log(`action economy: ${rider} is extra damage, not an action; not counted`);
    return true;
  }

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
      game.i18n.format("NOODLRHOOKS.Combat.Conditions.Incapacitated", { name }),
    );
    return false;
  }

  // Three of the PHB action items are our own rules under another name, so each is handed over rather
  // than charged: the rule runs the prerequisites, rolls, and bills the slot itself. Charging here as
  // well would be the Dash double-charge again, from the other direction — which is also why the
  // hand-over lives inside this one function rather than in a second `preUseActivity` listener, where
  // the outcome would depend on which module registered first.
  //
  // AFTER the Incapacitated refusal, so a stunned creature is stopped at the button; BEFORE the slot
  // lookup below, because a sheet that gives one of these an activation this module does not price
  // would otherwise skip the hand-over and quietly go back to doing nothing.
  if (interceptHideActivity(activity)) return false;
  if (interceptStabilizeActivity(activity)) return false;
  if (interceptInfluenceActivity(activity)) return false;
  if (interceptReadyActivity(activity)) return false;

  const slot = slotFor(activity?.activation?.type);
  if (!slot) return true;

  // Two of the 2024 PHB action items only announce what is coming: pressing Attack is followed by the
  // weapon, pressing Magic by the spell, and each of those claims an Action of its own. Charging both is
  // how one swing cost two Actions. Charged by the follow-through, not here — see
  // `system/dnd5e-declarations.ts` for which buttons are announcements and which are the whole action.
  //
  // Checked AFTER the Incapacitated refusal, unlike a damage rider: a rider only ever follows an attack
  // that was already allowed, while a declaration precedes one, so a stunned creature should be told no
  // at the button as well as at the swing.
  const declared = actionDeclarationOf(activity?.item, activity);
  if (declared) {
    log(`action economy: ${declared} declares an action; whatever follows pays for it`);
    return true;
  }

  // Outside a fight there is no turn to be over budget in, and nothing here should touch downtime.
  const combat: any = game.combat;
  if (!combat?.started) return true;

  const combatant = combatantFor(combat, actor);
  if (!combatant) return true;

  const isAttack = String(activity?.type ?? "") === "attack";
  let effective = slot;
  let verdict = check(actor, combat, combatant, slot, isAttack);

  // The off-hand swing, considered only once the Attack action has nothing left in it. A Light weapon
  // buys one extra attack per turn out of the bonus action — or out of nothing at all with the Nick
  // mastery — and dnd5e models neither, so both swings arrive here claiming the same Action and the
  // second was refused. See `system/dnd5e-two-weapon.ts` for why asking at the point of refusal is what
  // keeps this a narrow reading rather than a guess about every Light attack ever made.
  if (!verdict.allowed && slot === "action" && isAttack) {
    const cost = lightExtraAttackCost(actor, activity?.item, activity);
    if (cost && lightSwings(actor, combat, combatant) < 1) {
      if (cost === "free") {
        takeLightSwing(actor, combat, combatant, null);
        log(`action economy: ${combatant?.name}'s Nick attack rides on the Attack action`);
        return true;
      }
      const bonus = check(actor, combat, combatant, "bonus", false);
      if (bonus.allowed) {
        takeLightSwing(actor, combat, combatant, "bonus");
        log(`action economy: charged ${combatant?.name}'s bonus action for the Light extra attack`);
        return true;
      }
      // Out of bonus actions as well. Reported against the bonus action from here on, because that is
      // the slot the swing actually wanted and naming the Action would send the player looking in the
      // wrong place.
      effective = "bonus";
      verdict = bonus;
    }
  }

  if (verdict.allowed) {
    charge(actor, combat, combatant, slot, isAttack, activity);
    // Counterspell's window, and the placement is the whole of its resource clause. The Action has just been
    // charged, which is exactly what a countered caster loses; the veto that follows precedes dnd5e's
    // consumption step, so the slot is never spent, which is exactly what 2024 says they keep. Held here
    // rather than earlier so a cast that was never legal is refused outright instead of being offered up to
    // be countered, and here rather than in a second `preUseActivity` listener for the reason above.
    if (holdForCounterspell(activity, usageConfig, dialogConfig, messageConfig)) return false;
    return true;
  }

  // An attack rerouted to the bonus action is no longer spending the Attack action's allowance, so it
  // must not be recorded as one either — otherwise approving it would eat a swing the creature still has.
  const chargeAsAttack = isAttack && effective === "action";

  // Noodlr playing a monster gets no say and no dialog: there is nobody to answer it.
  if (isAutomating() || (shouldAutomate(combatant) && !actor?.hasPlayerOwner)) {
    log(`action economy: ${combatant?.name} has no ${label(effective)} left; the use was refused`);
    return false;
  }

  const mode = getEconomyMode(actor);
  if (mode === "off") {
    charge(actor, combat, combatant, effective, chargeAsAttack, activity);
    return true;
  }

  if (mode === "block" && !game.user?.isGM) {
    ui.notifications?.warn(
      game.i18n.format("NOODLRHOOKS.Combat.Economy.Blocked", {
        name: String(actor?.name ?? "This creature"),
        slot: label(effective),
      }),
    );
    return false;
  }

  void askThenRetry(activity, usageConfig, dialogConfig, messageConfig, {
    actor,
    combat,
    combatant,
    slot: effective,
    isAttack: chargeAsAttack,
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
    ? game.i18n.localize("NOODLRHOOKS.Combat.Economy.Attack")
    : label(over.slot);
  const proceed = await confirm(
    game.i18n.localize("NOODLRHOOKS.Combat.Economy.Title"),
    game.i18n.format("NOODLRHOOKS.Combat.Economy.Ask", {
      name: String(over.actor?.name ?? "This creature"),
      slot: what,
      spent: String(over.spent),
      max: String(over.max),
      activity: String(activity?.name ?? activity?.item?.name ?? "this"),
    }),
  );
  if (!proceed) return;

  charge(over.actor, over.combat, over.combatant, over.slot, over.isAttack, activity);
  await announce(over, activity, what);
  await replayCleared(activity, usageConfig, dialogConfig, messageConfig);
}

/**
 * Run a use that has already been paid for, so this layer waves it through.
 *
 * Shared by the over-budget approval and by Counterspell's window: both cancel a use, decide something about
 * it, and then let the original happen. A second copy of the `cleared` bookkeeping is how the two would
 * eventually disagree about whether the retry gets charged.
 */
async function replayCleared(
  activity: any,
  usageConfig: any,
  dialogConfig: any,
  messageConfig: any,
): Promise<void> {
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
        `<p><strong>${esc(game.i18n.localize("NOODLRHOOKS.Combat.Economy.Override"))}</strong> ` +
        game.i18n.format("NOODLRHOOKS.Combat.Economy.Logged", {
          name: esc(name),
          slot: esc(what),
          activity: esc(used),
          user: esc(String(game.user?.name ?? "")),
        }) +
        `</p>`,
      speaker: speakerFor(over.actor, name),
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
          yes: { label: game.i18n.localize("NOODLRHOOKS.Combat.Economy.Continue") },
          no: { label: game.i18n.localize("NOODLRHOOKS.Combat.Economy.Abort"), default: true },
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
      ? "NOODLRHOOKS.Combat.Economy.Action"
      : slot === "bonus"
        ? "NOODLRHOOKS.Combat.Economy.Bonus"
        : "NOODLRHOOKS.Combat.Economy.Reaction",
  );
}
