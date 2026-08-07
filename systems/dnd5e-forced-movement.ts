// What pushes, pulls and slides a creature, and how far. D&D 5e ONLY.
//
// SYSTEM-SPECIFIC BY NECESSITY, and quarantined here for exactly the same reason as the concealment and
// hazard tables: the distance is not readable anywhere. I had this checked against the dnd5e 5.3.3
// source and content before writing a line, and the finding is starker than for either of those:
//
//   * There is no schema field on ANY of the system's twelve activity types that can express "move the
//     target N feet". Not an unused one — the concept is absent, so no amount of content authoring
//     could represent it.
//   * `CONFIG.DND5E.weaponMasteries` is eight entries of `{label, reference}`. Searching the system for
//     each mastery key as a whole word finds nothing outside the config itself. Push is a tooltip.
//   * Every distance in the SRD lives in description prose. The clearest specimen is Open Hand
//     Technique, which ships three sibling activities: Addle has an Active Effect, Topple has an Active
//     Effect applying `prone`, and Push has `effects: []` and no distance anywhere on the item.
//   * The closest thing to a modelled distance in the entire content set is Bigby's Forceful Hand,
//     whose `[[5 + 5 * @flags.dnd5e.summon.mod]] foot push` sits inside `description.chatFlavor` — a
//     display string. Machine-evaluable, not machine-actionable.
//
// So this is a name table, matched with regular expressions, and it is a heuristic on purpose.
//
// WHAT IS DELIBERATELY NOT HERE. Rules that knock a creature prone without moving it (Destructive Wave,
// Tidal Wave, the Topple mastery) are conditions rather than movement and belong to whatever applies
// conditions. Vortex Warp needs a destination a human chooses, so it cannot be automatic. Antilife
// Shell pushes continuously as its own caster walks, which is a different mechanism entirely.
//
// A NOTE ON ONE CORRECTION. The Push mastery weapons are the Pike, Warhammer, Heavy Crossbow and
// Greatclub. The Greatsword carries Graze. This matters because the mastery arrives as a key on the
// attack message rather than as a weapon name, so it is read rather than guessed at either way.

import { isDnd5e } from "./dnd5e-rewards";

/** Which way the target goes, relative to whoever moved it. */
export type Shift = "away" | "toward" | "up";

/**
 * What has to happen for a rule to apply.
 *
 * `mastery` is separated from `hit` because it is the one rule the system hands us as data rather than
 * as a name: the chosen mastery rides on the attack message as `flags.dnd5e.roll.mastery`.
 */
export type Trigger = "hit" | "mastery" | "save" | "damage";

export interface ForcedRule {
  label: string;
  trigger: Trigger;
  direction: Shift;
  /** Feet, in the scene's own units. Ignored when `scalesWithSpellMod` is set. */
  distance: number;
  /** Matched against the item's name. */
  pattern?: RegExp;
  /** Matched against the activity's name, for items that carry several rules under one roof. */
  activity?: RegExp;
  /** Weapon mastery key, read from the attack message rather than inferred. */
  mastery?: string;
  /**
   * A feature the PUSHER must own for the rider to apply, matched against its items and effects.
   *
   * This is what separates a warlock who took Repelling Blast from one who did not, given that both
   * cast the identical cantrip from the identical item.
   */
  requires?: RegExp;
  /** Damage type the hit must have dealt, for the riders that key off one. */
  damageType?: string;
  /** Abilities the save may use, so an unrelated save is not mistaken for this rule's. */
  save?: string[];
  /** Largest size this can move at all: `"lg"` means "Large or smaller". */
  maxSize?: string;
  /** Refuses a target more than this many size steps larger than the pusher. */
  withinSizes?: number;
  /** Once per turn per creature, as the feat text says. */
  oncePerTurn?: boolean;
  /** Feet the pusher must already have travelled this turn (Charger's running start). */
  afterMoving?: number;
  /** Distance is 5 + 5 × the caster's spellcasting modifier (Bigby's Forceful Hand). */
  scalesWithSpellMod?: boolean;
  /**
   * Statuses that mean the rule's OTHER branch was chosen, so nothing should move.
   *
   * Only Shove needs it, and it is the reason Shove can be automated at all. 2024 folds grapple and
   * shove into one Unarmed Strike save activity with two Active Effects, so a failed save alone does
   * not say what the attacker picked. It does afterwards: `grappled` means they grappled, `prone` means
   * they shoved for the knockdown, and neither means they shoved for the 5 feet.
   */
  unlessStatus?: string[];
}

