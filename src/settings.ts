// Every setting this module owns, and the reasoning behind each default.
//
// The long comments are the point of this file: each one records what the stack does NOT do, which is
// why the setting exists at all and why it defaults the way it does. Deleting a comment here loses the
// audit that justified the code.
//
// **They no longer render in Foundry's native list.** Every rule setting is `config: false` and is
// rendered instead by the three windows in `apps/rules-config.ts`, reached from the three menus
// registered below. That reverses the original decision, and the reason is not length — it is that a
// native row cannot show the one thing a GM most needs to know. Several of these rules stand aside
// silently when another module owns them, so the checkbox reads on while nothing happens; the
// ownership badge in our own window is the fix, and it cannot exist in Foundry's list.
//
// `debugLogging` stays in the native list on purpose: it is client-scoped troubleshooting, it is not a
// rule, and it should be findable without knowing which of three windows to open.

import {
  COMBAT_SETTINGS,
  GENERAL_SETTINGS,
  LEGACY_MODULE_ID,
  MODULE_ID,
  SETTINGS,
  SPLIT_COMBAT_SETTINGS,
  audienceKey,
  log,
} from "./constants";
import { AUDIENCES, audienceOf, type Audience } from "./util/audience";
import { PAGES } from "./apps/pages";
import { menuShimFor } from "./apps/rules-config";

/**
 * How much of a hostile creature's turn this module runs:
 *   full    — every non-player combatant is played automatically when its turn comes up.
 *   partial — only the creatures the GM opted in with the "Act as NPC" tool, for this fight only.
 *   off     — nothing is automated and the tool is not offered.
 */
export type CombatAutomationMode = "full" | "partial" | "off";

const L = (key: string): string => `NOODLRHOOKS.Combat.${key}`;

/**
 * Register a world-scoped rule setting.
 *
 * `config: false` — rendered by our own windows, not Foundry's list. The name and hint keys are still
 * registered because the windows localize them through exactly these keys; they are the setting's
 * text wherever it appears.
 */
function world(key: string, i18n: string, type: any, defaultValue: unknown, extra: object = {}) {
  game.settings.register(MODULE_ID, key, {
    name: L(`${i18n}.Name`),
    hint: L(`${i18n}.Hint`),
    scope: "world",
    config: false,
    type,
    default: defaultValue,
    ...extra,
  });
}

/**
 * Register both halves of a per-audience rule.
 *
 * The two sides share one name and hint. That is deliberate: the settings window draws them in labelled
 * columns, so repeating "(NPCs)" in every label would say twice what the column heading already says,
 * and it keeps a translator from having to translate each rule's description twice.
 */
function split(
  base: string,
  i18n: string,
  type: any,
  defaults: Record<Audience, unknown>,
  extra: object = {},
) {
  for (const audience of AUDIENCES) {
    world(audienceKey(base, audience), i18n, type, defaults[audience], extra);
  }
}

/** The same, for the general rules, which have their own i18n branch because they are not combat. */
function general(key: string, i18n: string, type: any, defaultValue: unknown) {
  game.settings.register(MODULE_ID, key, {
    name: `NOODLRHOOKS.General.${i18n}.Name`,
    hint: `NOODLRHOOKS.General.${i18n}.Hint`,
    scope: "world",
    config: false,
    type,
    default: defaultValue,
  });
}

/**
 * The three submenu buttons, in the order the pages are declared.
 *
 * `restricted: true` throughout: these are world settings and only a GM can write one, so offering a
 * player a window whose every control fails is worse than not offering it.
 */
