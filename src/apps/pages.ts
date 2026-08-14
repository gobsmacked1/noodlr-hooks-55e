// The three settings pages, declared as data.
//
// This file is a map of the whole rules surface, not only of the parts that are built. Every row
// carries a `state`, and the two that matter are `live` (a setting a real rule reads) and `planned`
// (a rule nobody has written yet). Planned rows render collapsed under "Not built yet" at the foot of
// their section rather than as dead checkboxes, so the page stays usable while still telling the
// truth about where the module ends.
//
// That combination is the point. The roadmap and the settings window are the same artifact, so a rule
// cannot be built without somebody deciding where its switch lives, and a switch cannot appear
// without a rule behind it. Promoting a row is: change `state`, add `setting`, register it.
//
// `state: "system"` is a third, easily-lost category — the rule IS enforced, by dnd5e or by core, and
// there is nothing for us to add. Those rows exist because their absence reads as a gap. A GM
// comparing this module against midi's settings list needs to see "damage immunities: the system
// already does this" rather than nothing at all, or they will conclude immunities are unhandled.
//
// TEXT IS RESOLVED THROUGH `game.i18n.localize`, WHICH RETURNS AN UNKNOWN KEY UNCHANGED. So a row may
// carry either an i18n key or plain English, and both work. Existing settings keep the keys they
// already register with (their text is translated and must not fork); new and planned rows carry
// English inline, next to the `state` flag they belong with. Splitting a one-line roadmap note into a
// separate JSON file would make this map unreadable for no benefit while there are no translations.

import {
  COMBAT_SETTINGS,
  GENERAL_SETTINGS,
  SETTINGS,
  SPLIT_COMBAT_SETTINGS,
  audienceKey,
} from "../constants";
import type { Audience } from "../util/audience";

export type RowState =
  /** A real setting, read by a real rule in this module. */
  | "live"
  /** Not built. No setting is registered; the row documents the intent and who covers it today. */
  | "planned"
  /** dnd5e or core already enforces it. Listed so its absence is not mistaken for a gap. */
  | "system"
  /** Deliberately another module's job, and we do not intend to reimplement it. */
  | "external";

export interface Row {
  /** Unique within the page. Also the `data-row` attribute, and the preset key where applicable. */
  id: string;
  label: string;
  hint: string;
  state: RowState;
  /** World setting key, for `live` rows. */
  setting?: string;
  kind?: "boolean" | "number" | "select";
  choices?: Record<string, string>;
  range?: { min: number; max: number; step: number };
  /** Rule area in `integration/ownership.ts`, when one covers this row. Drives the ownership badge. */
  ownership?: string;
  /** For non-live rows: who does this today, in one sentence. */
  today?: string;
  /** Client-scoped rather than world-scoped. */
  client?: boolean;
}

/** One side of a split section. */
export interface Column {
  audience: Audience;
  label: string;
  /** Optional standfirst for this side alone, where the two differ for a reason worth stating. */
  blurb?: string;
  rows: Row[];
}

export interface Section {
  id: string;
  title: string;
  /** Optional standfirst, for a section whose grouping is not self-evident. */
  blurb?: string;
  /** Rows that apply to everyone in the initiative order. Full width. */
  rows?: Row[];
  /**
   * Rows configured separately for each side, drawn as two columns.
   *
   * A row here whose setting is one of `SPLIT_COMBAT_SETTINGS` resolves to that column's own key, so
   * the same row literal can appear in both columns and edit two different settings. Anything else is
   * one-sided by nature — nothing configures how the module plays a player character.
   */
  columns?: Column[];
}

export interface Page {
  id: string;
  title: string;
  icon: string;
  blurb: string;
  sections: Section[];
}

const C = COMBAT_SETTINGS;
const G = GENERAL_SETTINGS;

/**
 * The world setting this row edits, in this column.
 *
 * The base key of a split setting is not registered, so reading or writing it throws. Everything that
 * touches a row's setting goes through here for that reason.
 */
export function settingKey(row: Row, audience?: Audience): string | undefined {
  if (!row.setting) return undefined;
  if (!audience) return row.setting;
  if (!(SPLIT_COMBAT_SETTINGS as readonly string[]).includes(row.setting)) return row.setting;
  return audienceKey(row.setting, audience);
}

