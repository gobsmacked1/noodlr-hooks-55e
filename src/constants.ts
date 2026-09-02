// Durable identifiers and keys. Keep this the single source of truth for the module id and
// setting keys so nothing drifts between registration and lookup.

export const MODULE_ID = "noodlr-hooks-55e" as const;
export const MODULE_TITLE = "Noodlr Hooks 5.5e" as const;

/**
 * The module this one was extracted from.
 *
 * Read, never required. Two things need it: the one-time settings migration that copies a world's
 * tuned values across, and the actor-flag fallback that keeps every escape hatch a GM has already
 * written into an Active Effect working. Nothing here fails if `noodlr` is absent.
 */
export const LEGACY_MODULE_ID = "noodlr" as const;

/**
 * Combat feature settings keys.
 *
 * Deliberately still prefixed `combat.` even though this whole module is combat: the values are
 * migrated key-for-key out of `noodlr`, and a rename would turn a one-line copy into a mapping table
 * nobody would keep correct.
 *
 * THREE OF THESE ARE NOT REGISTERED UNDER THE KEY WRITTEN HERE. `dying`, `concentration` and `economy`
 * are per-audience: each registers as `<key>.npc` and `<key>.pc`, and the bare key exists only as the
 * base to build those from and as the name the migration reads a pre-split world's value out of. Never
 * `game.settings.get` one of them directly — it throws, because nothing registers it — and see
 * `SPLIT_COMBAT_SETTINGS` below.
 */
export const COMBAT_SETTINGS = {
  /** How much of an NPC's turn this module takes over: "full" | "partial" | "off". */
  automation: "combat.automation",
  /** Seconds an automated turn must last before the tracker advances, so the table can follow it. */
  turnPace: "combat.turnPace",
  /** Grid squares per second an automated token slides across the canvas. 0 leaves Foundry's own pace. */
  moveSpeed: "combat.moveSpeed",
  /** Whether hostile creatures start the fight themselves on noticing the party. */
  autoEngage: "combat.autoEngage",
  /** How far a creature's shout for help carries, in scene units. */
  engageRadius: "combat.engageRadius",
  /** Whether a declared hide actually keeps a creature unnoticed. */
  stealth: "combat.stealth",
  /** House rule: pressing Hide always rolls and always banks, whatever the position and the roll. */
  hideAlways: "combat.hideAlways",
  /** Whether creatures caught unawares are marked Surprised when a fight starts. */
  surprise: "combat.surprise",
  /** Whether the Invisibility spell ends itself on attacking, damaging or casting. */
  invisBreak: "combat.invisBreak",
  /** Per audience. How hard the action economy is enforced: "off" | "warn" | "block". */
  economy: "combat.economy",
  /** Whether a creature's Speed caps how far a player can drag it in a turn. */
  movement: "combat.movement",
  /** Whether pushes, pulls and shoves actually move the token they land on. */
  forced: "combat.forced",
  /** Per audience. Whether rolled damage lands on the creature it was rolled against, with no button. */
  autoDamage: "combat.autoDamage",
  /** Whether a saving throw is joined back to the spell that demanded it and settles the damage. */
  autoSaves: "combat.autoSaves",
  /**
   * Seconds a GM-elected roller has to press a demanded d20 before Foundry rolls it.
   * 0 = no prompt, roll immediately (full unresolved-roll automation).
   */
  owedSecondsGm: "combat.owedSeconds.gm",
  /**
   * Seconds a player-elected roller has to press a demanded d20 before Foundry rolls it.
   * Same control as `owedSecondsGm`: 0–120, 0 = roll immediately.
   */
  owedSecondsPlayers: "combat.owedSeconds.players",
  /**
   * Whether a placed MeasuredTemplate is deleted when its turn is over or its source is gone.
   *
   * Instantaneous leftovers (Fireball) and broken-concentration leftovers (a cone that was never a
   * dependent) are the stains. Not split by audience: the canvas is one map, and a player's leftover
   * is the same stain as an Archmage's.
   */
  templateLifetime: "combat.templateLifetime",
  /**
   * Whether the Damage button waits for the attack to be resolved before it can be pressed.
   *
   * NOT split by audience, unlike applying the damage, and the reason is that the two settings are about
   * different things. `autoDamage` asks what happens TO a creature, which a table may reasonably want
   * answered differently for the party and the bestiary. This one is about a control on a card, and the
   * card belongs to whoever swung — so a split would be governed by the attacker's side, which is not
   * the question anybody is asking. The GM is exempt rather than configured, as everywhere else.
   */
  damageGate: "combat.damageGate",
  /** Per audience. Whether a triggered reaction is offered to whoever plays the creature, on a clock. */
  reactionPrompts: "combat.reactionPrompts",
  /**
   * Per audience. Whether a cast is held open long enough for an opposed creature to counter it.
   *
   * Split by the CASTER, not by the counterspeller: the cost of this rule is a pause on somebody's cast, so
   * the audience whose casts may be delayed is the one whose column governs it.
   */
  counterspell: "combat.counterspell",
  /**
   * Per audience. Whether a creature may hold an action for a trigger it names itself.
   *
   * Split by the READIER, which is the creature the whole rule is about. Both sides start on: nothing
   * happens until somebody presses Ready, and the alternative is a PHB action item that spends an Action
   * and produces a chat card saying nothing.
   */
  ready: "combat.ready",
  /**
   * Per audience. Whether a d20 test that succeeded is held open for an opposed creature to spoil.
   *
   * Split by the creature that SUCCEEDED, matching Counterspell's split for the same reason: the cost of the
   * rule is a pause on somebody's roll, so the audience whose rolls may be delayed owns the column.
   */
  barbs: "combat.barbs",
  /**
   * Whether a failed NPC save offers the legendary resistance dnd5e draws a button for.
   *
   * Deliberately NOT split by audience: `resources.legres` is a field on the NPC data model, so a player
   * character has nothing to spend and a PC column could never fire. A setting with an inert half reads as
   * a broken setting.
   */
  legendaryResistance: "combat.legendaryResistance",
  /**
   * Per audience. Whether a qualifying hit offers Sneak Attack to whoever plays the rogue.
   *
   * Split by the ATTACKER, unlike the two settings above it, and for the opposite reason to theirs: those
   * hold somebody's roll open, so the delayed creature owns the column, while this offers a creature its
   * own damage and the creature offered is the one the column is about. A table running the party by hand
   * and the bestiary automatically is the case it serves.
   */
  sneak: "combat.sneak",
  /** Whether condition combat math (adv/disadv, auto-fail, crit-on-hit, incapacitated) is applied. */
  conditions: "combat.conditions",
  /** Per audience. Whether dropping to 0 HP applies Unconscious/Dead and damage-at-0 death failures. */
  dying: "combat.dying",
  /** Whether NPCs flagged Important get death saves like PCs instead of dying at 0. */
  importantNpcSaves: "combat.importantNpcSaves",
  /** Per audience. Whether damage rolls a real concentration save, and a failure ends the spell. */
  concentration: "combat.concentration",
  /** Whether "repeat the save at the end of each of its turns" actually rolls, and ends the effect. */
  repeatSaves: "combat.repeatSaves",
  /**
   * Whether a spent Recharge 5–6 ability rolls itself at the start of an NPC's turn.
   *
   * Three-way, matching dnd5e's own `autoRecharge`: `silent` (default) rolls with no card, `yes`
   * posts the system's recharge card, `no` leaves it for a human. dnd5e ships this off and hides
   * the switch; this is the operator-facing copy. When theirs is already on we stand aside — we
   * never write their setting.
   */
  autoRecharge: "combat.autoRecharge",
  /** Whether the tracker clears itself once nothing hostile is left standing. */
  autoEnd: "combat.autoEnd",
} as const;

