// Reading a dnd5e chat card: who rolled, what they used, who they were pointing at, and whether it hit.
//
// This is the one place that answers those questions. It was extracted from the forced-movement layer,
// which had grown the only implementation of it, at the point a second rule (automatic damage) needed
// the same answers. Two implementations of "did that attack connect" would be a bug whichever of them
// was right — the Hide action taught that lesson expensively, with a line-of-sight test that disagreed
// with the perception sweep for weeks.
//
// WHY CHAT MESSAGES AND NOT ROLL HOOKS. `dnd5e.rollAttack` and friends are ordinary local hooks that
// fire only on the client that rolled, so a player's attack is invisible to the GM through them. Chat
// messages arrive everywhere, which is what lets one elected client read every roll at the table.
//
// TWO FACTS THE SYSTEM DOES NOT WRITE DOWN, and therefore have to be reconstructed here:
//
//   * Whether an attack hit. dnd5e computes that inside the chat card's renderer and stores it nowhere,
//     so it is recomputed with the system's own arithmetic (`utils.mjs getTargetDescriptors` records the
//     AC; `chat-message.mjs` renders the verdict).
//   * Which activity demanded a saving throw. A save message names its roller and nothing else. The one
//     link back is `flags.dnd5e.originatingMessage`, the id of the usage card whose button was pressed —
//     which is also what joins a damage roll to the attack roll that preceded it, since both carry the
//     same one.
//
// Midi, when a table runs it, changes not the data but which event carries it: it suppresses the
// separate roll messages and fills one card in, writing `flags["midi-qol"].hitTargetUuids` and
// `.failedSaveUuids` as it goes. Those are token uuids, which is strictly better than dnd5e's actor
// uuids, and they are the real answer rather than a reconstruction of one. Callers select the path by
// the PRESENCE of those flags, never by the presence of the module: midi has settings that turn its own
// automation off, and a card without the flags needs the native reading even in a world that has it.

import { log } from "../constants";

/** A target as dnd5e records it on a message: `{name, img, uuid, ac}`, ac null under total cover. */
export interface CardTarget {
  name: string;
  uuid: string;
  ac: number | null;
}

/**
 * What an attack roll did to each of its targets.
 *
 * `unresolved` exists so a caller can say WHY it is standing down rather than silently doing nothing.
 * That is the difference between automation that failed and automation that declined, and only one of
 * them is worth a GM's attention.
 */
export interface HitReading {
  hits: any[];
  missed: any[];
  unresolved: Array<{ name: string; why: string }>;
  /**
   * Token id -> how much the roll beat that target's AC by, negative on a miss.
   *
   * Present only where a comparison actually decided the outcome, so a critical and a fumble are absent
   * rather than zero. The consumer is the Shield window in `rules/damage.ts`: a +5 is worth offering
   * against a hit that landed by four and is a slot thrown away against one that landed by nine.
   */
  margin: Record<string, number>;
}

/** One rolled damage or healing part, in the shape `Actor5e#applyDamage` expects. */
export interface DamagePart {
  value: number;
  type: string;
  properties: Set<string>;
}

export function rollType(message: any): string {
  return String(message?.flags?.dnd5e?.roll?.type ?? "");
}

/**
 * The id of the usage card this roll came from, or "" when there is none.
 *
 * Empty is the honest answer for anything rolled straight off a sheet: dnd5e only sets this when the
 * roll carried the click event from a card button (`attack.mjs`, `damage.mjs`, `heal.mjs` all pass it),
 * so a save or a damage roll made any other way genuinely cannot be attributed to an activity.
 */
export function originatingId(message: any): string {
  return String(message?.flags?.dnd5e?.originatingMessage ?? "");
}

/** Sum of every roll total on a damage card, or NaN when none can be read. */
export function combinedDamageTotal(message: any): number {
  let sum = 0;
  let any = false;
  for (const roll of message?.rolls ?? []) {
    const n = Number(roll?.total);
    if (!Number.isFinite(n)) continue;
    sum += n;
    any = true;
  }
  return any ? sum : NaN;
}

/** The attack message this damage roll joined to, or null. */
export function attackMessageOf(damage: any): any {
  const origin = originatingId(damage);
  const selfId = String(damage?.id ?? "");
  const collection = (globalThis as any).game?.messages;
  const list = Array.isArray(collection) ? collection : (collection?.contents ?? []);
  for (const msg of list) {
    if (rollType(msg) !== "attack") continue;
    if (origin && (String(msg.id) === origin || originatingId(msg) === origin)) return msg;
    if (selfId && originatingId(msg) === selfId) return msg;
  }
  return null;
}

