// Who in this fight could react to what that creature just did?
//
// Counterspell had the only implementation of this, and Silvery Barbs needs the same seven questions asked in
// the same order. Copying them would have been four lines shorter and is the mistake this repo has now made
// twice — the Hide action's line-of-sight test disagreed with the perception sweep for weeks, and the forced
// movement layer carried its own copy of "did that attack connect" until `cards.ts` took it away. Two answers
// to "can that creature see this one and does it still have its reaction" is a bug whichever of them is
// right, and the wrong one here is invisible: it does not throw, it just quietly stops offering somebody
// their spell.
//
// ONLY CREATURES OPPOSED TO THE SUBJECT ARE ASKED, which is a deliberate narrowing rather than the rule. RAW,
// a wizard may counter their own party's spell or spoil an ally's saving throw, and very occasionally should.
// But putting a dialog in front of the whole table every time a friend rolls well is the "long chain of
// approvals" the brief rules out, and the cost of the narrowing is one rare play that the sheet can still
// perform by hand.
//
// UNREADABLE VISION OFFERS THE REACTION rather than withholding it. A caster silently immune to being
// countered is a thing nothing at the table can explain; a reaction offered to somebody round a corner is a
// thing a person declines in one keystroke.

import { log } from "../constants";
import { hasReaction } from "./economy/ledger";
import { alive, canReact, offerable, type ReactionTrigger } from "./offer";
import { observersWhoSee } from "./perception";

/** One creature that could react, and how far its reaction reaches. */
export interface Reactor<T> {
  actor: any;
  token: any;
  /** Whatever the readiness check handed back — a DC, a range, an item. */
  ready: T;
}

export interface ReactorSearch<T> {
  /** The creature being reacted TO. Its side, and the thing that has to be seen. */
  subjectToken: any;
  subjectActor: any;
  combat: any;
  /** Which offer this is, so `offerable` can consult the right midi stand-aside. */
  trigger: ReactionTrigger;
  /** Can this creature do the thing at all? Returns the payload, or null. */
  ready: (actor: any) => T | null;
  /** How far the reaction reaches, in scene units, from whatever `ready` handed back. */
  range: (ready: T) => number;
  /** How many are asked at most. See `MAX_ASKED` at each caller for why there is a cap. */
  max: number;
  /** An extra per-candidate refusal, e.g. Counterspell's Deafened check. */
  also?: (token: any, actor: any) => boolean;
  /** For the log, so a refusal names the rule that refused. */
  label: string;
}

export function reactorsAgainst<T>(search: ReactorSearch<T>): Array<Reactor<T>> {
  const subjectSide = sideOf(search.subjectToken);
  const found: Array<Reactor<T>> = [];
  const tokens: any[] = [];

  for (const combatant of search.combat?.combatants ?? []) {
    const token: any = combatant?.token?.object ?? combatant?.token;
    const actor: any = combatant?.actor;
    if (!token || !actor) continue;
    if (actor === search.subjectActor) continue;
    if (sideOf(token) === subjectSide) continue;

    if (!alive(actor) || !canReact(actor)) continue;
    if (!hasReaction(combatant)) continue;
    if (!offerable(actor, search.trigger)) continue;
    if (search.also && !search.also(token, actor)) continue;

    const ready = search.ready(actor);
    if (ready === null || ready === undefined) continue;
    if (!within(token, search.subjectToken, search.range(ready))) continue;

    tokens.push(token);
    found.push({ actor, token, ready });
  }

  if (!found.length) return found;

  let sees: Set<string>;
  try {
    sees = observersWhoSee(tokens, search.subjectToken);
  } catch (err) {
    log(`${search.label}: could not work out who can see, so all of them are offered:`, err);
    return found.slice(0, search.max);
  }
  return found.filter((c) => sees.has(String(c.token?.id ?? ""))).slice(0, search.max);
}

function sideOf(token: any): number {
  return Number(token?.document?.disposition ?? token?.disposition ?? 0);
}

/**
 * Straight-line separation in scene units, elevation included, as every measurement here does it.
 *
 * An unreadable position counts as in range. That is the same fail-open direction as the vision test and for
 * the same reason: the failure a table can diagnose is a reaction offered where it should not have been.
 */
export function within(from: any, to: any, feet: number): boolean {
  const a = from?.center ?? from?.object?.center;
  const b = to?.center ?? to?.object?.center;
  if (!a || !b) return true;
  try {
    const measured: any = (canvas as any)?.grid?.measurePath?.([a, b]);
    if (measured?.distance !== undefined) return Number(measured.distance) <= feet;
  } catch {
    /* gridless and older grid shapes fall through to the pixel reading */
  }
  const scale = Number((canvas as any)?.dimensions?.distance ?? 5);
  const size = Number((canvas as any)?.dimensions?.size ?? 100);
  return (Math.hypot(b.x - a.x, b.y - a.y) / size) * scale <= feet;
}

/** The token an actor is standing on, preferring a live placeable. Shared with the reaction rules. */
export function tokenOf(actor: any): any {
  const active = actor?.getActiveTokens?.(true, false)?.[0];
  if (active) return active;
  const doc = actor?.token;
  return doc?.object ?? doc ?? null;
}

/** The combatant for a token in a given fight. */
export function combatantFor(combat: any, token: any): any {
  const id = String(token?.id ?? token?.document?.id ?? "");
  return (combat?.combatants ?? []).find?.(
    (c: any) => String(c?.tokenId ?? c?.token?.id ?? "") === id,
  );
}
