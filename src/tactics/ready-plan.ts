// Readying an action on a monster's behalf.
//
// The Ready action shipped for players only, and the reason is worth stating plainly: RAW, a readied
// action is a PREDICTION, and predicting is precisely what a utility scorer over this turn's board cannot
// do. A planner that can see one turn ahead has no basis for "the cutpurse is about to bolt". So the
// feature reached the bestiary not at all, which is the user's observation and their fix (2026-08-14):
// give NPCs the finite canned list and draw from it at RANDOM, so monsters get some benefit from the
// functionality rather than waiting on a planner that will never arrive.
//
// RANDOM WITHIN THE PLAUSIBLE SET, THOUGH, NOT RANDOM ACROSS IT. A creature holding a scimitar that waits
// for "an enemy comes into view" is holding an action it cannot use at the moment the trigger fires, and
// at the table that is indistinguishable from the feature being broken. So the trigger is drawn from the
// ones the HELD ACTION can answer: a melee weapon waits for something to arrive within reach, a bow waits
// for something to appear, close, or start casting. One rule, no cost, and it is what stops "random"
// reading as "wrong".
//
// ITS OWN RANDOM STREAM, for the reason `core/random.ts` gives: drawing from the tactics stream would mean
// turning readying off silently changed every other number the planner sees, and therefore what creatures
// do. Independent decisions, independent streams.

import { isReadyEnabled } from "../settings";
import { cannedTriggers, readiableActivation, type CannedTrigger } from "../system/dnd5e-ready";
import { allowedToReady, reachOf } from "../rules/ready";
import type { Board } from "../core/board";
import type { CreatureAction } from "./actions";
import type { PlanOption } from "./planner";
import { can, type TierProfile } from "./tiers";

/**
 * Which canned triggers a held action can actually answer.
 *
 * The distances are the whole point. `reach` fires when something arrives next to the creature, which is
 * the only one a melee weapon can act on; `near`, `appears` and `casts` all fire at a range a bow covers
 * and a scimitar does not.
 *
 * Two are deliberately absent. `leaves` — an enemy backing out of reach — is what the opportunity-attack
 * layer already answers for free, so readying for it spends an Action to buy a reaction the creature had
 * anyway. `ally-hurt` and `door` say nothing about where the creature will need to be when they fire, so
 * pairing either with an attack is a coin flip on whether the attack is usable.
 */
const MELEE_TRIGGERS = ["reach"];
const RANGED_TRIGGERS = ["appears", "near", "casts"];

/** Which canned trigger ids pair with a held action of this kind. Exported so a test can pin the rule. */
export function triggersFor(ranged: boolean): string[] {
  return ranged ? RANGED_TRIGGERS : MELEE_TRIGGERS;
}

/**
 * What a monster is willing to hold.
 *
 * Attacks and control effects only: a readied heal is a rule nobody plays, and a `utility` activity is
 * usually the mechanical residue of something else. **`depleting` is excluded, and that is a rule rather
 * than caution** — the release prompt fires on a six-second clock, so a dragon that readied its breath
 * weapon for a canned trigger spends it on the first goblin through the door. That is the same rule
 * `util/prompt.ts` states from the other end: a clock may spend a renewing resource and never a depleting
 * one. A player readying a spell slot is exempt because they said so in writing; a random choice has said
 * nothing.
 */
export function holdable(action: CreatureAction): boolean {
  if (!action.available || !readiableActivation(action.economy)) return false;
  if (action.kind !== "attack" && action.kind !== "control") return false;
  return !action.depleting;
}

/**
 * Offer readying as one of this creature's options, or nothing.
 *
 * `hasOffensive` is the planner's own answer to "is there anything it could hit right now", which is what
 * decides whether waiting is clever or merely idle:
 *
 *   - **Nothing in range and something to shoot with:** readying is strictly better than advancing. It
 *     ends the turn where it started and buys a free shot as the enemy arrives, before the enemy has
 *     acted. Scored above `advance`.
 *   - **Nothing in reach and only melee:** standing still all round while the party shoots back is
 *     usually worse than closing, so this scores BELOW `advance` and happens only sometimes — which is
 *     the ambusher holding a corridor, and reads well when it does.
 *   - **Something already in reach:** only at `holdResources`, tier 7, whose own description is "hold an
 *     action or resource for a predicted opening instead of spending it now". Scored low on purpose: at
 *     tier 7's sharpness that is a couple of per cent, which is "occasionally" rather than "unreliably".
 */
export function readyOptions(
  board: Board,
  kit: CreatureAction[],
  profile: TierProfile,
  hasOffensive: boolean,
  rand: () => number,
): PlanOption[] {
  const actor = board.self.actor;
  if (!actor || !isReadyEnabled(actor) || !allowedToReady(actor)) return [];
  // Nothing to lie in wait for, and no trigger in the canned set can fire without an enemy.
  if (board.enemies.length === 0) return [];

  const holding = kit.filter(holdable);
  if (holding.length === 0) return [];

  const triggers = new Map(cannedTriggers(reachOf(actor)).map((t) => [t.id, t]));
  // Every workable pairing is built and ONE draw is taken from the lot. Two draws — an action, then a
  // trigger — would make the choice depend on the order the sheet happens to be in, and would spend two
  // numbers from the stream where one will do.
  const pairs: Array<{ action: CreatureAction; trigger: CannedTrigger }> = [];
  for (const action of holding) {
    for (const id of triggersFor(action.ranged)) {
      const trigger = triggers.get(id);
      if (trigger) pairs.push({ action, trigger });
    }
  }
  if (pairs.length === 0) return [];

  const picked = pairs[Math.min(pairs.length - 1, Math.floor(rand() * pairs.length))];
  const reasons = [`holding ${picked.action.name} for: ${picked.trigger.descriptor.summary}`];

  let score: number;
  if (!hasOffensive) {
    if (picked.action.ranged) {
      score = 1.15;
      reasons.push("nothing in range yet, and a shot as they arrive costs no more than one now");
    } else {
      score = 0.7;
      reasons.push("nothing in reach; closing is usually better than waiting");
    }
  } else if (can(profile, "holdResources")) {
    score = 0.55;
    reasons.push("could strike now, but a better moment may be coming");
  } else {
    return [];
  }

  return [
    {
      kind: "ready",
      item: picked.action.item,
      itemName: picked.action.name,
      activity: picked.action.activity,
      range: picked.action.range,
      ready: {
        prose: game.i18n.localize(picked.trigger.label),
        watch: picked.trigger.descriptor,
      },
      score,
      reasons,
    },
  ];
}
