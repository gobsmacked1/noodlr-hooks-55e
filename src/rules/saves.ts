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
import { isPrimaryGM, isRollerFor, rollerForActor } from "../util/gm";
import { narrator } from "../util/speaker";
import { isAutoSavesEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import { midiOwnsDamage, midiOwnsSaves } from "../system/dnd5e-damage";
import { canResist } from "../system/dnd5e-legendary";
import { applyRolledDamage, type DamageEntry } from "./damage";
import { savesSkip } from "./counterspell";
import { considerResistance } from "./legendary";
import { considerBarbs } from "./barbs";
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
import { fireSaveTriggers, type SaveVerdict } from "../capability/saves";

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
  /** The failed save's message, which is what a legendary resistance is stamped on. */
  saveMessage: any;
  /** Set once a resistance has been offered for this failure, so it is offered exactly once. */
  offered: boolean;
  /** Set once Silvery Barbs has been offered against this success, for the same reason. */
  barbed: boolean;
}

/** One use of a save activity, and everything still outstanding about it. */
interface Activation {
  usageId: string;
  /** The usage card itself, so the caster and the activity are readable without a chat-log lookup. */
  usage: any;
  /** "half" | "none" | "full". Known once the damage arrives; before that, unused. */
  onSave: string;
  damage: { message: any; parts: DamagePart[] } | null;
  /** The abilities and DC the activity asks for, when we could read them off the item. */
  ask: { abilities: string[]; dc: number | null } | null;
  /**
   * Does this activity deal damage at all? Null while unknown.
   *
   * It decides WHEN a legendary resistance can be offered, which is the only reason it is recorded. A
   * damaging spell's stake is a number, so the offer waits for the damage roll; a Hold Monster has no
   * damage roll coming, so waiting for one would mean never asking about the failures that matter most.
   */
  deals: boolean | null;
  /** What demanded the save, for the resistance prompt. */
  source: string;
  /** An open resistance prompt. Damage must not land under it. */
  asking: Promise<void> | null;
  targets: Map<string, TargetState>;
  at: number;
}

const activations = new Map<string, Activation>();

/**
 * Record that a save was cancelled as an automatic failure.
 *
 * Cancelling the roll (Paralyzed / Unconscious auto-fail Str/Dex) produces no save
 * message, so `onSave` never runs and `success` stays null. The damage layer then
 * stands aside because auto-saves is on, and Apply sits there forever. An auto-fail
 * is a failed save — "the answer is no", not "we have no answer".
 *
 * Returns false when a verdict is already in, so a later card cannot overwrite a
 * real roll. Exported so a test can pin the distinction without a Foundry world.
 */
export function applyAutoFailedSave(state: {
  success: boolean | null;
  rolling: boolean;
}): boolean {
  if (state.success !== null) return false;
  state.success = false;
  state.rolling = false;
  return true;
}

