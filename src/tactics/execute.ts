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
import { moveAwayFrom, moveOffField, moveTo, moveToward, moveTowardPoint } from "../core/movement";
import { centerOf, tokenDistance } from "../core/positioning";
import { gap3d } from "./altitude";
import { clearNextUse, duringAutomation } from "../rules/economy/enforce";
import { check, slotFor } from "../rules/economy/ledger";
import { standUp } from "../rules/prone";
import { declareReadied } from "../rules/ready";
import { placesTemplate } from "../rules/template-targets";
import { crawlAction, isProne, standCost } from "../system/dnd5e-prone";
import { placeAimedTemplate, stampCatch } from "./place-template";
import type { PlanOption, TurnPlan } from "./planner";

/** Token id from a BoardActor, a Token, or a TokenDocument. Empty is "nobody". */
export function tokenIdOf(who: any): string | undefined {
  const id = String(
    who?.tokenId ?? who?.document?.id ?? who?.token?.document?.id ?? who?.token?.id ?? who?.id ?? "",
  );
  return id || undefined;
}

function tokenOf(who: any): any {
  if (!who) return null;
  if (who.token?.center || who.token?.document) return who.token;
  if (who.center || who.document) return who;
  return null;
}

function dnd5eTargets(who: any): object[] {
  const token = tokenOf(who);
  const doc = token?.document ?? token;
  const actor = doc?.actor ?? who?.actor;
  if (!actor?.uuid) return [];
  const ac = Number(actor.system?.attributes?.ac?.value);
  return [
    {
      name: String(doc?.name ?? actor.name ?? ""),
      img: actor.img,
      uuid: actor.uuid,
      ac: Number.isFinite(ac) ? ac : null,
    },
  ];
}

export interface Performed {
  /** Distance actually travelled, in scene units. */
  moved: number;
  /** Name of the thing that was used, when one was. */
  used?: string;
  /** Stood up from Prone before acting. */
  stood?: boolean;
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
  if (!tokenId) return fn();