function registerMenus(): void {
  // Wrapped, and deliberately not fatal. `registerMenu` throws unless the type it is handed is a real
  // ApplicationV2 subclass, so building those classes is the one part of settings registration that
  // depends on Foundry's application namespace being the shape we expect. The rules are the product
  // and the windows are the convenience: losing the windows must never take the rules with them.
  try {
    for (const page of PAGES) {
      game.settings.registerMenu(MODULE_ID, `page.${page.id}`, {
        name: page.title,
        label: page.title,
        hint: page.blurb,
        icon: page.icon,
        type: menuShimFor(page.id),
        restricted: true,
      });
    }
  } catch (err) {
    log("could not register the settings windows; the rules are unaffected:", err);
  }
}

export function registerCombatSettings(): void {
  registerMenus();

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
  // Both sides default to what the single setting used to do, so a fresh world behaves as before and an
  // upgraded one keeps the value the GM chose (the migration copies it into both). Tempting to ship NPCs
  // on "block" — a stat block has no Haste to justify a third action — and it would be very nearly a
  // no-op, because a GM is asked rather than refused whatever this says. Changing a default to buy
  // nothing is how a setting stops meaning what it reads.
  split(
    COMBAT_SETTINGS.economy,
    "Economy",
    String,
    { npc: "warn", pc: "warn" },
    {
      choices: {
        off: L("Economy.Off"),
        warn: L("Economy.Warn"),
        block: L("Economy.Block"),
      },
    },
  );
  world(COMBAT_SETTINGS.movement, "Movement", Boolean, true);
  world(COMBAT_SETTINGS.forced, "Forced", Boolean, true);
  // Both sides on: see `isAutoDamageEnabled()` for why the obvious asymmetry (automate monsters, leave
  // the party to click) is the wrong way round.
  split(COMBAT_SETTINGS.autoDamage, "AutoDamage", Boolean, { npc: true, pc: true });
  world(COMBAT_SETTINGS.autoSaves, "AutoSaves", Boolean, true);
  split(COMBAT_SETTINGS.reactionPrompts, "ReactionPrompts", Boolean, { npc: true, pc: true });
  world(COMBAT_SETTINGS.legendaryResistance, "LegendaryResistance", Boolean, true);
  world(COMBAT_SETTINGS.conditions, "Conditions", Boolean, true);
  split(COMBAT_SETTINGS.dying, "Dying", Boolean, { npc: true, pc: true });
  world(COMBAT_SETTINGS.importantNpcSaves, "Dying.Important", Boolean, true);
  split(COMBAT_SETTINGS.concentration, "Concentration", Boolean, { npc: true, pc: true });
  // Deliberately NOT split by audience, unlike the two above it. Those ask what happens to a creature
  // on its own account; this one is the escape clause of an effect somebody else put on it, and a world
  // where the goblins can shake off a Hold Person the party cannot is not a preference anyone has — it
  // is the same rule read two ways at the same table.
  world(COMBAT_SETTINGS.repeatSaves, "RepeatSaves", Boolean, true);
  world(COMBAT_SETTINGS.autoEnd, "AutoEnd", Boolean, true);

  general(GENERAL_SETTINGS.jump, "Jump", Boolean, true);
  general(GENERAL_SETTINGS.influence, "Influence", Boolean, true);

  game.settings.register(MODULE_ID, SETTINGS.compileCapabilities, {
    name: "NOODLRHOOKS.Capabilities.Name",
    hint: "NOODLRHOOKS.Capabilities.Hint",
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });

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
  game.settings.register(MODULE_ID, SETTINGS.migration, {
    scope: "world",
    config: false,
    type: Number,
    default: 0,
  });
}

/** The migration step this build knows how to reach. */
const MIGRATION_TARGET = 2;

/**
 * Bring a world's stored settings up to what this build registers. Runs once per step.
 *
 * Step 1 — copy the sixteen combat settings out of the `noodlr` namespace, where they lived until this
 * module was split out of it in 0.2.0. World settings are stored per module id, so without this every
 * table that had tuned them silently reverts to defaults on upgrade, and a reverted setting looks like
 * a bug in the new module rather than like the migration it is.
 *
 * Step 2 — fan the three per-audience settings out into their `.npc` and `.pc` halves (0.3.0). Both
 * sides get the value the world already had, so the split changes nothing until somebody uses it.
 *
 * Both steps read through `game.settings.storage` rather than `game.settings.get`, because in each case
 * the source key is no longer registered and `get` throws on an unregistered key. Absent values are
 * left alone, so a world that never had the old key keeps this module's defaults.
 */
