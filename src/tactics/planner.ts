// Deciding what a creature does on its turn, locally and for free.
//
// Architecture (user's call, 2026-08-02): utility scoring rather than a literal branching tree. Every
// legal option is generated, scored by the considerations the creature's tier unlocks, and then
// chosen by WEIGHTED RANDOM rather than by taking the maximum. That last part is the whole design:
//
//   - Taking the best option every time produces monsters that play like a tournament grinder, which
//     is both unfun and wrong for most of the bestiary.
//   - Choosing at random produces noise nobody reads as intent.
//   - Choosing randomly *in proportion to a score*, with the sharpness of that proportion set by the
//     creature's mental tier, produces an owlbear that usually mauls whatever is closest and a lich
//     that almost always does the clever thing. The score says what is appropriate; the tier says how
//     reliably the creature manages it.
//
// The randomness is SEEDED from the fight, the round, and the creature, so a turn replays identically:
// no reroll-shopping by clicking twice, and tests can assert on real decisions.
//
// This file never computes an attack roll, damage, a save, or a DC — see the amended principle 0 in
// AGENTS.md. It picks a verb, an implement, and a target; resolution belongs to the system.

import { pickNumber, systemPaths, type SystemPaths } from "../system/profiles";
import { readActions, type CreatureAction } from "./actions";
import { isMercifulSort, partyHasCeasedAggression, partyIsDefeated } from "./encounter";
import { readBoard, type Board, type BoardActor, type UnseenEnemy } from "../core/board";
import { applyAwareness } from "./awareness";
import { findConcealment, type Spot } from "../core/positioning";
import { findWayOut, hazardsUnder } from "../core/hazards";
import { turnRandom } from "../core/random";
import { can, mentalScore, tierForScore, tierProfile, type TierProfile } from "./tiers";
import { readyOptions } from "./ready-plan";
import type { WatchDescriptor } from "../integration/watch";
import { isProne, shouldStand, standCost } from "../system/dnd5e-prone";

/** Below this fraction of maximum hit points a creature considers itself in trouble. */
const BLOODIED = 0.5;
const DESPERATE = 0.25;

export type PlanKind =
  | "attack"
  | "heal-self"
  | "heal-ally"
  | "control"
  | "flee"
  | "call"
  | "close"
  | "advance"
  | "search"
  | "kite"
  | "hide"
  | "help"
  | "surrender"
  | "mercy"
  | "escape"
  | "ready";

export interface PlanOption {
  kind: PlanKind;
  /** Item being used, when the option involves one. */
  item?: any;
  itemName?: string;
  /**
   * The specific activity to invoke, and its reach. Both come straight from the normalized action and
   * exist for the execution layer: invoking the ITEM when it holds several activities makes dnd5e
   * prompt for which one, and nobody is watching an automated turn to answer that.
   */
  activity?: any;
  range?: number;
  /** Passed through to `rollAttack` so a thrown spear is thrown, not stabbed from 20 ft. */
  attackMode?: string;
  /** Separation the creature wants from `target` when withdrawing, in scene units. */
  standOff?: number;
  target?: BoardActor;
  /** Distance that must be crossed first, in scene units. */
  approach?: number;
  /** Where the creature ends up, when the option involves going somewhere specific. */
  spot?: Spot;
  /**
   * For `search`: the enemy it has lost, and the last place it saw them.
   *
   * Deliberately not a `target`, which every other movement option carries: a `BoardActor` knows where
   * the creature IS, and the whole point of this option is that it does not. Anything reading
   * `option.target` to aim at would defeat the hide it exists to respect.
   */
  lost?: UnseenEnemy;
  /** Whose eyes the spot was chosen against. */
  observer?: string;
  /**
   * For `ready`: the trigger being held for, already compiled. Carried on the option rather than looked
   * up again at execution time because the choice was random — re-drawing it would announce one trigger
   * and store another.
   */
  ready?: { prose: string; watch: WatchDescriptor };
  score: number;
  /** Why this scored what it did — surfaced to the GM, and the reason the tuning is debuggable. */
  reasons: string[];
}

