// Jumping: how far, and the fact that it costs movement.
//
// NOBODY ENFORCES THE DISTANCE, and the near miss is more interesting than the gap. Core Foundry v13+
// has a real `jump` movement action, and dnd5e configures it properly — `deriveTerrainDifficulty =
// () => 1` and an identity cost function (`documents/token.mjs:139-140` in 5.3.3), which is exactly
// right: a jump ignores difficult terrain and each foot of it costs a foot of movement. dnd5e even
// populates `system.attributes.movement.jump`, so the drag ruler turns a sensible colour.
//
// What none of that does is stop anybody. The ruler is advisory, and the number behind it is
// `str.value / 2` (`data/actor/templates/attributes.mjs:456`) — the STANDING long jump and only that.
// A Strength 16 fighter who takes a run-up may clear sixteen feet and the ruler will call it eight;
// the same fighter may clear sixty and nothing at all objects.
//
// THE INTERACTION THAT WAS ACTUALLY BROKEN, and the reason this file exists rather than a chat card.
// `economy/speed.ts` budgets a turn against `movement[action]`, so the moment a player selected the
// jump action their whole turn's allowance collapsed to half their Strength score — eight feet for
// that same fighter, less than one square, with everything they had already walked counted against
// it. The rule is the opposite: jumping spends ordinary movement out of Speed, and the jump distance
// limits one leap rather than the turn. Both halves are fixed here.
//
// WHAT IS DELIBERATELY NOT ENFORCED. The DC 10 Athletics check to clear a low obstacle is at the
// DM's option in the rules themselves, and there is no way to know a hedge is there — Foundry models
// no obstacle heights. The DC 10 Acrobatics check for landing in difficult terrain is checkable in
// principle and is left alone too: it would fire on every jump into a bog with no way for the player
// to say they were expecting it, and a Prone condition applied by surprise is worse than a forgotten
// rule. Both are reported by `api.surveyJump()` so the GM can call for them.

import { MODULE_ID, log } from "../constants";
import { narrator, speakerFor } from "../util/speaker";
import { isJumpEnabled } from "../settings";
import { generalRulesApply, JUMP_RUN_UP, jumpDistances } from "../system/dnd5e-checks";
import type { JumpDistances } from "../system/dnd5e-checks";

/** Core's key for the jump movement action. */
export const JUMP_ACTION = "jump";

/**
 * Movement that counts as a run-up.
 *
 * "if you move at least 10 feet on foot immediately before the jump" — so flying and swimming into a
 * leap do not qualify, and neither does another jump. Crawling is included because it is on foot and
 * excluding it would need a rule the books do not state.
 */
const ON_FOOT = new Set(["walk", "climb", "crawl"]);

/** One contiguous leap within a movement path. */
export interface JumpLeg {
  /** Total distance of the leap in scene units. Equals cost, since a jump ignores terrain. */
  cost: number;
  /** Height gained, in scene units. */
  rise: number;
  /** Horizontal component, taken as the remainder of the path length. */
  horizontal: number;
  /** Feet moved on foot immediately before this leap. */
  runUp: number;
}

/** What a creature could clear right now, given how it has already moved this turn. */
export interface JumpState {
  distances: JumpDistances;
  /** On-foot movement immediately preceding the current position. */
  runUp: number;
  hasRunUp: boolean;
  /** The longest single leap allowed right now. */
  maxLong: number;
  maxHigh: number;
  units: string;
}

function units(): string {
  return String((canvas as any)?.scene?.grid?.units ?? "ft");
}

function enabled(): boolean {
  return generalRulesApply() && isJumpEnabled();
}

/**
 * Break a sequence of waypoints into leaps, carrying the run-up that preceded each.
 *
 * A leap is a run of consecutive `jump` waypoints: dragging four squares in one motion is one jump,
 * not four, which is the whole reason this is a walker rather than a per-waypoint check. Anything
 * airborne or aquatic between two leaps zeroes the run-up, because the rule says on foot.
 *
 * `startElevation` is the height the sequence begins at; without it a leap that starts at the very
 * first waypoint has nothing to measure its rise against.
 */
