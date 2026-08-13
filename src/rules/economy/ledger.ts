// What a creature has spent this turn, and how much it had to spend.
//
// dnd5e does not track this. Verified in 5.3.3 rather than assumed: `CONFIG.DND5E.activityActivationTypes`
// gives each activation type an optional `consume` property naming an actor resource pool, and exactly
// three declare one — `legendary`, `mythic` (both spending `resources.legact`) and `crew` (vehicles). The
// entries for `action`, `bonus` and `reaction` carry a label, a header and a group and nothing else, and
// the whole enforcement block in `Activity#_prepareUsageUpdates` is gated on `activationConfig?.consume`
// being present. So the "not enough actions" warning the system already ships is unreachable for ordinary
// actions, and no counter for them exists anywhere in the data model. The system's own JSDoc says so:
// "Should action economy be tracked? Currently only handles legendary actions." It is roadmapped ("Action
// tracking", dnd5e 5.0.0 release notes) and unshipped.
//
// Legendary, mythic and crew actions are therefore deliberately NOT tracked here — the system already
// does those properly, and counting them twice would be worse than not counting them at all.
//
// WHERE THE STATE LIVES. On the actor, as a flag, not in a Map on the GM's client. The veto hook fires on
// whichever client used the item, so a player's browser has to be able to read and write its own budget;
// GM-side memory would be invisible to exactly the person it needs to stop. Writing through the actor
// also gets unlinked tokens right for free, because `token.actor.setFlag` lands in that token's
// ActorDelta rather than on the shared base actor — eight skeletons off one prototype keep eight budgets.
//
// HOW IT RESETS. It does not, actively. There is no reset hook and nothing is ever cleared, because a
// stored tally carries the stamp of the turn it belongs to and a tally from a stamp that is no longer
// current simply reads as zero. That is not a shortcut: an active reset needs someone to perform the
// write, and the only client entitled to write every actor is the GM, which reintroduces the race the
// flag storage was chosen to avoid. Deriving the stamp means every client computes the same answer from
// state it already has, with no write and nothing to go stale.
//
// The stamp is the round in which the creature's own turn most recently began, which is what "refreshes
// at the start of your turn" means for all three slots in the 2024 rules (user, 2026-08-05). A reaction
// spent on someone else's turn earlier in the round belongs to the previous stamp, and so survives until
// the creature's own turn comes round — which is the behaviour the rules describe and the behaviour a
// naive per-round reset gets wrong.

import { MODULE_ID } from "../../constants";
import { numberFlag, readFlag } from "../../util/flags";
import { capabilityAttacksPerAction } from "../../capability/bindings";

export type Slot = "action" | "bonus" | "reaction";

/**
 * A creature's spending, valid only for the turn identified by `stamp`.
 *
 * `action` counts actions spent on things that are NOT attacks, and `attack` counts attack rolls, which
 * are deliberately not the same currency: one Action buys several attacks for anything with Extra Attack
 * or Multiattack. Actions used is therefore `action + ceil(attack / attacksPerAction)`, and keeping the
 * two apart is what stops a fighter's second swing being charged as a second Action.
 */
interface Tally {
  stamp: string;
  action: number;
  bonus: number;
  reaction: number;
  attack: number;
  /**
   * Dashes bought this turn, each worth another Speed of movement. The slot that paid for it is already
   * counted above — an Action normally, a bonus action for anything with Cunning Action or its relatives.
   */
  dash: number;
  /**
   * Extra attacks taken this turn from the Light property, which the rules allow once and once only.
   *
   * Counted separately from `attack` because the Light swing is not bought by the Attack action: it
   * costs the bonus action, or nothing at all with the Nick mastery. Folding it into `attack` would
   * charge it against a budget it does not draw on, and leaving it uncounted would make the Nick case
   * unlimited — free and unbounded are not the same thing.
   */
  light: number;
}

const FLAG = "spent";

/**
 * Same-client shadow of what has been written, merged over the flag on read.
 *
 * `setFlag` is a round trip, and two attacks a third of a second apart both read the pre-write value
 * without this. The flag remains the shared truth; this only stops the acting client racing itself.
 */
const local = new Map<string, Tally>();

function zero(stamp: string): Tally {
  return { stamp, action: 0, bonus: 0, reaction: 0, attack: 0, dash: 0, light: 0 };
}

/** The activation types this file is willing to police. Everything else is somebody else's business. */
export function slotFor(activationType: unknown): Slot | null {
  const type = String(activationType ?? "");
  if (type === "action" || type === "bonus" || type === "reaction") return type;
  return null;
}