export interface TurnPlan {
  profile: TierProfile;
  mental: number | null;
  chosen: PlanOption;
  /** Everything that was weighed, best-scored first. */
  considered: PlanOption[];
  board: Board;
  /** An intent tacked onto the end of the turn, such as ducking behind cover. */
  postscript?: string;
  /** Where that end-of-turn move ends up, when one was found. */
  coverSpot?: Spot;
  /** Stand from Prone before acting. Half Speed; staying down is the keepDistance stay-put case. */
  stand?: boolean;
}

// ---- reading the creature's own kit ------------------------------------------------------------
//
// Normalizing an actor's items into actions lives in `../actions.ts`, which speaks both the dnd5e
// activities model and the older actionType shape. The planner only cares about the normalized form.

type Usable = CreatureAction;

/**
 * Can this be spent on the creature's own turn?
 *
 * Reactions and legendary actions are off-turn resources: a creature that used its Parry as its turn
 * has thrown the turn away. Both are real behaviours the creature should get — just not from here, and
 * the off-turn layer that will spend them does not exist yet (see AGENTS.md gaps).
 */
// A creature's turn is its action and its bonus action. "free" is deliberately excluded: the system
// marks those activations passive, and the surveyed world has 106 of them — grapple-escape checks and
// similar companions to other actions. Offering one as a turn option risks a creature spending its only
// choice on the mechanical residue of something it did not do.
const onTurn = (u: Usable) => u.economy === "action" || u.economy === "bonus";

const isAttack = (u: Usable) => u.available && u.kind === "attack" && onTurn(u);
const isRangedAttack = (u: Usable) => isAttack(u) && u.ranged;

/** Already able to shoot the thing it would hide from — hiding instead of shooting is the bug. */
export function rangedCovers(kit: Usable[], distance: number): boolean {
  return kit.some((u) => isRangedAttack(u) && u.range >= distance);
}

/** What an opponent can do back, which is all the creature needs to decide how close to stand. */
interface ThreatProfile {
  /** Farthest a melee-style attack of theirs reaches, in scene units; 0 when they have none. */
  meleeReach: number;
  hasRanged: boolean;
  /** How far they can move to close the gap next turn. */
  speed: number;
}

function threatOf(enemy: BoardActor, P: SystemPaths, cache: Map<string, ThreatProfile>) {
  const key = enemy.combatantId;
  const cached = cache.get(key);
  if (cached) return cached;

  const kit = readActions(enemy.actor);
  const melee = kit.filter((u) => isAttack(u) && u.melee);
  const grid = Number((canvas as any)?.scene?.grid?.distance ?? 5);
  // An opponent whose sheet says nothing readable is assumed able to hit you if you stand next to
  // it. Guessing "harmless" would walk archers into a grapple on every unfamiliar system.
  const unreadable = kit.length === 0;
  const profile: ThreatProfile = {
    // Zero when it has no melee at all — an archer threatens nobody's withdrawal.
    meleeReach: unreadable
      ? grid
      : melee.length === 0
        ? 0
        : Math.max(grid, ...melee.map((u) => u.range)),
    hasRanged: unreadable ? false : kit.some(isRangedAttack),
    speed: pickNumber(enemy.actor, P.speed) ?? grid * 6,
  };
  cache.set(key, profile);
  return profile;
}

// ---- option generation -------------------------------------------------------------------------

function normalize(value: number, max: number): number {
  return max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
}

