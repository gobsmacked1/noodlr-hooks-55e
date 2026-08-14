// Turning a decision into something that happens on the table.
//
// The planner decides; this performs. Split deliberately: a wrong decision is a monster behaving oddly,
// whereas a wrong execution edits documents in someone's world, so the two failure modes get different
// blast radii and this file stays boring on purpose.
//
// Division of labour (AGENTS.md design principle #2: mechanics belong to mechanics modules):
//   - Noodlr moves the token and nominates the target.
//   - The GAME SYSTEM rolls the attack, the damage, and the saves, through its own item-use path.
//   - Midi QoL / DAE / whatever the table runs then resolves the consequences, exactly as it would if
//     the GM had clicked the button themselves. We add no rules and no arithmetic of our own.
//
// Everything is best-effort and non-fatal: an execution that fails leaves the announcement standing,
// because a GM who reads "the wolf lunges at Hobocop" and resolves it by hand has lost a click, while
// a thrown exception mid-turn loses the turn.

import { log } from "../constants";
import { moveAwayFrom, moveOffField, moveTo, moveToward } from "../core/movement";
import { duringAutomation } from "../rules/economy/enforce";
import { check, slotFor } from "../rules/economy/ledger";
import { declareReadied } from "../rules/ready";
import type { PlanOption, TurnPlan } from "./planner";

export interface Performed {
  /** Distance actually travelled, in scene units. */
  moved: number;
  /** Name of the thing that was used, when one was. */
  used?: string;
  /** Human-readable reason the mechanical part did not happen. */
  problem?: string;
}

/**
 * Nominate the target for the system's roll.
 *
 * Midi QoL and the dnd5e roll pipeline both read the ACTING USER's targets, not an argument — so
 * automation has to set them the way a GM clicking the token would, then release them afterwards to
 * avoid leaving the GM's cursor holding a selection they never made.
 */
async function withTarget<T>(tokenId: string | undefined, fn: () => Promise<T>): Promise<T> {
  const user: any = game.user;
  if (!tokenId || typeof user?.updateTokenTargets !== "function") return fn();

  const previous = Array.from((user.targets ?? []) as Set<any>).map(
    (t: any) => t?.id ?? t?.document?.id,
  );
  try {
    user.updateTokenTargets([tokenId]);
    return await fn();
  } finally {
    try {
      user.updateTokenTargets(previous.filter(Boolean));
    } catch {
      // a stale target is cosmetic; never let cleanup mask the real result
    }
  }
}

/**
 * Use an item or activity through the system's own path, so the table's automation runs.
 *
 * `CreatureAction` carries the item and, where the system models them, the specific activity. The
 * activity is preferred: an item with several activities ("Bite", "Frightful Presence") would otherwise
 * prompt, and a prompt on an automated turn is a turn that never finishes.
 */