export async function migrateSettings(): Promise<void> {
  // A world that ran step 1 under the old boolean marker has already done it.
  let done = Number(game.settings.get(MODULE_ID, SETTINGS.migration) ?? 0);
  if (!done && game.settings.get(MODULE_ID, SETTINGS.settingsMigrated)) done = 1;
  if (done >= MIGRATION_TARGET) return;

  try {
    if (done < 1) await migrateFromNoodlr();
    if (done < 2) await migrateToPerAudience();
  } catch (err) {
    log("settings migration failed; keeping whatever is stored:", err);
  }
  await game.settings.set(MODULE_ID, SETTINGS.migration, MIGRATION_TARGET);
}

/** Step 1: `noodlr.combat.*` -> `noodlr-hooks-55e.combat.*`. */
async function migrateFromNoodlr(): Promise<void> {
  let moved = 0;
  for (const key of Object.values(COMBAT_SETTINGS)) {
    const value = storedValue(`${LEGACY_MODULE_ID}.${key}`);
    if (value === undefined) continue;
    // The three split keys are not registered under their bare name, so each has to land on both
    // sides. Missing this would throw and abandon the rest of the copy half-done.
    await writeSetting(key, value);
    moved += 1;
  }
  if (moved) log(`migrated ${moved} setting(s) from ${LEGACY_MODULE_ID}`);
}

/** Step 2: `combat.dying` -> `combat.dying.npc` + `combat.dying.pc`, and the other two. */
async function migrateToPerAudience(): Promise<void> {
  let moved = 0;
  for (const base of SPLIT_COMBAT_SETTINGS) {
    const value = storedValue(`${MODULE_ID}.${base}`);
    if (value === undefined) continue;
    await writeSetting(base, value);
    moved += 1;
  }
  if (moved) log(`split ${moved} setting(s) into their NPC and player halves`);
}

/** Write one setting, fanning a split key out to both audiences. */
async function writeSetting(base: string, value: unknown): Promise<void> {
  const keys = (SPLIT_COMBAT_SETTINGS as readonly string[]).includes(base)
    ? AUDIENCES.map((a) => audienceKey(base, a))
    : [base];
  for (const key of keys) await game.settings.set(MODULE_ID, key, value as never);
}

/** A stored world setting, read past the registry. Undefined when there is no row. */
function storedValue(fullKey: string): unknown {
  const store = (game.settings as any)?.storage?.get?.("world");
  const row = store?.getSetting?.(fullKey);
  if (row?.value === undefined || row?.value === null) return undefined;
  const raw = row.value;
  // Foundry stores world settings JSON-encoded; older rows may already be primitives.
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // a bare string is a legitimate value for the enum settings
  }
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
 *
 * Per audience, and this is the pairing the split was built for: death saves for the party and a
 * straight kill for the mooks is how most tables already play, and it took a code change to express.
 */
