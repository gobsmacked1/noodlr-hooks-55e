// Rolled damage lands on the creature it was rolled against, without anybody pressing a button.
//
// WHY THIS HAS TO EXIST. dnd5e decides whether an attack hit inside its chat card's RENDERER and stores
// the answer nowhere (see `cards.ts`), so it has no basis on which to apply anything, and what it ships
// instead is the damage tray: a button per target for a human to press. That is a deliberate position —
// hit determination and "Range, reach, & cover" are both unshipped roadmap items — and midi-qol is the
// module that has always filled the gap. On a table without midi, every single hit costs the GM a click
// and a subtraction.
//
// WHAT IT UNBLOCKS IS LARGER THAN ITSELF, and that is the real argument for building it first. Death
// saves, instant death, Unconscious at zero and the concentration save all hang off dnd5e's own
// `damageActor` hook, which only fires when somebody applies damage. Every one of those rules was
// already built here and none of them could fire on a table where the tray went unpressed. Applying the
// damage switches the whole chain on.
//
// WHAT IT DOES NOT DO: arithmetic. `Actor5e#applyDamage` resolves resistance, vulnerability, immunity,
// physical-damage properties, temporary hit points and the floor at zero, and fires the system's hooks on
// the way. See `system/dnd5e-damage.ts`.
//
// WHERE IT STANDS DOWN, and this is the shape the user asked for: when the answer is genuinely ambiguous
// — no readable AC, no recorded target, two identical tokens the target record cannot tell apart — it
// applies nothing, leaves dnd5e's button exactly where it is, and says why in a GM whisper. A wrong
// subtraction is worse than a click, and silence is worse than either.

import { COMBAT_SETTINGS, MODULE_ID, log } from "../constants";
import { isPrimaryGM } from "../util/gm";
import { narrator } from "../util/speaker";
import { enabledForEither, isAutoDamageEnabled, isAutoSavesEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  applyDamageTo,
  hasHitPoints,
  midiOwnsDamage,
  restoreHp,
  snapshotHp,
  type HpSnapshot,
} from "../system/dnd5e-damage";
import { grazeDamage } from "../system/dnd5e-graze";
import { fireAttackTriggers } from "../capability/attack";
import { offerReaction } from "./offer";
import { considerBarbs } from "./barbs";
import { considerAgainstDiceMods, considerDiceMods } from "./dice-mod";
import { considerDamageDice } from "./damage-dice";
import { noteSpent, noteVerdict, type GateVerdict } from "./gate";
import { offerSneakAttack } from "./sneak";
import {
  activityOf,
  damageParts,
  isHealing,
  itemOf,
  midiHits,
  originatingId,
  readHits,
  rollType,
  speakerToken,
  targetsOf,
  tokenFromActorUuid,
  type DamagePart,
  type HitReading,
} from "./cards";

/** Our own flag on a message we have already acted on. */
const APPLIED = "damageApplied";

/**
 * Attack verdicts, waiting for the damage roll that follows them.
 *
 * Keyed by the id of the USAGE card, which is what joins the two: dnd5e stamps
 * `flags.dnd5e.originatingMessage` with it on the attack roll and again on the damage roll. Also keyed by
 * the attack message's own id, because a roll made through `BasicRoll` records that instead.
 *
 * Bounded rather than unbounded: a long session would otherwise accumulate one entry per attack forever,
 * and nothing older than the last few exchanges can ever be asked about.
 */
const verdicts = new Map<string, HitReading>();
const VERDICT_LIMIT = 64;

/** Messages already acted on, so our own flag write cannot re-enter through `updateChatMessage`. */
const handled = new Set<string>();

/**
 * Reaction windows still open, keyed the same way as `verdicts`.
 *
 * The damage roll must not be applied while somebody is still deciding whether they were hit. dnd5e posts
 * the attack and the damage as two separate presses, so in practice there is a human gap — but "in practice"
 * is not a guarantee, and a Shield answered a moment too late would be a spell slot spent on damage that had
 * already landed. So the window is registered synchronously before anybody is asked, and the damage path
 * awaits it.
 */