export function jumpLegs(
  waypoints: any[],
  options: { runUp?: number; startElevation?: number } = {},
): JumpLeg[] {
  const legs: JumpLeg[] = [];
  let runUp = Number(options.runUp) || 0;
  let elevation = Number(options.startElevation) || 0;
  let current: JumpLeg | null = null;

  for (const waypoint of waypoints ?? []) {
    const action = String(waypoint?.action ?? "walk");
    const cost = Number(waypoint?.cost);
    const height = Number(waypoint?.elevation);
    const step = Number.isFinite(cost) ? cost : 0;

    if (action === JUMP_ACTION) {
      if (!current) current = { cost: 0, rise: 0, horizontal: 0, runUp };
      current.cost += step;
      if (Number.isFinite(height)) current.rise = Math.max(current.rise, height - elevation);
    } else {
      if (current) {
        legs.push(finish(current));
        current = null;
        // Landing and running on can set up a second leap, so the tally restarts from here.
        runUp = 0;
      }
      if (ON_FOOT.has(action)) runUp += step;
      else runUp = 0;
    }
    if (Number.isFinite(height) && action !== JUMP_ACTION) elevation = height;
  }
  if (current) legs.push(finish(current));
  return legs;
}

function finish(leg: JumpLeg): JumpLeg {
  const rise = Math.max(0, leg.rise);
  return {
    cost: leg.cost,
    rise,
    // An approximation, and stated as one: core measures a 3D path as a single length, so the
    // horizontal share of a leap that also climbs is taken as what is left after the rise. It is
    // exact for a flat jump and for a straight-up one, which is nearly every jump anyone makes.
    horizontal: Math.max(0, leg.cost - rise),
    runUp: leg.runUp,
  };
}

/** How far this creature has come on foot immediately before now, from core's own record. */
export function runUpSoFar(doc: any): number {
  let total = 0;
  for (const waypoint of doc?.movementHistory ?? []) {
    const action = String(waypoint?.action ?? "walk");
    const cost = Number(waypoint?.cost);
    if (action === JUMP_ACTION) total = 0;
    else if (ON_FOOT.has(action)) total += Number.isFinite(cost) ? cost : 0;
    else total = 0;
  }
  return total;
}

/** What this token can clear from where it is standing. Null when the rules do not apply. */
export function jumpState(doc: any): JumpState | null {
  const actor = doc?.actor ?? doc;
  if (!actor) return null;
  const distances = jumpDistances(actor);
  if (distances.unreadable) return null;

  const runUp = runUpSoFar(doc);
  const hasRunUp = runUp >= JUMP_RUN_UP;
  return {
    distances,
    runUp,
    hasRunUp,
    maxLong: hasRunUp ? distances.longRunning : distances.longStanding,
    maxHigh: hasRunUp ? distances.highRunning : distances.highStanding,
    units: units(),
  };
}

/**
 * The furthest this creature can leap horizontally, for anything that needs the number rather than
 * the enforcement.
 *
 * Exported for the planner: a chasm is only an obstacle to a creature that cannot clear it, and
 * `core/positioning.ts` has no way to know that without asking. Takes the running distance, since a
 * creature choosing to jump a gap will take the run-up.
 */
export function jumpReach(actor: any): number {
  return jumpDistances(actor).longRunning;
}

/**
 * Is a proposed movement a jump that goes further than the rules allow? Returns the complaint, or
 * null when there is nothing to say.
 *
 * Measures the leaps inside the proposed path rather than the path's total cost, because a drag that
 * walks fifteen feet and then leaps ten is a legal ten-foot jump, and refusing it on a total of
 * twenty-five would be enforcing a rule that does not exist.
 */