/**
 * Which turn a creature's budget currently belongs to.
 *
 * Derived rather than stored, so that every client agrees without anyone writing anything. If the fight
 * has already passed this creature's place in the order, its most recent turn began this round;
 * otherwise it began in the previous one, and the budget from that turn is still the live one.
 */
export function stampFor(combat: any, combatant: any): string {
  const turns: any[] = combat?.turns ?? [];
  const id = String(combatant?.id ?? "");
  const mine = turns.findIndex((c: any) => String(c?.id ?? "") === id);
  const round = Number(combat?.round ?? 0);
  const now = Number(combat?.turn ?? 0);
  const began = mine >= 0 && now >= mine ? round : round - 1;
  return `${String(combat?.id ?? "")}:${began}`;
}

function readTally(actor: any, stamp: string): Tally {
  let tally = zero(stamp);
  try {
    // Both namespaces, so a world upgraded mid-fight does not hand everyone a fresh turn's worth of
    // actions. A stale stamp reads as zero anyway, so the fallback can only help.
    const stored = readFlag(actor, FLAG) as any;
    if (stored && String(stored.stamp) === stamp) {
      tally = {
        stamp,
        action: Number(stored.action) || 0,
        bonus: Number(stored.bonus) || 0,
        reaction: Number(stored.reaction) || 0,
        attack: Number(stored.attack) || 0,
        dash: Number(stored.dash) || 0,
        light: Number(stored.light) || 0,
      };
    }
  } catch {
    /* an unreadable flag is an empty budget, which errs towards letting the table play */
  }

  const shadow = local.get(String(actor?.uuid ?? ""));
  if (shadow && shadow.stamp === stamp) {
    tally.action = Math.max(tally.action, shadow.action);
    tally.bonus = Math.max(tally.bonus, shadow.bonus);
    tally.reaction = Math.max(tally.reaction, shadow.reaction);
    tally.attack = Math.max(tally.attack, shadow.attack);
    tally.dash = Math.max(tally.dash, shadow.dash);
    tally.light = Math.max(tally.light, shadow.light);
  }
  return tally;
}

/**
 * How many of a slot the creature gets, before anything is spent.
 *
 * One each, plus whatever an effect has granted. The extra is read from a flag so that Haste and its
 * relatives can be expressed as an ordinary Active Effect — `flags.noodlr.extraAction`, mode Add, value 1
 * — instead of needing to be known about here. That matters more than it looks: the rules are full of
 * features that hand out an economy slot the general rule says you do not have, and a system that cannot
 * express them makes those features unplayable (user, 2026-08-05).
 */
export function allowance(actor: any, slot: Slot): number {
  const key = slot === "action" ? "extraAction" : slot === "bonus" ? "extraBonus" : "extraReaction";
  const extra = numberFlag(actor, key) ?? 0;
  return Math.max(1, 1 + Math.max(0, extra));
}

/** Words a stat block uses for how many attacks a Multiattack makes. */
const COUNTS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/**
 * How many attack rolls one Attack action buys.
 *
 * This is the whole reason action tracking is hard, and the reason nobody in the ecosystem has shipped
 * it. An Action is not an attack: a level 11 fighter's single Action is three attack rolls, and a system
 * that counts rolls instead of actions stops that fighter dead on their second swing — the most common
 * thing that happens in the game, broken by the feature meant to make the game more correct.
 *
 * For characters this is genuinely machine-readable, which I did not expect: dnd5e's class features
 * carry stable `system.identifier` values, so `extra-attack`, `two-extra-attacks` and
 * `three-extra-attacks` (fighter, at 11 and 20) can be read rather than inferred from class levels.
 *
 * For monsters there is no such field, so Multiattack's prose is read for a number word. That is a
 * genuine heuristic and it is biased deliberately: an unparseable Multiattack yields 2 rather than 1,
 * because letting a creature swing once too often is a bad turn, while blocking a legal attack is a bug
 * report. `flags.noodlr.attacksPerAction` overrides the lot.
 */
export function attacksPerAction(actor: any): number {
  return explainAttacksPerAction(actor).value;
}

/**
 * The same answer, plus what produced it.
 *
 * A diagnostic that reports only the number cannot distinguish a fighter correctly read at 3 from a
 * monster whose Multiattack failed to parse and defaulted to 2 — and those want opposite fixes. This is
 * where the real detection lives; `attacksPerAction` is the thin caller so the two can never disagree.
 */