const windows = new Map<string, Promise<void>>();

/** What we took off each creature, for the undo control. Keyed by the card that reported it. */
const undoable = new Map<string, HpSnapshot[]>();

export function registerDamageApplication(): void {
  Hooks.on("createChatMessage", (message: any) => {
    void consider(message, message?.flags).catch((err) => log("auto damage failed:", err));
  });

  // Midi fills one card in over several updates rather than posting separate roll messages, so the
  // verdict can arrive on an update to a message we have already seen. Same two-path shape as the
  // forced-movement layer, and for the same reason.
  Hooks.on("updateChatMessage", (message: any, changed: any) => {
    void consider(message, changed?.flags).catch((err) => log("auto damage failed:", err));
  });

  Hooks.on("deleteCombat", () => {
    verdicts.clear();
    handled.clear();
    undoable.clear();
  });

  const generation = Number((game as any)?.release?.generation ?? 13);
  Hooks.on(generation >= 13 ? "renderChatMessageHTML" : "renderChatMessage", wireCard);
}

/**
 * Should this client be doing this at all?
 *
 * Primary GM only. A damage roll's chat message arrives on every client, and two clients both calling
 * `applyDamage` subtracts twice — the same reason transcripts, artifact commits and forced movement all
 * elect one writer. It also means the GM's permissions are what apply the damage, so a player's own
 * hit points can be moved without granting anybody rights they should not have.
 */
function active(): boolean {
  return (
    isPrimaryGM() && isDnd5e() && enabledForEither(COMBAT_SETTINGS.autoDamage) && !midiOwnsDamage()
  );
}

async function consider(message: any, flags: any): Promise<void> {
  if (!active()) return;
  const id = String(message?.id ?? "");
  if (!id || handled.has(id)) return;

  // Midi's own verdict, when it left one. Token uuids, and the real answer rather than a reconstruction.
  const fromMidi = midiHits(flags);
  if (fromMidi.length > 0) {
    // No margins: midi records the verdict and not the arithmetic behind it, which costs nothing here
    // because midi runs its own reaction window and this one stands aside whenever midi is applying damage.
    remember(message, { hits: fromMidi, missed: [], unresolved: [], margin: {} });
  }

  const kind = rollType(message);
  if (kind === "attack") {
    let reading = readHits(message);
    remember(message, reading);
    if (reading.hits.length === 0 && reading.missed.length > 0) {
      const token = speakerToken(message?.speaker);
      const actor = token?.actor ?? message?.speakerActor ?? null;
      if (actor) {
        const result = await considerDiceMods({ kind: "attack", message, actor, token });
        if (result.changed) {
          reading = readHits(message);
          remember(message, reading);
        }
      }
    }
    // Registered before anything is awaited, so a damage roll arriving in the same tick still finds it.
    const window = reactionWindow(message, reading).finally(() => {
      for (const key of keysOf(message)) if (windows.get(key) === window) windows.delete(key);
    });
    for (const key of keysOf(message)) windows.set(key, window);
    await window;
    // Only now, because a Shield answered inside that window moves a creature out of `hits` and the
    // button must never open on a hit that has since been turned aside.
    await settleAttack(message, reading);
    return;
  }
  if (kind !== "damage" && kind !== "healing") return;

  // One press per attack, recorded where a reload and a second client can both see it.
  await noteSpent(message);

  // Anybody still deciding whether they were hit gets to finish first. Piercer
  // is hit-gated, so a Shield that turns the swing aside must land before we ask.
  for (const key of keysOf(message)) {
    const open = windows.get(key);
    if (open) await open;
  }

  await considerDamageDice(message, { hit: filedHit(message) });

  const parts = damageParts(message);
  if (parts.length === 0) return;
  if (message?.getFlag?.(MODULE_ID, APPLIED)) return;

  const resolved = resolveTargets(message);
  if (resolved.silent) return;
  if (resolved.declined) {
    handled.add(id);
    await explain(message, resolved.declined);
    return;
  }
  if (resolved.targets.length === 0) {
    // A clean miss against everything it was aimed at. Nothing to apply and nothing to explain: the
    // attack card already says so, and a whisper per miss would be noise on the busiest event in combat.
    handled.add(id);
    return;
  }

  handled.add(id);
  await applyRolledDamage(
    message,
    resolved.targets.map((doc) => ({ doc, multiplier: 1 })),
    parts,
    resolved.unresolved,
  );
}

