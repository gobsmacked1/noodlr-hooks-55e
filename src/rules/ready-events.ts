// Noticing that somebody's readied trigger just happened.
//
// The cheap half of the Ready action, and it is deliberately the half that runs thousands of times. Every
// wake-up starts here: an event arrives, the predicates on each live declaration dispose of it for
// nothing, and only what survives them is worth a model call. A `judge: false` descriptor never costs one
// at all, which is why `integration/watch.ts` makes the compiler state that flag explicitly.
//
// ON THE PRIMARY GM, and only there. The alternative is every client independently deciding a trigger
// fired and every client asking the owner about it — N dialogs for one goblin's step. Detection is
// therefore one client's job, and the RELEASE is then routed to whoever owns the creature, which is the
// same split the damage and save layers use: notice centrally, act where the resources are.
//
// THE EVENT VOCABULARY IS CLOSED AT THE POINT WHERE FOUNDRY STOPS TELLING US THINGS. Each member of
// `WATCH_EVENTS` is something a hook we already listen to reports, so a compiled trigger is expressed in
// terms of things that will genuinely be noticed. A sentence about something outside it ("if the tide
// comes in") compiles to no events and is reported as unwatchable at declaration time rather than
// silently never firing — which is the failure mode this module tries hardest to avoid.
//
// `narration` IS THE ESCAPE HATCH AND THE REASON THE AI MODULE EARNS ITS PLACE. "If I hear shouting
// ahead" has no mechanical signal whatsoever; the only thing at the table that knows it happened is
// whoever described it. So a GM's chat message — or an AI game master's narration — is an event, judged
// against the sentence like any other. It is also the one event kind that is ALWAYS judged, because there
// is no predicate that can read prose.

import { log } from "../constants";
import { isPrimaryGM } from "../util/gm";
import { isReadyEnabled } from "../settings";
import { readHp } from "../core/tracker";
import { observersWhoSee } from "./perception";
import { readiedOf, reachOf, releaseReady, spendJudge, type ReadyRecord } from "./ready";
import { requestWatchJudge, type WatchEvent } from "../integration/watch";

/** A candidate wake-up: what happened, and to whom. */
interface Happening {
  event: WatchEvent;
  /** The creature the event is ABOUT, when there is one. */
  subject: any;
  /** One clause naming what happened, shown to the player when the trigger fires. */
  why: string;
  /** For `narration`: what was actually said, which is all a judge has to go on. */
  text?: string;
}

/**
 * Declarations are checked in the order the tokens sit on the scene, one at a time, awaited.
 *
 * Serial rather than parallel because a release opens a dialog and resolves a whole attack: two of them
 * racing means two people answering prompts about a board that is mid-change, and the second answer is
 * about a situation that no longer holds. A queue also means one flurry of movement cannot fan out into
 * six simultaneous model calls.
 */
let working = false;
const queue: Happening[] = [];

function enqueue(happening: Happening): void {
  if (!isPrimaryGM()) return;
  queue.push(happening);
  if (queue.length > 32) queue.shift();
  void drain();
}

async function drain(): Promise<void> {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const happening = queue.shift()!;
      try {
        await consider(happening);
      } catch (err) {
        log("ready: could not evaluate a trigger:", err);
      }
    }
  } finally {
    working = false;
  }
}

/** Everything on the scene that is holding something for this kind of event. */
function watchers(event: WatchEvent): { token: any; record: ReadyRecord }[] {
  const out: { token: any; record: ReadyRecord }[] = [];
  for (const placeable of (canvas as any)?.tokens?.placeables ?? []) {
    const actor = placeable?.actor;
    if (!actor || !isReadyEnabled(actor)) continue;
    const record = readiedOf(actor);
    if (!record || !record.watch.events.includes(event)) continue;
    out.push({ token: placeable, record });
  }
  return out;
}