export function registerSaveResolution(): void {
  if (!isDnd5e()) return;

  Hooks.on("createChatMessage", (message: any) => {
    if (!active()) return;
    void route(message);
  });

  // A legendary resistance spent by hand is an UPDATE to a save we have already read: dnd5e's own button
  // stamps `roll.forceSuccess` on the existing message rather than posting anything. Without this, a GM who
  // pressed it during the pause before the damage roll would still watch the full amount land — which is the
  // worst version of this bug, because they had intervened and been ignored.
  Hooks.on("updateChatMessage", (message: any, changed: any) => {
    if (!active()) return;
    if (changed?.flags?.dnd5e?.roll?.forceSuccess !== true) return;
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

    // A cancelled auto-fail is a failed save. The condition layer posts this instead of a
    // roll, because a dialog would invite a total that contradicts Paralyzed / Unconscious.
    // It has to be read here — `preRollSavingThrow` is client-local, so a player's auto-fail
    // would otherwise never reach the GM who applies the damage.
    if (message?.flags?.[MODULE_ID]?.conditionAutoFail) {
      await onAutoFailedSave(message);
      return;
    }

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

  // Counterspell is a save activity and is not this layer's to settle. The window in `rules/counterspell.ts`
  // is holding a cast open waiting on that save's verdict, so it rolls and reads it there; settling it here
  // as well would race, and the visible symptom would be two legendary resistance prompts for one counter.
  if (savesSkip(item)) return;

  const usageId = String(message?.id ?? "");
  if (!usageId) return;

  const act = activation(usageId);
  act.usage = message;
  act.deals = Number(activity?.damage?.parts?.length ?? 0) > 0;
  act.source = String(item?.name ?? activity?.name ?? "");
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
    saveMessage: null,
    offered: false,
    barbed: false,
  };
  state.saveMessage = message;
  // A creature that rolls a save against this card IS a target, whatever the caster happened to have
  // selected when they rolled. The target list is a snapshot of `game.user.targets`, and a table that
  // plays by clicking tokens rather than by targeting them would otherwise be invisible here.
  state.success = reading.success;
  state.rolling = false;
  act.targets.set(id, state);
  await settle(act);
}

/**
 * The condition layer cancelled the roll and posted a card instead. Treat it as a failed save
 * so `settle` can apply damage the same way it would after a rolled 1.
 */
async function onAutoFailedSave(message: any): Promise<void> {
  const doc = speakerToken(message?.speaker);
  if (!doc) {
    log("save resolution: an auto-fail named no token, so it cannot be matched to a target");
    return;
  }

  const act = activationForAutoFail(message, doc);
  if (!act) {
    log(
      `save resolution: ${String(doc.name)} auto-failed a save with no activation to attach to`,
    );
    return;
  }

  const id = String(doc.id);
  const fail = message.flags[MODULE_ID].conditionAutoFail;
  const state = act.targets.get(id) ?? {
    doc,
    name: String(doc.name ?? "?"),
    success: null,
    rolling: false,
    applied: false,
    saveMessage: null,
    offered: false,
    barbed: false,
  };
  if (!applyAutoFailedSave(state)) {
    log(`save resolution: ${state.name} already has a save verdict; ignoring a later auto-fail`);
    return;
  }
  // The auto-fail card is not a d20, so legendary resistance cannot stamp `forceSuccess` on a
  // real roll. `considerResistance` still spends the resource and this layer flips `success`.
  state.saveMessage = message;
  act.targets.set(id, state);
  log(
    `save resolution: ${state.name} auto-fails ${String(fail?.ability ?? "?")} (${String(fail?.status ?? "?")}) — recorded as a failed save`,
  );
  await settle(act);
}

/** Prefer the stamped usage id; fall back to the one unfinished activation that names this token. */
function activationForAutoFail(message: any, doc: any): Activation | null {
  const usageId = originatingId(message);
  if (usageId) {
    const act = activations.get(usageId);
    if (act) return act;
  }
  const tokenId = String(doc.id ?? "");
  const matches: Activation[] = [];
  for (const act of activations.values()) {
    const state = tokenId ? act.targets.get(tokenId) : undefined;
    if (state && state.success === null) matches.push(act);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    log(
      `save resolution: auto-fail of ${String(doc.name)} matches ${matches.length} activations; not guessing`,
    );
  }
  return null;
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
    usage: null,
    onSave: "half",
    damage: null,
    ask: null,
    deals: null,
    source: "",
    asking: null,
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
      saveMessage: null,
      offered: false,
      barbed: false,
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

  // Anybody still deciding whether to spend a resource gets to finish first. Same shape as the damage
  // layer's reaction window and for the same reason: an answer that arrives after the damage has landed has
  // cost somebody a resource and changed nothing.
  if (act.asking) await act.asking;
  const asking = spoilAndResist(act).finally(() => {
    if (act.asking === asking) act.asking = null;
  });
  act.asking = asking;
  await asking;

  // Compiled save riders (Hold Person restrain, Charm Person) fire whether or not this activity
  // deals damage. The damage loop below returns early when none has arrived; that must not take
  // the riders with it. After `spoilAndResist`, so a spoiled success and a bought failure have
  // already moved between the two lists.
  await dispatchSaveTriggers(act);

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
        state.success
          ? "NOODLRHOOKS.Combat.AutoSaves.Saved"
          : "NOODLRHOOKS.Combat.AutoSaves.Failed",
      ),
    });
  }
  if (!entries.length) {
    const waiting = Array.from(act.targets.values()).filter((s) => !s.applied && s.success === null);
    if (waiting.length) {
      log(
        `save resolution: ${act.source || act.usageId} damage is waiting on ${waiting
          .map((s) => s.name)
          .join(", ")} — no save verdict yet`,
      );
    }
    return;
  }
  await applyRolledDamage(act.damage.message, entries, act.damage.parts);
}

/**
 * Hand every target whose verdict is final to the capability layer.
 *
 * A failure that can still be bought with a legendary resistance is not final — `offered` is what
 * `offerResistances` sets, including when it waits on a damage roll that has not arrived yet. A
 * success is final once Barbs has had its pass (which `spoilAndResist` already awaited).
 */
async function dispatchSaveTriggers(act: Activation): Promise<void> {
  const usage = act.usage ?? (game.messages as any)?.get?.(act.usageId) ?? null;
  const verdicts: SaveVerdict[] = [];
  for (const state of act.targets.values()) {
    verdicts.push({
      doc: state.doc,
      success: state.success,
      saveMessage: state.saveMessage,
      pendingResistance: state.success === false && !state.offered && canResist(state.doc?.actor),
    });
  }
  try {
    await fireSaveTriggers(usage, verdicts);
  } catch (err) {
    log("save resolution: compiled save triggers failed:", err);
  }
}

/**
 * Successes first, failures second — and that order is a rules interaction rather than a preference.
 *
 * Silvery Barbs answers a made save and a legendary resistance answers a failed one, so the two sets are
 * disjoint at any instant but NOT across the pass: a save spoiled by Barbs becomes a failure, and a
 * legendary creature is then entitled to buy it back. Asking about resistances first would deny it that,
 * silently, on exactly the creatures where the interaction is most likely to come up.
 */
async function spoilAndResist(act: Activation): Promise<void> {
  await spoilSuccesses(act);
  await offerResistances(act);
}