async function useAction(
  action: { item: any; activity?: any; name: string },
  targetUuid?: string,
  asReaction = false,
): Promise<string | undefined> {
  // Dialogs must be suppressed: nobody is watching to click them, and dnd5e will happily wait forever.
  const dialog = { configure: false };
  const message = {};

  const attempts: Array<() => Promise<unknown>> = [];
  const activity = action.activity;
  const midi: any = (globalThis as any).MidiQOL;

  // Preferred when midi-qol is present: it resolves the entire workflow (attack, damage, saves, effects)
  // and can be told its targets outright. `ignoreUserTargets` matters because midi otherwise falls back
  // to whatever the GM happens to have selected, which on an automated turn is somebody else's choice
  // leaking into the monster's. Precedence between the two target options is unverified upstream, so the
  // acting user's targets are ALSO set by the caller: this is belt and braces, not a bet.
  if (typeof midi?.completeActivityUse === "function" && activity) {
    // `isReaction` and `targetConfirmation: "none"` are what midi's own reaction path passes; without
    // them an off-turn use is treated as an ordinary one and can stop for a target confirmation nobody
    // is present to give. Unknown options are ignored by midi, so they cost nothing when not reacting.
    const midiOptions: Record<string, unknown> = { ignoreUserTargets: true };
    if (targetUuid) midiOptions.targetUuids = [targetUuid];
    if (asReaction) {
      midiOptions.isReaction = true;
      midiOptions.workflowOptions = { targetConfirmation: "none" };
    }
    const usage = targetUuid || asReaction ? { midiOptions } : {};
    attempts.push(() => midi.completeActivityUse(activity, usage, dialog, message));
  }
  if (typeof activity?.use === "function") {
    attempts.push(() => activity.use({}, dialog, message));
  }
  const item = action.item;
  if (typeof item?.use === "function") {
    // `legacy: false` is what makes dnd5e 5.x take the activity path rather than its pre-5.x one.
    attempts.push(() => item.use({ legacy: false }, dialog, message));
    // dnd5e 3.x and systems built from it take one options bag, with a different key for the dialog.
    attempts.push(() => item.use({ configureDialog: false }));
  }

  // Asked before it is attempted, not only vetoed in the hook. A hook veto cancels the use without
  // throwing, so the loop below would see a clean return and report the action as taken — the turn
  // narration would then describe a swing that never happened, which is worse than the swing.
  const refusal = unaffordable(action);
  if (refusal) throw new Error(refusal);

  // Marked as automation throughout, so the action-economy ledger holds this creature to the rules
  // exactly rather than stopping to ask a question nobody is present to answer.
  return duringAutomation(async () => {
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        await attempt();
        return action.name;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw lastError;
    return undefined;
  });
}

/**
 * Can this creature still pay for what it is about to do? Returns why not, or nothing.
 *
 * Silent outside combat and silent for anything the ledger does not police, so the only creatures this
 * can stop are ones in a fight spending a slot they have already spent.
 */
function unaffordable(action: { item: any; activity?: any; name: string }): string | undefined {
  const combat: any = game.combat;
  if (!combat?.started) return undefined;

  const slot = slotFor(action.activity?.activation?.type ?? (action as any).economy);
  if (!slot) return undefined;

  const actor = action.activity?.actor ?? action.item?.actor;
  if (!actor) return undefined;
  const combatant = (combat.combatants ?? []).find?.(
    (c: any) => String(c?.actor?.uuid ?? "") === String(actor?.uuid ?? ""),
  );
  if (!combatant) return undefined;

  const isAttack = String(action.activity?.type ?? "") === "attack";
  if (check(actor, combat, combatant, slot, isAttack).allowed) return undefined;
  return `no ${slot} left this turn`;
}

/**
 * Use one action against one token, through the system's own path.
 *
 * The off-turn reaction layer needs exactly what a planned turn needs — targets set both ways, dialogs
 * suppressed, the system left to roll — so it shares this rather than growing a second, subtly different
 * copy. Returns the name of what was used, or throws what the system threw.
 */
export async function useActionAt(
  action: { item: any; activity?: any; name: string },
  target: any,
  opts: { asReaction?: boolean } = {},
): Promise<string | undefined> {
  const doc = target?.document ?? target;
  const tokenId = String(doc?.id ?? target?.id ?? "") || undefined;
  return withTarget(tokenId, () =>
    useAction(action, doc?.uuid as string | undefined, opts.asReaction),
  );
}

/** Plans whose whole point is that the creature ends up somewhere else. */
const MOVING_PLANS = new Set(["close", "kite", "hide", "advance", "help", "flee", "escape"]);

/** Movement budget left for the mechanical part of the turn, in scene units. */
function speedOf(plan: TurnPlan): number {
  return plan.board.speed ?? 0;
}

/** Reach of the chosen option, defaulting to a single square when the option carries no range. */
function reachOf(option: PlanOption): number {
  const range = Number((option as any)?.range);
  if (Number.isFinite(range) && range > 0) return range;
  return Number((canvas as any)?.scene?.grid?.distance ?? 5) || 5;
}

