// Turning a sentence into something a rules engine can watch for.
//
// The Ready action is the only rule in the book whose trigger is written by the player, in their own
// words, at the table: "if a goblin I can see approaches an ally, I shoot it". Every other module that
// has attempted this offered a dropdown of half a dozen canned conditions, which is why nobody uses it —
// the interesting readied actions are exactly the ones the dropdown does not contain.
//
// So this is the second half of the same trade `noodlrHooks.compile` already makes, arriving from a
// different direction. There, a creature's prose is compiled once into a descriptor and deterministic
// code runs it every turn. Here, a PLAYER's prose is compiled once into a descriptor and deterministic
// code checks it against every event in the round. Same division of labour, same non-negotiable:
//
//   **THE MODEL COMPILES, AND WHERE IT CANNOT, IT JUDGES ONE QUESTION AT A TIME. IT NEVER ADJUDICATES.**
//
// The difference from `compile` is that a Ready trigger genuinely cannot always be reduced to
// predicates. "If I see the Cutpurse flee" is not a distance, a status or a hit point count; it is a
// reading of what a movement MEANT. So the schema carries an explicit `judge` flag, and a descriptor
// that sets it gets one narrow yes/no question per candidate event instead of a rule. That is the
// expensive path and it is deliberately the second one tried: the predicates below dispose of most
// events for nothing, and only what survives them costs a call.
//
// WHY THIS LIVES HERE AND NOT IN `capability.ts`. Both are compile contracts and they are not the same
// contract. A capability descriptor is a rule about a creature, cached by prose hash, shareable between
// worlds, and valid forever. A watch descriptor is about one creature's intention for the next six
// seconds, is never cached, and is worthless the moment the trigger fires. Sharing a schema between
// them would mean a cache key that has to know which kind it is holding.
//
// NOTHING HERE IS REQUIRED. With no listener, `requestWatch` resolves to null, and `rules/ready.ts`
// falls back to the closed vocabulary of deterministic triggers — which is what NPCs use in any case.
// A table with no AI module installed gets a Ready action that works, with a picker instead of a
// sentence. That is this module's baseline and not a failure mode.

import { askGm, registerQuery } from "../util/queries";

/**
 * Bumped when a watch payload changes shape in a way a listener could not tolerate.
 *
 * Deliberately its own number rather than the contract's `PROTOCOL`. The two hooks are answered by
 * different code even inside one listener, and a change to the watch schema has no bearing on whether a
 * capability compiler is still valid — sharing one number would invalidate the expensive listener to
 * announce a change in the cheap one.
 */
export const WATCH_PROTOCOL = 1;

/**
 * Every kind of event this module will wake a readied action up for.
 *
 * Closed on purpose, and closed at the point where Foundry stops being able to tell us anything: each
 * member is something core or the system reports through a hook we already listen to, so a compiler
 * that answers in this vocabulary is answering in terms of things that will actually be noticed. A
 * trigger about something not on this list ("if the tide comes in") compiles to no events and is
 * reported to the player as unwatchable rather than silently never firing.
 *
 * `narration` is the escape hatch and the reason the AI module is worth having here at all: "if I hear
 * shouting ahead" has no mechanical signal whatsoever, and the only thing at the table that knows it
 * happened is whoever described it. So a GM's chat message — or the AI DM's own narration — is an
 * event, judged against the prose like any other.
 */
export const WATCH_EVENTS = [
  /** A token finished moving. Carries the distance covered and the new separations. */
  "creature_moves",
  /** A creature's hit points went down. */
  "creature_damaged",
  /** A creature reached zero hit points, fell Unconscious, or died. */
  "creature_drops",
  /** A creature began casting a spell. Fires before the cast resolves. */
  "creature_casts",
  /** A creature's attack roll resolved, hit or miss. */
  "creature_attacks",
  /** A status effect was applied to a creature — prone, grappled, frightened. */
  "creature_condition",
  /** A creature the watcher could not see became visible to it. */
  "creature_appears",
  /** A creature's turn ended. */
  "creature_turn_ends",
  /** A door was opened, closed, or unlocked. */
  "door_changes",
  /** Something was said or described in chat, by the GM or by an AI game master. */
  "narration",
] as const;

export type WatchEvent = (typeof WATCH_EVENTS)[number];

/** Whose side the trigger is about, relative to the creature that readied. */
export const WATCH_SIDES = ["enemy", "ally", "self", "any"] as const;
export type WatchSide = (typeof WATCH_SIDES)[number];

/** Which of the readying creature's senses the trigger depends on. */
export const WATCH_SENSES = ["sight", "hearing", "any"] as const;
export type WatchSense = (typeof WATCH_SENSES)[number];

/**
 * Which creature the trigger is about.
 *
 * `names` is matched loosely against the token name, the actor name, the creature type and the subtype,
 * because a player writing "a goblin" may be naming a kind, an individual, or a token labelled
 * "Goblin Boss". Loose matching costs a needless judge call at worst; strict matching costs the whole
 * trigger, silently, which is the failure this module tries hardest to avoid.
 */