export function isDyingAutomationEnabled(subject: unknown): boolean {
  return splitFlag(COMBAT_SETTINGS.dying, subject);
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
 *
 * Per audience: the save is a roll the player expects to make, while a monster's is one more dialog in
 * front of a GM who has six of them waiting.
 */
export function isConcentrationAutomationEnabled(subject: unknown): boolean {
  return splitFlag(COMBAT_SETTINGS.concentration, subject);
}

/**
 * Does "it can repeat the saving throw at the end of each of its turns" actually happen?
 *
 * Nobody does this. dnd5e models the clause nowhere — an Active Effect carries a duration and a status
 * and has no field for a save that ends it early — so the effect simply runs its full length unless a
 * human remembers, every round, for every afflicted creature. midi's `OverTime` can express it, but
 * only on items that were authored with it (DDB imports, mostly), and only when midi is installed.
 * On by default, because a save the rules grant and nobody rolls is a rule that is not being played.
 */
export function isRepeatSaveEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.repeatSaves));
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
 * How hard a creature is held to one action, one bonus action and one reaction per turn.
 *
 * Creatures this module plays are always held to the rules exactly and this setting does not reach
 * them; it governs whoever is clicking, who is a different problem (user, 2026-08-05).
 *
 *   off   — count nothing, stop nobody. What Foundry and dnd5e do today.
 *   warn  — ask, and write every "continue anyway" to the public chat log. The default.
 *   block — refuse outright. The GM is still only ever asked, never refused.
 *
 * "warn" is the default rather than "block" because the rules break their own general case constantly:
 * Haste hands out an extra action, and a system with no way to say yes turns every such feature into a
 * bug report. Asking privately and answering publicly keeps the override usable without making it
 * abusable — the table sees each one, so nobody has to police it.
 *
 * Per audience, on the creature being used rather than on who is using it: a player driving a familiar
 * is playing a monster, and the NPC column is where a GM would look for it.
 */
export function getEconomyMode(subject: unknown): "off" | "warn" | "block" {
  const raw = String(splitValue(COMBAT_SETTINGS.economy, subject) ?? "warn");
  return raw === "off" || raw === "block" ? raw : "warn";
}

/**
 * Does rolled damage land on the creature it was rolled against, without anyone pressing a button?
 *
 * Nothing in the stack does this. dnd5e computes whether an attack hit inside its chat card's renderer
 * and stores the answer nowhere, so it has no basis on which to apply anything; what it ships instead is
 * the damage tray, a button per target for a human to press. That is a deliberate position rather than a
 * gap — "Range, reach, & cover" and hit determination are both unshipped roadmap items — and midi-qol is
 * the module that has always filled it. On a table without midi, every hit costs the GM a click and a
 * subtraction, which is precisely the arithmetic nobody came to the table for.
 *
 * On by default for BOTH sides. The asymmetry a GM might expect — automate the monsters, leave the party
 * alone — is the wrong way round: a player watching their own hit points move is watching the fiction
 * happen, and the click they would otherwise make is on the GM's screen anyway, because a damage tray is
 * pressed by whoever owns the target.
 *
 * Per audience on the creature TAKING the damage, not on whoever rolled it, so the NPC column reads as
 * "monsters' hit points look after themselves" — which is how a GM thinks about it.
 *
 * Stands aside for midi when midi is applying damage itself; see `midiOwnsDamage()`.
 */
export function isAutoDamageEnabled(subject: unknown): boolean {
  return splitFlag(COMBAT_SETTINGS.autoDamage, subject);
}

/**
 * Is a saving throw joined back to the thing that demanded it, and does it settle the damage?
 *
 * dnd5e rolls a save when a button is pressed and then compares it to nothing. The DC is on the roll and
 * the activity's own "on save" setting says half, none or full, and neither is ever read: the result is a
 * number in the chat log for a human to interpret, after which that human works out half of 24.
 *
 * NOT per audience, unlike applying the damage, and the asymmetry people expect is here already without a
 * switch: a creature nobody but the GM can roll for has its save rolled automatically, and a character
 * with a player owner does not, because that player came to the table to roll it. That is derived from
 * ownership rather than configured, which is the right place for it — a table does not want a preference,
 * it wants its players rolling their own dice.
 *
 * What this does NOT do is apply the conditions a failed save imposes. Those live on the item as prose,
 * which is the compiler's problem rather than this layer's.
 */
export function isAutoSavesEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.autoSaves));
}