/**
 * The rules configured separately for the party and for everything else.
 *
 * Kept as a list rather than as a flag on each key so that the migration, the presets, the ownership
 * resolver and the settings window all agree on which keys are split by reading one array. A fourth
 * candidate — forced movement — was considered and left alone: its gate fires while reading a chat
 * message, before the creature being displaced has been resolved, so splitting it would mean pushing
 * the check down into every target branch of a 700-line file for a preference nobody has asked for.
 */
export const SPLIT_COMBAT_SETTINGS = [
  COMBAT_SETTINGS.dying,
  COMBAT_SETTINGS.concentration,
  COMBAT_SETTINGS.economy,
  COMBAT_SETTINGS.autoDamage,
  COMBAT_SETTINGS.reactionPrompts,
  COMBAT_SETTINGS.counterspell,
  COMBAT_SETTINGS.ready,
  COMBAT_SETTINGS.barbs,
  COMBAT_SETTINGS.sneak,
] as const;

/** The registered key for one side of a split setting. */
export function audienceKey(base: string, audience: "npc" | "pc"): string {
  return `${base}.${audience}`;
}

/**
 * The general rules — the ones that read the same for every creature in every campaign.
 *
 * Separated from `COMBAT_SETTINGS` for two reasons. They are not combat: a party jumps a chasm and
 * talks a guard captain round without anybody rolling initiative. And they are new rather than
 * inherited, so unlike everything above they have no counterpart in `noodlr` to migrate across, and
 * grouping them under the `combat.` prefix would have implied one.
 */