function attackOptions(
  board: Board,
  kit: Usable[],
  p: TierProfile,
  threat: (enemy: BoardActor) => ThreatProfile,
): PlanOption[] {
  const options: PlanOption[] = [];
  const biggestFootprint = Math.max(1, ...board.enemies.map((e) => e.footprint));
  const mostSpells = Math.max(1, ...board.enemies.map((e) => e.spellCount));
  const selfHurt = board.self.hpFraction !== null && board.self.hpFraction < BLOODIED;
  const hasRangedOption = kit.some(isRangedAttack);

  for (const usable of kit) {
    if (!isAttack(usable)) continue;

    for (const enemy of board.enemies) {
      // Separation is three-dimensional, and pretending otherwise is how a wolf ends up "reaching" a
      // wizard hovering thirty feet above it. Reach is measured through the air; closing is only
      // offered if the creature has some way of covering the vertical part as well.
      const rise = enemy.elevation - board.self.elevation;
      const separation = Math.hypot(enemy.distance, rise);
      const gap = separation - usable.range;
      const inReach = gap <= 0;
      if (!inReach && (board.speed === null || gap > board.speed)) continue;
      if (!inReach && Math.abs(rise) > 1 && !canChangeHeight(board)) {
        continue;
      }

      const reasons: string[] = [];
      // Everything starts equal: hitting something is what combatants do.
      let score = 1;

      // Nearer is better, always — even an insect goes for what it can already touch.
      score += 0.6 * (1 - normalize(enemy.distance, 60));
      if (!inReach) {
        score -= 0.35;
        reasons.push(`must close ${Math.round(gap)} ${board.units}`);
      }

      if (can(p, "targetApparentWeakest")) {
        const small = 1 - normalize(enemy.footprint, biggestFootprint);
        if (small > 0) {
          score += 0.5 * small;
          reasons.push("looks like the easy one");
        }
      }
      if (can(p, "targetHighestThreat") && enemy.spellCount > 0) {
        score += 0.7 * normalize(enemy.spellCount, mostSpells);
        reasons.push("throws spells");
      }
      if (can(p, "focusFire") && enemy.hpFraction !== null && enemy.hpFraction < 1) {
        score += 0.5 * (1 - enemy.hpFraction);
        reasons.push("already wounded");
      }
      // Tier 4 and up would rather shoot than be stood next to. Two separate judgements: reward a
      // shot taken from outside the target's reach, and penalize deliberately walking into it when
      // there was a ranged option on the sheet.
      if (can(p, "keepDistance")) {
        const reach = threat(enemy).meleeReach;
        if (!usable.melee && enemy.distance > reach) {
          score += 0.45;
          reasons.push("out of their reach");
        }
        if (hasRangedOption && usable.melee && !inReach) {
          score -= 0.55;
          reasons.push("would have to close into melee");
        }
      }

      if (can(p, "avoidStrongOpponents") && selfHurt) {
        const bulk = normalize(enemy.footprint, biggestFootprint);
        score -= 0.45 * bulk;
        if (bulk > 0.5) reasons.push("wary of something that size");
      }

      options.push({
        kind: inReach ? "attack" : "close",
        item: usable.item,
        itemName: usable.name,
        activity: usable.activity,
        range: usable.range,
        attackMode: usable.attackMode,
        target: enemy,
        approach: inReach ? 0 : gap,
        score,
        reasons,
      });
    }
  }
  return options;
}

/**
 * Walking toward the enemy when it cannot be reached this turn.
 *
 * The gap that made the first play test embarrassing: a Dire Wolf 60 ft from the party has no attack
 * "in reach", cannot close 60 ft on a 50 ft move, and therefore generated no attack option at all —
 * leaving a floor option (bellowing for help) as the best thing it could think of. Advancing needs no
 * intelligence whatsoever, so it sits at tier 1 alongside attacking, and is only offered when nothing
 * better exists: it scores below any real attack and above the floor.
 */
/** Can this creature gain or lose height under its own power? */
function canChangeHeight(board: Board): boolean {
  const modes = board.locomotion.modes;
  return (modes.fly ?? 0) > 0 || (modes.climb ?? 0) > 0;
}

function advanceOptions(board: Board, kit: Usable[], hasBetter: boolean): PlanOption[] {
  if (hasBetter) return [];
  const target = board.enemies[0];
  if (!target || board.speed === null || board.speed <= 0) return [];
  // Walking hopefully toward something in the air achieves nothing but a wasted turn.
  if (Math.abs(target.elevation - board.self.elevation) > 1 && !canChangeHeight(board)) return [];

  const attacks = kit.filter(isAttack);
  if (attacks.length === 0) return [];
  const bestReach = Math.max(...attacks.map((a) => a.range));

  return [
    {
      kind: "advance",
      target,
      range: bestReach,
      score: 0.9,
      reasons: [`${target.name} is out of reach; closing the distance`],
    },
  ];
}