/**
 * Did the attack this damage belongs to hit someone?
 *
 * `true` / `false` only when the attack card can be read. `null` is "could not tell"
 * — Piercer fails closed on that, because offering a hit-gated reroll on a miss
 * (or on a standalone Damage activity) is a free extra die.
 */
export function attackHitForDamage(damage: any): boolean | null {
  const attack = attackMessageOf(damage);
  if (!attack) return null;
  const reading = readHits(attack);
  if (reading.hits.length > 0) return true;
  if (reading.missed.length > 0) return false;
  return null;
}

/**
 * The usage-card id a PENDING roll is about, read the same two ways dnd5e itself does.
 *
 * `originatingId` reads a posted message. This reads the roll CONFIG, which is what a
 * `preRollSavingThrow` handler has — `buildPost` (`basic-roll.mjs:171-174`) has not run
 * yet, so a click-originated save has no `flags.dnd5e.originatingMessage` until then.
 * Cancelling at pre-roll (Paralyzed auto-fail Str/Dex) would otherwise lose the only
 * thread back to the activation.
 *
 * An explicit stamp beats the click event: `rollMissing` writes one onto the message
 * data, and a second roll can still carry a stale event from another card.
 */
export function originatingUsageIdFromRoll(config: any, message: any): string {
  const stamped = String(
    message?.data?.flags?.dnd5e?.originatingMessage ??
      message?.flags?.dnd5e?.originatingMessage ??
      "",
  );
  if (stamped) return stamped;
  try {
    return String(config?.event?.target?.closest?.("[data-message-id]")?.dataset?.messageId ?? "");
  } catch {
    return "";
  }
}

/** The TokenDocument a chat message speaks for, or null when it does not name one. */
export function speakerToken(speaker: any): any {
  const sceneId = String(speaker?.scene ?? "");
  const tokenId = String(speaker?.token ?? "");
  if (sceneId && tokenId) {
    const doc = (game.scenes as any)?.get(sceneId)?.tokens?.get(tokenId);
    if (doc) return doc;
  }
  // No token on the speaker: the actor's tokens on the current scene are the only remaining guess, and
  // it is only unambiguous when there is exactly one of them.
  const actor: any = speaker?.actor ? (game.actors as any)?.get(String(speaker.actor)) : null;
  const tokens = actor?.getActiveTokens?.() ?? [];
  return tokens.length === 1 ? (tokens[0]?.document ?? null) : null;
}

/**
 * The token behind an ACTOR uuid, which is what dnd5e records for each target.
 *
 * Unlinked tokens resolve exactly, because their synthetic actor knows its own token. Linked ones do
 * not: the uuid contains no token at all, and dnd5e additionally keys its target map by actor uuid, so
 * two copies of the same linked creature collapse into a single entry before we ever see it. That loss
 * is in the system's data and cannot be recovered here — only reported.
 */
export function tokenFromActorUuid(uuid: string): any {
  try {
    const actor: any = (globalThis as any).fromUuidSync?.(uuid);
    if (!actor) return null;
    if (actor.token) return actor.token;
    const tokens = actor.getActiveTokens?.() ?? [];
    if (tokens.length === 1) return tokens[0]?.document ?? null;
    if (tokens.length > 1) {
      log(
        `card: ${String(actor.name ?? uuid)} has ${tokens.length} tokens on this scene and the ` +
          `target record cannot say which was hit; skipping rather than guessing`,
      );
    }
    return null;
  } catch {
    return null;
  }
}

export function tokenFromTokenUuid(uuid: string): any {
  try {
    const doc: any = (globalThis as any).fromUuidSync?.(uuid);
    return doc?.documentName === "Token" ? doc : (doc?.document ?? null);
  } catch {
    return null;
  }
}

export function itemOf(message: any): any {
  const uuid = String(message?.flags?.dnd5e?.item?.uuid ?? "");
  if (!uuid) return null;
  try {
    return (globalThis as any).fromUuidSync?.(uuid) ?? null;
  } catch {
    return null;
  }
}

/** The activity that ran, looked up on its item — activity uuids do not resolve through `fromUuid`. */
export function activityOf(message: any, item: any): any {
  const id = String(message?.flags?.dnd5e?.activity?.id ?? "");
  if (!id || !item) return null;
  try {
    return item.system?.activities?.get?.(id) ?? null;
  } catch {
    return null;
  }
}

/**
 * The weapon mastery in use, if any.
 *
 * dnd5e copies the chosen mastery onto its own attack message at `flags.dnd5e.roll.mastery`, which is
 * the authoritative reading. Under midi that separate message is never created, so the weapon's own
 * mastery property is the fallback — best-effort, and only trusted as far as being a string.
 */