/** Filed attack verdict for this damage card, or `undefined` when nothing was filed. */
function filedHit(message: any): boolean | null | undefined {
  for (const key of keysOf(message)) {
    const reading = verdicts.get(key);
    if (!reading) continue;
    if (reading.hits.length > 0) return true;
    if (reading.missed.length > 0) return false;
    return null;
  }
  return undefined;
}

/**
 * File an attack's verdict under every id the damage roll might quote.
 *
 * Two, because there are two shapes. A damage roll launched from a usage card's button carries that
 * card's id, which the attack roll carries too — so the usage card is the join. Midi instead puts both
 * the verdict and the rolls on one message, so that message's own id is the join. Recording under both
 * costs a map entry and removes a whole branch from the lookup.
 *
 * AN EMPTY READING IS STILL A VERDICT AND MUST BE FILED. "Nothing was hit" is not "there was no attack",
 * and the damage roll cannot tell the two apart — so a rogue who rolled 14 against AC 15 and then rolled
 * damage anyway, which players do every round, was told "no attack roll was recorded for it" and handed
 * the Apply button for an attack that demonstrably did not land. The distinction that matters downstream
 * is drawn in `resolveTargets`, where all three shapes are separately reportable.
 */
function remember(message: any, reading: HitReading): void {
  for (const key of keysOf(message)) verdicts.set(key, reading);
  while (verdicts.size > VERDICT_LIMIT) {
    const oldest = verdicts.keys().next().value;
    if (oldest === undefined) break;
    verdicts.delete(oldest);
  }
}

/** Every id a later roll from the same use might quote. See `remember`. */
function keysOf(message: any): string[] {
  return [String(message?.id ?? ""), originatingId(message)].filter(Boolean) as string[];
}

/**
 * The moment dnd5e never had: an attack has been rolled, and has not yet been resolved.
 *
 * This is the whole reason the hit-determination layer was worth building first. Shield is a reaction "when
 * you are hit by an attack", and on a table without midi there is no such event — the system rolls a number,
 * renders a colour, and stores nothing — so a wizard's most-used spell was unplayable except by a human
 * noticing and the GM agreeing to walk the attack back. Now that one answer to "did this connect" exists,
 * and lives here, the window falls out of it: read the verdict, ask the creature that was hit, and if the
 * bonus arrives, move it out of `hits` before anything is applied.
 *
 * THREE PASSES SHARE ONE WINDOW, and the ORDER IS THE DESIGN. Silvery Barbs first, Cutting Words
 * second, Shield third. Barbs and Cutting Words both attack the number; a spoiled hit must not be
 * subtracted, and a subtracted miss must not be Shielded. Shield still attacks the AC. The other
 * orders spend a slot or a BI die on a roll that no longer lands.
 */
