// Holding a creature to its Speed, and charging an Action when it goes further.
//
// NOBODY ELSE DOES THIS. Core Foundry v13+ has a real movement model — it records every waypoint a token
// crosses during its turn in `TokenDocument#movementHistory`, clears it at the start of the next turn,
// and measures each path's cost through difficult terrain — but it never compares any of that to a
// creature's Speed, because core has no idea what a creature's Speed is. dnd5e supplies the number and
// uses it for exactly one thing: colouring the drag ruler green, amber or red (`module/canvas/ruler.mjs`
// in 5.3.3). midi-qol does not touch movement at all. So the ruler turns red and the token keeps going,
// which is what the table saw: a player crossing the whole map on one turn, never once made to choose
// between moving and acting (user, 2026-08-05).
//
// TWO LAYERS, because they fail differently.
//
//   1. TRUNCATION, during the drag. Core v14 added `maxCost` to the drag's constrain options, which
//      makes it discard waypoints past a budget. The token then stops at the line by itself, exactly as
//      it stops at a wall — no dialog, no snap-back, no error. This is the layer that should do all the
//      work, and it only exists on the drag path.
//   2. REFUSAL, at the document. `preMoveToken` can veto a move outright but cannot shorten one, so it
//      is the backstop for the routes truncation does not cover: arrow keys, and any case where core
//      turns out to measure `maxCost` against the proposed path alone rather than the path plus the
//      history already recorded this turn. Core's own docs do not say which, and the answer decides
//      whether a second drag in the same turn is measured from zero. Budgeting the WHOLE turn and
//      keeping the backstop is correct under both readings: if history counts, truncation lands exactly
//      right and the backstop never fires; if it does not, the backstop catches the overflow instead of
//      letting it through.
//
// DASH IS CHARGED, NOT ASKED. A creature with its Action still in hand is allowed to keep dragging past
// its Speed, and the moment it does, the Action is spent as a Dash and said so in chat. That is the rule
// the GM actually wanted enforced — "stop moving, or take the Dash as your turn's action" — and doing it
// silently-but-visibly beats a confirmation dialog on a movement people perform dozens of times a night.
// With no Action left there is no second budget, so the drag simply stops.
//
// WHO IS HELD. Players, on their own turn, in a started combat. Not the GM, who moves tokens for staging
// reasons that are none of this module's business; not creatures Noodlr is playing, which budget their
// own movement before they take a step (elevation included, in `core/movement.ts`); and not anybody
// outside their turn, where the question is whose turn it is rather than how far they have come.
//
// ELEVATION SPENDS SPEED TOO. Fly / climb / swim / burrow / jump add |Δz|, and a size tax when the
// token leaves or meets the zero plane. A level flight is still just XY. See `core/elevation-cost.ts`.
//
// The Token subclass below also owns sheet-paced animation and mode-traverse. Those are not the Speed
// budget; they share the class because a second `objectClass` replacement would drop this one. See
// `core/pace.ts`, `core/traverse.ts` and `core/wall-height.ts`.

import { debug, log } from "../../constants";
import { speakerFor } from "../../util/speaker";
import {
  getMoveSpeed,
  isModeTraverseEnabled,
  isMovementCapEnabled,
  isSheetPaceEnabled,
} from "../../settings";
import { pickNumber, systemPaths } from "../../system/profiles";
import { JUMP_RUN_UP, jumpDistances } from "../../system/dnd5e-checks";
import {
  animationDurationMs,
  gridDistanceOf,
  paceActionOf,
  sheetSpacesPerSecondOf,
} from "../../core/pace";
import {
  horizontalSceneUnits,
  pathClearsWalls,
  segmentsOf,
  type TraverseWaypoint,
} from "../../core/traverse";
import {
  decidePath,
  scenePolicyOf,
  trimToCut,
  type CrossingFacts,
  type PathDecision,
  type WallLike,
} from "../../core/wall-height";
import { check, dashesTaken, takeDash } from "./ledger";
import { stoodThisTurn } from "../prone";
import { isAutomating } from "./enforce";
import { bonusDashSource } from "../../system/dnd5e-dash";
import { JUMP_ACTION, jumpVeto } from "../jump";
import { paintMotionFx, restoreMotionFx } from "../../core/motion-fx";
import { mountCostThisTurn, syncRiderVisuals } from "../riding";
import {
  elevationTaxOf,
  historyTravelCost,
  pathTravelCost,
  type TravelSpend,
} from "../../core/elevation-cost";