// ---------------------------------------------------------------------------------------------
// House Rules — the variants a table decides once and lives with.
// ---------------------------------------------------------------------------------------------

const HOUSE: Page = {
  id: "house",
  title: "NOODLRHOOKS.Pages.House.Title",
  icon: "fa-solid fa-gavel",
  blurb:
    "Rule variants the table agrees on before play. Everything here changes how a situation is read, " +
    "not how hard a number is enforced.",
  sections: [
    {
      id: "hiding",
      title: "Hiding and surprise",
      blurb:
        "Foundry's vision test knows about walls and light and nothing about a Stealth roll. These " +
        "connect the two.",
      rows: [
        {
          id: "stealth",
          label: "NOODLRHOOKS.Combat.Stealth.Name",
          hint: "NOODLRHOOKS.Combat.Stealth.Hint",
          state: "live",
          setting: C.stealth,
          kind: "boolean",
          ownership: "stealth",
        },
        {
          id: "surprise",
          label: "NOODLRHOOKS.Combat.Surprise.Name",
          hint: "NOODLRHOOKS.Combat.Surprise.Hint",
          state: "live",
          setting: C.surprise,
          kind: "boolean",
          ownership: "surprise",
        },
        {
          id: "unseenAttacker",
          label: "Unseen attacker and unseen target",
          hint:
            "Advantage when the attacker cannot be seen, disadvantage when the target cannot be. " +
            "Visibility is asked of the same layer that runs the hiding contest, so a creature that " +
            "is hidden enough to avoid starting a fight is hidden enough to get Advantage.",
          state: "live",
          setting: C.conditions,
          kind: "boolean",
          ownership: "unseen",
        },
        {
          id: "hiddenPrereq",
          label: "Hide prerequisites",
          hint:
            "2024 requires Heavily Obscured or three-quarters cover and no enemy line of sight. The " +
            "Hide button checks cover by counting blocked corner rays; obscurement is not modelled.",
          state: "planned",
        },
      ],
    },
    {
      id: "invisibility",
      title: "Invisibility and concealment",
      rows: [
        {
          id: "invisBreak",
          label: "NOODLRHOOKS.Combat.InvisBreak.Name",
          hint: "NOODLRHOOKS.Combat.InvisBreak.Hint",
          state: "live",
          setting: C.invisBreak,
          kind: "boolean",
          ownership: "invisBreak",
        },
        {
          id: "concealmentTable",
          label: "Magical concealment recognised by name",
          hint:
            "Fog Cloud, Darkness, Pass Without Trace, Nondetection and friends are matched by name " +
            "and tested both as worn effects and as screens placed between two creatures. Always on: " +
            "an unrecognised effect simply does nothing, so there is no failure state to switch off.",
          state: "live",
          today: "No setting — it fails safe by construction.",
        },
      ],
    },
    {
      id: "positioning",
      title: "Cover, flanking and vision",
      blurb: "The three every table rules on differently, and the three we have least of today.",
      rows: [
        {
          id: "cover",
          label: "Cover as an AC bonus",
          hint:
            "dnd5e applies +2 and +5 to AC and Dexterity saves the moment its cover statuses are " +
            "present, and nothing in the system sets them from geometry. We are unlikely to build " +
            "this: Simple Cover 5e already sets the status AND adjusts AC, so a second implementation " +
            "would double-apply rather than fill a gap.",
          state: "planned",
          today:
            "Simple Cover 5e, thoroughly — 3D geometry, Dexterity saves and total cover included. " +
            "Midi QoL and Automated Conditions 5e also ship cover logic; AC5e stands down for midi.",
        },
        {
          id: "flanking",
          label: "Flanking",
          hint:
            "An optional rule in both editions and a house rule in practice — advantage, a flat bonus, " +
            "or nothing. Not built, and it needs a decision about which variant before it can be.",
          state: "planned",
          today: "Midi QoL implements several flanking variants.",
        },
        {
          id: "rangedInMelee",
          label: "Ranged attack with a hostile within 5 feet",
          hint:
            "Disadvantage, when that enemy can see you and is not Incapacitated. Both modules that " +
            "have this rule ship it switched off — AC5e's range checks default to an empty set and " +
            "midi's sits under Optional Rules — so at stock settings this is the only one running.",
          state: "live",
          setting: C.conditions,
          kind: "boolean",
          ownership: "rangedNearby",
        },
        {
          id: "vision",
          label: "Per-creature vision",
          hint:
            "Whether a specific monster can see a specific token, computed against a vision source " +
            "built for that creature rather than the GM's own screen. Always on and not configurable: " +
            "it is how encounters start, not a rule variant.",
          state: "live",
          today: "No setting. Vision 5e improves the sense data it reads when installed.",
        },
      ],
    },
    {
      id: "crits",
      title: "Critical hits and fumbles",
      rows: [
        {
          id: "critWithin5",
          label: "Critical on a hit within 5 feet of a helpless creature",
          hint:
            "Paralyzed and Unconscious make a hit within 5 feet a critical. Part of the condition " +
            "rules on the Mechanics page, so it follows that switch rather than having its own.",
          state: "live",
          ownership: "conditions",
        },
        {
          id: "critRange",
          label: "Critical range and fumble house rules",
          hint:
            "Expanded crit ranges, critical fumbles, criticals on saves. Not built. dnd5e handles a " +
            "19-20 range from the sheet; a fumble table is pure house rule and has no home in the system.",
          state: "planned",
          today: "Midi QoL has critical/fumble house-rule settings including critical saves.",
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// Mechanics — resolution rules that are not about a turn order.
// ---------------------------------------------------------------------------------------------

const MECHANICS: Page = {
  id: "mechanics",
  title: "NOODLRHOOKS.Pages.Mechanics.Title",
  icon: "fa-solid fa-dice-d20",
  blurb:
    "How checks, costs and consumables resolve. Rows marked as handled by the system are listed so " +
    "you can see they are covered, not because there is anything here to turn on.",
  sections: [
    {
      id: "checks",
      title: "Checks and saves",
      rows: [
        {
          id: "conditions",
          label: "NOODLRHOOKS.Combat.Conditions.Name",
          hint: "NOODLRHOOKS.Combat.Conditions.Hint",
          state: "live",
          setting: C.conditions,
          kind: "boolean",
          ownership: "conditions",
        },
        {
          id: "influence",
          label: "NOODLRHOOKS.General.Influence.Name",
          hint: "NOODLRHOOKS.General.Influence.Hint",
          state: "live",
          setting: G.influence,
          kind: "boolean",
          ownership: "influence",
        },
        {
          id: "jump",
          label: "NOODLRHOOKS.General.Jump.Name",
          hint: "NOODLRHOOKS.General.Jump.Hint",
          state: "live",
          setting: G.jump,
          kind: "boolean",
          ownership: "jump",
        },
        {
          id: "blindAbility",
          label: "Ability checks rolled blind",
          hint:
            "Per-ability blind rolling, so the player sees that they rolled but not what. Foundry has " +
            "the roll modes natively; what is missing is per-check configuration.",
          state: "planned",
          today:
            "Blind Skill Rolls covers all eighteen skills, abilities and saves, and integrates with midi.",
        },
        {
          id: "blindSave",
          label: "Saving throws rolled blind",
          hint: "As above, per ability.",
          state: "planned",
          today: "Blind Skill Rolls.",
        },
        {
          id: "blindSkill",
          label: "Skill checks rolled blind",
          hint:
            "The one that matters most at the table — Perception, Insight and Stealth are the classic " +
            "blind rolls, because a player who sees a 4 knows to distrust what they were told.",
          state: "planned",
          today: "Blind Skill Rolls.",
        },
      ],
    },
    {
      id: "costs",
      title: "Costs and limits",
      blurb:
        "What an activity consumes. How many activities a turn allows is a different question and lives " +
        "on the Combat page, where it is set per side.",
      rows: [
        {
          id: "charges",
          label: "Item charges and limited uses",
          hint:
            "Required, consumed and recovered on rest. Fully modelled by dnd5e's consumption targets " +
            "and recovery periods; nothing to add.",
          state: "system",
        },
        {
          id: "ammo",
          label: "Ammunition",
          hint:
            "dnd5e resolves ammunition against the actor's stock at roll time and marks empty stacks " +
            "unusable. Recovering spent ammunition after a fight is not modelled by anything.",
          state: "system",
          today: "Recovery is unbuilt on all sides.",
        },
        {
          id: "components",
          label: "Spell components and gold-value materials",
          hint:
            "Whether a costly material is required, consumed, and actually in the pack. dnd5e records " +
            "the component flags and the cost as data but never checks either.",
          state: "planned",
          today: "Midi QoL enforces components and material cost.",
        },
        {
          id: "freeHand",
          label: "Free hand and two-weapon rules",
          hint:
            "Somatic components with both hands full, two-weapon fighting eligibility, shields. Foundry " +
            "models equipped state but not handedness.",
          state: "planned",
          today: "Midi QoL has free-hand checks.",
        },
        {
          id: "rangedMax",
          label: "Ranged weapon maximum distance",
          hint:
            "Refusing or penalising a shot beyond long range. Note that if midi is installed this is " +
            "already live and cancels the use quietly — see the advisory on the summary page.",
          state: "planned",
          today: "Midi QoL, and it is one of the few midi rules that is ON at stock settings.",
        },
      ],
    },
    {
      id: "damage",
      title: "Damage application",
      blurb: "All handled by dnd5e. Listed so their absence here is not read as a gap.",
      rows: [
        {
          id: "immunities",
          label: "Damage immunities",
          hint: "Applied by dnd5e from the creature's own traits during damage application.",
          state: "system",
        },
        {
          id: "resistances",
          label: "Damage resistances",
          hint: "As above. Halving is the system's.",
          state: "system",
        },
        {
          id: "vulnerabilities",
          label: "Damage vulnerabilities",
          hint: "As above.",
          state: "system",
        },
        {
          id: "effects",
          label: "Applying an item's effects",
          hint:
            "Transferring an item's Active Effects to its target on use. dnd5e does this; midi adds " +
            "doing it automatically on a hit, which is a workflow question rather than a rule.",
          state: "system",
        },
        {
          id: "transformUndo",
          label: "Undoing transformations",
          hint:
            "Reverting a polymorphed or wild-shaped actor cleanly. dnd5e stores the original and can " +
            "restore it; doing so automatically when the effect ends is not built.",
          state: "planned",
        },
      ],
    },
    {
      id: "compiler",
      title: "Reading a creature's own abilities",
      rows: [
        {
          id: "compile",
          label: "NOODLRHOOKS.Capabilities.Name",
          hint: "NOODLRHOOKS.Capabilities.Hint",
          state: "live",
          setting: SETTINGS.compileCapabilities,
          kind: "boolean",
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// Combat — one page, no tabs. The rules that read the same for everybody run full width; the ones a
// table sets differently for the party than for the bestiary are drawn as two columns side by side,
// so choosing one is reading across a row rather than remembering what the other tab said.
// ---------------------------------------------------------------------------------------------

/**
 * Rows that govern everyone in the initiative order.
 *
 * Movement is here rather than in the player column on purpose: the Speed cap already exempts the GM
 * and every creature this module plays, because the planner budgets its own steps before it takes one.
 * Splitting it would mean offering a switch whose other half changes nothing.
 */
const SHARED_STATE: Section = {
  id: "state",
  title: "Everyone in the initiative order",
  blurb:
    "One switch each: these read the same whoever is being moved, shoved or held to their Speed.",
  rows: [
    {
      id: "forced",
      label: "NOODLRHOOKS.Combat.Forced.Name",
      hint: "NOODLRHOOKS.Combat.Forced.Hint",
      state: "live",
      setting: C.forced,
      kind: "boolean",
      ownership: "forced",
    },
    {
      id: "movement",
      label: "NOODLRHOOKS.Combat.Movement.Name",
      hint: "NOODLRHOOKS.Combat.Movement.Hint",
      state: "live",
      setting: C.movement,
      kind: "boolean",
      ownership: "movement",
    },
    // Shared rather than split, unlike death saves and concentration two sections down. Those ask what
    // happens to a creature on its own account; this is the escape clause of an effect somebody else
    // imposed, and a table where the goblins can shake off a Hold Person the party cannot is the same
    // rule read two ways at once.
    {
      id: "repeatSaves",
      label: "NOODLRHOOKS.Combat.RepeatSaves.Name",
      hint: "NOODLRHOOKS.Combat.RepeatSaves.Hint",
      state: "live",
      setting: C.repeatSaves,
      kind: "boolean",
      ownership: "repeatSaves",
    },
    {
      id: "dash",
      label: "Dash charged from movement",
      hint:
        "Dragging past your Speed charges a Dash rather than being refused, taking the bonus action " +
        "when Cunning Action or Step of the Wind provides one. Follows the movement cap above.",
      state: "live",
      ownership: "movement",
    },
    {
      id: "opportunity",
      label: "Opportunity attacks",
      hint:
        "Reacting when someone leaves your reach, and when you are hurt off-turn. Always on: it is " +
        "the reaction trigger everything else hangs off. Defers to Gambit's Premades when that is " +
        "installed with its own opportunity attacks on.",
      state: "live",
      ownership: "opportunity",
    },
    {
      id: "autoEnd",
      label: "NOODLRHOOKS.Combat.AutoEnd.Name",
      hint: "NOODLRHOOKS.Combat.AutoEnd.Hint",
      state: "live",
      setting: C.autoEnd,
      kind: "boolean",
    },
  ],
};

const SHARED_ROLLS: Section = {
  id: "rolls",
  title: "Rolling and reporting",
  blurb:
    "Applying damage is built and lives in the next section, per side; a saving throw settling that damage " +
    "is here. What is still missing is rolling an attack for you and deciding who a template caught — " +
    "this module reads rolls off the chat log and acts on them, but it does not make them. Worth being " +
    "clear about before you disable midi.",
  rows: [
    {
      id: "autoAttack",
      label: "Roll attacks automatically",
      hint:
        "dnd5e never compares an attack roll to an AC — a person eyeballs it — so hit and miss are " +
        "recomputed here from the AC recorded on the card, which is what applying damage hangs on. " +
        "What is missing is rolling the attack in the first place, and the 'about to hit' moment Shield " +
        "would need.",
      state: "planned",
      today: "Midi QoL, and it is the main reason tables install it. Hits are read either way.",
    },
    {
      id: "autoSave",
      label: "NOODLRHOOKS.Combat.AutoSaves.Name",
      hint: "NOODLRHOOKS.Combat.AutoSaves.Hint",
      state: "live",
      setting: C.autoSaves,
      kind: "boolean",
      ownership: "autoSaves",
    },
    {
      id: "targeting",
      label: "Targeting: automatic from a template, manual, or with cover applied",
      hint: "Selecting who a template caught, and whether cover modifies them.",
      state: "planned",
      today: "Midi QoL.",
    },
  ],
};

// The three rows below appear in BOTH columns and are the reason columns exist: each carries a base
// key from SPLIT_COMBAT_SETTINGS, which `settingKey` resolves against the column's own audience. One
// literal, two settings, and no chance of the two halves drifting apart in their wording.

const DYING_ROW: Row = {
  id: "dying",
  label: "NOODLRHOOKS.Combat.Dying.Name",
  hint: "NOODLRHOOKS.Combat.Dying.Hint",
  state: "live",
  setting: C.dying,
  kind: "boolean",
  ownership: "dying",
};

const CONCENTRATION_ROW: Row = {
  id: "concentration",
  label: "NOODLRHOOKS.Combat.Concentration.Name",
  hint: "NOODLRHOOKS.Combat.Concentration.Hint",
  state: "live",
  setting: C.concentration,
  kind: "boolean",
  ownership: "concentration",
};

const AUTO_DAMAGE_ROW: Row = {
  id: "autoDamage",
  label: "NOODLRHOOKS.Combat.AutoDamage.Name",
  hint: "NOODLRHOOKS.Combat.AutoDamage.Hint",
  state: "live",
  setting: C.autoDamage,
  kind: "boolean",
  ownership: "autoDamage",
};

const ECONOMY_ROW: Row = {
  id: "economy",
  label: "NOODLRHOOKS.Combat.Economy.Name",
  hint: "NOODLRHOOKS.Combat.Economy.Hint",
  state: "live",
  setting: C.economy,
  kind: "select",
  choices: {
    off: "NOODLRHOOKS.Combat.Economy.Off",
    warn: "NOODLRHOOKS.Combat.Economy.Warn",
    block: "NOODLRHOOKS.Combat.Economy.Block",
  },
  ownership: "economy",
};

/** Hit points, staying up, and what one turn allows. The genuinely symmetric rules. */
const PER_SIDE_STATE: Section = {
  id: "perSideState",
  title: "Hit points, staying up, and what a turn allows",
  blurb:
    "Set each side to taste. Most tables want death saves and concentration for the party and a " +
    "cleaner kill for the mooks, and want a budget the players are asked about and monsters are held to. " +
    "Applying damage is what switches the rest of this section on: death saves and the concentration " +
    "check both hang off the system's damage hook, which only fires when somebody's hit points actually " +
    "move.",
  columns: [
    {
      audience: "npc",
      label: "NOODLRHOOKS.Rules.Audience.Npc",
      blurb: "Anything whose sheet is not a character, whoever happens to own the token.",
      rows: [
        AUTO_DAMAGE_ROW,
        DYING_ROW,
        {
          id: "importantNpc",
          label: "NOODLRHOOKS.Combat.Dying.Important.Name",
          hint: "NOODLRHOOKS.Combat.Dying.Important.Hint",
          state: "live",
          setting: C.importantNpcSaves,
          kind: "boolean",
        },
        CONCENTRATION_ROW,
        ECONOMY_ROW,
      ],
    },
    {
      audience: "pc",
      label: "NOODLRHOOKS.Rules.Audience.Pc",
      blurb: "Character sheets. The GM is never refused here, only ever asked.",
      rows: [AUTO_DAMAGE_ROW, DYING_ROW, CONCENTRATION_ROW, ECONOMY_ROW],
    },
  ],
};

/** Taking a turn. Asymmetric by nature: nothing plays a player character for them. */
const PER_SIDE_TURN: Section = {
  id: "perSideTurn",
  title: "Taking a turn",
  columns: [
    {
      audience: "npc",
      label: "NOODLRHOOKS.Rules.Audience.Npc",
      rows: [
        {
          id: "automation",
          label: "NOODLRHOOKS.Combat.Automation.Name",
          hint: "NOODLRHOOKS.Combat.Automation.Hint",
          state: "live",
          setting: C.automation,
          kind: "select",
          choices: {
            full: "NOODLRHOOKS.Combat.Automation.Full",
            partial: "NOODLRHOOKS.Combat.Automation.Partial",
            off: "NOODLRHOOKS.Combat.Automation.Off",
          },
        },
        {
          id: "turnPace",
          label: "NOODLRHOOKS.Combat.Pace.Name",
          hint: "NOODLRHOOKS.Combat.Pace.Hint",
          state: "live",
          setting: C.turnPace,
          kind: "number",
          range: { min: 0, max: 60, step: 1 },
        },
        {
          id: "moveSpeed",
          label: "NOODLRHOOKS.Combat.MoveSpeed.Name",
          hint: "NOODLRHOOKS.Combat.MoveSpeed.Hint",
          state: "live",
          setting: C.moveSpeed,
          kind: "number",
          range: { min: 0, max: 20, step: 1 },
        },
        {
          id: "autoEngage",
          label: "NOODLRHOOKS.Combat.AutoEngage.Name",
          hint: "NOODLRHOOKS.Combat.AutoEngage.Hint",
          state: "live",
          setting: C.autoEngage,
          kind: "boolean",
        },
        {
          id: "engageRadius",
          label: "NOODLRHOOKS.Combat.EngageRadius.Name",
          hint: "NOODLRHOOKS.Combat.EngageRadius.Hint",
          state: "live",
          setting: C.engageRadius,
          kind: "number",
          range: { min: 0, max: 500, step: 5 },
        },
        {
          id: "playedBudget",
          label: "Creatures we play are held exactly",
          hint:
            "Not configurable, deliberately. Whatever the budget above says, a creature this module " +
            "plays is held to one action, one bonus action and one reaction — it asks the ledger before " +
            "it swings, so there is nothing to warn about.",
          state: "live",
        },
      ],
    },
    {
      audience: "pc",
      label: "NOODLRHOOKS.Rules.Audience.Pc",
      rows: [
        {
          id: "reactionTimeout",
          label: "Reaction prompt time-out",
          hint:
            "How long a player has to answer a reaction prompt before it passes. We do not prompt for " +
            "reactions at all yet — a player's opportunity attack is theirs to declare.",
          state: "planned",
          today: "Midi QoL prompts and has a time-out; its enforcement of reactions ships off.",
        },
      ],
    },
  ],
};

/** What each side spends between turns. */
const PER_SIDE_RESOURCES: Section = {
  id: "perSideResources",
  title: "Resources",
  blurb: "Read correctly when planning a turn; not yet tracked or enforced across a round.",
  columns: [
    {
      audience: "npc",
      label: "NOODLRHOOKS.Rules.Audience.Npc",
      rows: [
        {
          id: "recharge",
          label: "Recharge abilities",
          hint:
            "A spent breath weapon is already excluded when planning a turn. Rolling the recharge at the " +
            "start of the creature's turn is the system's, and it ships with auto-recharge off.",
          state: "system",
          today: "dnd5e, but its Auto Recharge setting defaults to off.",
        },
        {
          id: "legendaryActions",
          label: "Legendary actions",
          hint:
            "The one part of the action economy dnd5e genuinely tracks — the activation type declares a " +
            "resource pool and the system spends it. What is missing is prompting between turns.",
          state: "system",
          today: "dnd5e tracks the pool; nothing offers the actions at the right moment.",
        },
        {
          id: "legendaryResistances",
          label: "Legendary resistances",
          hint:
            "The count is on the sheet and decrements when spent. Deciding to spend one is a judgement " +
            "and stays the GM's.",
          state: "system",
        },
        {
          id: "lairActions",
          label: "Lair actions",
          hint:
            "dnd5e stores a lair initiative count and a boolean and does nothing with either. Nobody " +
            "inserts the turn at initiative 20.",
          state: "planned",
        },
        {
          id: "fakeRolls",
          label: "GM fake rolls",
          hint:
            "Showing the table a roll that did not happen, or hiding one that did. A deliberate GM tool " +
            "rather than a rule; not built.",
          state: "planned",
          today: "Midi QoL has fake-roll options.",
        },
      ],
    },
    {
      audience: "pc",
      label: "NOODLRHOOKS.Rules.Audience.Pc",
      rows: [
        {
          id: "heroicInspiration",
          label: "Heroic Inspiration",
          hint:
            "dnd5e stores the flag on the sheet and spending it is a click. Awarding it on a natural 1 " +
            "under 2024 rules, and reminding a player they are holding one, are not built.",
          state: "system",
          today: "dnd5e holds the flag; nothing awards or reminds.",
        },
        {
          id: "bardicInspiration",
          label: "Bardic Inspiration",
          hint:
            "A limited-use feature with a die, fully modelled by the system. Applying it to a roll is " +
            "manual.",
          state: "system",
        },
      ],
    },
  ],
};

const COMBAT: Page = {
  id: "combat",
  title: "NOODLRHOOKS.Pages.Combat.Title",
  icon: "fa-solid fa-swords",
  blurb:
    "The rules that read the same for everybody run full width. The ones a table sets differently for " +
    "the party than for the bestiary are drawn side by side, so both answers are visible at once.",
  sections: [SHARED_STATE, PER_SIDE_STATE, PER_SIDE_TURN, PER_SIDE_RESOURCES, SHARED_ROLLS],
};

export const PAGES: Page[] = [HOUSE, MECHANICS, COMBAT];

export function pageById(id: string): Page | undefined {
  return PAGES.find((p) => p.id === id);
}
