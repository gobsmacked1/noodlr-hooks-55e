// Off-turn reactions: opportunity attacks, and hitting back when hurt on somebody else's turn.
//
// Built on Foundry's own hooks and the actor's own sheet, with NO third-party module required. That is a
// deliberate architectural decision (user, 2026-08-04): Midi QoL is excellent and has gone quiet for
// months at a time, and a table whose reactions stop working because someone else's module has not been
// updated is a table Noodlr has failed. Where midi IS present, the existing item-use path already routes
// through it, so reactions resolve with its fidelity — but nothing here depends on it existing.
//
// The two triggers implemented here were chosen because both can be detected with certainty from core:
//
//   1. SOMEONE LEFT MY REACH — `moveToken`, which hands over the whole route: where the move began, the
//      waypoints it passed through, and the action each one used. The route is walked rather than
//      compared end to end, because leaving reach provokes even when the creature finishes back inside
//      it, and a `displace` waypoint is a teleport, which provokes nothing at all.
//   2. I WAS HURT AND IT IS NOT MY TURN — a hit-point decrease on the actor. This is as system-agnostic
//      as anything gets: every system tracks hit points, and none of them hide a decrease.
//
// Triggers deliberately NOT here yet: reacting to an attack roll before it resolves (Shield, Parry) and
// to a spell being cast (Counterspell). Without midi, dnd5e never compares an attack roll to an AC at
// all — a human eyeballs it — so there is no "about to hit" moment to hook, and Shield cannot be timed.
// The honest shape for those is an optional adapter that lights up when midi is present (its
// `preCheckHits` is the last point at which an AC change is still read) plus a native Counterspell via
// dnd5e's own activity-use hooks. Planned, specified in AGENTS.md, not guessed at here.
//
// The bookkeeping is ours too. Whether a creature has spent its reaction is read from Noodlr's own
// action-economy ledger rather than any module's flags, for exactly the same reason — and from the same
// ledger a player's reaction is drawn against, so automation and the table cannot disagree about it.

import { log } from "../../constants";
import { hasReaction, spend } from "../economy/ledger";
import { isPrimaryGM } from "../../util/gm";
import { readActions, type CreatureAction } from "../actions";
import { readHp } from "../tracker";
import { pickNumber, systemPaths } from "../system-profiles";
import { getCombatAutomation } from "../config";
import { shouldAutomate } from "./registry";
import { useActionAt } from "./execute";
import { can, mentalScore, tierForScore, tierProfile } from "./tiers";
import { turnRandom } from "./random";

/** Mover id -> where it was, captured before a bare document update lands. */
const departing = new Map<string, { x: number; y: number }>();

/** Movers already resolved through the movement hook, so the update fallback does not double up. */
const handled = new Set<string>();

/** Actor id -> damage taken, carried from before the hit-point change to after it has landed. */
const wounded = new Map<string, number>();

interface Watcher {
  combatant: any;
  token: any;
  action: CreatureAction;
  reach: number;
}

/** Words a system or module might use for "I chose not to provoke this". Matched loosely on purpose. */
const DISENGAGED = /disengag|withdraw/i;

export function registerReactionHooks(): void {
  Hooks.on("deleteCombat", () => {
    departing.clear();
    wounded.clear();
  });

  // `moveToken` carries the whole route: `movement.origin`, `movement.passed.waypoints`, and the action
  // each waypoint used. That matters for two rules, not just for convenience. A creature that steps out
  // of reach and back again inside one move still provokes, which a simple before-and-after comparison
  // misses entirely. And a teleport provokes nothing, which is only knowable from the waypoint's action.
  // Neither hook is awaited by core, so nothing here may block it.
  Hooks.on("moveToken", (doc: any, movement: any) => {
    if (!active()) return;
    void provoke(doc, movement).catch((err) => log("opportunity attack failed:", err));
  });

  // Fallback for a move that arrives as a plain document update, with no movement operation attached.
  Hooks.on("preUpdateToken", (doc: any, changes: any) => {
    if (!active()) return;
    if (!("x" in (changes ?? {})) && !("y" in (changes ?? {}))) return;
    departing.set(String(doc?.id ?? ""), {
      x: Number(doc?._source?.x ?? doc?.x ?? 0),
      y: Number(doc?._source?.y ?? doc?.y ?? 0),
    });
  });

  Hooks.on("updateToken", (doc: any, _changes: any, _options: any, _userId: string) => {
    const before = departing.get(String(doc?.id ?? ""));
    if (!before) return;
    departing.delete(String(doc?.id ?? ""));
    if (!active() || handled.has(String(doc?.id ?? ""))) return;
    void provoke(doc, { origin: before }).catch((err) => log("opportunity attack failed:", err));
  });

  // Hit points falling on someone else's turn is the one damage signal every system gives us. The old
  // value only exists before the update and the reaction must not resolve until the damage has actually
  // landed, so the two halves are split across both hooks.
  Hooks.on("preUpdateActor", (actor: any, changes: any) => {
    if (!active()) return;
    const before = readHp(actor)?.value;
    const after = incomingHp(changes);
    if (before === null || before === undefined || after === null) return;
    if (after >= before) return;
    wounded.set(String(actor?.id ?? ""), before - after);
  });

  Hooks.on("updateActor", (actor: any) => {
    const amount = wounded.get(String(actor?.id ?? ""));
    if (amount === undefined) return;
    wounded.delete(String(actor?.id ?? ""));
    if (!active()) return;
    void retaliate(actor, amount);
  });
}

