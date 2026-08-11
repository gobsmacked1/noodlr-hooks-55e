// What this module tells the outside world, and how the outside world answers back.
//
// The audience is `noodlr` — an AI game master that narrates, voices and adjudicates but deliberately
// owns no rules. Neither module depends on the other: this one enforces the rules whether or not
// anything is listening, and every hook below is fire-and-forget when nobody is.
//
// Hook names are prefixed `noodlrHooks.` rather than by module id ON PURPOSE. A future
// `noodlr-hooks-pf2e` fires the same five names with a different `systemId`, so a listener is written
// once against the contract rather than once per game system. Do not rename these to include the
// module id; that is the whole design.
//
// Protocol 2 added `compile`, which runs the other way round from the rest: instead of this module
// telling the listener what happened, it hands over prose it cannot interpret and gets back rules it
// can execute. The model compiles; it never adjudicates. A descriptor is produced once, at scene
// load, and deterministic code runs it every turn thereafter — which is why this does not reopen the
// decision to cut the per-turn model call.
//
// Two shapes, and the difference matters:
//
//   * `Hooks.callAll` for observation and for participation. A listener that wants to DO something
//     asynchronous — post a card, speak a line, ask a model — pushes its promise into `waitFor` and
//     this module awaits it before continuing. Foundry hooks are synchronous, so without that a
//     narration would land after the dice it was meant to introduce.
//   * `Hooks.call` (stopping) for `preRuling` only. Returning false there cancels the ruling, which is
//     how the GM's AI is allowed to overrule the rules engine.

import { capabilityVocabulary } from "./capability";

/** Bumped when a payload changes shape in a way a listener could not tolerate. */
export const PROTOCOL = 2;

/** What kind of rule just fired. Listed rather than free-text so a listener can switch on it. */
export type RulingKind =
  | "condition"
  | "dying"
  | "death-save"
  | "concentration"
  | "stealth"
  | "surprise"
  | "economy"
  | "movement"
  | "forced"
  | "reaction"
  | "encounter"
  | "initiative"
  // Added after protocol 2 without a bump, deliberately: a new member of this union is additive, and
  // a listener that switches on `kind` simply does not match it. The protocol number is for payload
  // shapes a listener could not tolerate, and an unhandled kind is tolerated by construction.
  | "influence";

/** A rule this module is about to apply, or has just applied. */
export interface Ruling {
  kind: RulingKind;
  /** Which module ruled. Always this module's id; present so a listener need not assume. */
  module: string;
  /** The game system the ruling is in terms of, e.g. `dnd5e`. */
  systemId: string;
  /** One plain sentence, safe to read aloud at the table. */
  summary: string;
  /** Structured particulars — DCs, totals, distances. Shape varies by `kind`. */
  detail?: Record<string, unknown>;
  actor?: any;
  token?: any;
  combat?: any;
  /** Present when the ruling can be reversed. Calling it undoes exactly what was done. */
  undo?: () => Promise<unknown>;
}

/**
 * A social move, handed to whoever can play it out.
 *
 * `FLEE`, `MERCY` and `SURRENDER` come from the encounter layer; `PERSUADE`, `DECEIVE`,
 * `INTIMIDATE`, `BRIBE` and `PARLEY` come from the Influence action. `AMBUSH` and `DISTRACT` are
 * declared and not yet fired: adding one later should be a call site, not a contract change, and a
 * listener written now against the full list keeps working when they arrive.
 */
export type BehaviorVerb =
  | "FLEE"
  | "MERCY"
  | "SURRENDER"
  | "BRIBE"
  | "PARLEY"
  | "INTIMIDATE"
  | "PERSUADE"
  | "DECEIVE"
  | "AMBUSH"
  | "DISTRACT";