export interface WatchSubject {
  names?: string[];
  side?: WatchSide;
  /** Which sense has to reach the subject for the trigger to be legal. */
  sense?: WatchSense;
}

/** Where the subject has to be for the trigger to fire. Distances in scene units. */
export interface WatchWhere {
  /** Within this distance of the readying creature. */
  ofSelf?: number;
  /** Within this distance of any ally of the readying creature. */
  ofAlly?: number;
  /** Within the readying creature's own melee reach. Preferred over a hardcoded 5. */
  inReach?: boolean;
  /** Further away from the readying creature than this. "If it backs off". */
  beyondSelf?: number;
}

/** A compiled Ready trigger. */
export interface WatchDescriptor {
  /** Which events are worth waking up for. Empty means nothing will ever fire it. */
  events: WatchEvent[];
  subject?: WatchSubject;
  where?: WatchWhere;
  /** Status effects the subject must have gained or be carrying. "If the troll falls prone". */
  statuses?: string[];
  /**
   * The predicates above do not fully express the sentence, so each surviving event needs a judgement.
   *
   * Set by the compiler, never inferred here. A descriptor with `judge: false` never costs a model call
   * again for the rest of the round, which is the whole reason the flag is explicit: a compiler that
   * reduced "a goblin moves within 5 feet of me" to predicates has bought the player a trigger that
   * fires instantly and free, and it should be able to say so.
   */
  judge: boolean;
  /** One sentence describing what the compiler understood, shown to the player before they commit. */
  summary: string;
  /** Present when the compiler could not express the sentence at all. Shown instead of a summary. */
  problem?: string;
}

/** The vocabulary sent on every request, so a listener validates against ours rather than its own. */
export function watchVocabulary(): Record<string, unknown> {
  return {
    protocol: WATCH_PROTOCOL,
    events: [...WATCH_EVENTS],
    sides: [...WATCH_SIDES],
    senses: [...WATCH_SENSES],
    where: ["ofSelf", "ofAlly", "inReach", "beyondSelf"],
    notes: [
      "Answer with a descriptor object, not prose.",
      "Set judge:false only when the predicates fully express the sentence; a false judge flag that " +
        "should have been true makes the trigger fire on the wrong event, which is worse than a call.",
      "statuses are the game system's own condition ids, lowercase.",
      "Distances are in the scene's own units, which for a foot-based scene means feet.",
    ],
  };
}

/** What is asked. `compile` turns a sentence into a descriptor; `judge` tests one event against one. */
export type WatchVerb = "compile" | "judge";

export interface WatchRequest {
  verb: WatchVerb;
  module: string;
  systemId: string;
  protocol: number;
  vocabulary: Record<string, unknown>;
  /** Who readied, and what they can see and do. Context for both verbs. */
  watcher: Record<string, unknown>;
  /** The player's own words. Present on both verbs — the judge is judging against the sentence. */
  prose: string;
  /** `compile` only: nothing else is needed. */
  /** `judge` only: the descriptor produced earlier, and the event to test against it. */
  descriptor?: WatchDescriptor;
  event?: Record<string, unknown>;
  /**
   * Filled in by the listener.
   *
   * `compile` puts a descriptor here; `judge` puts `{fires, why}`. Left alone means unanswered, which
   * every caller treats as "no opinion" and never as a no — an unanswered judge falls through to
   * asking the human, because a trigger that silently never fires is indistinguishable from a broken
   * feature and costs the player their Action for nothing.
   */
  answer?: unknown;
  /** Register asynchronous work; this module waits for it before reading `answer`. */
  waitFor(promise: Promise<unknown>): void;
  /** Set by a listener that took the question on, so a second one does not pay for it again. */
  handled?: boolean;
}

/** What a `judge` answers. */
export interface WatchVerdict {
  fires: boolean;
  /** One short sentence, shown to the player when the trigger fires. */
  why: string;
}

function systemId(): string {
  return String((game as any)?.system?.id ?? "");
}

async function ask(
  verb: WatchVerb,
  fields: Partial<WatchRequest>,
): Promise<{ answer: unknown; handled: boolean }> {
  const pending: Promise<unknown>[] = [];
  const payload: WatchRequest = {
    verb,
    module: "noodlr-hooks-55e",
    systemId: systemId(),
    protocol: WATCH_PROTOCOL,
    vocabulary: watchVocabulary(),
    watcher: {},
    prose: "",
    ...fields,
    waitFor: (p: Promise<unknown>) => {
      if (p && typeof (p as any).then === "function") pending.push(p);
    },
  };
  try {
    Hooks.callAll("noodlrHooks.watch", payload);
  } catch {
    return { answer: undefined, handled: false };
  }
  if (pending.length) await Promise.allSettled(pending);
  return { answer: payload.answer, handled: Boolean(payload.handled) };
}

