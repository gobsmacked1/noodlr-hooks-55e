// The 2024 PHB action items that only DECLARE an action something else pays for. D&D 5e ONLY.
//
// The 2024 Player's Handbook module ships the actions as ordinary feat items with real activations, so a
// character sheet and Argon's action bar can offer them as buttons. Most of them are complete in
// themselves — pressing Dodge IS dodging, and charging an Action for it is exactly right.
//
// Two are not. `Attack` and `Magic` announce what you are about to do, and then you do it with something
// else: the weapon's own attack activity, or the spell. Each of those claims an Action in its own right,
// so the button and the follow-through were charged separately and a single swing cost two Actions —
// which for anyone without Extra Attack means the first attack of the turn is refused.
//
// Measured rather than reasoned about (`api.surveyActions()` over the user's world): all four characters
// carry `attack` claiming an action off a `utility` activity, and `magic` claiming one off each of its
// Spell, Magic Item and Ritual activities.
//
// THIS IS THE THIRD TIME THE SAME SHAPE HAS BITTEN, so the general rule is worth stating plainly: whenever
// a layer infers a resource spend from behaviour, check whether the world also has a BUTTON for it. Dash
// was the first (v0.4.48 — the movement charged, and so did the item), Hide the second, and the cause each
// time was a world with the PHB action items installed, which is most of them.
//
// WHY CHARGE NOTHING HERE, rather than charge here and make the follow-through free. Two reasons. The
// ledger already models the Attack action correctly on its own: the first attack roll buys the Action and
// the rest of `attacksPerAction` rides along on it, so a fighter with Extra Attack comes out right without
// anybody counting declarations. And a declaration is not a commitment — someone who presses Attack and
// then thinks better of it has spent nothing, which is the generous direction, and the one this module
// takes everywhere else in the economy.

import { isDnd5e } from "./dnd5e-rewards";
import { hasFlag } from "../util/flags";

/**
 * Set this on an item (or via an Active Effect) to declare it an announcement rather than an action.
 *
 * Read under this module's namespace and under `noodlr` — see util/flags.ts.
 */
const FLAG_KEY = "actionDeclaration";

interface Declaration {
  label: string;
  /** `system.identifier` values, as the Player's Handbook module authors them. */
  identifiers: string[];
  /** Matched against the item's name when it states no identifier. */
  pattern: RegExp;
}

/**
 * Buttons whose cost is paid by whatever the player does next.
 *
 * Deliberately absent, and each for its own reason:
 *
 *   Dash. Also charged twice, and already handled — but it cannot simply be skipped, because whoever
 *   charges it has to record the Dash itself so the movement cap knows the extra Speed is paid for.
 *   `isDashActivity` routes it to `takeDash` instead. See system/dnd5e-dash.ts.
 *
 *   Hide. Our own toolbar button bills a slot and so does the item, but they are two ways of pressing
 *   one thing rather than two charges for one press: whichever the player uses, exactly one Action goes.
 *
 *   Dodge, Disengage, Help, Ready, Search, Study, Influence, Stabilize. Complete actions in themselves,
 *   with no follow-through to charge, so the button is the right place to bill them.
 *
 * Known imperfection, left alone: a readied attack is the Reaction that the Ready action bought, but it
 * reaches the ledger as an ordinary attack claiming an Action, so a player who readies and then fires
 * looks over budget and gets asked. Nothing distinguishes a readied use from a normal one, and guessing
 * would be worse than the occasional prompt.
 */
const DECLARATIONS: Declaration[] = [
  { label: "Attack (PHB action item)", identifiers: ["attack"], pattern: /^attack$/i },
  { label: "Magic (PHB action item)", identifiers: ["magic"], pattern: /^magic$/i },
];

/**
 * Is pressing this only an announcement, charged by the weapon or spell that follows?
 *
 * Returns a label so a caller can say which rule it applied, or null. Takes the item, because that is
 * where the identifier and the flag live; the activity is accepted so a caller holding only one can
 * reach the item through it.
 */
export function actionDeclarationOf(item: any, activity?: any): string | null {
  // Gated here rather than at every call site, so a system-agnostic caller can ask the question without
  // knowing whose rules answer it. On another game system this returns null for everything.
  if (!isDnd5e()) return null;
  const owner = item ?? activity?.item ?? null;
  if (!owner) return null;
  if (hasFlag(owner, FLAG_KEY)) return String(owner?.name ?? "an action declaration");

  // Both the identifier and the name are matched only on FEATURES, which is tighter than the damage-rider
  // table and deliberately so. "Attack" and "Magic" are generic enough to be a homebrew weapon or a
  // scroll, and exempting one of those would not merely miss a rider — it would make that weapon free to
  // use every turn, forever, with nothing anywhere reporting it.
  if (String(owner?.type ?? "") !== "feat") return null;

  const identifier = String(owner?.system?.identifier ?? "")
    .trim()
    .toLowerCase();
  const name = String(owner?.name ?? "").trim();

  for (const declaration of DECLARATIONS) {
    if (identifier && declaration.identifiers.includes(identifier)) return declaration.label;
    // Only when the sheet states no identifier, so a world that deliberately re-identified a feature is
    // not overruled by what it happens to be called. Same discipline as the rider and Dash tables.
    if (!identifier && name && declaration.pattern.test(name)) return declaration.label;
  }
  return null;
}

export function isActionDeclaration(item: any, activity?: any): boolean {
  return actionDeclarationOf(item, activity) !== null;
}