async function reactionWindow(message: any, reading: HitReading): Promise<void> {
  if (reading.hits.length === 0) return;
  // `speakerToken` rather than a local reader: the attack-trigger dispatch asks the same question a
  // moment later, and two answers to "which token rolled this" is how a rider ends up on the wrong
  // creature. It is also the better answer — it falls back to the actor's sole token on the scene when
  // the speaker carries no token id, which a bare scene lookup does not.
  const attacker = speakerToken(message?.speaker);

  await barbsWindow(message, reading, attacker);
  if (reading.hits.length === 0) return;
  await cuttingWordsWindow(message, reading, attacker);
  if (reading.hits.length === 0) return;

  for (const doc of [...reading.hits]) {
    const margin = reading.margin[String(doc?.id ?? "")];
    if (!Number.isFinite(margin)) continue; // A crit. No AC bonus reaches it.
    const answer = await offerReaction(doc?.actor, {
      actorUuid: String(doc?.actor?.uuid ?? ""),
      tokenUuid: String(doc?.uuid ?? ""),
      targetUuid: String(attacker?.uuid ?? ""),
      targetName: String(attacker?.name ?? "the attacker"),
      trigger: "incoming",
      margin: Number(margin),
    });
    if (!answer.taken || !answer.acBonus) continue;
    if (Number(margin) >= Number(answer.acBonus)) continue; // Taken anyway, but it does not turn the hit.

    const at = reading.hits.indexOf(doc);
    if (at >= 0) reading.hits.splice(at, 1);
    reading.missed.push(doc);
    log(`shield: ${doc?.name}'s ${answer.label} turns a hit by ${margin} into a miss`);
    await (globalThis as any).ChatMessage?.create?.({
      speaker: narrator(),
      content: `<p><strong>${answer.label}</strong> — ${doc?.name}'s AC rises by ${answer.acBonus} and the attack misses.</p>`,
    });
  }
}

/**
 * Offer Silvery Barbs against the attack roll, and re-read the card if the die moved.
 *
 * ASKED ONCE PER ROLL, NOT ONCE PER TARGET, because the spell is cast on the creature that rolled rather
 * than on any of the creatures it was aimed at. An attack against three targets is one d20 and therefore one
 * question; asking per target would invite three slots spent on one die.
 *
 * THE VERDICT IS RE-READ RATHER THAN RECOMPUTED. `rerollLower` rewrites the message, so asking `readHits` for
 * a fresh answer is both shorter and the only version that cannot drift from the original reading — the same
 * one-question-one-implementation rule that the Hide line-of-sight bug and the forced-movement layer's
 * private copy of "did that connect" both taught. It also gets crit and fumble right for free, because a
 * discarded 19 is no longer what the die sums.
 *
 * Mutated in place, because `verdicts` and the damage path are holding this object.
 */
async function barbsWindow(message: any, reading: HitReading, attacker: any): Promise<void> {
  // The best case for the barber is the target it beat by least, since that is the one a spoiled roll is
  // likeliest to save. It is also the honest number to show them: a reroll has to find at least this much.
  const margins = reading.hits
    .map((doc) => reading.margin[String(doc?.id ?? "")])
    .filter((value) => Number.isFinite(value)) as number[];
  if (margins.length === 0) return; // Every hit was a critical, and no reroll of a kept 20 can be worse.

  const outcome = await considerBarbs({
    kind: "attack",
    message,
    roller: attacker,
    against: Number(message?.rolls?.[0]?.total) - Math.min(...margins),
    source: String(itemOf(message)?.name ?? ""),
    victim: reading.hits[0],
  });
  if (!outcome.taken) return;

  const fresh = readHits(message);
  reading.hits.splice(0, reading.hits.length, ...fresh.hits);
  reading.missed.splice(0, reading.missed.length, ...fresh.missed);
  reading.unresolved.splice(0, reading.unresolved.length, ...fresh.unresolved);
  for (const key of Object.keys(reading.margin)) delete reading.margin[key];
  Object.assign(reading.margin, fresh.margin);
}

/**
 * Cutting Words after Barbs. A spoiled hit must not be subtracted — the Bard would spend
 * a die and a reaction to worsen a roll that already missed. Re-read; do not infer.
 */