/**
 * What a creature may cross this turn, and what it has crossed already.
 *
 * `null` means the question does not apply — no combat, not this creature's turn, no readable Speed —
 * and every caller treats that as "leave it alone" rather than as a budget of zero.
 */
interface Budget {
  /** Base Speed for the movement action in use, in scene units. */
  speed: number;
  /** Already crossed this turn, in scene units, terrain costs included. */
  spent: number;
  /** Speed plus every Dash already paid for. */
  allowance: number;
  /** How one more Dash would be paid for, or null when nothing is left to pay with. */
  dash: DashCost | null;
  combatant: any;
  actor: any;
}

interface DashCost {
  slot: "action" | "bonus";
  /** The feature that makes a bonus action legal, for the chat line. Empty on the ordinary Action path. */
  source: string;
}

/**
 * Which slot the next Dash comes out of.
 *
 * The bonus action wins whenever the creature has something that grants it and the slot is free, because
 * that is what those features are FOR — charging a rogue's Action for a Dash quietly deletes Cunning
 * Action, on the most routine thing a rogue does all night (user, 2026-08-06). Dash remains legal as an
 * Action, so a creature that has already spent its bonus action falls back to that.
 */
function dashCost(actor: any, combat: any, combatant: any): DashCost | null {
  const source = bonusDashSource(actor);
  if (source && check(actor, combat, combatant, "bonus", false).allowed) {
    return { slot: "bonus", source };
  }
  if (check(actor, combat, combatant, "action", false).allowed) {
    return { slot: "action", source: "" };
  }
  return null;
}

function budgetFor(doc: any): Budget | null {
  if (!isMovementCapEnabled()) return null;

  const combat = game.combat;
  if (!combat?.started) return null;

  const combatant = doc?.combatant;
  // Only on your own turn. Moving out of turn is a different rule with a different answer, and a
  // creature that moves on somebody else's turn would otherwise spend a budget it has not been given.
  if (!combatant || String(combatant.id) !== String(combat.combatant?.id ?? "")) return null;

  const actor = doc?.actor;
  if (!actor) return null;

  const speed = speedFor(doc, actor);
  if (speed === null || speed <= 0) return null;

  const dashes = dashesTaken(actor, combat, combatant);
  return {
    speed,
    spent: spentThisTurn(doc),
    allowance:
      speed * (1 + dashes) -
      stoodThisTurn(actor, combat, combatant) -
      mountCostThisTurn(actor, combat, combatant),
    dash: dashCost(actor, combat, combatant),
    combatant,
    actor,
  };
}

/**
 * Speed for the way this creature is currently moving.
 *
 * A flying token is budgeted against its fly speed, a swimming one against its swim speed. Falling back
 * to the profile's generic speed keeps this working on systems that do not break movement down by mode.
 */
function speedFor(doc: any, actor: any): number | null {
  const modes = actor?.system?.attributes?.movement;
  const action = String(doc?.movementAction ?? "walk");

  // Jumping is the one mode whose named speed is not a turn budget. "Each foot you jump costs a foot
  // of movement" — the movement comes out of Speed, and the jump distance limits one leap rather than
  // the turn. dnd5e nevertheless publishes `movement.jump` (half the Strength score, to colour the
  // ruler), so reading it here collapsed a fighter's whole turn to eight feet the moment they selected
  // the jump action, with everything already walked counted against it. `rules/jump.ts` enforces the
  // per-leap distance separately.
  if (action === JUMP_ACTION) return walkSpeed(modes, actor);

  const mode = Number(modes?.[action]);
  if (Number.isFinite(mode) && mode > 0) return mode;

  return walkSpeed(modes, actor);
}

function walkSpeed(modes: any, actor: any): number | null {
  const walk = Number(modes?.walk);
  if (Number.isFinite(walk) && walk > 0) return walk;

  return pickNumber(actor, systemPaths().speed);
}

/**
 * How far this creature has already come this turn.
 *
 * Core's own record, not a tally of ours, plus the elevation surcharge in `elevation-cost.ts`. History
 * resets at the start of each turn and already has terrain multipliers baked into each waypoint's cost.
 * Costs are stored as `null` where core means infinity.
 */