export const FORCED_RULES: ForcedRule[] = [
  // ── Core rules and universal actions ──────────────────────────────────────────────────────────────
  {
    // The 2024 Shove, as an option of the Attack action via Unarmed Strike. dnd5e models the save
    // properly — one activity, `ability: [str, dex]`, `dc.calculation: str`, which resolves to
    // 8 + Strength modifier + proficiency — and models the knock-prone branch with a real effect. The
    // 5 feet is the half that does not exist.
    label: "Shove",
    trigger: "save",
    direction: "away",
    distance: 5,
    pattern: /unarmed\s*strike/i,
    activity: /grapple|shove/i,
    save: ["str", "dex"],
    unlessStatus: ["grappled", "prone"],
  },

  // ── Weapon mastery ───────────────────────────────────────────────────────────────────────────────
  {
    // No save, automatic on a hit, Large or smaller. The one rule here that needs no name matching.
    label: "Push mastery",
    trigger: "mastery",
    direction: "away",
    distance: 10,
    mastery: "push",
    maxSize: "lg",
  },

  // ── Feats ────────────────────────────────────────────────────────────────────────────────────────
  {
    label: "Crusher",
    trigger: "damage",
    direction: "away",
    distance: 5,
    damageType: "bludgeoning",
    requires: /\bcrusher\b/i,
    withinSizes: 1,
    oncePerTurn: true,
  },
  {
    // The running start is checked against the pusher's own movement history for this turn, which is
    // the only record of it that exists. Ten feet travelled is not the same as ten feet travelled in a
    // straight line, so this is the generous reading of the feat.
    label: "Charger",
    trigger: "hit",
    direction: "away",
    distance: 10,
    requires: /\bcharger\b/i,
    afterMoving: 10,
    oncePerTurn: true,
  },
  {
    label: "Shield Master",
    trigger: "save",
    direction: "away",
    distance: 5,
    pattern: /shield\s*master|shield\s*bash/i,
    save: ["str"],
    unlessStatus: ["prone"],
  },
  {
    label: "Telekinetic",
    trigger: "save",
    direction: "away",
    distance: 5,
    pattern: /telekinetic/i,
    save: ["str"],
  },
  {
    label: "Tavern Brawler",
    trigger: "hit",
    direction: "away",
    distance: 5,
    pattern: /unarmed\s*strike/i,
    requires: /tavern\s*brawler/i,
    oncePerTurn: true,
  },

  // ── Class and subclass features ──────────────────────────────────────────────────────────────────
  {
    // dnd5e ships Repelling Blast as an enchantment whose entire mechanical content is appending
    // ", Repelling" to the cantrip's name as a reminder for the human. Hence the `requires` check: the
    // item is the same Eldritch Blast either way, and only the invocation distinguishes them.
    label: "Repelling Blast",
    trigger: "hit",
    direction: "away",
    distance: 10,
    pattern: /eldritch\s*blast/i,
    requires: /repelling\s*blast/i,
  },
  {
    // Once per turn, unlike Repelling Blast, which repeats per beam. Both can be owned at once and the
    // rules let the warlock choose; the trigger layer prefers the push, since a warlock who took both
    // is far likelier to be keeping things at arm's length than reeling them in.
    label: "Grasp of Hadar",
    trigger: "hit",
    direction: "toward",
    distance: 10,
    pattern: /eldritch\s*blast/i,
    requires: /grasp\s*of\s*hadar/i,
    oncePerTurn: true,
  },
  {
    label: "Open Hand Technique",
    trigger: "save",
    direction: "away",
    distance: 15,
    pattern: /open\s*hand\s*technique/i,
    activity: /push/i,
    save: ["str"],
  },
  {
    label: "Pushing Attack",
    trigger: "save",
    direction: "away",
    distance: 15,
    pattern: /pushing\s*attack/i,
    save: ["str"],
  },
  {
    label: "Thunderbolt Strike",
    trigger: "damage",
    direction: "away",
    distance: 10,
    damageType: "lightning",
    requires: /thunderbolt\s*strike/i,
    maxSize: "lg",
  },

  // ── Spells ───────────────────────────────────────────────────────────────────────────────────────
  {
    label: "Thunderwave",
    trigger: "save",
    direction: "away",
    distance: 10,
    pattern: /thunderwave/i,
    save: ["con"],
  },
  {
    label: "Pulse Wave",
    trigger: "save",
    direction: "away",
    distance: 15,
    pattern: /pulse\s*wave/i,
    save: ["con"],
  },
  {
    // 5 feet plus five times the caster's spellcasting modifier, which is the one distance the content
    // actually computes — inside a chat-flavour display string.
    label: "Forceful Hand",
    trigger: "save",
    direction: "away",
    distance: 10,
    pattern: /forceful\s*hand|bigby|arcane\s*hand/i,
    save: ["str"],
    scalesWithSpellMod: true,
  },
  {
    label: "Thorn Whip",
    trigger: "hit",
    direction: "toward",
    distance: 10,
    pattern: /thorn\s*whip/i,
    maxSize: "lg",
  },
  {
    label: "Lightning Lure",
    trigger: "save",
    direction: "toward",
    distance: 10,
    pattern: /lightning\s*lure/i,
    save: ["str"],
  },
  {
    label: "Gust of Wind",
    trigger: "save",
    direction: "away",
    distance: 15,
    pattern: /gust\s*of\s*wind/i,
    save: ["str"],
  },
  {
    label: "Telekinesis",
    trigger: "save",
    direction: "away",
    distance: 30,
    pattern: /telekinesis/i,
    save: ["str"],
  },
  {
    // Straight up, which is why the engine has to understand elevation at all. Core has no concept of
    // falling, so what happens when the spell ends is the table's business, not ours.
    label: "Reverse Gravity",
    trigger: "save",
    direction: "up",
    distance: 100,
    pattern: /reverse\s*gravity/i,
    save: ["dex"],
  },
];