function healingOptions(board: Board, kit: Usable[], p: TierProfile): PlanOption[] {
  const options: PlanOption[] = [];
  const healers = kit.filter((u) => u.available && u.kind === "heal" && onTurn(u));
  if (healers.length === 0) return options;

  const selfHp = board.self.hpFraction;
  for (const usable of healers) {
    if (can(p, "selfHealing") && selfHp !== null && selfHp < BLOODIED) {
      options.push({
        kind: "heal-self",
        item: usable.item,
        itemName: usable.name,
        activity: usable.activity,
        range: usable.range,
        // Steeply more attractive the closer to death it is; a scratch is not worth a potion.
        score: 1.2 + 2.2 * (1 - selfHp),
        reasons: ["hurt badly enough to spend something on it"],
      });
    }
    if (can(p, "supportAllies")) {
      for (const ally of board.allies) {
        if (ally.hpFraction === null || ally.hpFraction >= BLOODIED) continue;
        if (ally.distance > usable.range) continue;
        options.push({
          kind: "heal-ally",
          item: usable.item,
          itemName: usable.name,
          activity: usable.activity,
          range: usable.range,
          target: ally,
          score: 1 + 1.8 * (1 - ally.hpFraction),
          reasons: [`${ally.name} is in a bad way`],
        });
      }
    }
  }
  return options;
}

function controlOptions(board: Board, kit: Usable[], p: TierProfile): PlanOption[] {
  if (!can(p, "controlManeuvers") && !can(p, "advancedCasting")) return [];
  // "save"-type items are the closest thing to a system-agnostic marker for an effect that imposes
  // something rather than dealing damage — which covers most crowd control and most maneuvers at
  // once. Counterspell specifically is a reaction, so it belongs to the off-turn work, not here.
  return kit
    .filter((u) => u.available && u.kind === "control" && onTurn(u))
    .flatMap((usable) =>
      board.enemies
        .filter((e) => e.distance <= usable.range)
        .map((enemy) => ({
          kind: "control" as const,
          item: usable.item,
          itemName: usable.name,
          activity: usable.activity,
          range: usable.range,
          target: enemy,
          score: 1.1 + (can(p, "targetHighestThreat") && enemy.spellCount > 0 ? 0.6 : 0),
          reasons: ["shut them down rather than trade blows"],
        })),
    );
}

/**
 * Stepping back out of melee range and shooting from the new spot.
 *
 * Revised 2026-08-02, and the subtlest rule in the file: a tier-4 creature withdraws only "when not at
 * risk of an opportunity attack". That inverts the naive version, which backed away precisely when
 * something was already adjacent — the exact moment leaving costs a free hit. So a creature that is
 * ALREADY engaged stays and fights; one that is merely about to be closed on gives ground now, while
 * it is still free to. Refusing the melee before it starts is the competent play, and the one the
 * rules reward.
 */
function kiteOptions(
  board: Board,
  kit: Usable[],
  p: TierProfile,
  threat: (enemy: BoardActor) => ThreatProfile,
): PlanOption[] {
  if (!can(p, "keepDistance")) return [];
  if (board.speed === null || board.speed <= 0) return [];

  const ranged = kit.find(isRangedAttack);
  if (!ranged) return [];

  // Anyone already within reach would get a swing at it as it left.
  const engaged = board.enemies.some((e) => e.distance <= threat(e).meleeReach);
  if (engaged) return [];

  // Nobody on it yet, but someone can be next turn: this is the free moment to open the gap.
  const closing = board.enemies.filter((e) => {
    const t = threat(e);
    return t.meleeReach > 0 && e.distance <= t.meleeReach + t.speed;
  });
  if (closing.length === 0) return [];

  const target = board.enemies.find((e) => e.distance <= ranged.range) ?? closing[0];
  return [
    {
      kind: "kite",
      item: ranged.item,
      itemName: ranged.name,
      activity: ranged.activity,
      range: ranged.range,
      attackMode: ranged.attackMode,
      // Far enough that the thing about to close cannot reach it, not as far as the bow can shoot.
      standOff:
        threat(target).meleeReach + (Number((canvas as any)?.scene?.grid?.distance ?? 5) || 5),
      target,
      score: 1.25 + 0.35 * Math.min(1, closing.length / 2),
      reasons: [`${closing[0].name} could close next turn`, "free to withdraw right now"],
    },
  ];
}