export interface BehaviorRequest {
  verb: BehaviorVerb;
  module: string;
  systemId: string;
  /** Whose voice is wanted. Not always the one performing the verb — see `incoming`. */
  actor?: any;
  token?: any;
  /** The other party: who the move is aimed at, or who is making it when `incoming`. */
  target?: any;
  /**
   * The verb is being done TO `actor` rather than BY it, and what is wanted is its answer.
   *
   * Needed the moment the Influence action started firing these. A creature that FLEEs is the one
   * fleeing, but a creature that is PERSUADEd is the one responding — and noodlr voices NPCs, so
   * the party's negotiator is exactly who must NOT be handed the microphone. Simply swapping `actor`
   * and `target` would name a player character as the speaker; this reverses the sentence instead.
   * A listener that ignores the flag narrates the right creature saying the wrong thing, which is
   * why it is a documented field rather than something inferred from the verb.
   */
  incoming?: boolean;
  context: Record<string, unknown>;
  /** Register asynchronous work; this module waits for it before moving on. */
  waitFor(promise: Promise<unknown>): void;
  /** Set by a listener that played the move out, so nothing else narrates it twice. */
  handled?: boolean;
}

/** What an automated creature has decided to do this turn, fired before it is announced. */
export interface TurnEvent {
  module: string;
  systemId: string;
  combatant: any;
  actor?: any;
  token?: any;
  /** The public sentence this module is about to post. A listener may rewrite it. */
  intent: string;
  /** GM-only: which cognition tier chose this, and why it scored well. Never shown to players. */
  reasoning: string;
  /** Whom the creature is about to deal with, when the plan has a target. */
  target?: any;
  /**
   * Everything a taunt needs, read from sheets here because that is where the system knowledge is.
   * Null when there is nobody to taunt; a zero `chance` when the creature has no language at all.
   * The line library, the picking and the voice all live in the listener.
   */
  banter?: unknown;
  /** Register asynchronous work; this module waits for it before announcing. */
  waitFor(promise: Promise<unknown>): void;
}

/**
 * One feature whose prose needs turning into rules. Protocol 2.
 *
 * `structured` is the half the corpus never had, and it is the reason compiling from a live sheet
 * beats mining a book. Regeneration's amount mined out of the Monster Manual as the literal string
 * `"[[lookup @healing.formula activity=…]]"` — the prose is an enricher pointing at data the miner
 * could not follow. Here the activity is resolved and handed over beside the text, so the compiler
 * reads 15. **Quantities in `structured` outrank anything the prose seems to say.**
 */
export interface CompileRequestItem {
  /** The prose hash. Comes back on the answer so a batch can be matched up out of order. */
  id: string;
  label: string;
  prose: string;
  /** Resolved activities, uses, damage parts and range off the sheet. Authoritative for numbers. */
  structured?: Record<string, unknown>;
  /** Whose feature this is — creature type, size, CR — for resolving "the creature" in the text. */
  context?: Record<string, unknown>;
}

export interface CompileRequest {
  module: string;
  systemId: string;
  protocol: number;
  /**
   * The closed vocabulary the answer has to be written in, as plain JSON.
   *
   * Sent rather than assumed, because the listener is game-system agnostic and this module is not.
   * A `noodlr-hooks-pf2e` will fire this same hook with its own vocabulary, and a listener that had
   * hardcoded ours would validate the wrong language while reporting success.
   */
  vocabulary: Record<string, unknown>;
  /**
   * A batch, deliberately, rather than one feature per call. A scene load has tens of misses and the
   * listener holds the API key, the concurrency limit and the rate-limit gate — so it is the only
   * party that can sensibly decide how many to run at once.
   */
  items: CompileRequestItem[];
  /**
   * Filled in by the listener: validated capabilities, keyed by the `id` they were asked about.
   * Anything absent simply was not compiled, which is a normal answer and never an error here.
   */
  compiled: Record<string, unknown>;
  /** Register asynchronous work; this module waits for it before reading `compiled`. */
  waitFor(promise: Promise<unknown>): void;
  /** Set by a listener that took the batch on, so a second one does not pay for it again. */
  handled?: boolean;
}

function systemId(): string {
  return String((game as any)?.system?.id ?? "");
}

/** Collects listener promises so a synchronous hook can still carry asynchronous work. */
function collector(): { pending: Promise<unknown>[]; waitFor: (p: Promise<unknown>) => void } {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitFor: (p: Promise<unknown>) => {
      if (p && typeof (p as any).then === "function") pending.push(p);
    },
  };
}