  const previous = Array.from((user?.targets ?? []) as Set<any>).map(
    (t: any) => t?.id ?? t?.document?.id,
  );
  try {
    const token = (canvas as any)?.tokens?.get?.(tokenId);
    if (typeof token?.setTarget === "function") {
      token.setTarget(true, { releaseOthers: true, groupSelection: false });
    }
    const updated = user?.updateTokenTargets?.([tokenId]);
    if (updated && typeof updated.then === "function") await updated;
    return await fn();
  } finally {
    try {
      user?.updateTokenTargets?.(previous.filter(Boolean));
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
  action: { item: any; activity?: any; name: string; attackMode?: string },
  target?: any,
  opts: { asReaction?: boolean; skipEconomy?: boolean } = {},
): Promise<string | undefined> {
  // Dialogs must be suppressed: nobody is watching to click them, and dnd5e will happily wait forever.
  // `configure: false` on `use()` is only the USAGE dialog. AttackActivity then fires `rollAttack`
  // with an empty dialog config (and does not await it), which is the Attack Roll window that sat
  // in front of the Assassin's Light Crossbow. We skip that subsequent call and finish the rolls
  // ourselves, awaited, so the turn cannot advance while the dice are still a dialog.
  //
  // `#placeTemplate` is a third wait: it calls `drawPreview()` and sits on a mouse click.
  // `configure: false` does not skip it. Automated area spells pass `create.measuredTemplate: false`
  // and place the template themselves, aimed at the nominated target.
  const dialog = { configure: false };
  const message = {};
  const usage: Record<string, unknown> = { subsequentActions: false };
  if (placesTemplate(action.activity)) usage.create = { measuredTemplate: false };

  const attempts: Array<() => Promise<unknown>> = [];
  const activity = action.activity;
  if (typeof activity?.use === "function") {
    attempts.push(() => finishActivity(activity, usage, dialog, message, action.attackMode, target));
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
  //
  // `skipEconomy` is a follow-through already paid for (Chomp → two Bites): the Bite still claims
  // an Action, and off-turn that Action is checked against the legendary creature's last turn.
  if (!opts.skipEconomy) {
    const refusal = unaffordable(action);
    if (refusal) throw new Error(refusal);
  } else {
    clearNextUse(action.activity);
  }

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
 * Use, then finish the attack the system would have started and not waited for.
 *
 * `results` is whatever `Activity#use` returned; an early return (cannot use, vetoed) is
 * `undefined` and must not grow a dangling roll.
 */
async function finishActivity(
  activity: any,
  usage: Record<string, unknown>,
  dialog: { configure: boolean },
  message: Record<string, unknown>,
  attackMode?: string,
  target?: any,
): Promise<unknown> {
  const results = await activity.use(usage, dialog, message);
  if (!results) return results;

  if (placesTemplate(activity)) {
    const aimedAt = tokenOf(target);
    const caster = casterTokenOf(activity);
    if (!aimedAt) throw new Error("the area could not be aimed — no target was nominated");
    if (!caster) throw new Error("the area could not be aimed — the caster has no token");
    const aimed = await placeAimedTemplate(activity, caster, aimedAt);
    if (!aimed) throw new Error("the area could not be placed");
    await stampCatch(results.message, aimed.caught);
  }

  const origin = results?.message?.id;
  const stamped = dnd5eTargets(target);
  const follow = {
    data: {
      flags: {
        dnd5e: {
          ...(origin ? { originatingMessage: origin } : {}),
          ...(stamped.length ? { targets: stamped } : {}),
        },
      },
    },
  };
  const silent = { configure: false };
  const rollCfg = attackMode ? { attackMode } : {};

  const parts = activity.damage?.parts;
  const hasParts = Array.isArray(parts) && parts.length > 0;
  const kind = String(activity.type ?? "");

  if (typeof activity.rollAttack === "function") {
    await activity.rollAttack(rollCfg, silent, follow);
    if (typeof activity.rollDamage === "function" && hasParts) {
      await activity.rollDamage({}, silent, follow);
    }
  } else if (
    (kind === "heal" || kind === "damage" || kind === "save") &&
    typeof activity.rollDamage === "function" &&
    hasParts
  ) {
    // Heal/Damage fire an unawaited subsequent roll. A Save activity also has
    // `rollDamage` (Fireball, Disintegration Ray) and the system leaves that
    // button for after the save — nobody presses it on an automated turn, so
    // the table saw the save and never the damage. Charm Ray has no parts and
    // is skipped. Auto-saves then settle the card the same way a Bite's damage
    // card already does.
    await activity.rollDamage({}, silent, follow);
  }
  return results;
}

function casterTokenOf(activity: any): any {
  const actor = activity?.actor ?? activity?.item?.actor;
  const tokens: any[] = actor?.getActiveTokens?.(true) ?? actor?.getActiveTokens?.() ?? [];
  return tokens[0] ?? null;
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
  action: { item: any; activity?: any; name: string; attackMode?: string },
  target: any,
  opts: { asReaction?: boolean; skipEconomy?: boolean } = {},
): Promise<string | undefined> {
  return withTarget(tokenIdOf(target), () => useAction(action, target, opts));
}

/** Plans whose whole point is that the creature ends up somewhere else. */
const MOVING_PLANS = new Set([
  "close",
  "kite",
  "hide",
  "advance",
  "search",
  "help",
  "flee",
  "escape",
  "hover",
  "flyby",
  "emerge",
]);

/** One grid square in scene units. */
function oneSquare(): number {
  return Number((canvas as any)?.scene?.grid?.distance ?? 5) || 5;
}

/** Movement budget left for the mechanical part of the turn, in scene units. */
function speedOf(plan: TurnPlan, stood: boolean): number {
  const raw = plan.board.speed ?? 0;
  if (!stood) return raw;
  return Math.max(0, raw - standCost(raw));
}

/** Crawl while still Prone; walk/fly once they have stood. */
function gaitOf(actor: any): { action?: string } {
  const action = isProne(actor) ? crawlAction() : undefined;
  return action ? { action } : {};
}

function liveElevation(token: any, fallback: number): number {
  const n = Number(token?.document?.elevation ?? token?.elevation);
  return Number.isFinite(n) ? n : fallback;
}

/** Reach of the chosen option, defaulting to a single square when the option carries no range. */
function reachOf(option: PlanOption): number {
  const range = Number((option as any)?.range);
  if (Number.isFinite(range) && range > 0) return range;
  return Number((canvas as any)?.scene?.grid?.distance ?? 5) || 5;
}

/**
 * May this melee close swing from here?
 *
 * Unknown separation fails closed. Swinging from 33 ft with an empty target list is how two
 * Dire Wolves looked like they had a 40-foot Bite after a wall refused the walk — the planner
 * was honest (`must close 33 ft`); `performPlan` attacked anyway.
 */
export function meleeReached(distance: number, reach: number): boolean {
  if (!Number.isFinite(distance) || !Number.isFinite(reach) || reach <= 0) return false;
  return distance <= reach + 0.01;
}

/** Closest-square horizontal, then elevation. Same geometry the planner now uses. */
function meleeGap(selfToken: any, targetToken: any, selfElev: number, targetElev: number): number {
  if (!targetToken) return Number.POSITIVE_INFINITY;
  return gap3d(tokenDistance(selfToken, targetToken), selfElev, targetElev);
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
  const actor = plan.board.self.actor;
  const result: Performed = { moved: 0 };

  /** Aim at whoever the option names, both ways: the user's targets and midi's explicit list. */
  const at = (who: { token?: any; tokenId?: string } | undefined) =>
    withTarget(tokenIdOf(who), () => useAction(option as any, who));

  try {
    if (plan.stand && isProne(actor)) {
      const stood = await standUp(actor);
      if (stood.ok && !isProne(actor)) result.stood = true;
      else {
        log(
          `execution: ${plan.board.self.name} could not stand (${stood.reason ?? "unknown"}) — crawling if it moves`,
        );
      }
    }
    const budget = speedOf(plan, !!result.stood);
    const gait = gaitOf(actor);

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
        const reach = reachOf(option);
        result.moved = await moveToward(selfToken, option.target?.token, budget, reach, gait);
        const now = liveElevation(selfToken, plan.board.self.elevation);
        const gap = meleeGap(
          selfToken,
          option.target?.token,
          now,
          option.target?.elevation ?? 0,
        );
        if (!meleeReached(gap, reach)) {
          result.problem =
            result.moved === 0
              ? "the token would not move — still out of reach, so the attack was not made"
              : `closed ${Math.round(result.moved)} ${plan.board.units} but still ${Math.round(gap)} ${plan.board.units} away`;
          break;
        }
        result.used = await at(option.target);
        break;
      }

      case "hover": {
        const dest = Number(option.elevation);
        const here = centerOf(selfToken);
        if (here && Number.isFinite(dest)) {
          result.moved = await moveTo(selfToken, here, {
            budget,
            elevation: dest,
            action: option.moveAction ?? gait.action,
          });
        }
        const reach = reachOf(option);
        const now = liveElevation(selfToken, dest);
        const gap = meleeGap(selfToken, option.target?.token, now, option.target?.elevation ?? 0);
        if (!meleeReached(gap, reach)) {
          result.problem =
            result.moved === 0
              ? "could not take off — the attack from height was not made"
              : `rose ${Math.round(result.moved)} ${plan.board.units} but ${option.itemName ?? "the attack"} is still out of range`;
          break;
        }
        if (option.item) result.used = await at(option.target);
        break;
      }

      case "flyby": {
        const reach = reachOf(option);
        const gaitOr = { action: option.moveAction ?? gait.action, elevation: option.elevation };
        result.moved = await moveToward(selfToken, option.target?.token, budget, reach, gaitOr);
        const now = liveElevation(selfToken, plan.board.self.elevation);
        const gap = meleeGap(selfToken, option.target?.token, now, option.target?.elevation ?? 0);
        if (meleeReached(gap, reach) && option.item) {
          result.used = await at(option.target);
        } else if (option.item) {
          result.problem =
            result.moved === 0
              ? "the token would not move — still out of reach, so the attack was not made"
              : `flew ${Math.round(result.moved)} ${plan.board.units} but still ${Math.round(gap)} ${plan.board.units} away`;
        }
        const leftover = Math.max(0, budget - result.moved);
        if (leftover > 0 && option.target?.token) {
          result.moved += await moveAwayFrom(selfToken, option.target.token, leftover, leftover, gaitOr);
        }
        break;
      }

      case "emerge": {
        const dest = Number(option.elevation);
        const here = centerOf(selfToken);
        const gaitOr = { action: option.moveAction ?? gait.action, elevation: dest };
        if (Number.isFinite(dest) && dest < plan.board.self.elevation - 1) {
          if (here) result.moved = await moveTo(selfToken, here, { budget, ...gaitOr });
          break;
        }
        const reach = option.item ? reachOf(option) : 0;
        if (option.target?.token) {
          result.moved = await moveToward(selfToken, option.target.token, budget, reach, gaitOr);
        } else if (here && Number.isFinite(dest)) {
          result.moved = await moveTo(selfToken, here, { budget, ...gaitOr });
        }
        if (option.item && option.target?.token) {
          const now = liveElevation(selfToken, dest);
          const gap = meleeGap(selfToken, option.target.token, now, option.target.elevation);
          if (meleeReached(gap, reachOf(option))) result.used = await at(option.target);
          else {
            result.problem =
              result.moved === 0
                ? "could not emerge — the attack was not made"
                : `emerged ${Math.round(result.moved)} ${plan.board.units} but still out of reach`;
          }
        }
        break;
      }

      case "kite": {
        // Withdraw first, shoot second: the whole point of the manoeuvre is the shot coming from the
        // new position rather than the old one. The separation wanted is the THREAT's reach, not our
        // weapon's range — backing off 120 ft because that is how far a longbow carries is not kiting.
        const threat = option.target?.token;
        const standOff = Number(option.standOff) || reachOf(option);
        result.moved = await moveAwayFrom(selfToken, threat, budget, standOff, gait);
        result.used = await at(option.target);
        break;
      }

      case "hide":
        if (option.spot) result.moved = await moveTo(selfToken, option.spot, { budget, ...gait });
        break;

      // Getting clear of something harmful is the whole turn. It carries no item to use afterwards:
      // the creature has spent its movement leaving, and whether anything is still in reach from
      // where it lands is next turn's question.
      case "escape":
        if (option.spot) result.moved = await moveTo(selfToken, option.spot, { budget, ...gait });
        break;

      case "advance":
        result.moved = await moveToward(
          selfToken,
          option.target?.token,
          budget,
          reachOf(option),
          gait,
        );
        break;

      case "search":
        // A point, not a token, and that is the whole distinction the search plan exists to keep: the
        // creature is walking to a remembered spot on the floor rather than homing on somebody it
        // cannot see. `desired` is 0 because the spot is the destination — there is no reach to stop
        // short at when there is nothing standing there.
        if (option.lost) {
          result.moved = await moveTowardPoint(selfToken, option.lost.point, budget, 0, {
            label: `where ${option.lost.name} was last seen`,
            elevation: option.lost.elevation,
            action: gait.action,
          });
        }
        break;

      case "help":
        result.moved = await moveToward(
          selfToken,
          option.target?.token,
          budget,
          reachOf(option),
          gait,
        );
        break;

      case "flee":
        result.moved = await moveOffField(selfToken, budget, gait);
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
      const leftover = Math.max(0, budget - result.moved);
      result.moved += await moveTo(selfToken, plan.coverSpot, { budget: leftover, ...gait });
    }

    // Say so when the announcement promised movement and none happened. Silence here is what made the
    // first two attempts at this so hard to diagnose: the chat card described a creature closing 23 ft,
    // the token never budged, and nothing anywhere said the move had been refused.
    // A search that was already standing on the remembered spot is the one movement plan that
    // legitimately travels nowhere, so it is not a refusal to report. Every other zero is.
    const meantToTravel =
      option.kind === "search" ? (option.lost?.distance ?? 0) > oneSquare() : true;
    // Already in reach returns 0 from moveToward on purpose — that is a successful Bite,
    // not a refusal. A more specific problem from the switch must not be overwritten
    // (the 17:17 card said "see the console" after "still out of reach" had already been set).
    if (
      !result.problem &&
      !result.used &&
      MOVING_PLANS.has(option.kind) &&
      meantToTravel &&
      result.moved === 0
    ) {
      result.problem = "the token would not move — see the console for which call was refused";
    }
  } catch (err) {
    result.problem = String((err as any)?.message ?? err);
    log(`execution failed for ${plan.board.self.name}:`, err);
  }

  return result;
}