/**
 * Making an ally's attempt land. What "help" grants is the system's business; all this decides is
 * that the creature spends its turn on someone else's attack instead of its own.
 */
function helpOptions(
  board: Board,
  p: TierProfile,
  threat: (enemy: BoardActor) => ThreatProfile,
): PlanOption[] {
  if (!can(p, "helpAlly")) return [];
  const grid = Number((canvas as any)?.scene?.grid?.distance ?? 5);

  for (const ally of board.allies) {
    if (ally.distance > grid * 2) continue;
    const engagedWith = board.enemies.find((e) => e.distance <= threat(e).meleeReach + grid);
    if (!engagedWith) continue;
    return [
      {
        kind: "help",
        target: ally,
        score: 0.95,
        reasons: [`${ally.name} is toe to toe with ${engagedWith.name}`],
      },
    ];
  }
  return [];
}

/**
 * Throwing down its weapon, and sparing a party that has already stopped fighting.
 *
 * Both end the fight without anyone else dying, and both are gated on things the module can actually
 * check: how badly hurt the creature is, whether the party has held its fire for a full round, and
 * what the sheet says about alignment.
 */
function yieldOptions(board: Board, p: TierProfile, actor: any): PlanOption[] {
  const options: PlanOption[] = [];
  const hp = board.self.hpFraction;

  if (can(p, "surrender") && hp !== null && hp < DESPERATE && board.enemies.length > 0) {
    // Competes head-on with fleeing at the same hit points, which is the interesting choice: the
    // creature with nowhere to run is the one that gives up.
    options.push({
      kind: "surrender",
      score: 1.3 + 6 * (DESPERATE - hp),
      reasons: ["beaten, and would rather live than die well"],
    });
  }

  if (can(p, "mercy") && partyHasCeasedAggression() && partyIsDefeated() && isMercifulSort(actor)) {
    options.push({
      kind: "mercy",
      // Strong where it applies, because the conditions are narrow: the party must be beaten AND have
      // stopped fighting AND the creature must be the sort that spares people.
      score: 2.2,
      reasons: ["they have stopped fighting, and they are beaten"],
    });
  }

  return options;
}

/**
 * Whose eyes matter. The user's framing is "the Players", so player-owned combatants are preferred
 * as the reference observer; a fight with no PCs in it falls back to whoever is hostile.
 */
function playerFacing(board: Board): BoardActor[] {
  const pcs = board.enemies.filter((e) => e.isPC);
  return pcs.length > 0 ? pcs : board.enemies;
}

/** Hiding is tested against the NEAREST player: the hardest pair of eyes to escape. */
function hideOptions(
  board: Board,
  kit: Usable[],
  p: TierProfile,
  rand: () => number,
): PlanOption[] {
  if (!can(p, "stealth")) return [];
  if (board.speed === null || board.speed <= 0) return [];

  const nearest = playerFacing(board)[0];
  if (!nearest) return [];
  // Cover after a shot is `coverIntent`. Hide as the WHOLE turn is for when it cannot already
  // shoot — otherwise the Archmage walks twelve feet and ducks instead of using Arcane Burst.
  if (rangedCovers(kit, nearest.distance)) return [];

  const spot = findConcealment(board.self.token, nearest.token, board.speed, rand);
  if (!spot) return [];

  const hp = board.self.hpFraction ?? 1;
  const hasRanged = kit.some(isRangedAttack);
  const reasons = [`out of ${nearest.name}'s sight`];
  let score = 1.05;
  // Breaking contact is far more attractive when losing the stand-up fight, and a creature that can
  // shoot from concealment has a use for it beyond simply not being hit.
  if (hp < BLOODIED) {
    score += 0.9 * (1 - hp);
    reasons.push("losing the straight fight");
  }
  if (hasRanged) {
    score += 0.3;
    reasons.push("somewhere to shoot from");
  }

  return [{ kind: "hide", target: nearest, spot, observer: nearest.name, score, reasons }];
}

