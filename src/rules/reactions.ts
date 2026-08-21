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
// A third trigger — an attack that has been rolled and has not yet landed, which is Shield's moment —
// arrived in v0.4.2 and lives in `rules/damage.ts`, because it is a consequence of that layer rather than
// of this one. This header used to say Shield could not be timed without midi's `preCheckHits`, and the
// reason it gave was sound: dnd5e never compares an attack roll to an AC, so there was no moment to hook.
// Recomputing the hit ourselves created one. A fourth — a spell is being cast — arrived in v0.4.3 and lives
// in `rules/counterspell.ts`, because that one holds the trigger open rather than answering it afterwards.
// Silvery Barbs is still absent, with the reason in `rules/offer.ts`.
//
// The bookkeeping is ours too. Whether a creature has spent its reaction is read from Noodlr's own
// action-economy ledger rather than any module's flags, for exactly the same reason — and from the same
// ledger a player's reaction is drawn against, so automation and the table cannot disagree about it.
//
// WHO GETS PLAYED FOR AND WHO GETS ASKED (v0.4.2). Every candidate used to go through `shouldAutomate`,
// which refuses player characters in every mode and refuses any monster nobody opted in — so the whole
// feature existed only for automated NPCs, and a player with a halberd was never told their reaction had
// come up. Now the trigger is detected once and the creature is either played for (automated: the planner
// decides, no dialog, which is what stops this becoming a chain of approvals) or offered its options on a
// six-second clock (`rules/offer.ts`). The detection is unchanged; only who hears about it is new.