export function explainAttacksPerAction(actor: any): { value: number; source: string } {
  const override = numberFlag(actor, "attacksPerAction");
  if (override !== null && override > 0)
    return { value: override, source: `flags.*.attacksPerAction (${override})` };

  const items: any[] = Array.from(actor?.items ?? []);
  const ids = new Set<string>();
  for (const item of items) {
    const id = String(item?.system?.identifier ?? "").toLowerCase();
    if (id) ids.add(id);
  }
  if (ids.has("three-extra-attacks"))
    return { value: 4, source: "identifier: three-extra-attacks" };
  if (ids.has("two-extra-attacks")) return { value: 3, source: "identifier: two-extra-attacks" };
  // Devouring Blade before Thirsting Blade, because it requires it: a level 12 Pact of the Blade
  // warlock carries both, and the later invocation is the one that says how many. "The Extra Attack of
  // your Thirsting Blade invocation confers two extra attacks rather than one."
  if (ids.has("devouring-blade")) return { value: 3, source: "identifier: devouring-blade" };
  if (ids.has("extra-attack")) return { value: 2, source: "identifier: extra-attack" };
  // Thirsting Blade grants Extra Attack for the pact weapon only, and does it as an INVOCATION rather
  // than as a class feature — so it carries no `extra-attack` identifier and a Pact of the Blade
  // warlock read as having one attack, with their second swing refused. The pact-weapon restriction is
  // deliberately not modelled: refusing a legal attack is the failure worth avoiding, and a warlock
  // swinging a longbow twice is a worse turn rather than a broken one.
  if (ids.has("thirsting-blade")) return { value: 2, source: "identifier: thirsting-blade" };

  // A compiled capability, when the scene has been through the capability compiler. Above the prose
  // regex below and beneath the identifiers above, which is the honest ordering: authored structured
  // data beats a model reading a sentence, and a model reading the whole sentence beats a regular
  // expression hunting for the first number word in it. Null in a world that has compiled nothing.
  const compiled = capabilityAttacksPerAction(actor);
  if (compiled !== null) return { value: compiled, source: `compiled capability (${compiled})` };

  const multi = items.find((i: any) => /^multiattack\b/i.test(String(i?.name ?? "")));
  if (multi) {
    const text = String(multi?.system?.description?.value ?? "").replace(/<[^>]*>/g, " ");
    const worded = /\b(one|two|three|four|five|six)\b\s+(?:\w+\s+){0,3}attacks?\b/i.exec(text);
    if (worded)
      return {
        value: COUNTS[worded[1].toLowerCase()] ?? 2,
        source: "Multiattack prose (number word)",
      };
    const digits = /\b([1-9])\b\s+(?:\w+\s+){0,3}attacks?\b/.exec(text);
    if (digits) return { value: Number(digits[1]), source: "Multiattack prose (digit)" };
    return { value: 2, source: "Multiattack present but unparsed (default 2)" };
  }
  return { value: 1, source: "no Extra Attack or Multiattack found" };
}

/** Actions a tally has actually consumed, attacks folded back into the actions that bought them. */
function actionsUsed(tally: Tally, per: number): number {
  return tally.action + Math.ceil(tally.attack / Math.max(1, per));
}

export interface Verdict {
  /** May it go ahead without anyone being asked? */
  allowed: boolean;
  /** What ran out, for the message shown when it did not. */
  slot: Slot;
  spent: number;
  max: number;
  /** True when this attack rides on an Attack action already paid for, so nothing new is spent. */
  free: boolean;
}

/**
 * Would spending this slot be legal, and what would it cost?
 *
 * `isAttack` splits the Attack action from everything else: the first swing buys an action and the rest
 * of that action's allowance rides along on it. Both still draw on the same pool of actions, so a wizard
 * who has already cast a spell this turn has nothing left to attack with.
 */
export function check(
  actor: any,
  combat: any,
  combatant: any,
  slot: Slot,
  isAttack: boolean,
): Verdict {
  const stamp = stampFor(combat, combatant);
  const tally = readTally(actor, stamp);
  const max = allowance(actor, slot);

  if (slot === "action" && isAttack) {
    const per = attacksPerAction(actor);
    const needed = tally.action + Math.ceil((tally.attack + 1) / per);
    return {
      allowed: needed <= max,
      slot,
      spent: tally.attack,
      max: Math.max(0, max - tally.action) * per,
      free: tally.attack % per !== 0,
    };
  }

  if (slot === "action") {
    const used = actionsUsed(tally, attacksPerAction(actor));
    return { allowed: used < max, slot, spent: used, max, free: false };
  }

  return { allowed: tally[slot] < max, slot, spent: tally[slot], max, free: false };
}

