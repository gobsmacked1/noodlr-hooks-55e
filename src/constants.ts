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
  /** How hard the action economy is enforced against players: "off" | "warn" | "block". */
  economy: "combat.economy",
  /** Whether a creature's Speed caps how far a player can drag it in a turn. */
  movement: "combat.movement",
  /** Whether pushes, pulls and shoves actually move the token they land on. */
  forced: "combat.forced",
  /** Whether condition combat math (adv/disadv, auto-fail, crit-on-hit, incapacitated) is applied. */
  conditions: "combat.conditions",
  /** Whether dropping to 0 HP applies Unconscious/Dead and damage-at-0 death failures. */
  dying: "combat.dying",
  /** Whether NPCs flagged Important get death saves like PCs instead of dying at 0. */
  importantNpcSaves: "combat.importantNpcSaves",
  /** Whether damage rolls a real concentration save, and a failure actually ends the spell. */
  concentration: "combat.concentration",
  /** Whether the tracker clears itself once nothing hostile is left standing. */
  autoEnd: "combat.autoEnd",
} as const;

/** Settings that are this module's own rather than inherited. */
export const SETTINGS = {
  /** Verbose console diagnostics. Client-scoped: it is for whoever has a console open. */
  debugLogging: "debugLogging",
  /** Marks the one-time copy of a world's tuned values out of the `noodlr` namespace. */
  settingsMigrated: "settingsMigrated",
} as const;

/**
 * Every setting renders in Foundry's own module settings list.
 *
 * `noodlr` builds bespoke ApplicationV2 windows because it has some sixty settings and a single
 * scrolling form had stopped being navigable. There are sixteen here and all but three are
 * checkboxes, so the native list is both adequate and what a GM installing a community module
 * expects to find. No templates, no partials, no window.
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