import { log } from "../constants";
import { hasReaction, spend } from "./economy/ledger";
import { isPrimaryGM } from "../util/gm";
import { narrator } from "../util/speaker";
import { readActions, type CreatureAction } from "../tactics/actions";
import { readHp } from "../core/tracker";
import { centerOf, measureBetween, type Point } from "../core/positioning";
import { pickNumber, systemPaths } from "../system/profiles";
import { shouldAutomate } from "../tactics/registry";
import { useActionAt } from "../tactics/execute";
import { can, mentalScore, tierForScore, tierProfile } from "../tactics/tiers";
import { turnRandom } from "../core/random";
import { hasDisengaged } from "./disengage";
import { isForcedMovement } from "./shove";
import { standingExemption } from "../system/dnd5e-reactions";
import { isCounterspellAction } from "../system/dnd5e-counterspell";
import { alive, canReact, notifyMidi, offerReaction, offerable, opportunityTaken } from "./offer";

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
  /** False when nobody is playing this creature for us, so it is asked instead of swung. */
  automated: boolean;
}

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
  Hooks.on("moveToken", (doc: any, movement: any, operation: any) => {
    if (!active()) return;
    void provoke(doc, movement, operation).catch((err) => log("opportunity attack failed:", err));
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

/**
 * Is there a fight for a reaction to matter in, and are we the client that watches for one?
 *
 * The primary GM detects every trigger, however owns the creature: one detector means one offer, and every
 * client watching `moveToken` would put the same dialog up several times over. Where the ANSWER belongs is
 * a separate question, settled per creature by `rules/offer.ts`.
 *
 * No longer gated on combat automation being on (v0.4.2). It used to be, and that was the bug: "do not play
 * my monsters for me" is not "do not remind me my reaction is up", and the two had been conflated into one
 * switch. `shouldAutomate` still decides who gets played for, which is where that setting belongs.
 */
function active(): boolean {
  if (!isPrimaryGM()) return false;
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

/** Centre of a Token or TokenDocument. Placeable `.center` is preferred; documents have none. */
function tokenCenter(token: any): Point | null {
  const live = token?.center;
  if (Number.isFinite(live?.x) && Number.isFinite(live?.y)) return { x: live.x, y: live.y };
  return centerOf(token);
}

function distance(a: any, b: any): number {
  const from = tokenCenter(a) ?? (a?.x !== undefined ? { x: Number(a.x), y: Number(a.y) } : null);
  const to = tokenCenter(b) ?? (b?.x !== undefined ? { x: Number(b.x), y: Number(b.y) } : null);
  if (!from || !to) return Infinity;
  return measureBetween(from, to);
}

/**
 * Scene-unit distance from a watcher's centre to the mover standing at a TokenPosition.
 *
 * Foundry's `origin`, `destination` and waypoints are the token's TOP-LEFT, same as the
 * document. `centerOf` already adds half the footprint; adding it again here is what made a
 * creature already inside a 10 ft Halberd reach look like it started outside it.
 */
export function centerFromTopLeft(
  point: { x: number; y: number },
  mover: { width?: number; height?: number },
  gridSize: number,
): Point {
  return {
    x: Number(point.x) + (gridSize * (Number(mover?.width) || 1)) / 2,
    y: Number(point.y) + (gridSize * (Number(mover?.height) || 1)) / 2,
  };
}

/**
 * The walk a `moveToken` (or the update fallback) describes, as top-left TokenPositions.
 *
 * Destination comes from the movement operation when Foundry supplies it. `_source` is a
 * fallback for the plain-update path and for older cores; using it as the only dest while
 * the token is mid-animation is how a leave-reach step vanished.
 */
export function movementRoute(
  movement: {
    origin?: { x: number; y: number };
    destination?: { x: number; y: number };
    passed?: { waypoints?: Array<{ x: number; y: number }> };
  } | null,
  fallbackDest?: { x: number; y: number } | null,
): Array<{ x: number; y: number }> {
  const route: Array<{ x: number; y: number }> = [];
  const push = (p: { x: number; y: number } | undefined | null) => {
    if (!p) return;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const last = route[route.length - 1];
    if (last && last.x === x && last.y === y) return;
    route.push({ x, y });
  };
  push(movement?.origin);
  for (const point of movement?.passed?.waypoints ?? []) push(point);
  push(movement?.destination ?? fallbackDest ?? null);
  return route;
}

/**
 * Did the mover cross out of `reach` anywhere along `route`?
 *
 * Walked step by step rather than compared end to end, because leaving reach provokes even when
 * the creature finishes its move back inside it. Exported so a test can pin a 5-to-15 ft hide
 * without a canvas.
 */
export function leftReachAlong(
  watcherCenter: Point,
  route: Array<{ x: number; y: number }>,
  mover: { width?: number; height?: number },
  reach: number,
  gridSize: number,
  measure: (a: Point, b: Point) => number = measureBetween,
): boolean {
  let wasInside = false;
  for (const point of route) {
    const at = centerFromTopLeft(point, mover, gridSize);
    const inside = measure(watcherCenter, at) <= reach;
    if (wasInside && !inside) return true;
    wasInside = inside;
  }
  return false;
}

function profileFor(actor: any): ReturnType<typeof tierProfile> {
  const P = systemPaths();
  const mental = mentalScore(pickNumber(actor, P.intelligence), pickNumber(actor, P.wisdom));
  return tierProfile(mental === null ? 4 : tierForScore(mental));
}

function spendReaction(combatant: any): void {
  const actor = combatant?.actor;
  if (!actor) return;
  spend(actor, game.combat, combatant, "reaction", false);
  notifyMidi(actor);
}

/**
 * Everyone who could take a swing at this token if it left their reach.
 *
 * Captured BEFORE the move, because afterwards there is no way to know who had it. Hostility is read
 * from token disposition: a creature does not snap at its own side walking past.
 *
 * Includes creatures nobody automated, which is the v0.4.2 change and the whole of it: they used to be
 * dropped here, silently, so the feature did not exist for player characters. They are tagged rather than
 * filtered, and the caller decides whether to swing or to ask.
 */
function watchersOf(moverDoc: any): Watcher[] {
  const combat: any = game.combat;
  if (!combat?.started) return [];

  const mover = moverDoc?.object ?? moverDoc;
  const moverDisposition = Number(moverDoc?.disposition ?? 0);
  const moverCombatantId = String(combatantFor(mover)?.id ?? "");
  const out: Watcher[] = [];

  for (const combatant of combat.combatants ?? []) {
    if (String(combatant?.id ?? "") === moverCombatantId) continue;
    // Do NOT also skip `combat.combatant`. That is "whose turn the tracker is on", and a goblin
    // walking past during the fighter's turn is exactly when the fighter is entitled to swing.
    // Skipping the mover is the only identity filter this loop needs.
    const automated = shouldAutomate(combatant);
    if (!automated && !offerable(combatant?.actor)) continue;
    if (combatant?.isDefeated || !alive(combatant?.actor)) continue;
    if (!hasReaction(combatant) || !canReact(combatant.actor)) continue;

    const token = tokenFor(combatant);
    if (!tokenCenter(token)) continue;
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
    out.push({ combatant, token, action: best, reach: best.range, automated });
  }
  return out;
}

async function provoke(moverDoc: any, movement: any, operation?: any): Promise<void> {
  const mover = moverDoc?.object ?? moverDoc;
  const who = String(moverDoc?.name ?? mover?.name ?? "?");
  if (!tokenCenter(mover) && !tokenCenter(moverDoc)) {
    log(`reaction: ${who} moved but has no readable centre — no opportunity attacks`);
    return;
  }
  if (opportunityTaken()) {
    log(`reaction: ${who} left reach, but Gambit's Premades owns opportunity attacks`);
    return;
  }

  const id = String(moverDoc?.id ?? "");
  handled.add(id);
  // Cleared on a timer, not immediately: the fallback's `updateToken` fires just after this one.
  setTimeout(() => handled.delete(id), 2000);

  // Neither a teleport nor a shove provokes. A creature that was never between the two points cannot be
  // swung at on the way past (Misty Step, Blink and Dimension Door all arrive as displacements), and
  // under the 2024 rules an opportunity attack triggers only on movement a creature SPENDS — being
  // pushed, pulled or dragged is somebody else's expenditure.
  const waypoints: any[] = movement?.passed?.waypoints ?? [];
  if (isForcedMovement(movement, operation)) {
    log(`reaction: ${who} was displaced — forced movement does not provoke`);
    return;
  }

  const route = movementRoute(movement, {
    x: Number(moverDoc?._source?.x ?? moverDoc?.x ?? mover?.x),
    y: Number(moverDoc?._source?.y ?? moverDoc?.y ?? mover?.y),
  });
  if (route.length < 2) {
    log(`reaction: ${who} moved but the route had fewer than two points — no opportunity attacks`);
    return;
  }

  const watchers = watchersOf(moverDoc);
  if (watchers.length === 0) {
    log(`reaction: ${who} moved and nobody on the tracker could take an opportunity attack`);
    return;
  }

  // A standing trait — Flyby, Agile — is checked here rather than beside Disengage because Flyby's
  // exemption is conditional on HOW the creature left, and the waypoints are the only record of that.
  const standing = standingExemption(moverDoc?.actor);
  const exempt = standing && (!standing.requiresFlight || flew(moverDoc, waypoints));
  const disengaged = hasDisengaged(moverDoc?.actor);

  let left = 0;
  for (const watcher of watchers) {
    if (!leftReach(watcher, route, moverDoc)) continue;
    left++;

    if (exempt) {
      log(
        `reaction: ${watcher.combatant?.name} holds its swing — ${moverDoc?.name} has ${standing!.label}`,
      );
      continue;
    }
    if (disengaged) {
      log(`reaction: ${watcher.combatant?.name} holds its swing — ${moverDoc?.name} disengaged`);
      continue;
    }

    if (!watcher.automated) {
      await ask(watcher.combatant, watcher.token, mover, "opportunity");
      continue;
    }
    if (withholds(watcher.combatant)) continue;

    await strike(watcher, mover, "as it slips away");
  }
  if (left === 0) {
    log(
      `reaction: ${who} moved past ${watchers.length} watcher(s) and left nobody's reach` +
        ` (${watchers.map((w) => `${w.combatant?.name}@${w.reach}`).join(", ")})`,
    );
  }
}

/**
 * Hand the decision to whoever plays this creature.
 *
 * Awaited in sequence with the other watchers rather than fired off in parallel, deliberately: two dialogs
 * at once on one client is a stack of windows, and a player answering the second before the first has to be
 * able to trust that the first one's swing has already resolved. The clock is six seconds, so a queue of
 * three is over inside a round.
 */
async function ask(
  combatant: any,
  token: any,
  target: any,
  trigger: "opportunity" | "hurt",
): Promise<void> {
  const actor = combatant?.actor;
  const tokenUuid = String(token?.document?.uuid ?? token?.uuid ?? "");
  if (!actor || !tokenUuid) return;

  const answer = await offerReaction(actor, {
    actorUuid: String(actor.uuid ?? ""),
    tokenUuid,
    targetUuid: String(target?.document?.uuid ?? target?.uuid ?? "") || undefined,
    targetName: String(target?.name ?? ""),
    trigger,
  });
  if (answer.taken) {
    log(`reaction: ${combatant?.name} answered with ${answer.label}`);
  }
}

/**
 * Was this move made by flying?
 *
 * The waypoints are the record of how the creature travelled, and any flying step in the route is
 * enough: Flyby's wording is about leaving reach in the air, and a creature that takes off mid-move
 * has done exactly that. Falls back to the token's current movement action for the plain-update path,
 * which carries no waypoints at all — and to hovering, since a creature that never touched the ground
 * did not walk out of anybody's reach.
 */
function flew(moverDoc: any, waypoints: any[]): boolean {
  for (const point of waypoints ?? []) if (String(point?.action ?? "") === "fly") return true;
  if (String(moverDoc?.movementAction ?? "") === "fly") return true;
  try {
    return Boolean(moverDoc?.actor?.statuses?.has?.("hover"));
  } catch {
    return false;
  }
}

/**
 * Did the mover cross out of this watcher's reach anywhere along the route?
 *
 * Walked step by step rather than compared end to end, because leaving reach provokes even when the
 * creature finishes its move back inside it — a rogue circling an ogre to flank still gets snapped at.
 */
function leftReach(watcher: Watcher, route: Array<{ x: number; y: number }>, mover: any): boolean {
  const from = tokenCenter(watcher.token);
  if (!from) return false;
  const grid = Number((canvas as any)?.grid?.size ?? (canvas as any)?.dimensions?.size ?? 100) || 100;
  const doc = mover?.document ?? mover;
  return leftReachAlong(from, route, doc, watcher.reach, grid);
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
  if (!combatant || !hasReaction(combatant)) return;
  const automated = shouldAutomate(combatant);
  if (!automated && !offerable(actor, "hurt")) return;
  if (!canReact(actor) || !alive(actor)) return;
  // Its own turn is not off-turn, and a creature does not react to its own action.
  if (String(combatant.id ?? "") === String(combat?.combatant?.id ?? "")) return;

  const culprit = tokenFor(combat?.combatant);
  const self = tokenFor(combatant);
  if (!tokenCenter(culprit) || !tokenCenter(self)) return;
  if (Number(culprit?.document?.disposition ?? 0) === Number(self?.document?.disposition ?? 0)) {
    return;
  }

  const gap = distance(self, culprit);
  if (!automated) {
    // Nothing is chosen here: the options are read on the owner's client, which is also the only one that
    // can honestly say what is still available on that sheet.
    log(`reaction: ${combatant.name} took ${amount} damage off-turn; offering an answer`);
    await ask(combatant, self, culprit, "hurt");
    return;
  }

  let best: CreatureAction | undefined;
  for (const action of readActions(combatant.actor)) {
    if (!action.available || action.economy !== "reaction") continue;
    if (action.kind !== "attack" && action.kind !== "control") continue;
    if (isCounterspellAction(action)) continue;
    if (action.range < gap) continue;
    if (!best || action.range < best.range) best = action;
  }
  if (!best) return;

  log(
    `reaction: ${combatant.name} took ${amount} damage off-turn; assuming ${culprit?.name} caused it`,
  );
  await strike(
    { combatant, token: self, action: best, reach: best.range, automated },
    culprit,
    "in answer",
  );
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
      speaker: narrator(),
      whisper: ChatMessage.getWhisperRecipients("GM").map((u: any) => u.id),
    });
  }
}
