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

import { pickNumber, pickString, systemPaths, type SystemPaths } from "../system-profiles";
import { readBoard, type Board, type BoardActor } from "./board";
import { can, mentalScore, tierForScore, tierProfile, type TierProfile } from "./tiers";

/** Below this fraction of maximum hit points a creature considers itself in trouble. */
const BLOODIED = 0.5;
const DESPERATE = 0.25;

export type PlanKind =
  "attack" | "heal-self" | "heal-ally" | "control" | "flee" | "call" | "close" | "kite";

export interface PlanOption {
  kind: PlanKind;
  /** Item being used, when the option involves one. */
  item?: any;
  itemName?: string;
  target?: BoardActor;
  /** Distance that must be crossed first, in scene units. */
  approach?: number;
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
}

// ---- seeded randomness ------------------------------------------------------------------------

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, and good enough for picking between a dozen options. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- reading the creature's own kit ------------------------------------------------------------

interface Usable {
  item: any;
  name: string;
  /** dnd5e-style coarse type; "" when the system doesn't report one. */
  actionType: string;
  melee: boolean;
  /** Effective reach/range in scene units. */
  range: number;
  /** False when charges, ammunition, or quantity say it is spent. */
  available: boolean;
}

const MELEE_TYPES = new Set(["mwak", "msak", "melee"]);
const RANGED_TYPES = new Set(["rwak", "rsak", "ranged"]);
const ATTACK_TYPES = new Set([...MELEE_TYPES, ...RANGED_TYPES]);

function readUsables(actor: any, P: SystemPaths): Usable[] {
  const out: Usable[] = [];
  for (const item of actor?.items ?? []) {
    const actionType = pickString(item, P.itemActionType).toLowerCase();
    if (!actionType) continue;

    const usesMax = pickNumber(item, P.itemUsesMax);
    const spent = pickNumber(item, P.itemUsesSpent);
    const remaining =
      pickNumber(item, P.itemUses) ??
      (usesMax !== null && spent !== null ? Math.max(0, usesMax - spent) : null);
    const quantity = pickNumber(item, P.itemQuantity);

    // Ammunition: a bow with an empty quiver is not an option, which is the whole point of the
    // archer example. Consumables with a quantity of zero are equally gone.
    let available = true;
    if (remaining !== null && usesMax !== null && usesMax > 0 && remaining <= 0) available = false;
    if (quantity !== null && quantity <= 0) available = false;
    const ammoId = pickString(item, P.itemConsumeTarget);
    if (ammoId) {
      const ammo = actor?.items?.get?.(ammoId);
      const ammoQty = ammo ? pickNumber(ammo, P.itemQuantity) : null;
      if (ammoQty !== null && ammoQty <= 0) available = false;
    }

    const melee = MELEE_TYPES.has(actionType);
    const rangeValue = pickNumber(item, P.itemRange);
    out.push({
      item,
      name: String(item?.name ?? "?"),
      actionType,
      melee,
      // A melee weapon with no stated reach still reaches an adjacent square; the exact number is a
      // rules detail we deliberately do not model, so one grid step is the honest default.
      range: rangeValue ?? (melee ? Number((canvas as any)?.scene?.grid?.distance ?? 5) : 30),
      available,
    });
  }
  return out;
}

/** What an opponent can do back, which is all the creature needs to decide how close to stand. */
interface ThreatProfile {
  /** Farthest a melee-style attack of theirs reaches, in scene units; 0 when they have none. */
  meleeReach: number;
  hasRanged: boolean;
}

function threatOf(enemy: BoardActor, P: SystemPaths, cache: Map<string, ThreatProfile>) {
  const key = enemy.combatantId;
  const cached = cache.get(key);
  if (cached) return cached;

  const kit = readUsables(enemy.actor, P);
  const melee = kit.filter((u) => MELEE_TYPES.has(u.actionType));
  const grid = Number((canvas as any)?.scene?.grid?.distance ?? 5);
  // An opponent whose sheet says nothing readable is assumed able to hit you if you stand next to
  // it. Guessing "harmless" would walk archers into a grapple on every unfamiliar system.
  const unreadable = kit.length === 0;
  const profile: ThreatProfile = {
    meleeReach: unreadable ? grid : melee.reduce((max, u) => Math.max(max, u.range), 0),
    hasRanged: unreadable ? false : kit.some((u) => RANGED_TYPES.has(u.actionType)),
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
  const hasRangedOption = kit.some((u) => u.available && RANGED_TYPES.has(u.actionType));

  for (const usable of kit) {
    if (!usable.available || !ATTACK_TYPES.has(usable.actionType)) continue;

    for (const enemy of board.enemies) {
      const gap = enemy.distance - usable.range;
      const inReach = gap <= 0;
      // Closing the gap is only an option if the creature could plausibly cover it this turn.
      if (!inReach && (board.speed === null || gap > board.speed)) continue;

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
        target: enemy,
        approach: inReach ? 0 : gap,
        score,
        reasons,
      });
    }
  }
  return options;
}