async function cuttingWordsWindow(message: any, reading: HitReading, attacker: any): Promise<void> {
  if (reading.hits.length === 0) return;
  const actor = attacker?.actor ?? message?.speakerActor ?? null;
  if (!actor) return;
  const outcome = await considerAgainstDiceMods({
    kind: "attack",
    message,
    actor,
    token: attacker,
  });
  if (!outcome.changed) return;

  const fresh = readHits(message);
  reading.hits.splice(0, reading.hits.length, ...fresh.hits);
  reading.missed.splice(0, reading.missed.length, ...fresh.missed);
  reading.unresolved.splice(0, reading.unresolved.length, ...fresh.unresolved);
  for (const key of Object.keys(reading.margin)) delete reading.margin[key];
  Object.assign(reading.margin, fresh.margin);
}

/**
 * The attack is finished being argued about. Say so, and pay out anything a miss still owes.
 *
 * ORDER MATTERS AND IT IS THE OBVIOUS ONE: graze is settled before the verdict is filed, so the button is
 * released into a world where the miss has already been paid for. The other way round leaves a window in
 * which a player sees "Grazed" and no damage, presses something, and is right to.
 *
 * The verdict is deliberately a THREE-way answer plus an escape. `open` is what an attack against nobody,
 * or against a target nobody could resolve, comes back as — the module has no reading, so it says so and
 * hands the decision to the human rather than inventing a miss. Locking on "I do not know" is the one
 * behaviour that would make this feature a liability.
 *
 * The compiled riders go off HERE, between the two, and both sides of that are deliberate. After the
 * reaction window, so a Shield that turned a hit into a miss has already moved the creature and the
 * poison follows the verdict rather than the die. Before the flag, so everything a rider does has landed
 * by the time the Damage button opens.
 *
 * SNEAK ATTACK IS THE ONE THING THAT GOES AFTER THE FLAG, and it is the only exception because it is the
 * only one that ASKS. Everything above is deterministic and finishes in a tick; the Sneak Attack dialog
 * can sit on a player's screen for the whole six-second countdown, and holding the Damage button shut for
 * that long would read exactly like the lock having jammed. Its damage arrives as its own card with its
 * own undo, so nothing is lost by it landing a moment after the weapon's.
 */
async function settleAttack(message: any, reading: HitReading): Promise<void> {
  const grazed = await applyGraze(message, reading);
  await fireAttackTriggers(message, reading);

  let verdict: GateVerdict = "open";
  if (reading.hits.length > 0) verdict = "hit";
  else if (reading.missed.length > 0) verdict = grazed ? "graze" : "miss";
  await noteVerdict(message, verdict);

  const sneak = await offerSneakAttack(message, reading);
  if (sneak) {
    await applyRolledDamage(
      message,
      [
        {
          doc: sneak.target,
          multiplier: 1,
          note: game.i18n.localize("NOODLRHOOKS.Combat.Sneak.Note"),
        },
      ],
      [{ value: sneak.total, type: sneak.damageType, properties: new Set<string>() }],
    );
  }
}

/**
 * Graze: the ability modifier, flat, to everything this swing missed.
 *
 * Applied rather than offered, and the button stays shut behind it, because pressing Damage would roll the
 * weapon's dice — which is not what Graze deals. See `system/dnd5e-graze.ts` for the rule and for why the
 * mastery is read off the attack message rather than off the weapon.
 *
 * `unresolved` targets are excluded on purpose. Graze needs a creature to deal damage TO, and "there are
 * two of these on the scene and the record cannot say which" is exactly as unanswerable here as it is for
 * a hit.
 */
async function applyGraze(message: any, reading: HitReading): Promise<boolean> {
  if (reading.missed.length === 0) return false;
  const item = itemOf(message);
  const graze = grazeDamage(message, item, activityOf(message, item));
  if (!graze) return false;

  await applyRolledDamage(
    message,
    reading.missed.map((doc) => ({ doc, multiplier: 1, note: masteryNote() })),
    [{ value: graze.amount, type: graze.type, properties: new Set<string>() }],
  );
  return true;
}

function masteryNote(): string {
  return game.i18n.localize("NOODLRHOOKS.Combat.Gate.Graze");
}