/** Everything a rule needs to be recognised, gathered by the trigger layer from a chat message. */
export interface RuleQuery {
  trigger: Trigger;
  itemName?: string;
  activityName?: string;
  /** Weapon mastery key off the attack message. */
  mastery?: string;
  /** Damage types present on the roll, for the riders that key off one. */
  damageTypes?: string[];
  /** Ability the save used, for `save` triggers. */
  ability?: string;
  /** The creature doing the pushing, for `requires`. */
  pusher?: any;
}

/** Names of everything the creature owns or has running, for `requires`. */
function ownedNames(actor: any): string[] {
  const out: string[] = [];
  for (const collection of [actor?.items, actor?.appliedEffects ?? actor?.effects]) {
    for (const entry of collection ?? []) {
      const name = String(entry?.name ?? "").trim();
      if (name) out.push(name);
    }
  }
  return out;
}

function owns(actor: any, pattern: RegExp): boolean {
  return ownedNames(actor).some((name) => pattern.test(name));
}

/**
 * Every rule this event satisfies, in table order.
 *
 * More than one can match — a warlock with both invocations, or a maul that both carries a mastery and
 * deals bludgeoning damage to a Crusher — and choosing between them is the caller's job, because the
 * tie-breakers are about the fiction rather than about the data.
 */