/**
 * Offer Silvery Barbs against every save that has just been made.
 *
 * ONE PER SAVE, because each creature rolls its own d20 — unlike an attack, where three targets share one
 * roll. An area spell that five goblins all save against is five separate successes and five separate
 * questions, which is why the offer is capped at one candidate: five prompts is already a lot, and five
 * prompts each offering two casters would be unusable.
 *
 * A BOUGHT SUCCESS IS NOT SPOILABLE. A legendary resistance says the creature succeeds, full stop; the die
 * is no longer what decided it, so rerolling would spend a slot to change a number nobody is reading.
 *
 * `barbed` is set BEFORE the await, same as `offered`, so a re-entrant `settle` cannot raise a second dialog
 * about one save.
 */
async function spoilSuccesses(act: Activation): Promise<void> {
  for (const state of act.targets.values()) {
    if (state.applied || state.barbed || state.success !== true) continue;
    if (!state.saveMessage) continue;

    const before = readSave(state.saveMessage);
    if (before.forced) continue;
    if (before.dc === null) continue;

    state.barbed = true;
    const outcome = await considerBarbs({
      kind: "save",
      message: state.saveMessage,
      roller: state.doc,
      against: before.dc,
      source: act.source,
    });
    if (!outcome.taken) continue;

    // Re-read rather than trust the reroll's own arithmetic, for the same reason the damage layer re-reads
    // the attack: the card has been rewritten, so `readSave` is now the authority on what it says.
    const after = readSave(state.saveMessage);
    if (after.success === false) state.success = false;
  }
}

/**
 * Ask about a legendary resistance for every failure that could still be overturned.
 *
 * Sequential rather than concurrent, deliberately: two prompts at once is two dialogs stacked on one
 * screen with two clocks running, and the case that produces them — an area spell catching two legendary
 * creatures — is rare enough that answering them one at a time costs nothing.
 *
 * `offered` is set BEFORE the await, which is what makes a re-entrant `settle` safe: the second pass sees
 * the flag and skips, rather than raising a second dialog about the same save.
 */
async function offerResistances(act: Activation): Promise<void> {
  for (const state of act.targets.values()) {
    if (state.applied || state.offered || state.success !== false) continue;
    if (!canResist(state.doc?.actor)) continue;

    // What a resistance would be worth, or null when the failure is not a number. A damaging spell whose
    // damage has not been rolled yet is neither: it is simply too early, so leave it for the next pass.
    let avoided: number | null;
    if (act.damage) {
      const kept = saveMultiplier(act.onSave);
      const rolled = act.damage.parts.reduce((sum, part) => sum + part.value, 0);
      // A save that changes nothing about the damage ("full") does not make the resistance pointless — it
      // makes its value unreadable, because whatever else the spell does on a failure is prose on the item.
      // Treated as the unknown-stake case rather than as zero, which would silently never ask.
      avoided = kept >= 1 ? null : Math.abs(rolled) * (1 - kept);
    } else if (act.deals === false) {
      avoided = null;
    } else {
      continue;
    }

    state.offered = true;
    const resisted = await considerResistance({
      actor: state.doc.actor,
      message: state.saveMessage,
      name: state.name,
      spell: act.source,
      avoided,
    });
    if (resisted) state.success = true;
  }
}

/**
 * Roll a save for every target this client is the designated roller for.
 *
 * The election is `isRollerFor`, not a truthy `rollerForActor`. That function always names
 * someone when a GM is online (the player, else the GM), so treating a name as "leave the
 * button" skipped every NPC save — Hold Person's Wisdom DC sat on Bardo's usage card and
 * the Assassin never rolled. A connected player still owns their own dice: `isRollerFor`
 * is false on the GM for that character, and the button stays.
 */
async function rollMissing(act: Activation): Promise<void> {
  const ask = act.ask;
  if (!ask || ask.dc === null || !ask.abilities.length) return;

  for (const state of act.targets.values()) {
    if (state.success !== null || state.rolling || state.applied) continue;
    const actor = state.doc?.actor;
    if (!actor?.system?.abilities) continue;
    if (!isRollerFor(actor)) {
      const who = rollerForActor(actor);
      log(`save resolution: leaving ${state.name}'s save for ${who ?? "a player"}`);
      continue;
    }

    const ChatMessage = (globalThis as any).ChatMessage;
    state.rolling = true;
    log(`save resolution: rolling ${ask.abilities[0]} DC ${ask.dc} for ${state.name}`);
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
      log(`save resolution: could not roll a save for ${state.name}:`, err);
    } finally {
      // A cancelled auto-fail returns [] without throwing. Leave `rolling` set only while a
      // verdict is still outstanding so a later settle can retry; `onAutoFailedSave` clears
      // it itself when the card arrives.
      if (state.success === null) state.rolling = false;
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
        barbsOffered: state.barbed,
        resistanceOffered: state.offered,
        rolledBy: (() => {
          const actor = state.doc?.actor;
          if (!actor) return "?";
          if (isRollerFor(actor)) return "us";
          const id = rollerForActor(actor);
          const user = id ? (game.users as any)?.get?.(id) : null;
          return String(user?.name ?? id ?? "player");
        })(),
      })),
    })),
  };
}