/**
 * Perform a plan. Returns what actually happened, for the announcement to reflect.
 *
 * Note what is NOT here: ending the turn. Advancing the tracker is the GM's prerogative — Noodlr
 * finishing a creature's turn for them would take the table's pacing out of their hands, and an
 * execution bug that also skipped turns would be very hard to catch.
 */
export async function performPlan(plan: TurnPlan): Promise<Performed> {
  const option = plan.chosen;
  const selfToken = plan.board.self.token;
  const result: Performed = { moved: 0 };

  const uuidOf = (actor: { token?: any } | undefined) =>
    (actor?.token?.document ?? actor?.token)?.uuid as string | undefined;
  /** Aim at whoever the option names, both ways: the user's targets and midi's explicit list. */
  const at = (who: { token?: any; tokenId?: string } | undefined) =>
    withTarget(who?.tokenId, () => useAction(option as any, uuidOf(who)));

  try {
    switch (option.kind) {
      case "attack":
      case "control":
      case "heal-ally":
        result.used = await at(option.target);
        break;

      case "heal-self":
        result.used = await at(plan.board.self);
        break;

      case "close": {
        result.moved = await moveToward(
          selfToken,
          option.target?.token,
          speedOf(plan),
          reachOf(option),
        );
        result.used = await at(option.target);
        break;
      }

      case "kite": {
        // Withdraw first, shoot second: the whole point of the manoeuvre is the shot coming from the
        // new position rather than the old one. The separation wanted is the THREAT's reach, not our
        // weapon's range — backing off 120 ft because that is how far a longbow carries is not kiting.
        const threat = option.target?.token;
        const standOff = Number(option.standOff) || reachOf(option);
        result.moved = await moveAwayFrom(selfToken, threat, speedOf(plan), standOff);
        result.used = await at(option.target);
        break;
      }

      case "hide":
        if (option.spot) result.moved = await moveTo(selfToken, option.spot);
        break;

      // Getting clear of something harmful is the whole turn. It carries no item to use afterwards:
      // the creature has spent its movement leaving, and whether anything is still in reach from
      // where it lands is next turn's question.
      case "escape":
        if (option.spot) result.moved = await moveTo(selfToken, option.spot);
        break;

      case "advance":
        result.moved = await moveToward(
          selfToken,
          option.target?.token,
          speedOf(plan),
          reachOf(option),
        );
        break;

      case "help":
        result.moved = await moveToward(
          selfToken,
          option.target?.token,
          speedOf(plan),
          reachOf(option),
        );
        break;

      case "flee":
        result.moved = await moveOffField(selfToken, speedOf(plan));
        break;

      // Readying is the one plan that deliberately resolves nothing NOW. The Action is charged and the
      // declaration stored; the effect happens later, on somebody else's turn, if the trigger comes. So
      // there is no `used` to report — reporting one would put a swing in the log that never happened.
      case "ready":
        if (option.ready) {
          const held = await declareReadied(
            plan.board.self.actor,
            option.ready,
            { item: option.item, activity: option.activity },
            { announce: "gm" },
          );
          if (!held) result.problem = "the readied action could not be stored";
        }
        break;

      // Calling out, surrendering and showing mercy are social, not mechanical. The encounter layer
      // handles their consequences; there is nothing to roll and nowhere to walk.
      case "call":
      case "surrender":
      case "mercy":
        break;
    }

    // Cover is a second, smaller move at the end of the turn, and only after the action resolved.
    if (plan.coverSpot) {
      result.moved += await moveTo(selfToken, plan.coverSpot);
    }

    // Say so when the announcement promised movement and none happened. Silence here is what made the
    // first two attempts at this so hard to diagnose: the chat card described a creature closing 23 ft,
    // the token never budged, and nothing anywhere said the move had been refused.
    if (MOVING_PLANS.has(option.kind) && result.moved === 0) {
      result.problem = "the token would not move — see the console for which call was refused";
    }
  } catch (err) {
    result.problem = String((err as any)?.message ?? err);
    log(`execution failed for ${plan.board.self.name}:`, err);
  }

  return result;
}