interface Resolution {
  targets: any[];
  unresolved: Array<{ name: string; why: string }>;
  /** Set when we are deliberately leaving this to the button, with the reason to report. */
  declined?: string;
  /** Set when another layer of ours has it, so there is nothing to report and nothing to mark. */
  silent?: boolean;
}

/**
 * Who should take this roll?
 *
 * The activity's own type is what decides, and the four answers are genuinely different rules rather
 * than degrees of confidence:
 *
 *   attack — somebody had to hit. The verdict comes from the attack roll that preceded this one; without
 *            one there is no honest way to know, so decline.
 *   save   — a saving throw decides how much lands, so `rules/saves.ts` owns it: that layer holds the
 *            roll open until every verdict is in and then calls back into `applyRolledDamage` with a
 *            multiplier per creature. Stay out of it silently while that layer is running, and explain
 *            only when it is switched off — where applying the full amount really would be a rules error.
 *   damage — auto-hitting damage (Magic Missile, falling, a Damage activity). The recorded targets ARE
 *            the answer and no verdict is needed.
 *   heal   — the same, with the sign the other way round.
 *
 * No activity at all means the roll came off a sheet rather than a card button, so there is nothing to
 * attribute it to. Decline.
 */
function resolveTargets(message: any): Resolution {
  const item = itemOf(message);
  const activity = activityOf(message, item);
  const kind = String(activity?.type ?? "");

  if (!activity) {
    return { targets: [], unresolved: [], declined: reason("NoActivity") };
  }

  if (kind === "attack") {
    const verdict = verdicts.get(originatingId(message)) ?? verdicts.get(String(message?.id ?? ""));
    if (!verdict) return { targets: [], unresolved: [], declined: reason("NoAttack") };
    // An attack roll aimed at nobody. Distinct from having no attack roll at all, and distinct again
    // from a miss: there is a verdict and it is about nothing, so the Apply button is the honest answer
    // and "no attack roll was recorded" would be a plain untruth.
    if (
      verdict.hits.length === 0 &&
      verdict.missed.length === 0 &&
      verdict.unresolved.length === 0
    ) {
      return { targets: [], unresolved: [], declined: reason("NoTargets") };
    }
    return { targets: verdict.hits, unresolved: verdict.unresolved };
  }

  if (kind === "save") {
    // Silent when the save layer has it: two whispers about one roll, one of them saying nothing happened
    // while it demonstrably did, is worse than no whisper at all.
    if (isAutoSavesEnabled()) return { targets: [], unresolved: [], declined: "", silent: true };
    return { targets: [], unresolved: [], declined: reason("NeedsSave") };
  }

  // Auto-hitting damage or healing: everything the roller was pointing at.
  const targets: any[] = [];
  const unresolved: Array<{ name: string; why: string }> = [];
  for (const target of targetsOf(message)) {
    const doc = tokenFromActorUuid(target.uuid);
    if (doc) targets.push(doc);
    else unresolved.push({ name: target.name, why: reason("UnknownToken") });
  }
  if (targets.length === 0 && unresolved.length === 0) {
    return { targets: [], unresolved: [], declined: reason("NoTargets") };
  }
  return { targets, unresolved };
}

function reason(key: string): string {
  return game.i18n.localize(`NOODLRHOOKS.Combat.AutoDamage.Why.${key}`);
}

/** One creature about to take a roll, and how much of it. */
export interface DamageEntry {
  doc: any;
  /** 1 full, 0.5 a made save, 0 immunity by rule. Passed to the system; never applied by hand. */
  multiplier: number;
  /** A clause for the receipt, e.g. "saved". Optional. */
  note?: string;
}

