// "The dragon fails the save" is the one line in a fight that is never mundane.
//
// This is the decision the brief was describing (user, 2026-08-14): not a mundane trigger to be automated
// away, and not a chain of approvals either — a narratively consequential choice, surfaced to the GM, on a
// short clock, with a sensible answer if nobody presses anything. Everything else this module has built
// this week removes a click; this one deliberately adds one, in the one place a click is the point.
//
// IT IS ALSO A REGRESSION WE INTRODUCED, which is why it lands with the layer that caused it. dnd5e draws a
// Resist button on a failed NPC save and waits for a human (see `system/dnd5e-legendary.ts`). That was
// harmless while a human was also applying the damage — the same pause served both. `rules/saves.ts` now
// rolls the save and settles the damage in one breath, so the button arrives on a card whose consequences
// have already happened. Automation that closes a window the system left open is a bug however correct each
// of its pieces is.
//
// THE DEFAULT IS TO DECLINE, and that follows from the rule the whole prompt layer is built on: a timeout
// may spend a renewing resource and never a depleting one. Three resistances a day is the most depleting
// resource in the game. So the clock running out means "the dragon takes it", which is also the outcome
// that happens today on every table where nobody notices the button.
//
// WHICH MEANS THE OFFER ITSELF HAS TO BE RARE TO BE READ. A prompt on every failed save teaches a GM to
// dismiss prompts, and then the one that mattered is dismissed too. So it is only raised where a resistance
// changes something worth changing: a failure that does anything other than damage, or damage that is a
// real share of what the creature has left. A lich is not asked about a Firebolt.
//
// NOT DONE HERE, deliberately: choosing FOR the GM. Whether to spend the second of three resistances on
// this Banishment depends on what the party has left, what is coming, and how the evening is going, none of
// which is readable. The clock picks the safe answer, not the clever one.

import { COMBAT_SETTINGS, MODULE_ID, log } from "../constants";
import { promptChoice } from "../util/prompt";
import {
  canResist,
  currentHp,
  legendaryResistances,
  spendResistance,
} from "../system/dnd5e-legendary";

/**
 * How much of what a creature has left has to be at stake before the GM is asked.
 *
 * A fifth, which is a judgement rather than a rule and is written here so it can be argued with. The
 * reasoning: a resistance is worth roughly a whole round of the creature's own output, so trading one for
 * less than a round's worth of its hit points is a bad trade a GM should not be interrupted to make. Damage
 * that would drop it to zero is asked about regardless of the fraction.
 */
const MATERIAL_FRACTION = 0.2;

/** One failed save that a legendary resistance could still overturn. */
export interface ResistanceCase {
  actor: any;
  /** The failed SAVE message. `forceSuccess` is stamped on this, so it is the one the system needs. */
  message: any;
  /** The creature's name, for the prompt. */
  name: string;
  /** What demanded the save, when we could read it. */
  spell: string;
  /**
   * Hit points a resistance would prevent, or null when the failure does something other than damage.
   *
   * Null is the MORE serious case, not a missing value: a save with no damage attached is Banishment or
   * Hold Monster, and those are exactly the failures a legendary creature spends a resistance on.
   */
  avoided: number | null;
}

/** Is the rule switched on at all? */
export function resistancePromptsEnabled(): boolean {
  try {
    return Boolean(game.settings.get(MODULE_ID, COMBAT_SETTINGS.legendaryResistance));
  } catch {
    return false;
  }
}

/**
 * Offer the resistance, and spend it if it is taken.
 *
 * Resolves false for every reason there is not to ask — switched off, no resistances, not worth it, clock
 * ran out — so a caller has one branch rather than five. Never throws: a prompt that fails must not take the
 * damage with it.
 */
export async function considerResistance(request: ResistanceCase): Promise<boolean> {
  try {
    if (!resistancePromptsEnabled()) return false;
    if (!canResist(request.actor)) return false;
    if (!worthAsking(request.actor, request.avoided)) {
      log(
        `legendary resistance: ${request.name} failed, but ${describeStake(request)} is not worth asking about`,
      );
      return false;
    }

    const left = legendaryResistances(request.actor);
    const answer = await promptChoice({
      title: game.i18n.localize("NOODLRHOOKS.Legendary.Title"),
      body: game.i18n.format("NOODLRHOOKS.Legendary.Body", {
        name: request.name,
        spell: request.spell || game.i18n.localize("NOODLRHOOKS.Legendary.Something"),
        stake: describeStake(request),
      }),
      choices: [
        {
          id: "resist",
          label: game.i18n.localize("NOODLRHOOKS.Legendary.Resist"),
          hint: game.i18n.format("NOODLRHOOKS.Legendary.Remaining", {
            left: String(Math.max(0, (left?.value ?? 1) - 1)),
            max: String(left?.max ?? 0),
          }),
        },
        {
          id: "decline",
          label: game.i18n.localize("NOODLRHOOKS.Legendary.Take"),
          hint: game.i18n.localize("NOODLRHOOKS.Legendary.TakeHint"),
        },
      ],
      defaultId: "decline",
    });
    if (answer !== "resist") return false;

    if (!(await spendResistance(request.actor, request.message))) return false;
    log(`legendary resistance: ${request.name} resists ${request.spell || "it"}`);
    return true;
  } catch (err) {
    log("legendary resistance: the offer failed, so the save stands as rolled:", err);
    return false;
  }
}

/**
 * Is this failure worth a resistance, and therefore worth a prompt?
 *
 * Exported because it is the one judgement in this file rather than a fact, and a judgement should be
 * pinned by a test where it can be argued with.
 *
 * A null stake is always worth asking about: it means the failure does something other than damage, which
 * is Banishment or Hold Monster and is precisely what a resistance exists for. Unknown hit points count as
 * material for the same reason — a creature whose sheet cannot be read is not one to make a silent decision
 * about, and being wrong costs one prompt.
 */
export function worthAsking(actor: any, avoided: number | null): boolean {
  if (avoided === null) return true;
  const stake = Number(avoided);
  if (!Number.isFinite(stake) || stake <= 0) return false;
  const hp = currentHp(actor);
  if (hp === null || hp <= 0) return true;
  return stake >= hp || stake >= hp * MATERIAL_FRACTION;
}

/** The stake, in words, for the prompt and for the log line that explains a declined offer. */
function describeStake(request: ResistanceCase): string {
  if (request.avoided === null) return game.i18n.localize("NOODLRHOOKS.Legendary.StakeEffect");
  return game.i18n.format("NOODLRHOOKS.Legendary.StakeDamage", {
    amount: String(Math.round(Number(request.avoided))),
  });
}

/** For the console: does the selected creature have any, and would a failure be asked about? */
export function surveyLegendary(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  return {
    setting: COMBAT_SETTINGS.legendaryResistance,
    enabled: resistancePromptsEnabled(),
    materialFraction: MATERIAL_FRACTION,
    selected: String(token?.document?.name ?? "— select a token —"),
    resistances: actor ? legendaryResistances(actor) : null,
    canResistNow: actor ? canResist(actor) : null,
    hp: actor ? currentHp(actor) : null,
    askedAboveDamageOf: actor
      ? Math.ceil((currentHp(actor) ?? 0) * MATERIAL_FRACTION) || null
      : null,
  };
}