/**
 * Going to look where the quarry went.
 *
 * The other half of the awareness fix: filtering an unseen enemy off the board stops a creature walking
 * straight to a rogue it cannot see, and on its own it leaves that creature with nothing to do — which
 * at the table reads as the hide having switched the monsters off rather than having worked. So it goes
 * to the last place it saw them, which is what a thing that has lost sight of its quarry does, and is
 * also the movement most likely to restore line of sight and end the hide honestly.
 *
 * Offered only when nothing is visible, `advance`'s rule and for `advance`'s reason: a creature with
 * somebody in front of it should fight that, not go looking for the one that got away.
 *
 * NOTHING HERE KNOWS WHERE THE HIDER IS. The option carries a remembered point, the execution layer
 * walks to a point, and if the rogue moved after breaking sight then the creature searches an empty
 * patch of floor — which is the correct outcome and the entire value of having hidden.
 */
export function searchOptions(board: Board, p: TierProfile, hasBetter: boolean): PlanOption[] {
  if (hasBetter || !can(p, "searchLastSeen")) return [];
  if (board.enemies.length > 0) return [];
  const lost = board.unseen[0];
  if (!lost || board.speed === null || board.speed <= 0) return [];

  // Already standing on the spot: there is nothing left to search, and walking a step to arrive where
  // it already is would burn the turn reporting movement that never happened.
  const square = Number((globalThis as any).canvas?.scene?.grid?.distance) || 5;
  const arrived = lost.distance <= square;

  return [
    {
      kind: "search",
      lost,
      // Above the call-for-help floor and below a real attack, which it can never compete with anyway
      // — this is only generated when there are no attacks to be had.
      score: arrived ? 0.8 : 1.1,
      reasons: arrived
        ? [`lost ${lost.name} right about here`]
        : [`lost sight of ${lost.name}`, `last seen ${Math.round(lost.distance)} ${board.units} away`],
    },
  ];
}

/**
 * Getting out of something that is burning you.
 *
 * Scored above a routine attack but not above self-preservation, and only offered when a way out was
 * actually found — a creature announcing that it steps clear of the fire and then standing in it is
 * worse than one that never noticed. Below `understandsHazards` on the ladder a creature genuinely does
 * not work this out: an ooze in a cloud of poison stays in the cloud, and that is correct.
 *
 * The scaling is on how hurt it already is. A dragon at full health shrugs off a burning square to keep
 * fighting; the same dragon at a quarter health leaves.
 */
function hazardOptions(board: Board, p: TierProfile): PlanOption[] {
  if (!can(p, "understandsHazards")) return [];

  const standing = hazardsUnder(board.self.token);
  if (standing.length === 0) return [];

  const budget = board.speed ?? 0;
  const spot = findWayOut(board.self.token, budget);
  if (!spot) return [];

  const worst = Math.max(...standing.map((h) => h.severity));
  const hp = board.self.hpFraction;
  const urgency = hp === null ? 1 : 1 + (1 - hp);
  const trapped = standing.some((h) => h.restrains);

  return [
    {
      kind: "escape",
      spot,
      // Halved when something is holding it in place: it may not get out at all, and a creature that
      // spends its whole turn failing to escape a web should sometimes just attack from inside it.
      score: worst * urgency * (trapped ? 0.5 : 1),
      reasons: [
        `standing in ${standing.map((h) => h.label).join(" and ")}`,
        `clear ground ${spot.travel} ${board.units} ${spot.bearing}`,
      ],
    },
  ];
}

/**
 * `hasAny` is every other option this creature came up with, and the floor is only offered when there
 * are none.
 *
 * A LOW SCORE IS NOT A FLOOR AT HIGH NOISE, and the comment below said "rarely the best choice" while
 * the arithmetic said otherwise. `noise` is 0.85 at tier 1 precisely so that a stupid creature does not
 * play optimally, which flattens the distribution — so 0.35 against advancing's 0.9 is close to a coin
 * flip, and a Troll Limb spent about half its turns bellowing for help within earshot of the limb it
 * was standing next to. Reported, reasonably, as the limbs "sitting in place calling for help" rather
 * than moving.
 *
 * The fix is not to lower the number: noise flattens whatever spread it is given, so any score reachable
 * by consideration is reachable by choice. `advance` had this right from the start — it takes `hasBetter`
 * and declines outright — and the floor needs the same treatment for the same reason. **An option that
 * must never beat a real one has to be absent, not cheap.**
 *
 * Fleeing keeps its score, because it is a genuine choice competing on merit rather than a floor: a
 * badly hurt creature SHOULD sometimes run instead of swinging, and noise is what makes that a
 * temperament rather than a threshold.
 */