function spentThisTurn(doc: any): number {
  return travelThisTurn(doc).total;
}

function travelThisTurn(doc: any): TravelSpend {
  return historyTravelCost(doc?.movementHistory ?? [], elevationTaxOf(doc?.actor), (from, to) =>
    measureHorizontal(doc, from, to),
  );
}

/** This move's passed + pending path, priced as XY + our vertical, from `movement.origin`. */
function proposedTravel(doc: any, movement: any): number {
  const tax = elevationTaxOf(doc?.actor);
  const origin = movement?.origin;
  const dests = [...(movement?.passed?.waypoints ?? []), ...(movement?.pending?.waypoints ?? [])];
  if (origin && dests.length) {
    return pathTravelCost(origin, dests, tax, (from, to) => measureHorizontal(doc, from, to)).total;
  }
  return Number(movement?.passed?.cost ?? 0) + Number(movement?.pending?.cost ?? 0);
}

function traverseFactsOf(doc: any): CrossingFacts {
  const modes = doc?.actor?.system?.attributes?.movement ?? {};
  let jumpLong: number | null = null;
  let jumpHighRunning: number | null = null;
  let jumpHighStanding: number | null = null;
  try {
    const distances = jumpDistances(doc?.actor);
    if (!distances.unreadable) {
      jumpLong = Math.max(distances.longRunning, distances.longStanding);
      jumpHighRunning = distances.highRunning;
      jumpHighStanding = distances.highStanding;
    }
  } catch {
    jumpLong = null;
  }
  return {
    hasFly: Number(modes.fly) > 0,
    hasClimb: Number(modes.climb) > 0,
    hasBurrow: Number(modes.burrow) > 0,
    jumpLong,
    jumpHighRunning,
    jumpHighStanding,
    defaultAction: String(doc?.movementAction ?? "walk"),
  };
}

function wallsOf(doc: any): WallLike[] {
  const col = doc?.parent?.walls ?? (globalThis as any).canvas?.scene?.walls;
  if (!col) return [];
  const out: WallLike[] = [];
  for (const wall of col) {
    const d = (wall as any).document ?? wall;
    const src = d._source ?? d;
    out.push({
      c: d.c ?? src.c,
      move: d.move ?? src.move,
      door: d.door ?? src.door,
      ds: d.ds ?? src.ds,
      flags: d.flags ?? src.flags,
    });
  }
  return out;
}

function pathDecisionOf(doc: any, waypoints: TraverseWaypoint[]): PathDecision {
  if (!isModeTraverseEnabled()) return { kind: "core" };
  const facts = traverseFactsOf(doc);
  const measure = (from: TraverseWaypoint, to: TraverseWaypoint) => measureHorizontal(doc, from, to);
  if (!pathClearsWalls(segmentsOf(waypoints, facts, measure))) return { kind: "core" };
  return decidePath(waypoints, wallsOf(doc), facts, scenePolicyOf(doc?.parent), measure, JUMP_RUN_UP);
}

function measureHorizontal(doc: any, from: TraverseWaypoint, to: TraverseWaypoint): number {
  const grid = doc?.parent?.grid;
  if (typeof grid?.measurePath === "function") {
    try {
      const measured = grid.measurePath([
        { x: from.x, y: from.y },
        { x: to.x, y: to.y },
      ]);
      const distance = Number(measured?.distance);
      if (Number.isFinite(distance)) return distance;
    } catch {
      // Fall through to the pixel conversion. A thrown measure must not block the move.
    }
  }
  const size = Number((globalThis as any).canvas?.dimensions?.size) || 100;
  return horizontalSceneUnits(from, to, size, gridDistanceOf(doc));
}

