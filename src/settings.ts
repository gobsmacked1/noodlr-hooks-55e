// Every setting this module owns, and the reasoning behind each default.
//
// All sixteen render in Foundry's native module settings list. The long comments are the point of
// this file: each one records what the stack does NOT do, which is why the setting exists at all and
// why it defaults the way it does. Deleting a comment here loses the audit that justified the code.

import { COMBAT_SETTINGS, LEGACY_MODULE_ID, MODULE_ID, SETTINGS, log } from "./constants";

/**
 * How much of a hostile creature's turn this module runs:
 *   full    — every non-player combatant is played automatically when its turn comes up.
 *   partial — only the creatures the GM opted in with the "Act as NPC" tool, for this fight only.
 *   off     — nothing is automated and the tool is not offered.
 */
export type CombatAutomationMode = "full" | "partial" | "off";

const L = (key: string): string => `NOODLRHOOKS.Combat.${key}`;

/** Register a world-scoped setting that shows in Foundry's own list. */
function world(key: string, i18n: string, type: any, defaultValue: unknown, extra: object = {}) {
  game.settings.register(MODULE_ID, key, {
    name: L(`${i18n}.Name`),
    hint: L(`${i18n}.Hint`),
    scope: "world",
    config: true,
    type,
    default: defaultValue,
    ...extra,
  });
}

export function registerCombatSettings(): void {
  world(COMBAT_SETTINGS.automation, "Automation", String, "full", {
    choices: {
      full: L("Automation.Full"),
      partial: L("Automation.Partial"),
      off: L("Automation.Off"),
    },
  });
  world(COMBAT_SETTINGS.turnPace, "Pace", Number, 6, {
    range: { min: 0, max: 60, step: 1 },
  });
  world(COMBAT_SETTINGS.moveSpeed, "MoveSpeed", Number, 0, {
    range: { min: 0, max: 20, step: 1 },
  });
  world(COMBAT_SETTINGS.autoEngage, "AutoEngage", Boolean, true);
  world(COMBAT_SETTINGS.engageRadius, "EngageRadius", Number, 30);
  world(COMBAT_SETTINGS.stealth, "Stealth", Boolean, true);
  world(COMBAT_SETTINGS.surprise, "Surprise", Boolean, true);
  world(COMBAT_SETTINGS.invisBreak, "InvisBreak", Boolean, true);
  world(COMBAT_SETTINGS.economy, "Economy", String, "warn", {
    choices: {
      off: L("Economy.Off"),
      warn: L("Economy.Warn"),
      block: L("Economy.Block"),
    },
  });
  world(COMBAT_SETTINGS.movement, "Movement", Boolean, true);
  world(COMBAT_SETTINGS.forced, "Forced", Boolean, true);
  world(COMBAT_SETTINGS.conditions, "Conditions", Boolean, true);
  world(COMBAT_SETTINGS.dying, "Dying", Boolean, true);
  world(COMBAT_SETTINGS.importantNpcSaves, "Dying.Important", Boolean, true);
  world(COMBAT_SETTINGS.concentration, "Concentration", Boolean, true);
  world(COMBAT_SETTINGS.autoEnd, "AutoEnd", Boolean, true);

  game.settings.register(MODULE_ID, SETTINGS.debugLogging, {
    name: "NOODLRHOOKS.DebugLogging.Name",
    hint: "NOODLRHOOKS.DebugLogging.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });
  game.settings.register(MODULE_ID, SETTINGS.settingsMigrated, {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });
}

/**
 * Copy a world's tuned values out of the `noodlr` namespace, exactly once.
 *
 * These sixteen settings lived under `noodlr.combat.*` until this module was split out of it. World
 * settings are stored per module id, so without this every table that had tuned them would silently
 * revert to defaults on upgrade — and a reverted setting looks like a bug in the new module rather
 * than like the migration it is.
 *
 * Reads through `game.settings.storage` rather than `game.settings.get`, because the old keys are no
 * longer registered and `get` throws on an unregistered key. Absent values are left alone, so a world
 * that never had `noodlr` installed keeps this module's own defaults.
 */
export async function migrateLegacySettings(): Promise<void> {
  if (game.settings.get(MODULE_ID, SETTINGS.settingsMigrated)) return;
  let moved = 0;
  try {
    const store = (game.settings as any)?.storage?.get?.("world");
    if (store) {
      for (const key of Object.values(COMBAT_SETTINGS)) {
        const row = store.getSetting?.(`${LEGACY_MODULE_ID}.${key}`);
        if (row?.value === undefined || row?.value === null) continue;
        let value: unknown = row.value;
        // Foundry stores world settings JSON-encoded; older rows may already be primitives.
        if (typeof value === "string") {
          try {
            value = JSON.parse(value);
          } catch {
            /* a bare string is a legitimate value for the three non-boolean settings */
          }
        }
        await game.settings.set(MODULE_ID, key, value as never);
        moved += 1;
      }
    }
  } catch (err) {
    log("could not read the previous module's settings; keeping defaults:", err);
  }
  await game.settings.set(MODULE_ID, SETTINGS.settingsMigrated, true);
  if (moved) log(`migrated ${moved} setting(s) from ${LEGACY_MODULE_ID}`);
}

/**
 * Does a push, pull or shove actually move the creature it lands on?
 *
 * Nothing in the stack does this today. The D&D 5e system automates no forced movement whatsoever — no
 * activity type has a field that could express a distance, the Push weapon mastery is a tooltip, and
 * every distance in the published content sits in description prose (verified against 5.3.3,
 * 2026-08-06). Repelling Blast is shipped as an enchantment whose entire mechanical content is appending
 * ", Repelling" to the cantrip's name as a reminder for the human. midi-qol ships two movement helpers
 * and calls them from nothing. The premades packages cover about a dozen items between them.
 *
 * On by default, because a battlefield-control build that never moves anybody is not a build. Applied
 * automatically with an undo control on every card, rather than by prompting: most of these rules are
 * permissive ("you CAN push"), and a confirmation dialog on every hit would cost more table time than
 * the occasional undo.
 */
export function isForcedMovementEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.forced));
}

