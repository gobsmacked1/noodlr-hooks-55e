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
  /** Per audience. Whether a triggered reaction is offered to whoever plays the creature, on a clock. */
  reactionPrompts: "combat.reactionPrompts",
  /**
   * Whether a failed NPC save offers the legendary resistance dnd5e draws a button for.
   *
   * Deliberately NOT split by audience: `resources.legres` is a field on the NPC data model, so a player
   * character has nothing to spend and a PC column could never fire. A setting with an inert half reads as
   * a broken setting.
   */
  legendaryResistance: "combat.legendaryResistance",
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
} as const;

/** Settings that are this module's own rather than inherited. */
export const SETTINGS = {
  /** Whether a creature's own prose is compiled into executable rules by the companion module. */
  compileCapabilities: "capabilities.compile",
  /** Verbose console diagnostics. Client-scoped: it is for whoever has a console open. */
  debugLogging: "debugLogging",
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