export function jumpVeto(doc: any, movement: any): string | null {
  if (!enabled()) return null;
  const state = jumpState(doc);
  if (!state) return null;

  const proposed = [
    ...(movement?.passed?.waypoints ?? []),
    ...(movement?.pending?.waypoints ?? []),
  ];
  if (proposed.length === 0) return null;

  const legs = jumpLegs(proposed, {
    runUp: runUpSoFar(doc),
    startElevation: Number(doc?.elevation) || 0,
  });
  if (legs.length === 0) return null;

  const distances = state.distances;
  for (const leg of legs) {
    const standing = leg.runUp < JUMP_RUN_UP;
    const maxLong = standing ? distances.longStanding : distances.longRunning;
    const maxHigh = standing ? distances.highStanding : distances.highRunning;
    const kind = standing ? "standing" : "running";

    // Rounded for the same reason the Speed cap rounds: grid arithmetic produces 10.000000000000002
    // and refusing a legal jump over that is worse than allowing a hundredth of a foot.
    if (round2(leg.rise) > round2(maxHigh)) {
      return game.i18n.format("NOODLRHOOKS.Combat.Jump.TooHigh", {
        rise: trim(leg.rise),
        max: trim(maxHigh),
        kind,
        units: state.units,
      });
    }
    if (round2(leg.horizontal) > round2(maxLong)) {
      return game.i18n.format("NOODLRHOOKS.Combat.Jump.TooFar", {
        distance: trim(leg.horizontal),
        max: trim(maxLong),
        kind,
        units: state.units,
      });
    }
  }
  return null;
}

function round2(value: number): number {
  return Math.round(value * 100);
}

function trim(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/**
 * Announce what the selected tokens can clear.
 *
 * A card rather than a notification because the numbers are the GM's business as much as the
 * player's: "can I get across that?" is a question the table answers together, and the answer
 * depends on a run-up that the person asking may not have realised they still have.
 */
export async function announceJump(): Promise<void> {
  const selected: any[] = (canvas as any)?.tokens?.controlled ?? [];
  if (selected.length === 0) {
    ui.notifications?.warn(game.i18n.localize("NOODLRHOOKS.Combat.Jump.NoSelection"));
    return;
  }

  const lines: string[] = [];
  for (const token of selected) {
    const name = foundry.utils.escapeHTML(String(token?.name ?? "?"));
    const state = jumpState(token?.document ?? token);
    if (!state) {
      lines.push(
        `<strong>${name}</strong> ${game.i18n.localize("NOODLRHOOKS.Combat.Jump.Unreadable")}`,
      );
      continue;
    }
    lines.push(
      `<strong>${name}</strong> ${game.i18n.format("NOODLRHOOKS.Combat.Jump.Card", {
        long: trim(state.distances.longRunning),
        longStanding: trim(state.distances.longStanding),
        high: trim(state.distances.highRunning),
        highStanding: trim(state.distances.highStanding),
        units: state.units,
      })} ${game.i18n.format(
        state.hasRunUp ? "NOODLRHOOKS.Combat.Jump.HasRunUp" : "NOODLRHOOKS.Combat.Jump.NoRunUp",
        { moved: trim(state.runUp), needed: String(JUMP_RUN_UP), units: state.units },
      )}`,
    );
  }

  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content: `<p>${lines.join("</p><p>")}</p>`,
    speaker: selected.length === 1 ? speakerFor(selected[0]) : narrator(),
    flags: { [MODULE_ID]: { jump: true } },
  });
}

/** Everything the jump layer can see about the selected token, for the console. */
export function surveyJump(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  if (!token) return { error: "select a token" };
  const doc = token.document;
  const state = jumpState(doc);
  const report = {
    token: String(doc?.name ?? "?"),
    enabled: enabled(),
    movementAction: String(doc?.movementAction ?? ""),
    // dnd5e's own field, shown beside ours so the discrepancy is visible rather than mysterious.
    systemJumpSpeed: Number(token?.actor?.system?.attributes?.movement?.jump ?? NaN),
    state: state ?? "unreadable — no Strength score on this sheet",
    notAutomated: [
      "DC 10 Athletics to clear a low obstacle — at the DM's option, and Foundry models no obstacle heights",
      "DC 10 Acrobatics or Prone on landing in difficult terrain — checkable, deliberately left to the GM",
    ],
  };
  log("jump survey", report);
  return report;
}
