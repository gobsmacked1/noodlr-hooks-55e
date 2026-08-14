// A saving throw settles the damage, and nobody works out half of 24.
//
// dnd5e models this mechanic almost completely and then declines to finish it. The activity states its DC
// and whether a made save halves the damage, takes none of it, or changes nothing (`save.dc.value`,
// `damage.onSave`). It posts a save button per ability. It rolls the save correctly, with proficiency,
// advantage from every source, and the DC attached to the roll. It even copies `onSave` onto the damage
// message so a reader can see what a success is worth (`save.mjs:78-82`, rendered as a footnote at
// `chat-message.mjs:554-562`). What it never does is put the two together: the save's verdict is compared
// to nothing, and the damage arrives as a tray of buttons whose numbers a human halves in their head.
//
// So this layer joins them. Three things fall out of it, in the order a table notices them:
//
//   1. A creature nobody but the GM can roll for rolls its own save, automatically. That is where most of
//      the tedium lives — a Fireball on five goblins is five presses and five subtractions — and it is
//      also the asymmetry the GM asked for, without a setting: `rollerForActor` says whether a player
//      owns the creature, and a character with a player owner is left alone because that player came to
//      the table to roll their own dice.
//   2. The damage lands at the right fraction, by handing `multiplier` to the system rather than by doing
//      arithmetic here. Halving is not always halving — resistance, vulnerability and Evasion all sit in
//      `Actor5e#calculateDamage` — and a number we halved ourselves would be wrong on exactly the
//      creatures where it mattered.
//   3. It waits. A save and its damage arrive in either order, seconds apart, from different clients, and
//      a target whose save has not been seen yet is pending rather than absent.
//
// THE JOIN IS `flags.dnd5e.originatingMessage`, the id of the usage card whose button was pressed. Both
// `#rollSave` and `#rollDamage` pass their click event through, and `BasicRoll.buildPost` reads the
// message id out of the DOM (`basic-roll.mjs:173`), so every roll descending from one card carries the
// same id. A save or a damage roll made straight from a sheet carries none, and is honestly unjoinable —
// reported, not guessed at.
//
// WHAT THIS DELIBERATELY DOES NOT DO: apply what a failed save inflicts beyond damage. "Restrained until
// the end of its next turn" is prose on the item, which is the capability compiler's problem and not this
// layer's; inventing a condition from a save is exactly the kind of guess that produces a rules argument.