export function registerMovementCap(): void {
  // Truncation. Subclassed at `setup` rather than `init`, by which point dnd5e has already installed its
  // own Token class — extending whatever is there keeps its `ignoreTokens` handling instead of replacing
  // it, and needs no wrapper library. Sheet pace and mode-traverse live on this same subclass: a second
  // replacement of `objectClass` would drop the first.
  Hooks.once("setup", () => {
    const Base: any = (globalThis as any).CONFIG?.Token?.objectClass;
    if (!Base) return;
    (globalThis as any).CONFIG.Token.objectClass = class extends Base {
      _getDragConstrainOptions() {
        const options = super._getDragConstrainOptions();
        try {
          if (game.user?.isGM || isAutomating()) return options;
          const budget = budgetFor(this.document);
          if (!budget) return options;
          // The extra Speed is the Dash they have not bought yet: they are allowed to drag into it, and
          // charged for it on arrival.
          //
          // ONE Dash of headroom at a time, deliberately, even for a rogue who could afford two. Three
          // times its Speed remains reachable — the second drag is offered another Speed of headroom the
          // moment the first Dash is paid for — but each Dash costs a separate deliberate drag rather
          // than being handed over in one motion. A mis-drag should not be able to spend a creature's
          // action AND its bonus action before the player has noticed either.
          options.maxCost = budget.allowance + (budget.dash ? budget.speed : 0);
        } catch (err) {
          log("could not work out a movement budget for this drag:", err);
        }
        return options;
      }

      _getAnimationMovementSpeed(options: any) {
        try {
          if (isSheetPaceEnabled() && getMoveSpeed() <= 0) {
            const action = paceActionOf(this.document, options);
            const sps = sheetSpacesPerSecondOf(this.document, action);
            if (sps !== null) return sps;
          }
        } catch (err) {
          log("could not read a sheet pace:", err);
        }
        return super._getAnimationMovementSpeed(options);
      }

      _getAnimationDuration(from: any, to: any, options: any) {
        try {
          if (isSheetPaceEnabled() && getMoveSpeed() <= 0) {
            const action = paceActionOf(this.document, options, to);
            const sps = sheetSpacesPerSecondOf(this.document, action);
            const size = Number((globalThis as any).canvas?.dimensions?.size);
            if (sps !== null && size > 0) {
              const speed = this._modifyAnimationMovementSpeed(sps, options);
              const ours = animationDurationMs(from, to, speed, size, gridDistanceOf(this.document));
              // Super still owns rotation. Passing our speed also defeats climb/swim's
              // `defaultSpeed / 2`, which would otherwise skip `_getAnimationMovementSpeed`.
              const theirs = super._getAnimationDuration(from, to, { ...options, movementSpeed: speed });
              return Math.max(ours, theirs);
            }
          }
        } catch (err) {
          log("could not pace a movement animation:", err);
        }
        return super._getAnimationDuration(from, to, options);
      }

      _onAnimationUpdate(changed: any, context: any) {
        super._onAnimationUpdate(changed, context);
        try {
          paintMotionFx(this, context);
          syncRiderVisuals(this);
        } catch (err) {
          log("could not paint movement polish:", err);
        }
      }

      async animate(to: any, options: any = {}) {
        try {
          return await super.animate(to, options);
        } finally {
          try {
            if (!this.animationContexts?.size) restoreMotionFx(this);
          } catch (err) {
            log("could not restore movement polish:", err);
          }
        }
      }

      constrainMovementPath(waypoints: TraverseWaypoint[], options: any = {}) {
        const next = { ...options };
        try {
          if (!next.ignoreWalls) {
            const decision = pathDecisionOf(this.document, waypoints);
            if (decision.kind === "ignore-all") {
              next.ignoreWalls = true;
              debug("mode-traverse: ignoring walls", {
                name: String(this.document?.name ?? "?"),
                action: String(this.document?.movementAction ?? ""),
                elevation: this.document?._source?.elevation,
              });
            } else if (decision.kind === "cut" && decision.cut.skipped > 0) {
              next.ignoreWalls = true;
              debug("mode-traverse: cutting path at first blocking wall", {
                name: String(this.document?.name ?? "?"),
                skipped: decision.cut.skipped,
                x: decision.cut.x,
                y: decision.cut.y,
              });
              return super.constrainMovementPath(trimToCut(waypoints, decision.cut), next);
            }
          }
        } catch (err) {
          log("could not decide whether this path clears walls:", err);
        }
        return super.constrainMovementPath(waypoints, next);
      }
    };
  });

  // Refusal. Arrow keys never pass through the drag options above, and this also catches the reading of
  // `maxCost` in which core measures only the proposed path.
  Hooks.on("preMoveToken", (doc: any, movement: any) => {
    try {
      if (game.user?.isGM || isAutomating()) return true;
      const method = String(movement?.method ?? "");
      if (method !== "dragging" && method !== "keyboard") return true;

      // How far ONE leap may go, which is a different question from how far the turn may go and has
      // to be asked first: a creature with its whole Speed in hand may still not clear thirty feet.
      const overreach = jumpVeto(doc, movement);
      if (overreach) {
        ui.notifications?.warn(overreach);
        return false;
      }

      const budget = budgetFor(doc);
      if (!budget) return true;

      const proposed = proposedTravel(doc, movement) + budget.spent;
      const ceiling = budget.allowance + (budget.dash ? budget.speed : 0);
      // Rounded because grid arithmetic produces 30.000000000000004 and refusing a legal move over a
      // rounding error is worse than letting a fifteenth of a foot through.
      if (Math.round(proposed * 100) <= Math.round(ceiling * 100)) return true;

      ui.notifications?.warn(
        game.i18n.format("NOODLRHOOKS.Combat.Movement.Spent", {
          name: String(doc?.name ?? "?"),
          spent: round(budget.spent),
          max: round(ceiling),
          units: String((canvas as any)?.scene?.grid?.units ?? ""),
        }),
      );
      return false;
    } catch (err) {
      log("could not check a move against its budget:", err);
      return true;
    }
  });

  // Charging. Read after the move lands, because only then is the history authoritative.
  Hooks.on("moveToken", (doc: any, movement: any) => {
    const method = String(movement?.method ?? "");
    if (method !== "dragging" && method !== "keyboard") return;
    void chargeDash(doc);
  });
}

