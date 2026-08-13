// Who is enforcing this rule right now?
//
// Every stand-aside in this module is a silent one. `ac5eOwnsConditions()` switches the whole
// condition layer off, `midiOwnsConcentration()` hands concentration to midi, Gambit's takes
// opportunity attacks — and in each case our own setting still reads `true` in the settings list,
// because the setting means "we would like to do this" and the stand-aside decides whether we
// actually do. A GM has no way to tell those apart, and the failure looks exactly like the module
// being broken: the switch is on and nothing happens.
//
// This is the single place that answers the question, and the rule is that it must READ the same
// predicates the enforcement paths read rather than restate their conditions. A resolver with its own
// copy of "is AC5e on" would drift, and it would drift into telling the GM the opposite of the truth,
// which is worse than not telling them at all.
//
// Three ideas, kept apart on purpose:
//
//   * OWNERSHIP — for one rule area, who acts: us, another module, the system, or nobody. This is
//     what a settings row needs to show beside its checkbox.
//   * ADVISORIES — cross-cutting conditions that are nobody's rule area but change what the GM sees
//     at the table. Midi's live range check is the important one: it cancels an item use with only a
//     log line, which is indistinguishable from our automation failing to fire.
//   * CONFLICTS — two packages that will both act on one event. Not a stand-aside, because standing
//     aside needs certainty and these are suspicions; the GM is told and decides.

import {
  COMBAT_SETTINGS,
  GENERAL_SETTINGS,
  MODULE_ID,
  SPLIT_COMBAT_SETTINGS,
  audienceKey,
} from "../constants";
import { AUDIENCES, type Audience } from "../util/audience";
import {
  ac5eOwnsConditions,
  ac5eOwnsIncapacitatedUse,
  rangedNearbyFoeOwned,
  visibilityAttackRulesOwned,
} from "../system/dnd5e-conditions";
import { midiOwnsConcentration } from "../system/dnd5e-concentration";
import { midiOwnsDying } from "../system/dnd5e-dying";
import { isDnd5e } from "../system/dnd5e-rewards";
import { midiConfig, midiOn, moduleActive, moduleSetting } from "../util/modules";

/** Who acts on a rule when its trigger fires. */
export type Owner =
  /** This module. The setting is on and nothing else has claimed it. */
  | "us"
  /** Another module. Our setting may read on; we are standing aside. */
  | "other"
  /** dnd5e or core already does it, so there was never anything for us to add. */
  | "system"
  /** Our setting is off and nothing else covers it. The rule is not enforced at this table. */
  | "nobody";

export interface Ownership {
  /** Stable id, used as the settings-row key and by the presets. */
  id: string;
  /** The world setting that governs our half, when there is one. */
  setting?: string;
  /** Is our switch on? Distinct from `owner === "us"`: on and overruled is the interesting case. */
  enabled: boolean;
  owner: Owner;
  /** Display name of whoever else owns it. Present only when `owner === "other"`. */
  by?: string;
  /** Why, in one sentence, for the tooltip. Plain English — these name other modules' settings. */
  note?: string;
  /**
   * Does this rule get enforced by SOMEBODY? `owner !== "nobody"`.
   * The row's real state: a GM cares far more about this than about which package does it.
   */
  covered: boolean;
}

interface Area {
  id: string;
  /**
   * The world setting that governs our half. For a split rule this is the BASE key, which is not
   * registered — `keyFor` resolves it against the audience being asked about.
   */
  setting?: string;
  /**
   * Our switch. Defaults to reading `setting` as a boolean, per audience where the rule is split.
   *
   * Takes the resolved key rather than reading `area.setting` itself, so a rule with a non-boolean
   * setting (the economy's three-way mode) does not have to know whether it is split.
   */
  enabled?: (key: string) => boolean;
  /** Who else has claimed it, if anyone. Consulted only when our switch is on. */
  contender?: () => { by: string; note: string } | null;
  /**
   * Consulted when our switch is OFF: is the rule nonetheless enforced by the system or by another
   * module? Without this, turning a switch off would always report "nobody", which would be a lie
   * wherever we only ever existed to fill a gap somebody else can also fill.
   */
  fallback?: () => { owner: Owner; by?: string; note: string } | null;
}

function settingOn(key: string): boolean {
  try {
    return Boolean(game.settings.get(MODULE_ID, key));
  } catch {
    // Asked before registration. Reporting "off" would advertise a gap that does not exist.
    return true;
  }
}