export function forcedRules(query: RuleQuery): ForcedRule[] {
  if (!isDnd5e()) return [];

  const item = String(query.itemName ?? "");
  const activity = String(query.activityName ?? "");
  const damage = (query.damageTypes ?? []).map((t) => String(t).toLowerCase());

  return FORCED_RULES.filter((rule) => {
    if (rule.trigger !== query.trigger) return false;
    if (rule.mastery && rule.mastery !== String(query.mastery ?? "")) return false;
    if (rule.pattern && !rule.pattern.test(item)) return false;
    // Only checked when the message told us which activity ran. An item with several activities that
    // does not say which one fired is left alone rather than guessed at.
    if (rule.activity && activity && !rule.activity.test(activity)) return false;
    if (rule.damageType && !damage.includes(rule.damageType)) return false;
    if (rule.save && query.ability && !rule.save.includes(String(query.ability))) return false;
    if (rule.requires && !owns(query.pusher, rule.requires)) return false;
    return true;
  });
}

/**
 * Fallback size ordering, for a world where the system's own table cannot be read.
 *
 * The keys are abbreviated in dnd5e and are not the words: `sm`, `lg` and `grg` in particular.
 */
const SIZE_ORDER: Record<string, number> = { tiny: 0, sm: 1, med: 2, lg: 3, huge: 4, grg: 5 };

/** Where this creature sits on the size ladder, or null when its size cannot be read. */
export function sizeRank(actor: any): number | null {
  const key = String(actor?.system?.traits?.size ?? "").trim();
  if (!key) return null;
  const configured = Number(
    (globalThis as any).CONFIG?.DND5E?.actorSizes?.[key]?.numerical ?? Number.NaN,
  );
  // Checked for finiteness rather than truthiness: Tiny is 0, and a falsy test reads that as absent.
  if (Number.isFinite(configured)) return configured;
  const fallback = SIZE_ORDER[key.toLowerCase()];
  return fallback === undefined ? null : fallback;
}

/**
 * Is this creature small enough for the rule to move it?
 *
 * An unreadable size permits the push. That is the deliberate direction to fail in: a homebrew sheet
 * with no size trait should not silently disable a player's feat.
 */
export function sizeAllows(rule: ForcedRule, pusher: any, target: any): boolean {
  const theirs = sizeRank(target);
  if (theirs === null) return true;

  if (rule.maxSize) {
    const ceiling = SIZE_ORDER[rule.maxSize] ?? 3;
    if (theirs > ceiling) return false;
  }
  if (rule.withinSizes !== undefined) {
    const mine = sizeRank(pusher);
    if (mine !== null && theirs - mine > rule.withinSizes) return false;
  }
  return true;
}

/** How far this rule moves a creature, given who is doing it. */
export function forcedDistance(rule: ForcedRule, pusher: any): number {
  if (!rule.scalesWithSpellMod) return rule.distance;
  try {
    const ability = String(pusher?.system?.attributes?.spellcasting ?? "");
    const mod = Number(pusher?.system?.abilities?.[ability]?.mod);
    if (Number.isFinite(mod)) return 5 + 5 * mod;
  } catch {
    /* fall back to the flat distance below */
  }
  return rule.distance;
}

/**
 * Who is holding this creature, as an actor uuid, or null when nobody is.
 *
 * Read from the `grappled` effect's `origin`, which is the only link dnd5e records between a grappled
 * creature and its grappler — the condition itself is a status with no reference back. Dragging a
 * grappled creature along is not modelled anywhere in the system: `grappled` zeroes the victim's own
 * movement and that is the whole of it.
 */
export function grapplerUuidOf(actor: any): string | null {
  try {
    for (const effect of actor?.appliedEffects ?? actor?.effects ?? []) {
      const statuses: any = effect?.statuses;
      const named = /grappl/i.test(String(effect?.name ?? ""));
      if (!named && !statuses?.has?.("grappled")) continue;
      const origin = String(effect?.origin ?? "");
      if (origin) return origin;
    }
  } catch {
    /* an unreadable effect list means we cannot say who is holding them */
  }
  return null;
}