export const GENERAL_SETTINGS = {
  /** Whether a leap is held to the distance a creature can actually clear. */
  jump: "general.jump",
  /** Whether talking a creature round rolls a real check against a real DC, bent by its attitude. */
  influence: "general.influence",
  /** Whether opening a door requires a token within one square of it. */
  interactReach: "general.interactReach",
  /** Whether a creature's aura (Protection, Courage, …) is copied onto allies in range. */
  auras: "general.auras",
  /** Whether a transformed token shows a restore icon (Wild Shape / Polymorph / Shapechange). */
  transformUndo: "general.transformUndo",
  /** Copy items and coin acquired in a Wild Shape / Polymorph back onto the original on revert. */
  transformLoot: "general.transformLoot",
  /**
   * Actors-directory folder for linked-transform copies. Empty keeps them beside the original.
   * Default name is `Wild Shape (temp)`.
   */
  transformFolder: "general.transformFolder",
  /** Whether a creature may mount another token and follow it. */
  riding: "general.riding",
  /** Whether token animation pace is derived from the sheet's Speed. */
  sheetPace: "general.sheetPace",
  /** Whether fly / climb / jump / burrow may ignore walls at the matching elevation. */
  modeTraverse: "general.modeTraverse",
} as const;

/** Settings that are this module's own rather than inherited. */
export const SETTINGS = {
  /** Whether a creature's own prose is compiled into executable rules by the companion module. */
  compileCapabilities: "capabilities.compile",
  /** Verbose console diagnostics. Client-scoped: it is for whoever has a console open. */
  debugLogging: "debugLogging",
  /**
   * Draw the system's activity and roll cards at half height.
   *
   * Client-scoped, and that is a judgement rather than an oversight: display density is a property of
   * the screen somebody is looking at, not of the world, and a GM on a 32-inch monitor and a player on a
   * laptop want different answers. It defaults ON so the table gets the compact log without anybody
   * having to find the switch, and anybody who prefers the system's own spacing can turn it back.
   */
  compactCards: "compactCards",
  /**
   * How far the one-time settings migrations have run. See `migrateSettings()`.
   *
   * A number rather than a boolean because there are now two steps and a world can have run either,
   * both or neither: the copy out of the `noodlr` namespace shipped in 0.1.0, and the fan-out of the
   * three per-audience settings shipped in 0.3.0. A world that had already run the first would never
   * see the second if both shared one flag.
   */
  migration: "settingsMigration",
  /**
   * The 0.1.0 migration's own marker. Registered but no longer written.
   *
   * Kept because it is the only evidence that a world already ran step one, and reading it is how
   * `migrateSettings()` knows not to copy stale `noodlr` values back over settings the GM has since
   * tuned here. Do not remove it: `game.settings.get` throws on an unregistered key.
   */
  settingsMigrated: "settingsMigrated",
} as const;

/**
 * Rule settings render in this module's own windows, not Foundry's list.
 *
 * This used to say the opposite, and the reasoning was sound as far as it went: sixteen checkboxes fit
 * a native list, and a GM installing a community module expects to find them there. What it missed is
 * that a native row can only show a setting's value, and several of these rules stand aside when
 * another module owns them — so the checkbox reads on while nothing happens, which is indistinguishable
 * from the module being broken. `apps/rules-config.ts` exists to show ownership beside the switch.
 *
 * `debugLogging` is the exception and stays in the native list: client-scoped, not a rule, and it
 * should be findable without knowing which of three windows to open.
 */

/** Small helper for consistent, greppable console output. */
export function log(...args: unknown[]): void {
  console.log(`${MODULE_TITLE} |`, ...args);
}

/**
 * Always-on warning channel. Use for conditions the user needs to know about even with debug
 * logging off (a swallowed failure, an unreadable sheet, a vetoed move).
 */
export function warn(...args: unknown[]): void {
  console.warn(`${MODULE_TITLE} |`, ...args);
}

/**
 * Verbose diagnostics, gated on the `debugLogging` setting. Reads the setting defensively because
 * this is called from paths that can run before settings are registered.
 */
export function debug(label: string, ...args: unknown[]): void {
  try {
    if (!game?.settings?.get(MODULE_ID, SETTINGS.debugLogging)) return;
  } catch {
    return;
  }
  console.debug(`${MODULE_TITLE} debug | ${label}`, ...args);
}

/** True when verbose diagnostics are on. Guard expensive log-only work with this. */
export function isDebugEnabled(): boolean {
  try {
    return Boolean(game?.settings?.get(MODULE_ID, SETTINGS.debugLogging));
  } catch {
    return false;
  }
}