import { COMBAT_SETTINGS, MODULE_ID, log } from "../constants";
import { isPrimaryGM, rollerForActor } from "../util/gm";
import { narrator } from "../util/speaker";
import { isAutoSavesEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import { midiOwnsDamage, midiOwnsSaves } from "../system/dnd5e-damage";
import { applyRolledDamage, type DamageEntry } from "./damage";
import {
  activityOf,
  damageOnSave,
  damageParts,
  itemOf,
  originatingId,
  readSave,
  rollType,
  saveMultiplier,
  speakerToken,
  targetsOf,
  tokenFromActorUuid,
  type DamagePart,
} from "./cards";

/** How long an unfinished activation is kept. A save nobody ever rolls must not pin a target forever. */
const ACTIVATION_TTL_MS = 5 * 60 * 1000;

/** How many activations are remembered at once, oldest evicted. A long fight is not a memory leak. */
const ACTIVATION_LIMIT = 24;

/** One creature's part in an activation. */
interface TargetState {
  doc: any;
  name: string;
  /** null until a save has been read for it. */
  success: boolean | null;
  /** True while our own roll is in flight, so a second event cannot roll it twice. */
  rolling: boolean;
  applied: boolean;
}

/** One use of a save activity, and everything still outstanding about it. */
interface Activation {
  usageId: string;
  /** "half" | "none" | "full". Known once the damage arrives; before that, unused. */
  onSave: string;
  damage: { message: any; parts: DamagePart[] } | null;
  /** The abilities and DC the activity asks for, when we could read them off the item. */
  ask: { abilities: string[]; dc: number | null } | null;
  targets: Map<string, TargetState>;
  at: number;
}

const activations = new Map<string, Activation>();

export function registerSaveResolution(): void {
  if (!isDnd5e()) return;

  Hooks.on("createChatMessage", (message: any) => {
    if (!active()) return;
    void route(message);
  });

  // An activation is scoped to the fight it happened in. Keeping them past the end of combat would mean a
  // save rolled in the next encounter could settle damage from the last one, which is absurd but perfectly
  // possible while the ids are still in the map.
  Hooks.on("deleteCombat", () => activations.clear());
}

/** Is this layer doing anything at all right now? */
function active(): boolean {
  if (!isPrimaryGM()) return false;
  if (!isAutoSavesEnabled()) return false;
  // Midi resolves saves itself and writes its verdict to the card. Two layers deciding what a save was
  // worth is a race whichever of them is right, and midi's reading is the real answer rather than a
  // reconstruction of one — see `cards.ts` on why the flags, not the module, are the test.
  if (midiOwnsSaves() || midiOwnsDamage()) return false;
  return true;
}

/** Send a message to whichever half of this cares about it. */
async function route(message: any): Promise<void> {
  try {
    const dnd5e = message?.flags?.dnd5e ?? {};

    // A usage card: no `messageType`, but an activity. This is the earliest moment the NPCs' saves can be
    // rolled, which is the whole point of watching it — a Hold Person has no damage roll to wait for.
    if (!dnd5e.messageType && dnd5e.activity) {
      await onUsage(message);
      return;
    }
    if (rollType(message) === "save") {
      await onSave(message);
      return;
    }
    // A damage roll belonging to a save activity, which is what `damageOnSave` marks and nothing else
    // sets. Read from the roll rather than from the activity, because an unlinked token's item is not
    // always reachable by uuid and this answer is on the message either way.
    if (rollType(message) === "damage" && dnd5e.roll?.damageOnSave) {
      await onSaveDamage(message);
    }
  } catch (err) {
    log("save resolution: failed to read a message:", err);
  }
}

/** The spell has been cast. Note who it points at and roll for anyone the GM would otherwise roll for. */
async function onUsage(message: any): Promise<void> {
  const item = itemOf(message);
  const activity = activityOf(message, item);
  if (String(activity?.type ?? "") !== "save") return;

  const usageId = String(message?.id ?? "");
  if (!usageId) return;

  const act = activation(usageId);
  act.ask = {
    // `save.ability` is a Set of ability ids: 2024 statblocks offer a choice ("Dexterity or
    // Constitution"), and the rule is that the creature picks. The first is taken, which is a choice made
    // for expediency rather than a reading of the rules — it is stated in the receipt so a GM can see it.
    abilities: Array.from(activity?.save?.ability ?? []).map((a) => String(a)),
    dc: Number.isFinite(Number(activity?.save?.dc?.value)) ? Number(activity.save.dc.value) : null,
  };
  noteTargets(act, message);
  await settle(act);
}

/** Somebody rolled a save. Record it against its activation and see whether that finishes anything. */
async function onSave(message: any): Promise<void> {
  const usageId = originatingId(message);
  if (!usageId) return;
  const act = activations.get(usageId);
  if (!act) return;

  const doc = speakerToken(message?.speaker);
  if (!doc) {
    log("save resolution: a save named no token, so it cannot be matched to a target");
    return;
  }
  const reading = readSave(message);
  if (reading.success === null) {
    // No DC on the roll means the save was made without one — from a sheet, or by a macro. It is a number
    // and nothing more, and treating it as a failure (which `BasicRoll#isSuccess` would) is the one
    // outcome that silently costs a creature its hit points.
    log(`save resolution: ${String(doc.name)} rolled a save with no DC on it; cannot judge it`);
    return;
  }

  const id = String(doc.id);
  const state = act.targets.get(id) ?? {
    doc,
    name: String(doc.name ?? "?"),
    success: null,
    rolling: false,
    applied: false,
  };
  // A creature that rolls a save against this card IS a target, whatever the caster happened to have
  // selected when they rolled. The target list is a snapshot of `game.user.targets`, and a table that
  // plays by clicking tokens rather than by targeting them would otherwise be invisible here.
  state.success = reading.success;
  state.rolling = false;
  act.targets.set(id, state);
  await settle(act);
}

/** The damage has been rolled. Everything that has saved can be settled; the rest waits. */
async function onSaveDamage(message: any): Promise<void> {
  const usageId = originatingId(message);
  const parts = damageParts(message);
  if (!parts.length) return;

  if (!usageId) {
    // Nothing to join to. Saying so is worth a line: the alternative is a damage roll that never lands
    // and no explanation anywhere for why this layer stayed silent.
    await explain(game.i18n.localize("NOODLRHOOKS.Combat.AutoSaves.Why.NoActivation"));
    return;
  }

  const act = activation(usageId);
  act.onSave = damageOnSave(message);
  act.damage = { message, parts };
  noteTargets(act, message);
  await settle(act);
}

/** Get or create the activation for a usage card. */
function activation(usageId: string): Activation {
  const existing = activations.get(usageId);
  if (existing) return existing;
  const act: Activation = {
    usageId,
    onSave: "half",
    damage: null,
    ask: null,
    targets: new Map(),
    at: Date.now(),
  };
  activations.set(usageId, act);
  prune();
  return act;
}

function prune(): void {
  const cutoff = Date.now() - ACTIVATION_TTL_MS;
  for (const [id, act] of activations) if (act.at < cutoff) activations.delete(id);
  while (activations.size > ACTIVATION_LIMIT) {
    const oldest = activations.keys().next().value;
    if (oldest === undefined) break;
    activations.delete(oldest);
  }
}

/** Fold a message's recorded targets into an activation, keeping anything already known about them. */
function noteTargets(act: Activation, message: any): void {
  for (const target of targetsOf(message)) {
    const doc = tokenFromActorUuid(target.uuid);
    if (!doc) continue;
    const id = String(doc.id);
    if (act.targets.has(id)) continue;
    act.targets.set(id, {
      doc,
      name: String(doc.name ?? target.name),
      success: null,
      rolling: false,
      applied: false,
    });
  }
}

/**
 * Roll whatever saves nobody else will, then apply the damage to everything whose verdict is in.
 *
 * Called from every entry point, deliberately: the events arrive in any order and from any client, so the
 * only reliable design is one idempotent function that looks at the whole activation and does whatever is
 * currently possible. `applied` and `rolling` are what make repeated calls safe.
 */
async function settle(act: Activation): Promise<void> {
  await rollMissing(act);
  if (!act.damage) return;

  const entries: DamageEntry[] = [];
  for (const state of act.targets.values()) {
    if (state.applied || state.success === null) continue;
    const multiplier = state.success ? saveMultiplier(act.onSave) : 1;
    state.applied = true;
    // A made save against "none" is not a no-op we can skip: the receipt is the only place a GM sees that
    // the spell hit at all, and a multiplier of 0 through the system still fires its own hooks.
    entries.push({
      doc: state.doc,
      multiplier,
      note: game.i18n.localize(
        state.success ? "NOODLRHOOKS.Combat.AutoSaves.Saved" : "NOODLRHOOKS.Combat.AutoSaves.Failed",
      ),
    });
  }
  if (!entries.length) return;
  await applyRolledDamage(act.damage.message, entries, act.damage.parts);
}

/**
 * Roll a save for every target no player can roll for.
 *
 * The election is `rollerForActor`, which answers with a player's id when one owns the creature and null
 * when nobody does. That single call is the whole player/GM asymmetry: a goblin's save is rolled here, a
 * character's is left for the person whose character it is. It is derived rather than configured on
 * purpose — a table does not want a preference here, it wants its players rolling their own dice.
 */
async function rollMissing(act: Activation): Promise<void> {
  const ask = act.ask;
  if (!ask || ask.dc === null || !ask.abilities.length) return;

  for (const state of act.targets.values()) {
    if (state.success !== null || state.rolling || state.applied) continue;
    const actor = state.doc?.actor;
    if (!actor?.system?.abilities) continue;
    // Somebody else's dice to roll. Leave the button.
    if (rollerForActor(actor)) continue;

    const ChatMessage = (globalThis as any).ChatMessage;
    state.rolling = true;
    try {
      await actor.rollSavingThrow(
        { ability: ask.abilities[0], target: ask.dc },
        // No dialog: this is the roll the GM was going to make without thinking about it. Any advantage
        // or disadvantage the creature is entitled to is already in the roll — `#rollD20Test` reads the
        // ability's roll mode, which is where the condition layer and AC5e both put theirs.
        { configure: false },
        {
          data: {
            speaker: ChatMessage.getSpeaker({ actor, token: state.doc }),
            // Stamped by hand because we did not click a button, and this is the only thread back to the
            // activation. Without it our own roll would arrive as an unjoinable save.
            flags: { dnd5e: { originatingMessage: act.usageId } },
          },
        },
      );
    } catch (err) {
      state.rolling = false;
      log(`save resolution: could not roll a save for ${state.name}:`, err);
    }
  }
}

/** Say why a roll was left for a human, whispered to the GMs. */
async function explain(why: string): Promise<void> {
  const ChatMessage = (globalThis as any).ChatMessage;
  try {
    await ChatMessage.create({
      speaker: narrator(),
      whisper: (game.users as any)?.filter?.((u: any) => u?.isGM)?.map((u: any) => u.id) ?? [],
      flags: { [MODULE_ID]: { autoSaves: true } },
      content: `<p><strong>${game.i18n.localize(
        "NOODLRHOOKS.Combat.AutoSaves.Name",
      )}</strong> — ${game.i18n.format("NOODLRHOOKS.Combat.AutoSaves.Manual", { why })}</p>`,
    });
  } catch (err) {
    log("save resolution: could not post an explanation:", err);
  }
}

/** What this layer is holding, and why any of it is unfinished. */
export function surveyDamageSaves(): unknown {
  return {
    setting: COMBAT_SETTINGS.autoSaves,
    enabled: isAutoSavesEnabled(),
    running: active(),
    midiOwnsSaves: midiOwnsSaves(),
    activations: Array.from(activations.values()).map((act) => ({
      usage: act.usageId,
      onSave: act.onSave,
      damageRolled: Boolean(act.damage),
      asks: act.ask,
      targets: Array.from(act.targets.values()).map((state) => ({
        name: state.name,
        saved: state.success,
        rolling: state.rolling,
        applied: state.applied,
        rolledBy: state.doc?.actor ? (rollerForActor(state.doc.actor) ?? "us") : "?",
      })),
    })),
  };
}
