// Combat feature settings: the AI-run-NPC-turn system prompt.

import { MODULE_ID, COMBAT_SETTINGS } from "../constants";
import { promptDefault, promptValue } from "../prompts/fields";

/**
 * How much of a hostile creature's turn Noodlr runs:
 *   full    — every non-player combatant is played automatically when its turn comes up.
 *   partial — only the creatures the GM opted in with the "Act as NPC" tool, for this fight only.
 *   off     — nothing is automated and the tool is not offered.
 */
export type CombatAutomationMode = "full" | "partial" | "off";

export function registerCombatSettings(): void {
  game.settings.register(MODULE_ID, COMBAT_SETTINGS.systemPrompt, {
    scope: "world",
    config: false,
    type: String,
    default: promptDefault(COMBAT_SETTINGS.systemPrompt),
  });
  game.settings.register(MODULE_ID, COMBAT_SETTINGS.automation, {
    scope: "world",
    config: false,
    type: String,
    default: "full",
  });
  game.settings.register(MODULE_ID, COMBAT_SETTINGS.banter, {
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
  });
  game.settings.register(MODULE_ID, COMBAT_SETTINGS.turnPace, {
    scope: "world",
    config: false,
    type: Number,
    default: 6,
  });
  game.settings.register(MODULE_ID, COMBAT_SETTINGS.moveSpeed, {
    scope: "world",
    config: false,
    type: Number,
    default: 0,
  });
  game.settings.register(MODULE_ID, COMBAT_SETTINGS.autoEngage, {
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
  });
  game.settings.register(MODULE_ID, COMBAT_SETTINGS.engageRadius, {
    scope: "world",
    config: false,
    type: Number,
    default: 30,
  });
  game.settings.register(MODULE_ID, COMBAT_SETTINGS.stealth, {
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
  });
  game.settings.register(MODULE_ID, COMBAT_SETTINGS.economy, {
    scope: "world",
    config: false,
    type: String,
    default: "warn",
  });
}

/**
 * How hard a player is held to one action, one bonus action and one reaction per turn.
 *
 * Creatures Noodlr plays are always held to the rules exactly and this setting does not reach them; it
 * governs the people at the table, who are a different problem (user, 2026-08-05).
 *
 *   off   — count nothing, stop nobody. What Foundry and dnd5e do today.
 *   warn  — ask, and write every "continue anyway" to the public chat log. The default.
 *   block — refuse outright. The GM is still only ever asked, never refused.
 *
 * "warn" is the default rather than "block" because the rules break their own general case constantly:
 * Haste hands out an extra action, and a system with no way to say yes turns every such feature into a
 * bug report. Asking privately and answering publicly keeps the override usable without making it
 * abusable — the table sees each one, so nobody has to police it.
 */
export function getEconomyMode(): "off" | "warn" | "block" {
  const raw = String(game.settings.get(MODULE_ID, COMBAT_SETTINGS.economy) ?? "warn");
  return raw === "off" || raw === "block" ? raw : "warn";
}

/**
 * Does a Stealth roll actually stop a creature being noticed?
 *
 * On by default, because the alternative is that rogues do not work: Foundry's vision test knows only
 * about walls and light, so without this a rogue who rolled 27 is spotted by a guard with passive
 * Perception 10 the moment a corner ends (user, 2026-08-04). The switch exists for tables that would
 * rather adjudicate hiding themselves than have automation quietly decline to start fights.
 */
export function isStealthEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.stealth));
}

/**
 * How far a creature that spots the party can call for help, in the scene's distance units.
 *
 * Without a limit, one perceptive sentry drags every hostile on the map into the fight, which is both
 * implausible and unplayable (user, 2026-08-04) — a scene built as four separate encounters becomes one
 * enormous one the moment a single goblin looks the right way. 30 ft is shouting distance and the
 * default. 0 means the spotter fights alone; there is no "whole scene" value on purpose, though a large
 * number gets you there.
 *
 * Deliberately measured through walls: this models a shout, and a warband behind a door still hears it.
 */
export function getEngageRadius(): number {
  const raw = Number(game.settings.get(MODULE_ID, COMBAT_SETTINGS.engageRadius));
  if (!Number.isFinite(raw) || raw < 0) return 30;
  return raw;
}

/**
 * Do hostile creatures start the fight themselves when they notice the party?
 *
 * On by default, but only ever consulted when Combat Automation is already Full or Partial — a GM who
 * turned automation on has asked for the mechanical work to be taken off their hands, and stopping to
 * press "roll initiative" and "begin combat" is exactly the sort of work they meant (user, 2026-08-04).
 * It remains a separate switch because ambushes and set-piece openings are sometimes the GM's to time.
 */
export function isAutoEngageEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.autoEngage));
}

/**
 * Grid squares per second an automated creature slides across the canvas; 0 means "leave Foundry's".
 *
 * A creature that arrives instantly reads as a teleport, and players call foul on a Dire Wolf that
 * blinks 30 ft (user's report, 2026-08-04). The default is 0 rather than a number of my own choosing
 * because Foundry already has an animation pace and overriding it by default would be presumptuous;
 * this exists for tables that want the walk slowed down so it can be followed.
 */
export function getMoveSpeed(): number {
  const raw = Number(game.settings.get(MODULE_ID, COMBAT_SETTINGS.moveSpeed));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(20, Math.max(1, raw));
}

/**
 * Seconds an automated turn is held open before initiative advances.
 *
 * A machine resolves a turn in under a second, which reads as a blur rather than a fight: the table
 * cannot follow six skeletons acting in five seconds, and spoken banter from consecutive creatures
 * overlaps into noise (user's report, 2026-08-03). This is the deliberate handbrake — a floor on how
 * fast the fight can move, not a delay added to work that is still happening.
 */
export function getTurnPaceSeconds(): number {
  const raw = Number(game.settings.get(MODULE_ID, COMBAT_SETTINGS.turnPace));
  if (!Number.isFinite(raw)) return 6;
  return Math.min(60, Math.max(0, raw));
}

export function getCombatAutomation(): CombatAutomationMode {
  const raw = String(game.settings.get(MODULE_ID, COMBAT_SETTINGS.automation) ?? "full");
  return raw === "partial" || raw === "off" ? raw : "full";
}

export function isNpcBanterEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.banter));
}

/** The combat system prompt as stored — ships pre-filled, read verbatim (see prompts/fields.ts). */
export function getCombatSystemPrompt(): string {
  return promptValue(game.settings.get(MODULE_ID, COMBAT_SETTINGS.systemPrompt));
}