async function consider(happening: Happening): Promise<void> {
  const candidates = watchers(happening.event);
  if (!candidates.length) return;

  for (const { token, record } of candidates) {
    // A creature does not react to its own action. Every trigger in the book is about something else
    // happening, and without this a readied "if an enemy moves" fires on the readier's own step.
    if (happening.subject && sameToken(token, happening.subject)) continue;

    if (!predicates(token, record, happening)) continue;

    let why = happening.why;
    if (record.watch.judge || happening.event === "narration") {
      const verdict = await judge(token, record, happening);
      // Null is "nobody answered", and it must NOT be read as no: a readied action that never fires and
      // never explains why costs the player their Action for nothing. So an unanswered judge falls
      // through to asking the human, which is what the release prompt already is.
      if (verdict && !verdict.fires) continue;
      if (verdict?.why) why = verdict.why;
    }

    const fired = await releaseReady(
      token.actor,
      why,
      happening.subject ? String(subjectDoc(happening.subject)?.uuid ?? "") : undefined,
    );
    if (fired) log(`ready: ${token?.name} released a readied action on "${why}"`);
  }
}

async function judge(
  token: any,
  record: ReadyRecord,
  happening: Happening,
): Promise<{ fires: boolean; why: string } | null> {
  if (!(await spendJudge(token.actor))) {
    log(`ready: ${token?.name} has spent its judgement budget; falling through to the human`);
    return null;
  }
  const subject = happening.subject;
  return await requestWatchJudge(
    record.prose,
    record.watch,
    {
      kind: happening.event,
      what: happening.why,
      said: happening.text ?? "",
      subject: subject
        ? {
            name: String(subject?.name ?? ""),
            side: sideOf(token, subject),
            distance: gap(token, subject),
            statuses: statusesOf(subject),
            visible: canSee(token, subject),
          }
        : null,
    },
    { name: String(token?.name ?? ""), reach: reachOf(token.actor) },
  );
}

/**
 * The deterministic half of the trigger, and the reason this is affordable.
 *
 * Every clause is optional and an omitted one passes: a compiler that expressed only "an enemy moves"
 * gets exactly that, and the rest is left to the judge. Where a clause cannot be EVALUATED — an
 * unreadable distance, an unresolvable side — it passes rather than fails, because the judge or the human
 * behind it will catch a wrong fire, while a silent refusal is invisible.
 */