function healingOptions(board: Board, kit: Usable[], p: TierProfile): PlanOption[] {
  const options: PlanOption[] = [];
  const healers = kit.filter((u) => u.available && u.actionType === "heal");
  if (healers.length === 0) return options;

  const selfHp = board.self.hpFraction;
  for (const usable of healers) {
    if (can(p, "selfHealing") && selfHp !== null && selfHp < BLOODIED) {
      options.push({
        kind: "heal-self",
        item: usable.item,
        itemName: usable.name,
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
  if (!can(p, "controlManeuvers")) return [];
  // "save"-type items are the closest thing to a system-agnostic marker for effects that impose
  // something rather than deal damage. Stealth, deception, and disarm proper need identifiers we
  // cannot read generically yet — see the gaps note in AGENTS.md.
  return kit
    .filter((u) => u.available && u.actionType === "save")
    .flatMap((usable) =>
      board.enemies
        .filter((e) => e.distance <= usable.range)
        .map((enemy) => ({
          kind: "control" as const,
          item: usable.item,
          itemName: usable.name,
          target: enemy,
          score: 1.1 + (can(p, "targetHighestThreat") && enemy.spellCount > 0 ? 0.6 : 0),
          reasons: ["shut them down rather than trade blows"],
        })),
    );
}

/**
 * Backing out of melee and shooting from the new spot. Distinct from fleeing: the creature is not
 * leaving the fight, it is refusing to have it at arm's length.
 */
function kiteOptions(
  board: Board,
  kit: Usable[],
  p: TierProfile,
  threat: (enemy: BoardActor) => ThreatProfile,
): PlanOption[] {
  if (!can(p, "keepDistance")) return [];
  if (board.speed === null || board.speed <= 0) return [];

  const ranged = kit.find((u) => u.available && RANGED_TYPES.has(u.actionType));
  if (!ranged) return [];

  const crowding = board.enemies.filter((e) => e.distance <= threat(e).meleeReach);
  if (crowding.length === 0) return [];

  // Shoot whoever is still worth shooting once it has stepped away — usually the one that closed.
  const target =
    board.enemies.find((e) => e.distance <= ranged.range && !crowding.includes(e)) ?? crowding[0];

  return [
    {
      kind: "kite",
      item: ranged.item,
      itemName: ranged.name,
      target,
      score: 1.3 + 0.45 * Math.min(1, crowding.length / 2),
      reasons: [
        crowding.length > 1 ? "hemmed in by melee" : `${crowding[0].name} is close enough to swing`,
      ],
    },
  ];
}

function survivalOptions(board: Board, p: TierProfile): PlanOption[] {
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
  if (can(p, "callForHelp")) {
    options.push({
      kind: "call",
      // A floor option: something to do when nothing else is reachable, rarely the best choice.
      score: board.enemies.length === 0 ? 1.2 : 0.35,
      reasons: board.enemies.length === 0 ? ["nothing in sight"] : ["rallying the others"],
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
 * Ending the turn behind something solid, stated as an intent rather than a computed destination.
 *
 * Choosing a real cover square needs line-of-sight sampling against every shooter and the scene's
 * walls, which is the positioning layer's job (N5) and far too expensive to bolt on here. Announcing
 * the intent is still worth doing: the GM placing the token knows the creature meant to end up out of
 * sight, which is the part that changes how the next round plays.
 */
function coverIntent(
  board: Board,
  p: TierProfile,
  chosen: PlanOption,
  threat: (enemy: BoardActor) => ThreatProfile,
): string | undefined {
  if (!can(p, "seekCover")) return undefined;
  // Already leaving, or nobody can shoot it where it stands: no reason to spend the movement.
  if (chosen.kind === "flee" || chosen.kind === "kite") return undefined;
  const shooters = board.enemies.filter((e) => threat(e).hasRanged);
  if (shooters.length === 0) return undefined;
  return "then moves to put cover between itself and the ranged attackers";
}

/**
 * Decide one creature's turn. Returns null only when there is nothing to decide (no board, or the
 * creature has no conceivable option), which the caller reports rather than silently skipping.
 */
export function planTurn(combatant: any): TurnPlan | null {
  const board = readBoard(combatant);
  if (!board) return null;

  const P = systemPaths();
  const actor = combatant.actor;
  const mental = mentalScore(pickNumber(actor, P.intelligence), pickNumber(actor, P.wisdom));
  // An unreadable sheet lands mid-ladder rather than at insect: a missing number should not turn a
  // dragon into a beetle.
  const profile = tierProfile(mental === null ? 4 : tierForScore(mental));

  const kit = readUsables(actor, P);
  const threatCache = new Map<string, ThreatProfile>();
  const threat = (enemy: BoardActor) => threatOf(enemy, P, threatCache);

  const options = [
    ...attackOptions(board, kit, profile, threat),
    ...healingOptions(board, kit, profile),
    ...controlOptions(board, kit, profile),
    ...kiteOptions(board, kit, profile, threat),
    ...survivalOptions(board, profile),
  ];
  if (options.length === 0) return null;

  // Breadth is the creature's attention span: it weighs only the most promising handful, which is
  // both the tier's cognitive limit and the CPU ceiling for the turn.
  const considered = options.sort((a, b) => b.score - a.score).slice(0, profile.breadth);

  const seed = hashString(
    `${game.combat?.id ?? ""}:${game.combat?.round ?? 0}:${combatant?.id ?? ""}`,
  );
  const chosen = weightedChoice(considered, profile.noise, seededRandom(seed));

  return {
    profile,
    mental,
    chosen,
    considered,
    board,
    postscript: coverIntent(board, profile, chosen, threat),
  };
}