const AC5E_NAME = "Automated Conditions 5e";
const MIDI_NAME = "Midi QoL";

/**
 * Every rule area with an owner worth naming.
 *
 * Deliberately only the rules this module actually enforces today. It is tempting to pre-declare the
 * roadmap here so the settings pages can show an ownership badge on rules nobody has built yet, and
 * that would be a resolver that reports on imaginary code — the one failure mode this file exists to
 * prevent.
 */
const AREAS: Area[] = [
  {
    id: "conditions",
    setting: COMBAT_SETTINGS.conditions,
    contender: () =>
      ac5eOwnsConditions()
        ? {
            by: AC5E_NAME,
            note:
              "Its Automate Statuses setting is on, and it covers everything this does plus " +
              "attacker Prone, Restrained, Invisible and Grappled. Both of us acting would be a " +
              "race, not a stack, so this module stands down entirely.",
          }
        : null,
  },
  {
    id: "incapacitated",
    setting: COMBAT_SETTINGS.conditions,
    contender: () =>
      ac5eOwnsIncapacitatedUse()
        ? {
            by: AC5E_NAME,
            note:
              "Its Auto Armor / Spell Use setting is no longer off, so it refuses activity use by " +
              "Incapacitated creatures. Note this is separate from Automate Statuses: at stock " +
              "settings it is off and this module does the refusing.",
          }
        : null,
  },
  {
    id: "unseen",
    setting: COMBAT_SETTINGS.conditions,
    contender: () =>
      visibilityAttackRulesOwned()
        ? {
            by: AC5E_NAME,
            note:
              "Its Visibility Checks setting is on — it ships on — so it already ticks Advantage for " +
              "an unseen attacker and Disadvantage against an unseen target. If Midi QoL's " +
              "invisibility optional rule is live instead, AC5e defers to midi and so do we.",
          }
        : null,
  },
  {
    id: "rangedNearby",
    setting: COMBAT_SETTINGS.conditions,
    contender: () =>
      rangedNearbyFoeOwned()
        ? {
            by: AC5E_NAME,
            note:
              "Its Ranged Nearby Foes range check has been ticked, or Midi QoL's Optional Rules are " +
              "enabled with Nearby Foe on. Both ship off, so seeing this means somebody chose it.",
          }
        : null,
  },
  {
    id: "dying",
    setting: COMBAT_SETTINGS.dying,
    contender: () =>
      midiOwnsDying()
        ? {
            by: MIDI_NAME,
            note:
              "One of its Add Dead, Dead Condition or Unconscious Condition mechanics is on, so it " +
              "writes the status at 0 HP. Standing aside stops a creature being Unconscious and " +
              "Dead at once. Midi does not roll death saves either way.",
          }
        : null,
  },
  {
    id: "concentration",
    setting: COMBAT_SETTINGS.concentration,
    contender: () =>
      midiOwnsConcentration()
        ? {
            by: MIDI_NAME,
            note:
              "Its Concentration Check is not None, so it owns the verdict. Set it to None to hand " +
              "concentration to this module. Note midi does not press the save button either — with " +
              "its default of Chat it auto-rolls, which is why this is ownership rather than a gap.",
          }
        : null,
    fallback: () =>
      systemTracksConcentration()
        ? null
        : {
            owner: "nobody",
            note: "The dnd5e system's own concentration tracking is disabled, so there is nothing to break.",
          },
  },
  {
    id: "repeatSaves",
    setting: COMBAT_SETTINGS.repeatSaves,
    // No contender, and that is the finding rather than an omission. Midi CAN express a save-ends
    // clause, but only through `flags.midi-qol.OverTime` on an item that was authored with one — which
    // in practice means DDB imports and nothing else — so it owns particular effects rather than the
    // rule. The stand-aside is therefore per effect, inside `rules/repeat-save.ts`, and cannot be
    // stated here: this table answers "who enforces this rule", and for this one the answer is nobody.
    fallback: () => null,
  },
  {
    id: "opportunity",
    setting: COMBAT_SETTINGS.forced,
    enabled: () => true, // Opportunity attacks are not behind a switch of ours.
    contender: () =>
      gambitsOwnsOpportunity()
        ? {
            by: "Gambit's Premades",
            note:
              "It places a Region per combatant and reacts to departures. Two implementations means " +
              "the party is hit twice for one move, so this module defers. Midi does NOT automate " +
              "opportunity attacks despite appearances — its moved-reaction trigger is never fired.",
          }
        : null,
  },
  {
    id: "forced",
    setting: COMBAT_SETTINGS.forced,
    contender: () => {
      // Per-item rather than wholesale: both premades collections mark the specific documents they
      // drive, so they own a dozen items each and this module owns the rest. Reported as ours,
      // with the caveat, because "owned by Chris's Premades" would misdescribe every other item.
      const rivals = [
        moduleActive("chris-premades") ? "Chris's Premades" : null,
        moduleActive("gambits-premades") ? "Gambit's Premades" : null,
      ].filter(Boolean);
      return rivals.length
        ? {
            by: "shared",
            note: `Items marked by ${rivals.join(" or ")} are left to it; everything else is handled here.`,
          }
        : null;
    },
  },
  { id: "movement", setting: COMBAT_SETTINGS.movement },
  { id: "economy", setting: COMBAT_SETTINGS.economy, enabled: (key) => economyOn(key) },
  { id: "stealth", setting: COMBAT_SETTINGS.stealth },
  { id: "surprise", setting: COMBAT_SETTINGS.surprise },
  { id: "invisBreak", setting: COMBAT_SETTINGS.invisBreak },
  { id: "jump", setting: GENERAL_SETTINGS.jump },
  { id: "influence", setting: GENERAL_SETTINGS.influence },
];