export function masteryOf(message: any, item: any): string {
  const flagged = String(message?.flags?.dnd5e?.roll?.mastery ?? "");
  if (flagged) return flagged;
  const declared = item?.system?.mastery;
  return typeof declared === "string" ? declared : "";
}

/** Damage types on a message, one per roll — a DamageRoll carries exactly one. */
export function damageTypesOf(message: any): string[] {
  const out: string[] = [];
  for (const roll of message?.rolls ?? []) {
    const type = String((roll as any)?.options?.type ?? "");
    if (type) out.push(type.toLowerCase());
  }
  // Midi summarises the same information in its own flags, which is the only reading available when the
  // rolls live on a card it assembled rather than on a dedicated damage message.
  for (const entry of message?.flags?.["midi-qol"]?.damageDetail ?? []) {
    const type = String(entry?.type ?? "");
    if (type) out.push(type.toLowerCase());
  }
  return out;
}

export function targetsOf(message: any): CardTarget[] {
  const out: CardTarget[] = [];
  for (const target of message?.flags?.dnd5e?.targets ?? []) {
    const uuid = String((target as any)?.uuid ?? "");
    if (!uuid) continue;
    const ac = (target as any)?.ac;
    out.push({
      name: String((target as any)?.name ?? "?"),
      uuid,
      ac: ac === null || ac === undefined ? null : Number(ac),
    });
  }
  return out;
}

/**
 * Did this attack roll beat each target's AC, by dnd5e's own arithmetic?
 *
 * A null AC means total cover — `getTargetDescriptors` writes null when the target carries the
 * `coverTotal` status — or a sheet we could not read, and dnd5e conflates the two. It is reported as
 * unresolved rather than guessed at, which DIVERGES from the system's own renderer: its formula scores
 * a null AC as a hit, because `total < null` coerces to `total < 0`. Erring towards a hit is fine for a
 * display that a human is reading; it is not fine for something that subtracts hit points.
 */
export function readHits(message: any): HitReading {
  const reading: HitReading = { hits: [], missed: [], unresolved: [], margin: {} };
  const roll: any = message?.rolls?.[0];
  const total = Number(roll?.total);
  if (!roll || !Number.isFinite(total)) return reading;

  for (const target of targetsOf(message)) {
    if (target.ac === null) {
      reading.unresolved.push({
        name: target.name,
        why: "no readable AC (total cover, or the sheet)",
      });
      continue;
    }
    const doc = tokenFromActorUuid(target.uuid);
    if (!doc) {
      reading.unresolved.push({ name: target.name, why: "could not tell which token was hit" });
      continue;
    }
    const missed = !roll.isCritical && (total < target.ac || roll.isFumble);
    if (missed) reading.missed.push(doc);
    else reading.hits.push(doc);
    // Recorded for every target, hit or missed, and only where a real comparison happened: a critical or a
    // fumble is decided by the die and not by the number, so raising the AC cannot change either.
    if (!roll.isCritical && !roll.isFumble) {
      reading.margin[String(doc?.id ?? "")] = total - target.ac;
    }
  }
  return reading;
}

/** A saving throw as it appears in chat: which ability, against what, and whether it made it. */
export interface SaveReading {
  ability: string;
  dc: number | null;
  total: number;
  success: boolean | null;
  /** True when the success was bought rather than rolled — a legendary resistance. */
  forced: boolean;
}

/**
 * Read a saving-throw message.
 *
 * The DC lives on the roll rather than in the flags (`options.target`, set by `rollSavingThrow` from the
 * activity's `save.dc.value`), and the verdict is not stored at all. It is recomputed here rather than
 * read from `BasicRoll#isSuccess` for the same reason `readHits` does its own arithmetic: those getters
 * return `false` — not `undefined` — when there is no DC, so a save with no target reads as a failure,
 * and this layer must be able to tell "failed" from "cannot say". A null success means the latter.
 *
 * `forceSuccess` OUTRANKS THE ARITHMETIC, and reading it is not an optional nicety. It is the flag dnd5e's
 * own Resist button writes (`NPCData#resistSave`), it is consumed by the renderer and by nothing else, and
 * `isSuccess` knows nothing about it — so without this a GM who spent a legendary resistance by hand would
 * watch us apply the full damage anyway, on the one roll of the evening they had intervened in.
 */
