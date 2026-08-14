// Spoiling somebody else's success.
//
// Silvery Barbs was refused twice, and both refusals named the same missing thing: "it needs a d20 we did not
// roll to be rerolled after the fact", and an offer that cannot be honoured spends a slot and changes nothing.
// Neither half of that is missing any more, and neither was built for this spell:
//
//   1. THE VERDICT IS HELD. `readHits` answers "did that connect" and `readSave` answers "did that save", and
//      both of those answers are now held open through a window while somebody is asked about a reaction —
//      the Shield window in `rules/damage.ts` and the legendary-resistance window in `rules/saves.ts`. A
//      reaction that needs to change a verdict needs somewhere to stand between the roll and its
//      consequences, and that is what those two windows are.
//   2. THE DIE CAN BE MADE WORSE HONESTLY. `system/dnd5e-reroll.ts` appends a second result and strikes out
//      the loser, which is the shape dnd5e already draws for disadvantage — so `isCritical` comes right by
//      itself and the card stops claiming the first die is what happened.
//
// WHAT IS AUTOMATED IS THE REROLL, NOT THE WHOLE SPELL. "Then one creature you can see gains Advantage on its
// next attack roll, ability check, or saving throw" is a promise about a roll nobody has made yet, which is
// the same thing that keeps the Help action unbuilt: there is nothing to hang it on. Where the table's copy of
// the spell carries an Active Effect for it, using the item applies it exactly as the sheet says — the
// reaction goes through the ordinary activity pipeline, so anything authored on it happens.
//
// TWO OF THE THREE d20 TESTS. Attack rolls and saving throws are offered; ability checks are not, because
// nothing in this module holds a check's verdict open. A check produces information a GM interprets, and there
// is no consequence pending for a window to stand in front of. Stated rather than silent: a player whose
// Silvery Barbs never fires on a Stealth check is owed the reason.
//
// IN COMBAT ONLY, and the reaction ledger is why, exactly as with Counterspell. Outside a fight there is
// nothing to stop one creature spoiling every roll in a scene, and a rule that cannot count the resource it
// spends should not pretend to.