function economyOn(key: string): boolean {
  try {
    return String(game.settings.get(MODULE_ID, key) ?? "warn") !== "off";
  } catch {
    return true;
  }
}

function systemTracksConcentration(): boolean {
  try {
    return !game.settings.get("dnd5e", "disableConcentration");
  } catch {
    return true;
  }
}

function gambitsOwnsOpportunity(): boolean {
  if (!moduleActive("gambits-premades")) return false;
  return moduleSetting("gambits-premades", "Opportunity Attack") !== false;
}

/** Is this rule configured separately for each side? */
function isSplit(area: Area): boolean {
  return Boolean(
    area.setting && (SPLIT_COMBAT_SETTINGS as readonly string[]).includes(area.setting),
  );
}

/**
 * The registered key for this area, for the side being asked about.
 *
 * A split area asked with no audience answers about the NPC side, which is arbitrary and is why every
 * caller that has a side passes it. `enabledEitherSide` below is what "is this on at all" goes through.
 */
function keyFor(area: Area, audience?: Audience): string | undefined {
  if (!area.setting) return undefined;
  if (!isSplit(area)) return area.setting;
  return audienceKey(area.setting, audience ?? "npc");
}

function ourSwitch(area: Area, audience?: Audience): boolean {
  const key = keyFor(area, audience);
  if (!key) return false;
  return area.enabled ? area.enabled(key) : settingOn(key);
}

/**
 * Resolve one rule area. Unknown ids resolve to an honest "we do not model this".
 *
 * `audience` picks which side of a split rule is being reported, and the settings window always passes
 * one because a column heading has already promised the reader which side they are looking at. Omitted,
 * a split rule reads as on if EITHER side is: that is the right answer for a survey and for deciding
 * whether a listener is needed, and the wrong one for a checkbox.
 */
export function ownershipOf(id: string, audience?: Audience): Ownership {
  const area = AREAS.find((a) => a.id === id);
  if (!area) return { id, enabled: false, owner: "nobody", covered: false };

  const enabled =
    isSplit(area) && !audience
      ? AUDIENCES.some((a) => ourSwitch(area, a))
      : ourSwitch(area, audience);
  const setting = keyFor(area, audience);

  if (enabled) {
    const rival = area.contender?.() ?? null;
    if (rival && rival.by !== "shared") {
      return {
        id,
        setting,
        enabled,
        owner: "other",
        by: rival.by,
        note: rival.note,
        covered: true,
      };
    }
    return { id, setting, enabled, owner: "us", note: rival?.note, covered: true };
  }

  const other = area.fallback?.() ?? area.contender?.() ?? null;
  if (other && "owner" in other) {
    return {
      id,
      setting,
      enabled,
      owner: other.owner,
      by: other.by,
      note: other.note,
      covered: other.owner !== "nobody",
    };
  }
  if (other) {
    return { id, setting, enabled, owner: "other", by: other.by, note: other.note, covered: true };
  }
  return { id, setting, enabled, owner: "nobody", covered: false };
}

/** Every rule area, for `api.surveyOwnership()`. Split rules report either side being on. */
export function allOwnership(): Ownership[] {
  return AREAS.map((a) => ownershipOf(a.id));
}