/**
 * Pay for however far this creature has actually gone.
 *
 * A loop rather than a single charge, because one move can owe more than one Dash. A rogue in a hurry may
 * legitimately spend its full movement, its bonus action on Cunning Action, AND its action on a second
 * Dash, for three times its Speed in one turn (user, 2026-08-06) — and it may cross all of that in a
 * single drag rather than three tidy ones. Charging once per move event would let the second Dash go
 * unpaid. Each iteration re-reads the budget, so the allowance grows as the debt is settled and the loop
 * stops as soon as the distance is covered or the creature runs out of things to spend.
 *
 * Written by whoever owns the token, which is the same client that just moved it. `takeDash` updates the
 * ledger's same-client shadow synchronously, so the re-read sees each charge without waiting on a flag
 * round trip.
 */
async function chargeDash(doc: any): Promise<void> {
  try {
    const charged: Array<{ cost: DashCost; speed: number }> = [];

    // Bounded purely as a runaway guard: nothing in the rules reaches four Dashes in one turn, and a
    // budget that never catches up would otherwise spin.
    for (let guard = 0; guard < 4; guard++) {
      const budget = budgetFor(doc);
      if (!budget || budget.spent <= budget.allowance) break;
      const cost = budget.dash;
      if (!cost) break;
      takeDash(budget.actor, game.combat, budget.combatant, cost.slot);
      charged.push({ cost, speed: budget.speed });
    }

    const ChatMessage = (globalThis as any).ChatMessage;
    for (const { cost, speed } of charged) {
      await ChatMessage.create({
        content: `<p>${game.i18n.format(
          cost.slot === "bonus"
            ? "NOODLRHOOKS.Combat.Movement.DashedBonus"
            : "NOODLRHOOKS.Combat.Movement.Dashed",
          {
            name: String(doc?.name ?? "?"),
            source: cost.source,
            speed: round(speed),
            units: String((canvas as any)?.scene?.grid?.units ?? ""),
          },
        )}</p>`,
        speaker: speakerFor(doc),
      });
    }
  } catch (err) {
    log("could not charge a Dash:", err);
  }
}