export function readSave(message: any): SaveReading {
  const roll: any = message?.rolls?.[0];
  const total = Number(roll?.total);
  const target = Number(roll?.options?.target);
  const dc = Number.isFinite(target) ? target : null;
  const forced = message?.flags?.dnd5e?.roll?.forceSuccess === true;
  const rolled = dc === null || !Number.isFinite(total) ? null : total >= dc;
  return {
    ability: String(message?.flags?.dnd5e?.roll?.ability ?? ""),
    dc,
    total: Number.isFinite(total) ? total : NaN,
    // A bought success is a success even when the DC is unreadable: somebody paid for it explicitly.
    success: forced ? true : rolled,
    forced,
  };
}

/** An ability or skill check as it appears in chat: which ability, against what, and whether it made it. */
export interface CheckReading {
  ability: string;
  skill: string;
  dc: number | null;
  total: number;
  success: boolean | null;
}

/**
 * Read an ability-check or skill-check message.
 *
 * Same DC path as a save (`rolls[0].options.target`). A check with no DC is information, not a
 * contest — `success` is null rather than a guess, so an after-fail offer cannot fire on it.
 * Skill id and ability are both stamped when present: a Stealth check is `skill: "ste"` and
 * `ability: "dex"`.
 */
export function readCheck(message: any): CheckReading {
  const roll: any = message?.rolls?.[0];
  const flags = message?.flags?.dnd5e?.roll ?? {};
  const total = Number(roll?.total);
  const target = Number(roll?.options?.target);
  const dc = Number.isFinite(target) ? target : null;
  return {
    ability: String(flags.ability ?? ""),
    skill: String(flags.skillId ?? ""),
    dc,
    total: Number.isFinite(total) ? total : NaN,
    success: dc === null || !Number.isFinite(total) ? null : total >= dc,
  };
}

/**
 * What a made save does to this damage roll: "half", "none" or "full".
 *
 * `SaveActivity#rollDamage` copies its own `damage.onSave` onto the damage message
 * (`save.mjs:78-82`), so the answer travels with the roll and the activity need not be resolved — which
 * matters, because an activity on an unlinked token's item is not always reachable by uuid. Defaults to
 * "half", the overwhelmingly common case and the one dnd5e's own schema defaults to.
 */
export function damageOnSave(message: any): string {
  const stated = String(message?.flags?.dnd5e?.roll?.damageOnSave ?? "");
  return stated || "half";
}

/**
 * What a MADE save multiplies the damage by.
 *
 * Lives here rather than beside the layer that uses it because it is a reading of what the card said, and
 * because it is the one piece of that layer's arithmetic worth pinning down in a test. "half" is the
 * fallback for an unrecognised value as well as the default: a new value dnd5e might add is far more
 * likely to mean some fraction than to mean "the save changed nothing".
 */
export function saveMultiplier(onSave: string): number {
  if (onSave === "none") return 0;
  if (onSave === "full") return 1;
  return 0.5;
}

/** Midi's own verdict, when it left one: token uuids of everything it decided was hit. */
export function midiHits(flags: any): any[] {
  const uuids = flags?.["midi-qol"]?.hitTargetUuids;
  return (Array.isArray(uuids) ? uuids : [])
    .map((u) => tokenFromTokenUuid(String(u)))
    .filter(Boolean);
}

/** Midi's own verdict on saves: token uuids of everything that failed one. */
export function midiFailedSaves(flags: any): any[] {
  const uuids = flags?.["midi-qol"]?.failedSaveUuids;
  return (Array.isArray(uuids) ? uuids : [])
    .map((u) => tokenFromTokenUuid(String(u)))
    .filter(Boolean);
}

/**
 * The rolled damage, in the shape the system applies.
 *
 * Deliberately the same mapping the damage tray performs (`chat-message.mjs applyChatCardDamage`):
 * healing types carry a negative value, and the roll's properties travel with it because
 * `calculateDamage` reads them for physical-damage resistance ("nonmagical" and the rest). Not
 * aggregated by type first, as the tray does — aggregation is for display, and `applyDamage` takes a
 * list of descriptions perfectly well.
 */
export function damageParts(message: any): DamagePart[] {
  const healingTypes = (globalThis as any).CONFIG?.DND5E?.healingTypes ?? {};
  const out: DamagePart[] = [];
  for (const roll of message?.rolls ?? []) {
    const total = Number((roll as any)?.total);
    if (!Number.isFinite(total)) continue;
    const type = String((roll as any)?.options?.type ?? "");
    const healing = type in healingTypes;
    out.push({
      value: Math.max(0, total) * (healing ? -1 : 1),
      type,
      properties: new Set<string>((roll as any)?.options?.properties ?? []),
    });
  }
  return out;
}

/** Is every part of this roll healing rather than damage? */
export function isHealing(parts: DamagePart[]): boolean {
  return parts.length > 0 && parts.every((part) => part.value <= 0);
}
