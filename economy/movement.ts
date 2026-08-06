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
// own movement before they take a step; and not anybody outside their turn, where the question is whose
// turn it is rather than how far they have come.

import { log } from "../../constants";
import { isMovementCapEnabled } from "../config";
import { pickNumber, systemPaths } from "../system-profiles";
import { check, dashesTaken, takeDash } from "./ledger";
import { isAutomating } from "./enforce";

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
  /** Whether one more Dash could still be bought with an Action in hand. */
  dashable: boolean;
  combatant: any;
  actor: any;
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
    allowance: speed * (1 + dashes),
    dashable: check(actor, combat, combatant, "action", false).allowed,
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
  const mode = Number(modes?.[action]);
  if (Number.isFinite(mode) && mode > 0) return mode;

  const walk = Number(modes?.walk);
  if (Number.isFinite(walk) && walk > 0) return walk;

  return pickNumber(actor, systemPaths().speed);
}

/**
 * How far this creature has already come this turn.
 *
 * Core's own record, not a tally of ours. It resets at the start of each turn, survives undo, and
 * already has terrain multipliers baked into each waypoint's cost — a parallel counter would drift from
 * it within a round. Costs are stored as `null` where core means infinity.
 */
function spentThisTurn(doc: any): number {
  let total = 0;
  for (const waypoint of doc?.movementHistory ?? []) {
    const cost = Number(waypoint?.cost);
    if (Number.isFinite(cost)) total += cost;
  }
  return total;
}

export function registerMovementCap(): void {
  // Truncation. Subclassed at `setup` rather than `init`, by which point dnd5e has already installed its
  // own Token class — extending whatever is there keeps its `ignoreTokens` handling instead of replacing
  // it, and needs no wrapper library.
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
          options.maxCost = budget.allowance + (budget.dashable ? budget.speed : 0);
        } catch (err) {
          log("could not work out a movement budget for this drag:", err);
        }
        return options;
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

      const budget = budgetFor(doc);
      if (!budget) return true;

      const proposed =
        Number(movement?.passed?.cost ?? 0) + Number(movement?.pending?.cost ?? 0) + budget.spent;
      const ceiling = budget.allowance + (budget.dashable ? budget.speed : 0);
      // Rounded because grid arithmetic produces 30.000000000000004 and refusing a legal move over a
      // rounding error is worse than letting a fifteenth of a foot through.
      if (Math.round(proposed * 100) <= Math.round(ceiling * 100)) return true;

      ui.notifications?.warn(
        game.i18n.format("NOODLR.Combat.Movement.Spent", {
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
 * Spend the Action if this creature has now gone further than its Speed.
 *
 * Written by whoever owns the token, which is the same client that just moved it. Guarded on the
 * ledger's own verdict so that a creature with nothing left to spend is never charged for a move that
 * truncation should have prevented.
 */
async function chargeDash(doc: any): Promise<void> {
  try {
    const budget = budgetFor(doc);
    if (!budget || budget.spent <= budget.allowance) return;
    if (!budget.dashable) return;

    takeDash(budget.actor, game.combat, budget.combatant);

    const ChatMessage = (globalThis as any).ChatMessage;
    await ChatMessage.create({
      content: `<p>${game.i18n.format("NOODLR.Combat.Movement.Dashed", {
        name: String(doc?.name ?? "?"),
        speed: round(budget.speed),
        units: String((canvas as any)?.scene?.grid?.units ?? ""),
      })}</p>`,
      speaker: { alias: String(doc?.name ?? "") },
    });
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
  return {
    token: String(doc?.name ?? "?"),
    enabled: isMovementCapEnabled(),
    combatStarted: Boolean(game.combat?.started),
    isTheirTurn: String(doc?.combatant?.id ?? "") === String(game.combat?.combatant?.id ?? ""),
    movementAction: String(doc?.movementAction ?? ""),
    historyWaypoints: (doc?.movementHistory ?? []).length,
    spentThisTurn: spentThisTurn(doc),
    dashesTaken: doc?.combatant
      ? dashesTaken(doc.actor, game.combat, doc.combatant)
      : "not in combat",
    budget: budget
      ? {
          speed: budget.speed,
          allowance: budget.allowance,
          dashable: budget.dashable,
          ceiling: budget.allowance + (budget.dashable ? budget.speed : 0),
        }
      : "not applicable — see the flags above for why",
    units: String((canvas as any)?.scene?.grid?.units ?? ""),
  };
}