/** Record the spend. Writes through to the actor so every client sees it; never throws. */
export function spend(
  actor: any,
  combat: any,
  combatant: any,
  slot: Slot,
  isAttack: boolean,
): void {
  const stamp = stampFor(combat, combatant);
  const tally = readTally(actor, stamp);

  if (slot === "action" && isAttack) tally.attack += 1;
  else tally[slot] += 1;

  local.set(String(actor?.uuid ?? ""), tally);
  try {
    void Promise.resolve(actor?.setFlag?.(MODULE_ID, FLAG, tally)).catch(() => {
      /* the shadow above already has it for this client; a failed write costs cross-client accuracy only */
    });
  } catch {
    /* an actor we may not write is an actor we do not police */
  }
}

/**
 * Dashes bought this turn, each worth another Speed of movement.
 *
 * Kept in the turn ledger rather than alongside the movement code so that it resets on exactly the same
 * lazy stamp as the Action that paid for it. A Dash counted anywhere else would have to be reset by
 * somebody, and whoever that was would eventually disagree with this file about when the turn began.
 */
export function dashesTaken(actor: any, combat: any, combatant: any): number {
  return readTally(actor, stampFor(combat, combatant)).dash;
}

/** Extra Light-weapon attacks already taken this turn. The rules allow exactly one. */
export function lightSwings(actor: any, combat: any, combatant: any): number {
  return readTally(actor, stampFor(combat, combatant)).light;
}

/**
 * Record the Light property's extra attack, and the slot it cost.
 *
 * `slot` is null for the Nick mastery, which folds the swing into the Attack action and so spends
 * nothing — but it is still counted, because the once-per-turn limit is the rule and "free" is not
 * "unlimited". Which of the two applies is a reading of the weapon, and lives in the system table.
 */
export function takeLightSwing(
  actor: any,
  combat: any,
  combatant: any,
  slot: "bonus" | null,
): void {
  const stamp = stampFor(combat, combatant);
  const tally = readTally(actor, stamp);
  if (slot) tally[slot] += 1;
  tally.light += 1;
  local.set(String(actor?.uuid ?? ""), tally);
  try {
    void Promise.resolve(actor?.setFlag?.(MODULE_ID, FLAG, tally)).catch(() => {
      /* see spend() */
    });
  } catch {
    /* ditto */
  }
}

/**
 * Charge a Dash, and record the extra Speed it bought.
 *
 * The slot is the caller's decision, not this file's: Dash costs an Action by the general rule, but
 * Cunning Action, Step of the Wind and Expeditious Retreat all make it a bonus action instead, and which
 * of those applies is a system-specific reading of the sheet.
 */
export function takeDash(actor: any, combat: any, combatant: any, slot: "action" | "bonus"): void {
  const stamp = stampFor(combat, combatant);
  const tally = readTally(actor, stamp);
  tally[slot] += 1;
  tally.dash += 1;
  local.set(String(actor?.uuid ?? ""), tally);
  try {
    void Promise.resolve(actor?.setFlag?.(MODULE_ID, FLAG, tally)).catch(() => {
      /* see spend() */
    });
  } catch {
    /* ditto */
  }
}

/** Give a slot back, for a use that was announced and then failed to resolve. */
export function refund(actor: any, combat: any, combatant: any, slot: Slot): void {
  const stamp = stampFor(combat, combatant);
  const tally = readTally(actor, stamp);
  tally[slot] = Math.max(0, tally[slot] - 1);
  local.set(String(actor?.uuid ?? ""), tally);
  try {
    void Promise.resolve(actor?.setFlag?.(MODULE_ID, FLAG, tally)).catch(() => {
      /* see spend() */
    });
  } catch {
    /* ditto */
  }
}

/** Everything a creature has left, for diagnostics and for the planner to reason with. */
export function budget(actor: any, combat: any, combatant: any): Record<string, number> {
  const stamp = stampFor(combat, combatant);
  const tally = readTally(actor, stamp);
  const per = attacksPerAction(actor);
  const actions = allowance(actor, "action");
  return {
    action: actions - actionsUsed(tally, per),
    bonus: allowance(actor, "bonus") - tally.bonus,
    reaction: allowance(actor, "reaction") - tally.reaction,
    attack: Math.max(0, actions - tally.action) * per - tally.attack,
    attacksPerAction: per,
  };
}

/**
 * Has this creature still got its reaction?
 *
 * The off-turn reaction layer's own question, answered from the same ledger as everything else so that a
 * reaction spent by automation and one spent by a player are the same fact rather than two.
 */
export function hasReaction(combatant: any): boolean {
  const actor = combatant?.actor;
  if (!actor) return false;
  return check(actor, game.combat, combatant, "reaction", false).allowed;
}
