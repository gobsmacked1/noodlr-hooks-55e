// What this module tells the outside world, and how the outside world answers back.
//
// The audience is `noodlr` — an AI game master that narrates, voices and adjudicates but deliberately
// owns no rules. Neither module depends on the other: this one enforces the rules whether or not
// anything is listening, and every hook below is fire-and-forget when nobody is.
//
// Hook names are prefixed `noodlrHooks.` rather than by module id ON PURPOSE. A future
// `noodlr-hooks-pf2e` fires the same four names with a different `systemId`, so a listener is written
// once against the contract rather than once per game system. Do not rename these to include the
// module id; that is the whole design.
//
// Two shapes, and the difference matters:
//
//   * `Hooks.callAll` for observation and for participation. A listener that wants to DO something
//     asynchronous — post a card, speak a line, ask a model — pushes its promise into `waitFor` and
//     this module awaits it before continuing. Foundry hooks are synchronous, so without that a
//     narration would land after the dice it was meant to introduce.
//   * `Hooks.call` (stopping) for `preRuling` only. Returning false there cancels the ruling, which is
//     how the GM's AI is allowed to overrule the rules engine.

/** Bumped when a payload changes shape in a way a listener could not tolerate. */
export const PROTOCOL = 1;

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
  | "initiative";

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
 * A social move a creature wants to make, handed to whoever can play it out.
 *
 * The first three are produced today by the encounter layer. The other seven are declared but never
 * fired yet: adding one later should be a call site, not a contract change, and a listener written
 * now against the full list keeps working when they arrive.
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
  actor?: any;
  token?: any;
  /** Who the move is aimed at, when it is aimed at anyone. */
  target?: any;
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
    return Hooks.call("noodlrHooks.preRuling", {
      ...ruling,
      module: "noodlr-hooks-55e",
      systemId: systemId(),
    }) !== false;
  } catch {
    // A broken listener must never be able to suppress a rule.
    return true;
  }
}

/** Announce a ruling that has already landed, and wait for anyone narrating it. */
export async function announceRuling(
  ruling: Omit<Ruling, "module" | "systemId">,
): Promise<void> {
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