/**
 * Is a triggered reaction offered to whoever plays this creature?
 *
 * The gap this closes was invisible: the reaction layer detected its triggers correctly and then only ever
 * acted for a creature the GM had handed to the planner, so a player with a halberd, a Hellish Rebuke or
 * War Caster was never told their reaction had come up. No swing, no prompt, no line in the log.
 *
 * Per audience because the two columns mean genuinely different things. The PC side is a reminder to
 * somebody who wants one — the brief's "players like agency, and do not enjoy crunching arithmetic" —
 * while the NPC side is a question the GM will be answering, which is the "long chain of approvals" a GM
 * most wants to be able to turn down. Both start on, because a reaction nobody is offered is a rule the
 * table has silently stopped playing.
 *
 * A creature the planner is playing is never asked whatever this says: it has something deciding for it,
 * and a dialog per goblin per departure is the thing the brief rules out.
 */
export function isReactionPromptEnabled(subject: unknown): boolean {
  return splitFlag(COMBAT_SETTINGS.reactionPrompts, subject);
}

/**
 * Is a per-audience rule on for ANY audience?
 *
 * For the ownership resolver and for registering a hook: a listener has to exist if either side wants
 * it, and the per-creature check inside decides whether it does anything. Never use this to decide
 * whether to apply a rule to a creature — that is what passing the creature is for.
 */
export function enabledForEither(base: string): boolean {
  return AUDIENCES.some((a) => Boolean(game.settings.get(MODULE_ID, audienceKey(base, a))));
}

/** One side of a split boolean, chosen by what the creature is. */
function splitFlag(base: string, subject: unknown): boolean {
  return Boolean(splitValue(base, subject));
}

/** One side of any split setting. */
function splitValue(base: string, subject: unknown): unknown {
  return game.settings.get(MODULE_ID, audienceKey(base, audienceOf(subject)));
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

/**
 * May a creature's own prose be sent to `noodlr` to be compiled into executable rules?
 *
 * **Off by default, and the only setting in this file that is.** Every other switch here changes how
 * this module reads data the operator already has; this one spends their money — each miss on the
 * capability cache is a frontier-model call against the key configured in the companion module. A
 * feature that quietly bills somebody has to be asked for.
 *
 * Off is not a broken state. The cache still loads, anything already compiled still runs, and with
 * nothing compiled at all the module behaves exactly as it did before the compiler existed: it reads
 * structured sheet data and knows nothing about what the prose says.
 */
export function isCapabilityCompileEnabled(): boolean {
  try {
    return Boolean(game.settings.get(MODULE_ID, SETTINGS.compileCapabilities));
  } catch {
    // Called from paths that can run before registration; silence is the safe answer for a switch
    // whose "on" position spends money.
    return false;
  }
}

/**
 * Is a leap held to the distance the creature could actually clear?
 *
 * On by default. Core has a real jump movement action and dnd5e configures its cost correctly, so
 * the only missing piece is the limit — and without it the jump action is strictly better than
 * walking: it ignores difficult terrain by design and, until this shipped, was bounded by nothing.
 * Turning this off restores that, which is the reason the switch exists rather than a reason to use it.
 */
export function isJumpEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, GENERAL_SETTINGS.jump));
}

/**
 * Does talking a creature round roll a real check, against a real DC, bent by its attitude?
 *
 * On by default. The judgement half of the Influence rule stays the GM's and is asked for every time;
 * what this automates is the arithmetic underneath it, which is forgotten far more often than it is
 * disputed — the DC being the higher of 15 and the creature's Intelligence, and Advantage or
 * Disadvantage from a Friendly or Hostile attitude. Off for tables that would rather call for the
 * check themselves.
 */
export function isInfluenceEnabled(): boolean {
  return Boolean(game.settings.get(MODULE_ID, GENERAL_SETTINGS.influence));
}

export function getCombatAutomation(): CombatAutomationMode {
  const raw = String(game.settings.get(MODULE_ID, COMBAT_SETTINGS.automation) ?? "full");
  return raw === "partial" || raw === "off" ? raw : "full";
}