/**
 * A player pressed Ready, so the compile question is asked from a PLAYER's client — and answering it
 * there would be the first time in either module that a player's browser spends the world's credit.
 *
 * So it is routed. `CONFIG.queries` already gives an addressed request, a promise and a timeout, and the
 * listener then only ever runs on one client, where it can gate on `isGM` exactly as the capability
 * compiler does. Nothing here needs the player's own context — the sentence and the watcher's name and
 * reach are the whole input — which is what makes routing free rather than a compromise.
 *
 * The timeout is generous on purpose: the player is sitting in front of a dialog waiting for it, and a
 * compile that gives up early leaves them with the picker while the answer is still in flight.
 */
export function registerWatchRelay(): void {
  registerQuery("watch.compile", async (data: any) => {
    const prose = String(data?.prose ?? "").slice(0, 140);
    if (!prose.trim()) return null;
    const { answer } = await ask("compile", {
      prose,
      watcher: (data?.watcher ?? {}) as Record<string, unknown>,
    });
    return validateWatch(answer);
  });
}

/**
 * Compile a player's sentence into something watchable. Null when nobody answered or the answer was
 * unusable — the caller then falls back to the deterministic picker.
 */
export async function requestWatchCompile(
  prose: string,
  watcher: Record<string, unknown>,
): Promise<WatchDescriptor | null> {
  if (!prose.trim()) return null;
  if (!game.user?.isGM) {
    // Validated on both sides. The answer crossed the wire as plain JSON, so the type it arrives with
    // is a claim rather than a fact.
    return validateWatch(
      await askGm<unknown>("watch.compile", { prose, watcher }, { timeout: 90000 }),
    );
  }
  const { answer } = await ask("compile", { prose, watcher });
  return validateWatch(answer);
}

/**
 * Ask whether one event satisfies one compiled trigger.
 *
 * Null means nobody answered. **Do not read that as false.** The caller escalates to the human, because
 * the alternative is a readied action that never fires and never explains why.
 */
export async function requestWatchJudge(
  prose: string,
  descriptor: WatchDescriptor,
  event: Record<string, unknown>,
  watcher: Record<string, unknown>,
): Promise<WatchVerdict | null> {
  const { answer } = await ask("judge", { prose, descriptor, event, watcher });
  const raw: any = answer;
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.fires !== "boolean") return null;
  return { fires: raw.fires, why: String(raw.why ?? "").slice(0, 200) };
}

/** Is anything listening at all? Used to decide whether to offer the text field or the picker. */
export function watchAvailable(): boolean {
  try {
    const events: any = (Hooks as any)?.events ?? {};
    const registered = events["noodlrHooks.watch"];
    return Array.isArray(registered) ? registered.length > 0 : Boolean(registered);
  } catch {
    return false;
  }
}

/**
 * Check an answer against our own vocabulary before it reaches anything that acts on it.
 *
 * Same discipline as `validateCapability`: the listener is a language model at one remove, so an
 * unknown event name is dropped rather than trusted, and a descriptor left with no events at all comes
 * back as unwatchable. **An unknown field never fails the whole descriptor**, because the useful half
 * of a partly-understood sentence is worth more than a refusal — except for `events`, which is the one
 * field with nothing to fall back on.
 */
export function validateWatch(raw: unknown): WatchDescriptor | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, any>;

  const allowed = new Set<string>(WATCH_EVENTS);
  const events = Array.isArray(source.events)
    ? (source.events.filter((e: unknown) => allowed.has(String(e))) as WatchEvent[])
    : [];

  const problem = typeof source.problem === "string" ? source.problem.slice(0, 200) : undefined;
  if (!events.length && !problem) {
    return {
      events: [],
      judge: false,
      summary: "",
      problem: "nothing in that sentence is something Foundry can notice",
    };
  }

  const descriptor: WatchDescriptor = {
    events: Array.from(new Set(events)),
    judge: source.judge !== false,
    summary: String(source.summary ?? "").slice(0, 200),
  };
  if (problem) descriptor.problem = problem;

  const subject = source.subject;
  if (subject && typeof subject === "object") {
    const out: WatchSubject = {};
    if (Array.isArray(subject.names)) {
      const names = subject.names
        .map((n: unknown) =>
          String(n ?? "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean)
        .slice(0, 8);
      if (names.length) out.names = names;
    }
    if (WATCH_SIDES.includes(String(subject.side) as WatchSide)) out.side = subject.side;
    if (WATCH_SENSES.includes(String(subject.sense) as WatchSense)) out.sense = subject.sense;
    if (Object.keys(out).length) descriptor.subject = out;
  }

  const where = source.where;
  if (where && typeof where === "object") {
    const out: WatchWhere = {};
    for (const key of ["ofSelf", "ofAlly", "beyondSelf"] as const) {
      const value = Number(where[key]);
      // Zero is not a distance anybody means, and negative ones are nonsense; both would make a
      // predicate that can never be satisfied look like a predicate that was never set.
      if (Number.isFinite(value) && value > 0) out[key] = value;
    }
    if (where.inReach === true) out.inReach = true;
    if (Object.keys(out).length) descriptor.where = out;
  }

  if (Array.isArray(source.statuses)) {
    const statuses = source.statuses
      .map((s: unknown) =>
        String(s ?? "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean)
      .slice(0, 8);
    if (statuses.length) descriptor.statuses = statuses;
  }

  return descriptor;
}