function round(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** What the budget looks like for the selected token, for the console. */
export function surveyMovement(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  if (!token) return { error: "select a token" };
  const doc = token.document;
  const budget = budgetFor(doc);
  const modes = doc?.actor?.system?.attributes?.movement ?? {};
  const action = String(doc?.movementAction ?? "walk");
  const elevation = Number(doc?._source?.elevation ?? doc?.elevation ?? 0);
  const gridDistance = gridDistanceOf(doc);
  const sps = sheetSpacesPerSecondOf(doc, action);
  const paceByAction: Record<string, number | null> = {};
  for (const mode of ["walk", "fly", "climb", "swim", "burrow"] as const) {
    if (Number(modes[mode]) > 0) paceByAction[mode] = sheetSpacesPerSecondOf(doc, mode);
  }
  const sample = [
    { x: Number(doc._source?.x ?? 0), y: Number(doc._source?.y ?? 0), elevation, action },
    {
      x: Number(doc._source?.x ?? 0) + Number((canvas as any)?.dimensions?.size ?? 100),
      y: Number(doc._source?.y ?? 0),
      elevation,
      action,
    },
  ];
  const policy = scenePolicyOf(doc?.parent);
  const travel = travelThisTurn(doc);
  const size = String(doc?.actor?.system?.traits?.size ?? "");
  const tax = elevationTaxOf(doc?.actor);
  const report = {
    token: String(doc?.name ?? "?"),
    enabled: isMovementCapEnabled(),
    combatStarted: Boolean(game.combat?.started),
    isTheirTurn: String(doc?.combatant?.id ?? "") === String(game.combat?.combatant?.id ?? ""),
    movementAction: action,
    elevation,
    size: size || "—",
    elevationTax: tax,
    sheet: {
      walk: modes.walk ?? 0,
      fly: modes.fly ?? 0,
      climb: modes.climb ?? 0,
      swim: modes.swim ?? 0,
      burrow: modes.burrow ?? 0,
    },
    sheetPace: isSheetPaceEnabled(),
    paceAction: action,
    paceByAction,
    spacesPerSecond: sps,
    secondsForOneSquare: sps ? round(gridDistance / (sps * gridDistance)) : "—",
    secondsForSheetSpeed: sps ? ROUND_HINT(modes, action, gridDistance, sps) : "—",
    modeTraverse: isModeTraverseEnabled(),
    enclosure: policy.enclosure,
    floor: policy.floor,
    defaultWall: `${policy.defaultBottom}–${policy.defaultTop}`,
    walls: wallsOf(doc).length,
    oneSquareDecision: pathDecisionOf(doc, sample).kind,
    historyWaypoints: (doc?.movementHistory ?? []).length,
    spentThisTurn: travel.total,
    spentCore: travel.core,
    spentElevationSurcharge: travel.surcharge,
    dashesTaken: doc?.combatant
      ? dashesTaken(doc.actor, game.combat, doc.combatant)
      : "not in combat",
    bonusDashFrom: bonusDashSource(doc?.actor) ?? "— none, Dash costs its action —",
    budget: budget
      ? {
          speed: budget.speed,
          allowance: budget.allowance,
          nextDashCostsA: budget.dash ? budget.dash.slot : "nothing left to pay with",
          ceiling: budget.allowance + (budget.dash ? budget.speed : 0),
        }
      : "not applicable — see the flags above for why",
    units: String((canvas as any)?.scene?.grid?.units ?? ""),
  };
  const lines = [
    `${report.token}: ${action} at ${elevation} ${report.units} (${report.size}, tax ${tax})`,
    `spent ${round(travel.total)} (core ${round(travel.core)} + Z ${round(travel.surcharge)})`,
    `sheet ${JSON.stringify(report.sheet)}`,
    `pace ${report.sheetPace ? "on" : "off"} ${action} → ${sps ?? "Foundry default"} spaces/sec` +
      (typeof report.secondsForSheetSpeed === "string" ? ` (${report.secondsForSheetSpeed})` : "") +
      (Object.keys(paceByAction).length
        ? ` [${Object.entries(paceByAction)
            .map(([mode, value]) => `${mode} ${value ?? "—"}`)
            .join(", ")}]`
        : ""),
    `traverse ${report.modeTraverse ? "on" : "off"} ${report.enclosure}/${report.floor} walls ${
      report.defaultWall
    } (${report.walls}) → one square ${report.oneSquareDecision}`,
  ];
  console.log(lines.join("\n"));
  return report;
}

function ROUND_HINT(modes: any, action: string, gridDistance: number, sps: number): string {
  const feet = Number(action === "jump" || action === "crawl" ? modes.walk : modes[action] ?? modes.walk);
  if (!(feet > 0) || !(sps > 0)) return "—";
  const seconds = feet / gridDistance / sps;
  return `dragging ${feet} ${gridDistance ? "ft" : "units"} ≈ ${round(seconds)}s`;
}