export function survivalOptions(board: Board, p: TierProfile, hasAny: boolean): PlanOption[] {
  const options: PlanOption[] = [];
  const hp = board.self.hpFraction;

  if (can(p, "fleeWhenHurt") && hp !== null && hp < DESPERATE) {
    options.push({
      kind: "flee",
      // Outweighs a routine attack once it is genuinely desperate, without ever being automatic.
      score: 1.4 + 2.5 * (DESPERATE - hp) * 4,
      reasons: ["would rather live"],
    });
  }
  // Nothing in sight is the case this option exists for, and there it is the best thing available
  // rather than a floor — so it is offered on its own terms even though something else may have been
  // generated (a hazard to step out of, an ally to help).
  //
  // A creature that has merely LOST somebody is not in that case: it knows where to look, and searching
  // is the better answer. Without this the bellow at 1.2 outscores the search at 1.1 and the fix above
  // would present as the monsters standing around shouting instead of pursuing.
  const blind = board.enemies.length === 0 && board.unseen.length === 0;
  if (can(p, "callForHelp") && (blind || !hasAny)) {
    options.push({
      kind: "call",
      score: blind ? 1.2 : 0.35,
      reasons: blind ? ["nothing in sight"] : ["nothing else it can reach"],
    });
  }
  return options;
}

// ---- choosing ------------------------------------------------------------------------------------

/**
 * Weighted-random pick. `noise` widens the distribution: near 0 the best option is nearly certain,
 * near 1 everything under consideration is roughly equally likely.
 */
function weightedChoice(options: PlanOption[], noise: number, rand: () => number): PlanOption {
  const temperature = Math.max(0.08, noise) * 1.5;
  const best = Math.max(...options.map((o) => o.score));
  const weights = options.map((o) => Math.exp((o.score - best) / temperature));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rand() * total;
  for (let i = 0; i < options.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return options[i];
  }
  return options[options.length - 1];
}

/**
 * Ending the turn behind something solid.
 *
 * Tested against the FURTHEST player (user's call): distant opponents are the ones still shooting at
 * the end of a round, and one observer keeps this to a few dozen ray casts. The known hole is that
 * cover from the far archer is not cover from the near one — accepted deliberately, because the
 * alternative on a per-turn budget was announcing an intention and computing nothing.
 *
 * Budget is half the creature's speed: it has already spent movement acting, and we do not track how
 * much. Half is the conservative guess — it under-promises rather than proposing a shuffle the
 * creature could not actually afford.
 */
function coverIntent(
  board: Board,
  p: TierProfile,
  chosen: PlanOption,
  threat: (enemy: BoardActor) => ThreatProfile,
  rand: () => number,
  remainingSpeed: number,
): { text: string; spot: Spot } | undefined {
  if (!can(p, "seekCover")) return undefined;
  // Already leaving, already breaking away, or already hiding: the movement is spoken for.
  if (
    chosen.kind === "flee" ||
    chosen.kind === "kite" ||
    chosen.kind === "hide" ||
    chosen.kind === "escape"
  ) {
    return undefined;
  }
  if (!(remainingSpeed > 0)) return undefined;

  const shooters = board.enemies.filter((e) => threat(e).hasRanged);
  if (shooters.length === 0) return undefined;

  const facing = playerFacing(board);
  const furthest = facing[facing.length - 1];
  if (!furthest) return undefined;

  const spot = findConcealment(board.self.token, furthest.token, remainingSpeed / 2, rand);
  // No reachable cover means no claim of cover. Announcing an intention we could not satisfy would
  // have the GM hunting for a wall that isn't there.
  if (!spot) return undefined;

  return {
    text: `then falls back ${spot.travel} ${board.units} ${spot.bearing} into cover from ${furthest.name}`,
    spot,
  };
}