/** Apply a roll to a set of creatures, report what moved, and offer to put it back. */
export async function applyRolledDamage(
  message: any,
  entries: DamageEntry[],
  parts: DamagePart[],
  unresolved: Array<{ name: string; why: string }> = [],
): Promise<void> {
  const healing = isHealing(parts);
  const lines: string[] = [];
  const snapshots: HpSnapshot[] = [];

  for (const entry of entries) {
    const doc = entry.doc;
    const actor = doc?.actor;
    if (!actor || !hasHitPoints(actor)) {
      unresolved.push({ name: String(doc?.name ?? "?"), why: reason("NoHitPoints") });
      continue;
    }
    // Per audience, on the creature TAKING it: a table may want the monsters looked after and the party
    // clicking, or the reverse.
    if (!isAutoDamageEnabled(actor)) continue;

    const before = snapshotHp(actor);
    try {
      await applyDamageTo(actor, parts, message, entry.multiplier);
    } catch (err) {
      log(`auto damage: ${String(doc?.name)} could not be updated:`, err);
      unresolved.push({ name: String(doc?.name ?? "?"), why: reason("UpdateFailed") });
      continue;
    }
    const after = snapshotHp(actor);
    if (before) snapshots.push(before);
    // The amount reported is what was ROLLED, adjusted only by the multiplier we passed. It is
    // deliberately not the difference in hit points: those two disagree whenever the system resolved a
    // resistance or soaked something into temporary hit points, and the before → after pair beside it
    // already tells the honest half of that story.
    const rolled = Math.abs(total(parts)) * entry.multiplier;
    lines.push(
      game.i18n.format(`NOODLRHOOKS.Combat.AutoDamage.${healing ? "Healed" : "Line"}`, {
        name: String(doc?.name ?? "?"),
        amount: String(Math.round(rolled)),
        types: [typeList(parts), entry.note].filter(Boolean).join(", "),
        before: String(before?.value ?? "?"),
        after: String(after?.value ?? "?"),
      }),
    );
  }

  if (lines.length === 0 && unresolved.length === 0) return;
  await report(message, lines, unresolved, snapshots);
  if (lines.length > 0) {
    try {
      await message.setFlag(MODULE_ID, APPLIED, true);
    } catch {
      // A message we cannot flag still had its damage applied; the guard set stops a repeat this session.
    }
  }
}

function total(parts: DamagePart[]): number {
  return parts.reduce((sum, part) => sum + part.value, 0);
}

function typeList(parts: DamagePart[]): string {
  const types = [...new Set(parts.map((part) => part.type).filter(Boolean))];
  return types.join(", ");
}

/**
 * The receipt, whispered to GMs.
 *
 * Whispered rather than public, and the reason is the one the Hide leak taught: exact hit points are
 * information about a monster that the party has not earned. The table already sees the damage roll on
 * dnd5e's own public card, and a player watching their own bar move is watching the fiction happen —
 * what nobody needs is "Beholder Zombie: 47 → 12" in the log. The undo lives here because it is the GM's
 * to press.
 */
async function report(
  message: any,
  lines: string[],
  unresolved: Array<{ name: string; why: string }>,
  snapshots: HpSnapshot[],
): Promise<void> {
  const ChatMessage = (globalThis as any).ChatMessage;
  const gmIds = (game.users as any)?.filter?.((u: any) => u.isGM)?.map((u: any) => u.id) ?? [];

  let content = "";
  if (lines.length > 0) {
    content += `<p>${lines.join("<br>")}</p>`;
  }
  for (const skipped of unresolved) {
    content += `<p><em>${game.i18n.format("NOODLRHOOKS.Combat.AutoDamage.Skipped", {
      name: skipped.name,
      why: skipped.why,
    })}</em></p>`;
  }

  let created: any = null;
  try {
    created = await ChatMessage.create({
      content,
      whisper: gmIds,
      speaker: narrator(),
      flags: { [MODULE_ID]: { autoDamageReceipt: true, source: String(message?.id ?? "") } },
    });
  } catch (err) {
    log("auto damage: could not post the receipt:", err);
  }

  // The undo is keyed by the receipt so a GM undoes the hit they are looking at, rather than "the last
  // thing that happened" — which in a busy round is rarely the one they meant.
  const id = String(created?.id ?? "");
  if (id && snapshots.length > 0) {
    undoable.set(id, snapshots);
    if (created?.setFlag) {
      try {
        await created.setFlag(MODULE_ID, "undoable", true);
      } catch {
        /* the button is drawn from the flag; without it the GM still has the tray */
      }
    }
  }
}