import { COMBAT_SETTINGS, MODULE_ID, log } from "../constants";
import { speakerFor } from "../util/speaker";
import { isBarbsEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import { barbsReady, gambitsOwnsBarbs, type BarbsReady } from "../system/dnd5e-barbs";
import { rerollLower, type Reroll } from "../system/dnd5e-reroll";
import { hasReaction } from "./economy/ledger";
import { offerReaction } from "./offer";
import { combatantFor, reactorsAgainst, tokenOf, type Reactor } from "./candidates";

/**
 * How many creatures are asked before the success stands.
 *
 * One, and this is a tighter cap than Counterspell's two. Barbs fires on every hit and every made save, which
 * is the busiest pair of events in a fight, so the delay budget is far smaller than for a cast — and unlike a
 * counter-the-counterspell chain there is nothing to be gained by a second ask: the die has already been
 * rerolled, and RAW a second Barbs on the same test does nothing.
 */
const MAX_ASKED = 1;

/** Successes currently held open, so two events about one roll cannot open two windows. */
const holding = new Set<string>();

/** A d20 test that has just succeeded, and what it takes to be a success. */
export interface Spoilable {
  /** "attack" or "save", for the sentence and for how the verdict is recomputed. */
  kind: "attack" | "save";
  /** The message carrying the die, which is what gets rewritten. */
  message: any;
  /** The creature that rolled it, and whose success is at stake. */
  roller: any;
  /** The AC it beat, or the DC it met. */
  against: number;
  /** What the roll was for, for the announcement. */
  source: string;
  /**
   * Only for keying the guard: an attack against several targets is one d20 and one question, and a save is
   * per creature, so the pair (message, victim) is what identifies a distinct success.
   *
   * Deliberately NOT the creature the spell is cast on. That is `roller`, and pointing Barbs at the victim is
   * the natural mistake here — it would offer the reaction to the wrong side of the table, i.e. to the
   * attacker's allies, who have no interest in spoiling their own side's hit.
   */
  victim?: any;
}

/** Whether the roll still succeeds, and what it cost to find out. */
export interface Spoiled {
  /** True when somebody cast the spell, whatever the dice then did. */
  taken: boolean;
  /** True when the test no longer succeeds. This is the only field a caller has to act on. */
  fails: boolean;
}

const UNTOUCHED: Spoiled = { taken: false, fails: false };

function active(actor: any): boolean {
  if (!isDnd5e()) return false;
  if (!isBarbsEnabled(actor)) return false;
  // Gambit's Premades implements both halves of this spell wherever midi is there to carry it. Two windows on
  // one success would ask twice and could reroll twice.
  if (gambitsOwnsBarbs()) return false;
  return true;
}

/**
 * Offer Silvery Barbs against a success, and report whether it still stands.
 *
 * Never throws, and a thrown-away answer is always "the success stands". A reaction is a nice-to-have; losing
 * a hit to our own bug is not, and the caller is mid-way through applying damage.
 */
export async function considerBarbs(spoilable: Spoilable): Promise<Spoiled> {
  try {
    return await run(spoilable);
  } catch (err) {
    log("silvery barbs: the window could not be opened, so the roll stands:", err);
    return UNTOUCHED;
  }
}

async function run(spoilable: Spoilable): Promise<Spoiled> {
  const actor = spoilable.roller?.actor ?? spoilable.roller?.document?.actor;
  if (!active(actor)) return UNTOUCHED;

  const combat: any = game.combat;
  if (!combat?.started) return UNTOUCHED;

  const key = `${String(spoilable.message?.id ?? "")}:${String(spoilable.victim?.id ?? "")}`;
  if (holding.has(key)) return UNTOUCHED;

  // Nothing to spoil: a fumble is already a failure, and a roll with no readable die cannot be rerolled.
  if (!Number.isFinite(spoilable.against)) return UNTOUCHED;

  const candidates = barbers(spoilable.roller, actor, combat);
  if (!candidates.length) return UNTOUCHED;

  holding.add(key);
  try {
    return await ask(spoilable, candidates);
  } finally {
    holding.delete(key);
  }
}

type Candidate = Reactor<BarbsReady>;

/**
 * Who could spoil this roll?
 *
 * The seven shared questions are `reactorsAgainst`, the same ones Counterspell asks. What is specific here is
 * only the readiness check — and the SUBJECT, which is the creature that rolled well rather than whoever it
 * rolled against. "When a creature you can see succeeds" puts the spell on the successful creature, so the
 * side that gets asked is the side opposed to it.
 */
function barbers(rollerToken: any, rollerActor: any, combat: any): Candidate[] {
  return reactorsAgainst({
    subjectToken: rollerToken,
    subjectActor: rollerActor,
    combat,
    trigger: "success",
    label: "silvery barbs",
    max: MAX_ASKED,
    ready: (actor) => barbsReady(actor),
    range: (ready) => ready.range,
  });
}

async function ask(spoilable: Spoilable, candidates: Candidate[]): Promise<Spoiled> {
  for (const candidate of candidates) {
    const answer = await offerReaction(candidate.actor, {
      actorUuid: String(candidate.actor?.uuid ?? ""),
      tokenUuid: String(candidate.token?.document?.uuid ?? candidate.token?.uuid ?? ""),
      targetUuid: String(
        spoilable.roller?.document?.uuid ?? spoilable.roller?.uuid ?? "",
      ),
      targetName: String(spoilable.roller?.name ?? ""),
      trigger: "success",
      spell: spoilable.source,
      // The margin is how much room there is to spoil. Offered whatever it is — a d20 can move by nineteen —
      // but it is the one number that tells the person whether this is worth a slot.
      margin: spoilable.against === null ? undefined : marginOf(spoilable),
    });
    if (!answer.taken) continue;

    const reroll = await rerollLower(spoilable.message);
    if (!reroll) {
      await announce(spoilable, candidate, null);
      return { taken: true, fails: false };
    }
    const fails = nowFails(spoilable, reroll);
    await announce(spoilable, candidate, reroll, fails);
    return { taken: true, fails };
  }
  return UNTOUCHED;
}

/** How much the roll beat what it needed, so the person deciding knows how much a reroll has to find. */
function marginOf(spoilable: Spoilable): number | undefined {
  const total = Number(spoilable.message?.rolls?.[0]?.total);
  if (!Number.isFinite(total)) return undefined;
  return total - spoilable.against;
}

/**
 * Does the test still succeed?
 *
 * The two answers are genuinely different rules and getting them the same way round would be wrong in a way
 * nobody would notice at the table:
 *
 *   attack — the die decides before the number does. A kept 1 misses whatever the modifiers say, a kept 20
 *            hits whatever the AC is, and only in between does the total matter. That is `readHits`'s own
 *            arithmetic, which is why the crit and fumble thresholds travel on the reroll rather than being
 *            assumed to be 20 and 1.
 *   save   — the number is all there is. A natural 20 on a saving throw does NOT automatically succeed in 5e,
 *            and a natural 1 does not automatically fail; that rule belongs to attack rolls and to nothing
 *            else. So a save is a bare comparison against the DC, exactly as `readSave` does it.
 */
function nowFails(spoilable: Spoilable, reroll: Reroll): boolean {
  if (spoilable.kind === "attack") {
    if (reroll.crit === true) return false;
    if (reroll.fumble === true) return true;
    return reroll.total < spoilable.against;
  }
  return reroll.total < spoilable.against;
}

/**
 * Say what happened, publicly.
 *
 * Public because everybody at the table watched the hit land and then not land, and because the alternative —
 * a hit that quietly becomes a miss — is the single most confusing thing this module could do. Signed with the
 * caster's token, so the card names who paid for it.
 */
async function announce(
  spoilable: Spoilable,
  candidate: Candidate,
  reroll: Reroll | null,
  fails = false,
): Promise<void> {
  const ChatMessage: any = (globalThis as any).ChatMessage;
  const key = !reroll
    ? "NOODLRHOOKS.Barbs.Unrolled"
    : fails
      ? "NOODLRHOOKS.Barbs.Spoiled"
      : "NOODLRHOOKS.Barbs.Held";
  try {
    await ChatMessage.create({
      speaker: speakerFor(candidate.token),
      flags: { [MODULE_ID]: { barbs: fails ? "spoiled" : "held" } },
      content: `<p><strong>${game.i18n.localize("NOODLRHOOKS.Barbs.Name")}</strong> — ${game.i18n.format(
        key,
        {
          caster: String(candidate.token?.name ?? candidate.actor?.name ?? ""),
          name: String(spoilable.roller?.name ?? ""),
          was: String(reroll?.was ?? "?"),
          rolled: String(reroll?.rolled ?? "?"),
          total: String(reroll?.total ?? "?"),
        },
      )}</p>`,
    });
  } catch (err) {
    log("silvery barbs: could not announce the reroll:", err);
  }
}

export function surveyBarbs(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  const combat: any = game.combat;
  return {
    setting: COMBAT_SETTINGS.barbs,
    enabled: actor ? isBarbsEnabled(actor) : null,
    gambitsOwns: gambitsOwnsBarbs(),
    holding: holding.size,
    selected: actor
      ? {
          name: String(token?.name ?? ""),
          ready: barbsReady(actor) ? "yes" : "no",
          reaction: combat ? hasReaction(combatantFor(combat, tokenOf(actor))) : null,
        }
      : "select a token",
  };
}