/** Is the reaction layer switched on and is there a fight for it to matter in? */
function active(): boolean {
  if (!isPrimaryGM()) return false;
  if (getCombatAutomation() === "off") return false;
  return Boolean((game.combat as any)?.started);
}

/** The new hit-point value out of an update payload, across the shapes systems use. */
function incomingHp(changes: any): number | null {
  const candidates = [
    changes?.system?.attributes?.hp?.value,
    changes?.system?.hp?.value,
    changes?.system?.health?.value,
    changes?.system?.attributes?.health?.value,
  ];
  for (const value of candidates) if (typeof value === "number") return value;
  return null;
}

function combatantFor(token: any): any {
  const id = String(token?.document?.id ?? token?.id ?? "");
  return (game.combat as any)?.combatants?.find?.(
    (c: any) => String(c?.tokenId ?? c?.token?.id ?? "") === id,
  );
}

function tokenFor(combatant: any): any {
  return combatant?.token?.object ?? combatant?.token ?? null;
}

function alive(actor: any): boolean {
  const hp = readHp(actor);
  return !hp || hp.value === null || hp.value > 0;
}

/** Conditions that take a creature's reaction away entirely. */
const CANNOT_REACT = ["incapacitated", "paralyzed", "stunned", "unconscious", "petrified", "dead"];

/**
 * Is this creature in a state where a reaction is legal?
 *
 * A paralysed ogre does not swing at anybody, and letting one do so is the sort of rules break that
 * makes the whole feature untrustworthy. Read from status ids, which every system registers, rather than
 * from a helper belonging to some module.
 */
function canReact(actor: any): boolean {
  try {
    const statuses: any = actor?.statuses;
    for (const status of CANNOT_REACT) if (statuses?.has?.(status)) return false;
  } catch {
    /* an unreadable status set is not evidence of incapacity */
  }
  return true;
}

/**
 * Has another module claimed opportunity attacks?
 *
 * Gambit's Premades implements them properly, and two modules both reacting means the party is hit
 * twice for one departure. It is the only current implementation I know of, and this is a name check
 * rather than a dependency: if it is absent, nothing here changes.
 */
function opportunityTaken(): boolean {
  const gps: any = (game as any).modules?.get?.("gambits-premades");
  if (!gps?.active) return false;
  try {
    return game.settings.get("gambits-premades", "Opportunity Attack") !== false;
  } catch {
    // Present but unreadable: defer, because double attacks are worse than none.
    return true;
  }
}

function distance(a: any, b: any): number {
  const from = a?.center ?? a;
  const to = b?.center ?? b;
  try {
    const measured = (canvas as any)?.grid?.measurePath?.([from, to]);
    if (measured?.distance !== undefined) return Number(measured.distance);
  } catch {
    /* gridless and older grid shapes fall through */
  }
  const scale = Number((canvas as any)?.dimensions?.distance ?? 5);
  const size = Number((canvas as any)?.dimensions?.size ?? 100);
  return (Math.hypot(to.x - from.x, to.y - from.y) / size) * scale;
}

/** Pixel distance converted the same way, for comparing a remembered position. */
function distanceFromPoint(point: { x: number; y: number }, token: any, mover: any): number {
  const half = (Number(mover?.width ?? 1) * Number((canvas as any)?.dimensions?.size ?? 100)) / 2;
  return distance(token, { x: point.x + half, y: point.y + half });
}

function profileFor(actor: any): ReturnType<typeof tierProfile> {
  const P = systemPaths();
  const mental = mentalScore(pickNumber(actor, P.intelligence), pickNumber(actor, P.wisdom));
  return tierProfile(mental === null ? 4 : tierForScore(mental));
}

