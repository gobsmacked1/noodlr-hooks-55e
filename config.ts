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