export interface Advisory {
  level: "info" | "warn";
  title: string;
  detail: string;
}

/**
 * Cross-cutting conditions the GM should know about, whether or not they touch a setting of ours.
 *
 * The first two exist because of a measured trap: midi ships with nearly every mechanical automation
 * OFF, and a GM reading its config panel reasonably concludes otherwise. Both range rules, by
 * contrast, ARE live at stock settings and cancel an item use with only a console line — which at the
 * table is indistinguishable from this module failing to fire.
 */
export function advisories(): Advisory[] {
  const out: Advisory[] = [];
  if (!isDnd5e()) {
    out.push({
      level: "warn",
      title: "This is not a D&D 5e world",
      detail:
        "Every rule in this module is 5e-specific and checks the system id before acting, so nothing " +
        "here will do anything. The companion AI module works on any system.",
    });
    return out;
  }

  const midi = midiConfig();
  if (midi) {
    const range = midi.optionalRules?.checkRange ?? midi.checkRange;
    if (midiOn(range)) {
      out.push({
        level: "warn",
        title: "Midi QoL is enforcing weapon range",
        detail:
          `Its Check Range is "${String(range)}", which is live at stock settings — it is read ` +
          "through a path that ignores midi's own Optional Rules master switch. An out-of-range use " +
          "is cancelled with only a log line, which looks exactly like this module failing to act. " +
          "Check this first when an item use does nothing at all.",
      });
    }
    const walls = midi.optionalRules?.wallsBlockRange ?? midi.wallsBlockRange;
    if (midiOn(walls)) {
      out.push({
        level: "info",
        title: "Midi QoL is treating walls as blocking range",
        detail:
          `Walls Block Range is "${String(walls)}". Same path as Check Range above: live regardless ` +
          "of the Optional Rules switch, and it cancels quietly.",
      });
    }
    if (midi.optionalRulesEnabled) {
      out.push({
        level: "info",
        title: "Midi QoL optional rules are on",
        detail:
          "Its house rules (invisibility advantage, critical saves, hidden-attacker advantage, " +
          "nearby-foe disadvantage) are actively modifying rolls. Worth knowing before attributing " +
          "an unexpected advantage to this module.",
      });
    }
  }

  // Same shape of trap as midi's range check: nothing here is wrong, but a whole class of roll stops
  // reaching us and the symptom is a rule of ours quietly not firing.
  if (moduleActive("monks-tokenbar")) {
    out.push({
      level: "warn",
      title: "Monk's Token Bar group rolls are invisible to this module",
      detail:
        "Its group and contested rolls suppress the system's own chat card, so they never carry the " +
        "roll data every capture here reads. A Stealth check requested through the token bar will " +
        "not hide anybody, and the same blindness applies anywhere a roll result is watched for. " +
        "Roll from the sheet when the result has to be enforced.",
    });
  }

  return out;
}

/** Two packages that will both act on one event. Suspicion, not certainty — hence a warning, not a stand-down. */
export function conflicts(): Advisory[] {
  const out: Advisory[] = [];

  if (moduleActive("wm5e") && settingOn(COMBAT_SETTINGS.forced)) {
    out.push({
      level: "warn",
      title: "Weapon Mastery 5e may double up on Push",
      detail:
        "This module implements the Push mastery natively (Pike, Warhammer, Heavy Crossbow, " +
        "Greatclub) and does not recognise wm5e, so a hit with one of those may move the target " +
        "twice. UNVERIFIED — wm5e's source has not been read. If you see a double push, turn off " +
        "forced movement here and let wm5e have it.",
    });
  }

  if (
    moduleActive("hurry-up") &&
    moduleSetting("hurry-up", "goNext") === true &&
    moduleSetting("hurry-up", "runForNPC") === true
  ) {
    out.push({
      level: "warn",
      title: "Hurry Up will advance turns this module is still playing",
      detail:
        "Its combat timer calls nextTurn() when it expires, and asks nothing about whether a turn is " +
        "mid-resolution. On an automated creature that races this module's own advance, so a slow " +
        "turn can be skipped or double-advanced. Turning off its Run for NPCs scopes the timer to " +
        "players and removes the conflict entirely.",
    });
  }

  if (moduleActive("gambits-premades") && !gambitsOwnsOpportunity()) {
    out.push({
      level: "info",
      title: "Gambit's Premades is installed with opportunity attacks off",
      detail:
        "This module is handling them. Turning Gambit's back on hands them over automatically.",
    });
  }

  return out;
}