/**
 * Say why the button is still there.
 *
 * The alternative — applying nothing and saying nothing — is what makes automation feel broken: the GM
 * has been told damage is automatic, sees a tray, and has no way to know whether the module declined or
 * failed. One whisper per roll, and never for an ordinary miss.
 */
async function explain(message: any, why: string): Promise<void> {
  log(`auto damage: leaving this one to the Apply button — ${why}`);
  const ChatMessage = (globalThis as any).ChatMessage;
  const gmIds = (game.users as any)?.filter?.((u: any) => u.isGM)?.map((u: any) => u.id) ?? [];
  try {
    await ChatMessage.create({
      content: `<p><em>${game.i18n.format("NOODLRHOOKS.Combat.AutoDamage.Manual", {
        why,
      })}</em></p>`,
      whisper: gmIds,
      speaker: narrator(),
      flags: { [MODULE_ID]: { autoDamageNote: true, source: String(message?.id ?? "") } },
    });
  } catch {
    /* the console line above is the fallback */
  }
}

// ── The card's controls ──────────────────────────────────────────────────────────────────────────────

/**
 * Wire the undo on a receipt, and mark a card whose damage has already landed.
 *
 * The tray is deliberately left working on an applied card rather than disabled: a GM may legitimately
 * want to apply the same roll to somebody else (an area effect the system did not target for them), and
 * removing a control the system drew is a larger intervention than adding a line of text. What the note
 * prevents is the GM pressing it because they cannot tell whether anything happened.
 */
function wireCard(message: unknown, html: unknown): void {
  if (!game.user?.isGM) return;
  const root: HTMLElement | undefined =
    html instanceof HTMLElement ? html : ((html as any)?.[0] as HTMLElement | undefined);
  if (!root) return;
  const doc = message as any;

  if (doc?.getFlag?.(MODULE_ID, APPLIED)) {
    const note = document.createElement("p");
    note.className = "noodlr-auto-damage-note";
    note.textContent = game.i18n.localize("NOODLRHOOKS.Combat.AutoDamage.Already");
    root.querySelector(".message-content")?.prepend(note);
  }

  if (!doc?.getFlag?.(MODULE_ID, "undoable")) return;
  const id = String(doc?.id ?? "");
  if (!undoable.has(id)) return;

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = game.i18n.localize("NOODLRHOOKS.Combat.AutoDamage.Undo");
  button.addEventListener("click", async () => {
    button.disabled = true;
    const restored = await undoDamage(id);
    ui.notifications?.info(
      game.i18n.format("NOODLRHOOKS.Combat.AutoDamage.Restored", { count: String(restored) }),
    );
  });
  root.querySelector(".message-content")?.appendChild(button);
}

/** Put back what one receipt took off. */
export async function undoDamage(receiptId: string): Promise<number> {
  const snapshots = undoable.get(receiptId) ?? [];
  let restored = 0;
  for (const snapshot of snapshots) {
    if (await restoreHp(snapshot)) restored += 1;
  }
  undoable.delete(receiptId);
  return restored;
}

/** What the damage layer can see, for the console. */
export function surveyDamage(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  return {
    running: active(),
    primaryGM: isPrimaryGM(),
    midiOwns: midiOwnsDamage(),
    enabledFor: {
      npc: game.settings.get(MODULE_ID, `${COMBAT_SETTINGS.autoDamage}.npc`),
      pc: game.settings.get(MODULE_ID, `${COMBAT_SETTINGS.autoDamage}.pc`),
    },
    selected: String(token?.document?.name ?? "— select a token —"),
    selectedWouldBeAutomated: token?.actor ? isAutoDamageEnabled(token.actor) : null,
    verdictsRemembered: verdicts.size,
    undoableReceipts: undoable.size,
  };
}