/**
 * Offer a ruling for veto before it lands. True means proceed.
 *
 * Synchronous by necessity — most callers are inside a Foundry `pre*` hook that cannot be awaited —
 * so a listener wanting to stop something must decide on the spot. An AI deliberation cannot happen
 * here; that is what `ruling` plus `undo` is for.
 */
export function proposeRuling(ruling: Omit<Ruling, "module" | "systemId">): boolean {
  try {
    return (
      Hooks.call("noodlrHooks.preRuling", {
        ...ruling,
        module: "noodlr-hooks-55e",
        systemId: systemId(),
      }) !== false
    );
  } catch {
    // A broken listener must never be able to suppress a rule.
    return true;
  }
}

/** Announce a ruling that has already landed, and wait for anyone narrating it. */
export async function announceRuling(ruling: Omit<Ruling, "module" | "systemId">): Promise<void> {
  const { pending, waitFor } = collector();
  try {
    Hooks.callAll("noodlrHooks.ruling", {
      ...ruling,
      module: "noodlr-hooks-55e",
      systemId: systemId(),
      waitFor,
    });
  } catch {
    return;
  }
  if (pending.length) await Promise.allSettled(pending);
}

/**
 * Ask for a social move to be played out. Resolves true when a listener took it on.
 *
 * A false answer is the normal case with no AI installed, and every caller has to carry on without
 * one — the rules consequence of fleeing or surrendering is this module's job regardless of whether
 * anybody narrated it.
 */
export async function requestBehavior(
  request: Omit<BehaviorRequest, "module" | "systemId" | "waitFor" | "handled">,
): Promise<boolean> {
  const { pending, waitFor } = collector();
  const payload: BehaviorRequest = {
    ...request,
    module: "noodlr-hooks-55e",
    systemId: systemId(),
    waitFor,
  };
  try {
    Hooks.callAll("noodlrHooks.behavior", payload);
  } catch {
    return false;
  }
  if (pending.length) await Promise.allSettled(pending);
  return Boolean(payload.handled);
}

/**
 * Ask for a batch of features to be compiled into capability descriptors.
 *
 * Same shape as `requestBehavior` — `callAll`, `waitFor`, a `handled` flag — because the degradation
 * story has to be the same. **With nobody listening this resolves to an empty object and the module
 * behaves exactly as it does today**, reading structured sheet data and knowing nothing about what
 * the prose says. That is not a failure mode; it is this module's baseline, and every caller must
 * treat a missing descriptor as ordinary.
 *
 * Nothing is trusted on the way back in. The listener is a language model at one remove, so the
 * caller validates every descriptor against the closed vocabulary before it reaches the cache.
 */
export async function requestCompile(
  items: CompileRequestItem[],
): Promise<Record<string, unknown>> {
  if (items.length === 0) return {};
  const { pending, waitFor } = collector();
  const payload: CompileRequest = {
    module: "noodlr-hooks-55e",
    systemId: systemId(),
    protocol: PROTOCOL,
    vocabulary: capabilityVocabulary(),
    items,
    compiled: {},
    waitFor,
  };
  try {
    Hooks.callAll("noodlrHooks.compile", payload);
  } catch {
    return {};
  }
  if (pending.length) await Promise.allSettled(pending);
  return payload.compiled ?? {};
}

/**
 * Announce a planned turn and wait for anything a listener wants to do first — a taunt, a line of
 * narration, a rewritten intent. Returns the intent to actually post, which a listener may have
 * replaced.
 */
export async function announceTurn(
  event: Omit<TurnEvent, "module" | "systemId" | "waitFor">,
): Promise<string> {
  const { pending, waitFor } = collector();
  const payload: TurnEvent = {
    ...event,
    module: "noodlr-hooks-55e",
    systemId: systemId(),
    waitFor,
  };
  try {
    Hooks.callAll("noodlrHooks.turn", payload);
  } catch {
    return event.intent;
  }
  if (pending.length) await Promise.allSettled(pending);
  return payload.intent || event.intent;
}