function spendReaction(combatant: any): void {
  const actor = combatant?.actor;
  if (actor) spend(actor, game.combat, combatant, "reaction", false);

  // Tell midi as well, when it is there. Not for our own bookkeeping — the ledger is authoritative
  // and works alone — but because midi skips any reaction activity whose owner has spent their reaction,
  // which makes its own prompt suppress itself instead of asking the GM to react a second time.
  // Silently inert unless the table set midi's "Enforce Reactions" to All or Display Only (its default
  // is "none", verified in midi 14.0.11 source); harmless either way.
  const midi: any = (globalThis as any).MidiQOL;
  if (!actor || typeof midi?.setReactionUsed !== "function") return;
  try {
    if (typeof midi.hasUsedReaction === "function" && midi.hasUsedReaction(actor)) return;
    void Promise.resolve(midi.setReactionUsed(actor)).catch(() => {
      /* best effort; our ledger has already recorded it */
    });
  } catch {
    /* ditto */
  }
}

/**
 * Everyone who could take a swing at this token if it left their reach.
 *
 * Captured BEFORE the move, because afterwards there is no way to know who had it. Hostility is read
 * from token disposition: a creature does not snap at its own side walking past.
 */
function watchersOf(moverDoc: any): Watcher[] {
  const combat: any = game.combat;
  if (!combat?.started) return [];

  const mover = moverDoc?.object ?? moverDoc;
  const moverDisposition = Number(moverDoc?.disposition ?? 0);
  const currentId = String(combat.combatant?.id ?? "");
  const moverCombatantId = String(combatantFor(mover)?.id ?? "");
  const out: Watcher[] = [];

  for (const combatant of combat.combatants ?? []) {
    if (String(combatant?.id ?? "") === moverCombatantId) continue;
    // Its own turn is not when it stands watching: an opportunity attack is an off-turn thing.
    if (String(combatant?.id ?? "") === currentId) continue;
    if (!shouldAutomate(combatant)) continue;
    if (combatant?.isDefeated || !alive(combatant?.actor)) continue;
    if (!hasReaction(combatant) || !canReact(combatant.actor)) continue;

    const token = tokenFor(combatant);
    if (!token?.center) continue;
    if (Number(token?.document?.disposition ?? 0) === moverDisposition) continue;

    // The best melee swing it has. Opportunity attacks are not a sheet entry in any system I know of —
    // they are an ordinary melee attack spent as a reaction — so this looks for the attack, not a
    // reaction-flagged item.
    let best: CreatureAction | undefined;
    for (const action of readActions(combatant.actor)) {
      if (!action.available || !action.melee || action.kind !== "attack") continue;
      if (action.economy !== "action" && action.economy !== "free") continue;
      if (!best || action.range > best.range) best = action;
    }
    if (!best) continue;
    // No proximity check here: whether the mover was ever inside this reach is decided by walking the
    // route, and by the time this runs the token has already arrived somewhere else.
    out.push({ combatant, token, action: best, reach: best.range });
  }
  return out;
}

async function provoke(moverDoc: any, movement: any): Promise<void> {
  const mover = moverDoc?.object ?? moverDoc;
  if (!mover?.center) return;
  if (opportunityTaken()) return;

  const id = String(moverDoc?.id ?? "");
  handled.add(id);
  // Cleared on a timer, not immediately: the fallback's `updateToken` fires just after this one.
  setTimeout(() => handled.delete(id), 2000);

  // A displacement is a teleport, and a creature that was never between the two points provokes nothing.
  // Misty Step, Blink and Dimension Door all arrive this way.
  const waypoints: any[] = movement?.passed?.waypoints ?? [];
  if (waypoints.some((w: any) => String(w?.action ?? "") === "displace")) return;

  const route: Array<{ x: number; y: number }> = [];
  const origin = movement?.origin;
  if (origin) route.push({ x: Number(origin.x), y: Number(origin.y) });
  for (const point of waypoints) route.push({ x: Number(point.x), y: Number(point.y) });
  route.push({
    x: Number(moverDoc?._source?.x ?? mover.x),
    y: Number(moverDoc?._source?.y ?? mover.y),
  });
  if (route.length < 2) return;

  const disengaged = hasDisengaged(moverDoc?.actor);

  for (const watcher of watchersOf(moverDoc)) {
    if (!leftReach(watcher, route, moverDoc)) continue;

    if (disengaged) {
      log(`reaction: ${watcher.combatant?.name} holds its swing — ${moverDoc?.name} disengaged`);
      continue;
    }
    if (withholds(watcher.combatant)) continue;

    await strike(watcher, mover, "as it slips away");
  }
}

/**
 * Did the mover cross out of this watcher's reach anywhere along the route?
 *
 * Walked step by step rather than compared end to end, because leaving reach provokes even when the
 * creature finishes its move back inside it — a rogue circling an ogre to flank still gets snapped at.
 */