function predicates(token: any, record: ReadyRecord, happening: Happening): boolean {
  const watch = record.watch;
  const subject = happening.subject;

  if (watch.statuses?.length) {
    if (!subject) return false;
    const held = statusesOf(subject);
    if (!watch.statuses.some((status) => held.includes(status))) return false;
  }

  const wanted = watch.subject;
  if (wanted && subject) {
    if (wanted.names?.length && !named(subject, wanted.names)) return false;
    if (wanted.side && wanted.side !== "any") {
      const side = sideOf(token, subject);
      if (side && side !== wanted.side) return false;
    }
    // Only sight is checkable. Hearing has no model in Foundry — `walls-have-ears` shows the sound
    // polygon backend exists, but nothing reports that a creature made a noise — so a hearing-based
    // trigger is left to the judge and the human rather than guessed at.
    if (wanted.sense === "sight" && canSee(token, subject) === false) return false;
  }

  const where = watch.where;
  if (where && subject) {
    const distance = gap(token, subject);
    if (distance !== null) {
      if (where.inReach && distance > reachOf(token.actor)) return false;
      if (where.ofSelf !== undefined && distance > where.ofSelf) return false;
      if (where.beyondSelf !== undefined && distance <= where.beyondSelf) return false;
      if (where.ofAlly !== undefined && !nearAnAlly(token, subject, where.ofAlly)) return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------------

export function registerReadyWatch(): void {
  // Movement. `updateToken` fires on every client and for a move made by any means — a drag, an arrow
  // key, an API call, a teleport — which is the property that matters: a trigger about something walking
  // into reach must not depend on HOW it walked.
  Hooks.on("updateToken", (doc: any, changes: any) => {
    if (changes?.x === undefined && changes?.y === undefined && changes?.elevation === undefined) {
      return;
    }
    enqueue({
      event: "creature_moves",
      subject: doc?.object ?? doc,
      why: reason("Moved", doc),
    });
  });

  // Hit points. `dnd5e.damageActor` fires on every client (the callAll sits outside the userId guard), so
  // this needs no separate before/after pair — the amount is on the hook.
  Hooks.on("dnd5e.damageActor", (actor: any) => {
    const token = tokenOf(actor);
    const hp = readHp(actor);
    enqueue({
      event: "creature_damaged",
      subject: token,
      why: reason("Hurt", token ?? actor),
    });
    if (hp && hp.value !== null && hp.value <= 0) {
      enqueue({ event: "creature_drops", subject: token, why: reason("Dropped", token ?? actor) });
    }
  });

  // Casts and attacks, read off the chat card rather than the roll hooks. `dnd5e.postUseActivity` and
  // `dnd5e.rollAttack` fire only on the acting client, and detection has to happen on the primary GM;
  // `createChatMessage` fires everywhere, which is the same reason the Stealth capture uses it.
  Hooks.on("createChatMessage", (message: any) => {
    try {
      const actor = message?.getAssociatedActor?.();
      const token = tokenOf(actor) ?? tokenFromSpeaker(message);
      const item = message?.getAssociatedItem?.();
      const roll = message?.getFlag?.("dnd5e", "roll");

      if (String(roll?.type ?? "") === "attack") {
        enqueue({
          event: "creature_attacks",
          subject: token,
          why: reason("Attacked", token ?? actor),
        });
        return;
      }
      if (item && String(item.type ?? "") === "spell" && !roll) {
        enqueue({
          event: "creature_casts",
          subject: token,
          why: game.i18n.format("NOODLRHOOKS.Ready.Why.Cast", {
            name: String(token?.name ?? actor?.name ?? ""),
            spell: String(item.name ?? ""),
          }),
        });
        return;
      }

      // Narration. Anything a GM says in character, and anything an AI game master posts, with no roll
      // and no item attached to it. Judged against the sentence, never matched by predicate — there is
      // no predicate that reads prose.
      if (roll || item) return;
      const author: any = message?.author ?? (game.users as any)?.get?.(message?.user);
      if (!author?.isGM) return;
      const text = plain(String(message?.content ?? ""));
      if (text.length < 3) return;
      enqueue({ event: "narration", subject: null, why: shorten(text), text });
    } catch (err) {
      log("ready: could not read a chat message for triggers:", err);
    }
  });

  // Conditions.
  Hooks.on("createActiveEffect", (effect: any) => {
    const statuses: string[] = Array.from(effect?.statuses ?? []);
    if (!statuses.length) return;
    const actor = effect?.parent;
    const token = tokenOf(actor);
    enqueue({
      event: "creature_condition",
      subject: token,
      why: game.i18n.format("NOODLRHOOKS.Ready.Why.Condition", {
        name: String(token?.name ?? actor?.name ?? ""),
        condition: statuses[0],
      }),
    });
  });

  // Becoming visible. The hidden status coming off is the observable half of "it steps out of the
  // shadows"; genuine perception changes are handled by the movement event, since something has to move
  // for a line of sight to open.
  Hooks.on("deleteActiveEffect", (effect: any) => {
    const statuses: string[] = Array.from(effect?.statuses ?? []);
    if (!statuses.some((s) => s === "hiding" || s === "invisible")) return;
    const token = tokenOf(effect?.parent);
    enqueue({
      event: "creature_appears",
      subject: token,
      why: reason("Appeared", token ?? effect?.parent),
    });
  });

  // Doors. `wall.ds` is 0 closed / 1 open / 2 locked.
  Hooks.on("updateWall", (_doc: any, changes: any) => {
    if (changes?.ds === undefined) return;
    enqueue({
      event: "door_changes",
      subject: null,
      why: game.i18n.localize(
        Number(changes.ds) === 1 ? "NOODLRHOOKS.Ready.Why.DoorOpen" : "NOODLRHOOKS.Ready.Why.DoorShut",
      ),
    });
  });

  // A turn ending. Separate from the expiry sweep, which is about declarations running out rather than
  // firing.
  Hooks.on("combatTurnChange", (combat: any, prior: any) => {
    const token = (canvas as any)?.tokens?.get?.(String(prior?.tokenId ?? ""));
    if (!token) return;
    void combat;
    enqueue({ event: "creature_turn_ends", subject: token, why: reason("TurnEnded", token) });
  });
}

// ---------------------------------------------------------------------------------------------------
// Reading the board
// ---------------------------------------------------------------------------------------------------

function reason(key: string, subject: any): string {
  return game.i18n.format(`NOODLRHOOKS.Ready.Why.${key}`, {
    name: String(subject?.name ?? ""),
  });
}

function tokenOf(actor: any): any {
  const active = actor?.getActiveTokens?.(true, true)?.[0];
  return active?.object ?? active ?? null;
}

function tokenFromSpeaker(message: any): any {
  const id = String(message?.speaker?.token ?? "");
  return id ? ((canvas as any)?.tokens?.get?.(id) ?? null) : null;
}

function subjectDoc(subject: any): any {
  return subject?.document ?? subject;
}

function sameToken(a: any, b: any): boolean {
  return String(subjectDoc(a)?.id ?? "") === String(subjectDoc(b)?.id ?? "");
}

function statusesOf(subject: any): string[] {
  try {
    return Array.from(subject?.actor?.statuses ?? []).map((s) => String(s).toLowerCase());
  } catch {
    return [];
  }
}

/**
 * Loose name matching, on purpose.
 *
 * A player writing "a goblin" may be naming a kind, an individual, or a token labelled "Goblin Boss", so
 * the token name, the actor name, the creature type and the subtype are all fair game. A needless judge
 * call is the cost of a false positive; a trigger that silently never matches is the cost of being strict.
 */
function named(subject: any, names: string[]): boolean {
  const doc = subjectDoc(subject);
  const actor = subject?.actor ?? doc?.actor;
  const type: any = actor?.system?.details?.type;
  const haystack = [
    String(doc?.name ?? ""),
    String(actor?.name ?? ""),
    String(type?.value ?? ""),
    String(type?.subtype ?? ""),
  ]
    .join(" ")
    .toLowerCase();
  return names.some((name) => haystack.includes(name));
}

/**
 * Whose side the subject is on, relative to the watcher, or null when it cannot be told.
 *
 * Read from disposition, and SECRET (−2) is deliberately not folded into "hostile": it is GM bookkeeping
 * rather than a stance, which is the same distinction `perception.ts` makes when recruiting for a fight.
 */
function sideOf(watcher: any, subject: any): "enemy" | "ally" | "self" | null {
  if (sameToken(watcher, subject)) return "self";
  const mine = Number(subjectDoc(watcher)?.disposition);
  const theirs = Number(subjectDoc(subject)?.disposition);
  if (!Number.isFinite(mine) || !Number.isFinite(theirs)) return null;
  const hostile = -1;
  if (mine === theirs) return "ally";
  if (mine === hostile || theirs === hostile) return "enemy";
  return null;
}

function canSee(watcher: any, subject: any): boolean | null {
  try {
    return observersWhoSee([watcher], subject).has(String(subjectDoc(watcher)?.id ?? watcher?.id));
  } catch (err) {
    log("ready: could not work out line of sight:", err);
    return null;
  }
}

function gap(a: any, b: any): number | null {
  const from = a?.center ?? a?.object?.center;
  const to = b?.center ?? b?.object?.center;
  if (!from || !to) return null;
  try {
    const measured = (canvas as any)?.grid?.measurePath?.([from, to]);
    if (measured?.distance !== undefined) return Number(measured.distance);
  } catch {
    /* gridless and older grid shapes fall through */
  }
  const scale = Number((canvas as any)?.dimensions?.distance ?? 5);
  const size = Number((canvas as any)?.dimensions?.size ?? 100);
  if (!size) return null;
  return (Math.hypot(to.x - from.x, to.y - from.y) / size) * scale;
}

function nearAnAlly(watcher: any, subject: any, within: number): boolean {
  const mine = Number(subjectDoc(watcher)?.disposition);
  for (const placeable of (canvas as any)?.tokens?.placeables ?? []) {
    if (sameToken(placeable, subject) || sameToken(placeable, watcher)) continue;
    if (Number(subjectDoc(placeable)?.disposition) !== mine) continue;
    const distance = gap(placeable, subject);
    if (distance !== null && distance <= within) return true;
  }
  return false;
}

function plain(html: string): string {
  return String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shorten(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
