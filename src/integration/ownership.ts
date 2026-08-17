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
  SETTINGS,
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
import { midiOwnsDamage, midiOwnsSaves } from "../system/dnd5e-damage";
import { midiPromptsReactions } from "../system/dnd5e-reactions";
import { gambitsOwnsCounterspell } from "../system/dnd5e-counterspell";
import { gambitsOwnsBarbs } from "../system/dnd5e-barbs";
import { cprMaySneak } from "../system/dnd5e-sneak";
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
    id: "autoDamage",
    setting: COMBAT_SETTINGS.autoDamage,
    contender: () =>
      midiOwnsDamage()
        ? {
            by: MIDI_NAME,
            note:
              "Its Auto Apply Damage is not None, so it writes the hit points. Note that it ships as " +
              "None: seeing this means somebody chose it, and NOT seeing it on a table with midi " +
              "installed means midi is applying nothing.",
          }
        : null,
  },
  {
    id: "autoSaves",
    setting: COMBAT_SETTINGS.autoSaves,
    contender: () =>
      midiOwnsSaves()
        ? {
            by: MIDI_NAME,
            note:
              "Its Auto Check Saves is not None, so it rolls the saves and decides them, writing the " +
              "verdict to its own card. That is a real answer rather than a reconstruction of one, so we " +
              "stand aside whole. It also ships as None.",
          }
        : midiOwnsDamage()
          ? {
              by: MIDI_NAME,
              note:
                "It is applying the damage, so there is nothing left for a save to settle here even " +
                "though it is not deciding the saves themselves.",
            }
          : null,
  },
  {
    id: "reactionPrompts",
    setting: COMBAT_SETTINGS.reactionPrompts,
    contender: () =>
      midiPromptsReactions()
        ? {
            by: MIDI_NAME,
            note:
              "Its Do Reactions is not None, so it already prompts when a creature is hit or damaged — " +
              "and unlike most midi mechanics that one ships ON. We keep the departure trigger, which " +
              "midi declares and never fires, so opportunity attacks are still offered here. Set Do " +
              "Reactions and GM Do Reactions to None to hand the whole surface over.",
          }
        : null,
  },
  {
    id: "counterspell",
    setting: COMBAT_SETTINGS.counterspell,
    contender: () =>
      gambitsOwnsCounterspell()
        ? {
            by: "Gambit's Premades",
            note:
              "Its 2024 Counterspell automation is complete — 60 feet, enemies only, sight, the reaction, " +
              "and the counter-a-counterspell chain — and it runs through Midi QoL, which is installed. " +
              "Two windows on one cast would ask twice, so this stands aside. Note that it fires only for " +
              "creatures carrying its own Counterspell item; ours reads whatever Counterspell is on the sheet.",
          }
        : null,
  },
  {
    id: "barbs",
    setting: COMBAT_SETTINGS.barbs,
    contender: () =>
      gambitsOwnsBarbs()
        ? {
            by: "Gambit's Premades",
            note:
              "Its Silvery Barbs automation covers both halves of the spell — the reroll and the ally who " +
              "gains Advantage — and it runs through Midi QoL, which is installed. Two windows on one " +
              "success would ask twice and could reroll twice. Ours automates the reroll only; the " +
              "Advantage half is whatever your copy of the spell carries as an effect.",
          }
        : null,
  },
  {
    id: "sneak",
    setting: COMBAT_SETTINGS.sneak,
    contender: () =>
      cprMaySneak()
        ? {
            by: "Chris's Premades",
            note:
              "Its Sneak Attack macro adds the dice on Midi QoL's damage-bonus pass, and both are " +
              "installed. That runs whether or not midi is applying damage, so this stands aside " +
              "PER ROGUE — a creature whose feature CPR has claimed is skipped, and one it never " +
              "touched is still offered. Theirs also reads the 2014 ally clause (an enemy of the " +
              "target) where ours reads the printed 2024 one (one of your allies).",
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

  out.push(...capabilityAdvisories());
  out.push(...sneakAdvisories());
  out.push(...systemSettingAdvisories());
  out.push(...sceneAdvisories());

  return out;
}

/**
 * Compiled rules that cannot fire because something they ride on is switched off.
 *
 * `on_hit` and `on_miss` are dispatched from inside the auto-damage layer, because that is the only
 * place in the world that knows whether an attack connected — dnd5e decides it in its chat card's
 * RENDERER and stores the answer nowhere. So switching auto-damage off takes the attack riders with
 * it: a bite compiled to poison on a hit is bound, badged as running on the capability sheet, and
 * never fires.
 *
 * That is a real coupling rather than an oversight, and the alternative was worse — a second, parallel
 * hit reading purely to feed the triggers, which is two answers to "did that connect" and the exact
 * divergence this repo keeps finding. What is NOT acceptable is it being silent, which is the same
 * doctrine as greying "Behavioral automation" and as the ownership resolver: a capability that
 * switches itself off has to say so in the interface.
 */
function capabilityAdvisories(): Advisory[] {
  const out: Advisory[] = [];
  try {
    // Read through this file's own `settingOn` rather than `settings.ts`'s accessors: `settings.ts`
    // reaches this module through `apps/pages.ts`, so importing back would close a cycle for two
    // one-line reads.
    if (!settingOn(SETTINGS.compileCapabilities)) return out;
    const damages = AUDIENCES.some((a) => settingOn(audienceKey(COMBAT_SETTINGS.autoDamage, a)));
    if (damages && !midiOwnsDamage()) return out;
    out.push({
      level: "warn",
      title: "Compiled on-hit rules will not fire",
      detail: midiOwnsDamage()
        ? "Midi QoL is applying damage, so this module never reads whether an attack connected — and " +
          "that reading is what dispatches a compiled ability's on-hit and on-miss rules. They stay " +
          "bound and inert. Everything else a compiled ability does (turn start and end, damage " +
          "taken, dropping to 0, rests, standing facts) is unaffected."
        : "Automatic damage is off, so nothing reads whether an attack connected — and that reading " +
          "is what dispatches a compiled ability's on-hit and on-miss rules. A bite compiled to " +
          "poison the creature it hits will not fire. Turn triggers, damage-taken, rests and " +
          "standing facts are unaffected.",
    });
  } catch {
    // Reading a setting is not worth taking the advisory list down for.
  }
  return out;
}

/**
 * The same coupling as the one above, for a rule that ships rather than one that is compiled.
 *
 * Sneak Attack is offered from inside the auto-damage layer for exactly the reason the on-hit triggers
 * are: that layer holds the only answer to "did this connect". So the switch a GM turns on says
 * "offer Sneak Attack" and, with automatic damage off, nothing ever will.
 *
 * Separate from `capabilityAdvisories` rather than folded into it because that one is gated on the
 * compiler being enabled, and this rule has nothing to do with the compiler. Merging them would hide
 * this warning from every table that never turned compilation on — which is most of them.
 */
function sneakAdvisories(): Advisory[] {
  const out: Advisory[] = [];
  try {
    if (!AUDIENCES.some((a) => settingOn(audienceKey(COMBAT_SETTINGS.sneak, a)))) return out;
    const damages = AUDIENCES.some((a) => settingOn(audienceKey(COMBAT_SETTINGS.autoDamage, a)));
    if (damages && !midiOwnsDamage()) return out;
    out.push({
      level: "warn",
      title: "Sneak Attack will never be offered",
      detail: midiOwnsDamage()
        ? "Midi QoL is applying damage, so this module never reads whether an attack connected — and " +
          "that reading is what decides whether a hit qualifies. Chris's Premades implements Sneak " +
          "Attack on midi's damage-bonus pass, so with both installed a rogue whose feature it has " +
          "claimed is already covered; one it has not is offered by nobody."
        : "Automatic damage is off, so nothing reads whether an attack connected — and that reading " +
          "is what decides whether a hit qualifies for Sneak Attack. The switch is on and no rogue " +
          "will ever be asked. Pressing the feature from the sheet still works exactly as it always " +
          "did.",
    });
  } catch {
    // Reading a setting is not worth taking the advisory list down for.
  }
  return out;
}

/**
 * Automation dnd5e already ships, switched off in its own settings.
 *
 * Worth reporting for the same reason the ownership badges exist: a GM comparing this module against what
 * they had before will find recharge abilities no longer rolling and reasonably blame whatever changed. The
 * cause is a system setting they have never seen — `autoRecharge` is registered `config: false`, so it is
 * not in Foundry's settings list at all and lives only inside dnd5e's Combat Settings submenu.
 *
 * We deliberately do NOT set it. Writing another module's settings is what makes two modules impossible to
 * reason about, and this one is a genuine preference: "silent" and "yes" differ by a chat card per recharge.
 */
function systemSettingAdvisories(): Advisory[] {
  const out: Advisory[] = [];
  // Each read is independently guarded and none of them returns early. An absent setting means "a
  // version that does not have this one", which says nothing about the next one — and the first two of
  // these were chained, so on any dnd5e without `autoRecharge` the Bloodied warning below could never
  // be reached. A missing setting must never be able to suppress an unrelated advisory.
  const setting = (key: string): string | null => {
    try {
      return String(game.settings.get("dnd5e", key));
    } catch {
      return null;
    }
  };

  const recharge = setting("autoRecharge");
  if (recharge === "no") {
    out.push({
      level: "info",
      title: "Recharge abilities are not rolling themselves",
      detail:
        "dnd5e can roll a monster's Recharge 5-6 at the start of its turn, and ships with it off " +
        '("Auto-recharge" = No). Nothing here does it instead: a spent breath weapon is correctly not ' +
        "offered as an option, and it stays spent until somebody rolls the recharge by hand. Turn it on " +
        'in Configure Settings, dnd5e, Combat, Monsters — "Silent" applies it with no chat card.',
    });
  }

  // Bloodied is the system's, and it is correct — but it has an off position, and switching it off does
  // not merely hide an icon. `updateBloodied` returns before creating the effect, so the STATUS never
  // exists, and every compiled `has_status: bloodied` guard silently reads false. A troll's Loathsome
  // Limbs would then never fire, with nothing anywhere saying why.
  if (setting("bloodied") === "none") {
    out.push({
      level: "warn",
      title: "The Bloodied status is switched off in the system",
      detail:
        "dnd5e applies Bloodied at half hit points and this world has it set to None, which stops the " +
        "status being created rather than merely hiding it. Any compiled ability guarded on being " +
        'bloodied will never fire. Turn it back on in Configure Settings, dnd5e, Visibility — "Players" ' +
        "keeps the icon hidden from the party for hostile creatures while the status still exists.",
    });
  }

  // A TELEPORT THAT LANDS ON AN OCCUPIED SQUARE IS CANCELLED WITH NO MESSAGE, AND IT IS NOT OURS.
  //
  // Read from source rather than inferred, because it was reported as a Noodlr bug. At
  // `movementAutomation: "full"` dnd5e's `constrainMovementPath` override truncates a path at the first
  // grid space held by a creature within one size step of the mover
  // (`canvas/layers/tokens.mjs:isOccupiedGridSpaceBlocking`), and it truncates to the ORIGIN when the
  // very first step is the blocked one — which for a teleport is the destination, since there are no
  // intermediate squares. Chris's Premades then calls that as a pre-check and returns early on a path
  // that goes nowhere (`cat_tokenUtils.mjs:58`) while its `postAnimation` and `postTeleport` passes run
  // regardless. So the slot is spent, the mist and the sound play at the target square, and the token
  // stays where it was, with nothing in the console.
  //
  // Neither half is wrong on its own and we cannot fix either from here. What we can do is say so —
  // this is the same doctrine as the scene advisories below, where the cause is also outside the module.
  // Reported only when a teleporting module is present, so a world that never teleports gets no noise.
  const teleporters = moduleActive("chris-premades") || moduleActive("gambits-premades");
  if (setting("movementAutomation") === "full" && teleporters) {
    out.push({
      level: "info",
      title: "A blocked square cancels a teleport silently",
      detail:
        "dnd5e's Movement Automation is set to Full, which makes creatures block movement — including " +
        "the single step of a teleport. A premade Misty Step or Thunder Step whose destination is held " +
        "by a creature within one size of the caster is refused without a message, after the spell slot " +
        "has been spent and the visual effects have played. If a teleport spends a slot and nothing " +
        "moves, that is the cause: pick a clear square, or set Movement Automation to Difficulty Only.",
    });
  }
  return out;
}

/**
 * The viewed scene's own vision settings, which no module can compensate for.
 *
 * Here because hiding, the perception sweep, surprise and the unseen-attacker rules are all built on
 * "can this creature see that one", and a scene with Token Vision switched off answers yes to every
 * pairing on the map — so all four go quietly useless together while their checkboxes still read ON.
 * It is also the likeliest cause of the report that produced this: a player who can see every hostile
 * token on the scene, with no fog, is describing this checkbox rather than a missing feature. Nothing in
 * this module writes either field; both are per-scene and live in the scene's Vision tab.
 */
function sceneAdvisories(): Advisory[] {
  const out: Advisory[] = [];
  const scene: any = (globalThis as any).canvas?.scene;
  if (!scene) return out;

  if (scene.tokenVision === false) {
    out.push({
      level: "warn",
      title: `Token Vision is off on "${String(scene.name)}"`,
      detail:
        "Every token on this scene is visible to everyone, so nothing can be hidden from anything: " +
        "the Hide action has no line of sight to break, the perception sweep sees the whole map at " +
        "once, and surprise and the unseen-attacker rules cannot apply. Turn it on in the scene's " +
        "Vision tab. This is a scene setting — no module sets it, and none can work around it.",
    });
  } else if (scene.fog?.exploration === false) {
    out.push({
      level: "info",
      title: `Fog of War is off on "${String(scene.name)}"`,
      detail:
        "Players see everything currently within their tokens' vision, but nothing is remembered as " +
        "explored and nothing stays dark once left behind. Vision itself still works, so the rules " +
        "here are unaffected. Also in the scene's Vision tab.",
    });
  }

  // Walls are what vision is computed against, so a scene with none is bright and open by construction.
  const walls = Number(scene.walls?.size ?? scene.walls?.length ?? 0);
  if (scene.tokenVision !== false && walls === 0) {
    out.push({
      level: "info",
      title: `"${String(scene.name)}" has no walls`,
      detail:
        "With nothing to block a line, cover and line of sight are decided by light and sense ranges " +
        "alone. Hiding in the open will be refused more often than a table expects. Note that tiles — " +
        "trees, rocks, furniture — block nothing on their own; only walls do.",
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