function leftReach(watcher: Watcher, route: Array<{ x: number; y: number }>, mover: any): boolean {
  let wasInside = false;
  for (const point of route) {
    const inside = distanceFromPoint(point, watcher.token, mover) <= watcher.reach;
    if (wasInside && !inside) return true;
    wasInside = inside;
  }
  return false;
}

/**
 * A creature clever enough to save its reaction sometimes does.
 *
 * Tier 7 unlocks holding a resource for a predicted opening, and a reaction is the purest example: a
 * mage who spends it snapping at a fleeing rogue has none left for Counterspell. Below that tier the
 * swing is reflex, which is correct — a wolf does not weigh its options as prey bolts.
 */
function withholds(combatant: any): boolean {
  const profile = profileFor(combatant?.actor);
  if (!can(profile, "holdResources")) return false;

  const hasBetter = readActions(combatant.actor).some(
    (a) => a.available && a.economy === "reaction",
  );
  if (!hasBetter) return false;

  // Not always: a creature that never swings reads as passive rather than patient.
  const rand = turnRandom(String(combatant?.id ?? ""), `hold-${(game.combat as any)?.round ?? 0}`);
  if (rand() >= 0.6) return false;
  log(`reaction: ${combatant?.name} keeps its reaction back for something better`);
  return true;
}

function hasDisengaged(actor: any): boolean {
  try {
    for (const status of (actor?.statuses ?? []) as Set<string>) {
      if (DISENGAGED.test(String(status))) return true;
    }
    for (const effect of actor?.appliedEffects ?? actor?.effects ?? []) {
      if (DISENGAGED.test(String(effect?.name ?? effect?.label ?? ""))) return true;
    }
  } catch {
    /* an unreadable effect list is not evidence of a disengage */
  }
  return false;
}

/**
 * Hit back at whoever is presumably responsible.
 *
 * "Presumably" is doing real work: a hit-point change carries no attribution, so the creature whose turn
 * it is gets the blame. That is right nearly always and wrong in the interesting cases (a trap, an area
 * effect from a previous round), so it is logged as an assumption rather than stated as a fact.
 */
async function retaliate(actor: any, amount: number): Promise<void> {
  const combat: any = game.combat;
  const combatant = (combat?.combatants ?? []).find?.((c: any) => c?.actor?.id === actor?.id);
  if (!combatant || !shouldAutomate(combatant) || !hasReaction(combatant)) return;
  if (!canReact(actor) || !alive(actor)) return;
  // Its own turn is not off-turn, and a creature does not react to its own action.
  if (String(combatant.id ?? "") === String(combat?.combatant?.id ?? "")) return;

  const culprit = tokenFor(combat?.combatant);
  const self = tokenFor(combatant);
  if (!culprit?.center || !self?.center) return;
  if (Number(culprit?.document?.disposition ?? 0) === Number(self?.document?.disposition ?? 0)) {
    return;
  }

  const gap = distance(self, culprit);
  let best: CreatureAction | undefined;
  for (const action of readActions(combatant.actor)) {
    if (!action.available || action.economy !== "reaction") continue;
    if (action.kind !== "attack" && action.kind !== "control") continue;
    if (action.range < gap) continue;
    if (!best || action.range < best.range) best = action;
  }
  if (!best) return;

  log(
    `reaction: ${combatant.name} took ${amount} damage off-turn; assuming ${culprit?.name} caused it`,
  );
  await strike({ combatant, token: self, action: best, reach: best.range }, culprit, "in answer");
}

/** Announce it, spend the reaction, and let the system roll. */
async function strike(watcher: Watcher, target: any, phrasing: string): Promise<void> {
  spendReaction(watcher.combatant);
  const name = String(watcher.combatant?.name ?? "Something");
  const targetName = String(target?.name ?? "its attacker");

  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content:
      `<p><em>Reaction:</em> ${foundry.utils.escapeHTML(name)} strikes at ` +
      `${foundry.utils.escapeHTML(targetName)} with ${foundry.utils.escapeHTML(watcher.action.name)} ` +
      `${foundry.utils.escapeHTML(phrasing)}.</p>`,
    speaker: { alias: name },
  });

  try {
    await useActionAt(watcher.action, target, { asReaction: true });
  } catch (err) {
    log(`reaction: ${name} could not use ${watcher.action.name}:`, err);
    await ChatMessage.create({
      content: `<p><em>${foundry.utils.escapeHTML(name)}'s reaction did not resolve — roll it by hand.</em></p>`,
      whisper: ChatMessage.getWhisperRecipients("GM").map((u: any) => u.id),
    });
  }
}