/**
 * Decide one creature's turn. Returns null only when there is nothing to decide (no board, or the
 * creature has no conceivable option), which the caller reports rather than silently skipping.
 */
export function planTurn(combatant: any): TurnPlan | null {
  const raw = readBoard(combatant);
  if (!raw) return null;
  // The tracker is omniscient and the creature is not. Everything below plans against what this one
  // can actually perceive — see `awareness.ts`.
  const board = applyAwareness(raw);

  const P = systemPaths();
  const actor = combatant.actor;
  const mental = mentalScore(pickNumber(actor, P.intelligence), pickNumber(actor, P.wisdom));
  // An unreadable sheet lands mid-ladder rather than at insect: a missing number should not turn a
  // dragon into a beetle.
  const profile = tierProfile(mental === null ? 4 : tierForScore(mental));

  const kit = readActions(actor);
  const threatCache = new Map<string, ThreatProfile>();
  const threat = (enemy: BoardActor) => threatOf(enemy, P, threatCache);

  const rand = turnRandom(String(combatant?.id ?? ""), "tactics");
  // Its own stream, so switching readying off cannot shift every other number the planner draws — the
  // same rule banter follows, and for the same reason (see `core/random.ts`).
  const readyRand = turnRandom(String(combatant?.id ?? ""), "ready");

  const offensive = attackOptions(board, kit, profile, threat);
  // Everything the creature can actually do, gathered before the floor is considered — the call for
  // help is only in the running when this comes back empty. See `survivalOptions`.
  const real = [
    ...offensive,
    ...advanceOptions(board, kit, offensive.length > 0),
    ...searchOptions(board, profile, offensive.length > 0),
    ...readyOptions(board, kit, profile, offensive.length > 0, readyRand),
    ...healingOptions(board, kit, profile),
    ...controlOptions(board, kit, profile),
    ...kiteOptions(board, kit, profile, threat),
    ...hideOptions(board, kit, profile, rand),
    ...helpOptions(board, profile, threat),
    ...yieldOptions(board, profile, actor),
    ...hazardOptions(board, profile),
  ];
  const options = [...real, ...survivalOptions(board, profile, real.length > 0)];
  if (options.length === 0) return null;

  // Breadth is the creature's attention span: it weighs only the most promising handful, which is
  // both the tier's cognitive limit and the CPU ceiling for the turn.
  const considered = options.sort((a, b) => b.score - a.score).slice(0, profile.breadth);

  const chosen = weightedChoice(considered, profile.noise, rand);
  const step = Number((globalThis as any).canvas?.scene?.grid?.distance ?? 5) || 5;
  const travels =
    chosen.kind === "close" ||
    chosen.kind === "advance" ||
    chosen.kind === "search" ||
    chosen.kind === "help" ||
    chosen.kind === "flee" ||
    chosen.kind === "escape" ||
    chosen.kind === "hide" ||
    chosen.kind === "kite" ||
    (chosen.approach ?? 0) > 0;
  const stand = shouldStand({
    prone: isProne(actor),
    speed: board.speed,
    keepDistance: can(profile, "keepDistance"),
    meleeWithin5: board.enemies.some((e) => e.distance <= step + 0.01),
    travels,
    meleeAttack:
      chosen.kind === "close" ||
      (chosen.kind === "attack" &&
        chosen.attackMode !== "ranged" &&
        chosen.attackMode !== "thrown"),
    flies: board.locomotion.primary === "fly",
  });
  const remaining =
    stand && board.speed != null ? Math.max(0, board.speed - standCost(board.speed)) : (board.speed ?? 0);
  // Staying Prone is a stay-put tactic. Cover after the shot would crawl them into the open.
  const cover =
    !isProne(actor) || stand
      ? coverIntent(board, profile, chosen, threat, rand, remaining)
      : undefined;

  return {
    profile,
    mental,
    chosen,
    considered,
    board,
    postscript: cover?.text,
    coverSpot: cover?.spot,
    stand,
  };
}