/**
 * Do statuses actually change attack rolls, saves, and whether you can act?
 *
 * Stock dnd5e applies nested Incapacitated for Paralyzed/Stunned/etc., lists Poisoned under
 * `conditionEffects.attackDisadvantage`, and never reads either when building a roll. Auto-fail
 * Strength/Dexterity and critical hits within 5 ft of a Paralyzed or Unconscious creature live only
 * as journal prose. On by default: a paralyzed creature that still makes Dex saves is not paralyzed.
 */
export function isConditionAutomationEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.conditions));
}

/**
 * Does dropping to 0 HP apply Unconscious (or Dead), and does further damage tick death failures?
 *
 * Stock floors hit points at zero and never writes those statuses. Instant death when excess damage
 * meets or exceeds max HP is journal prose only. On by default. Stands aside when midi-qol's
 * "Add Dead" mechanic is enabled, so the two do not double-apply.
 */
export function isDyingAutomationEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.dying));
}

/**
 * Do NPCs with `traits.important` get death saves and Unconscious at 0, like PCs?
 *
 * Ordinary NPCs still die at 0. The Important flag is what the 5e sheet uses to show death-save UI;
 * this makes that flag mean something mechanically. On by default.
 */
export function honorImportantNpcDeathSaves(): boolean {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.importantNpcSaves));
}

/**
 * Does damage actually threaten a concentration spell?
 *
 * Stock dnd5e gets everything right except the two ends of it: it computes the DC and posts a
 * whispered button, and nothing in the system ends concentration when that save fails. With this on,
 * the save is rolled on the client that owns the creature and a failure drops the spell — as does
 * being Incapacitated, dying, or hitting 0 hit points, which no part of the stack enforces. On by
 * default. Stands aside when midi-qol's concentration handling is anything but "None".
 */
export function isConcentrationAutomationEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.concentration));
}

/**
 * Does a creature's Speed actually limit how far a player can drag it in a turn?
 *
 * Nothing else enforces this. Core Foundry records how far a token has moved this turn and dnd5e
 * colours the drag ruler green/amber/red against Speed, but neither ever stops anyone — a player can
 * cross the whole map on one turn and the only consequence is that the ruler turns red (user,
 * 2026-08-05). On by default, since a movement budget nobody applies is not a rule.
 */
export function isMovementCapEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.movement));
}

/**
 * Does the tracker clear itself when the last hostile falls?
 *
 * On by default. The alternative is what the table saw: a finished fight that still hands out turns,
 * so the GM plays out an initiative order in which nobody has an enemy left (user, 2026-08-05).
 */
export function isAutoEndEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.autoEnd));
}

/**
 * How hard a player is held to one action, one bonus action and one reaction per turn.
 *
 * Creatures this module plays are always held to the rules exactly and this setting does not reach
 * them; it governs the people at the table, who are a different problem (user, 2026-08-05).
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
 * Are creatures that cannot see anybody marked Surprised when a fight starts?
 *
 * On by default. dnd5e already turns the status into Disadvantage on initiative under 2024 rules and never
 * applies it to anyone, so this costs a table nothing it was already getting and gives ambushes the
 * mechanical weight the edition intended. Off for tables that would rather rule on surprise themselves.
 */
export function isSurpriseEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.surprise));
}

/**
 * Does the Invisibility spell end itself when its target attacks, deals damage, or casts?
 *
 * On by default, and deliberately NOT coupled to the hiding clear the way midi couples them: the whole
 * point of Greater Invisibility is that attacking does not end it, and a single switch over both spells
 * silently deletes the difference between a second-level spell and a fourth-level one.
 */
export function isInvisibilityBreakEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.invisBreak));
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
 * fast the fight can move, not a delay added to work that is still happening. Nothing anywhere cuts a
 * turn short; a turn that takes longer than the floor simply takes longer.
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
