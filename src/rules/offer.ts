// Offering a creature its reaction, to whoever plays it, on a six-second clock.
//
// WHAT WAS MISSING. The reaction layer next door has detected its two triggers correctly since v0.4.31,
// and then only ever acted for a creature the GM had handed to the planner: every candidate went through
// `shouldAutomate`, which refuses player characters in every mode and refuses any monster nobody opted in.
// So an opportunity attack was automatic for an automated goblin and did not exist for anybody else — no
// swing, no prompt, no line in the log. A player with War Caster, a Hellish Rebuke, or simply a halberd
// was never told their reaction had come up, which is item 4 of the brief for both audiences.
//
// ASKED ON THE OWNER'S CLIENT, and everything follows from that. The question, the dice and the resource
// all belong to the same person: `rollerForActor` names the player who owns the sheet, and otherwise it is
// the GM's creature and the GM's question. That is the election concentration saves already use, and a
// second one would eventually disagree with it. The far client runs the whole thing — reads the options,
// draws the prompt, spends the reaction, uses the item — so a player's Shield is cast by the player's
// client and signed with their name, rather than the GM's client pressing buttons on their sheet.
//
// THE REQUEST IS UUIDS, NOT OBJECTS, because it crosses a wire. Everything is resolved on arrival and
// re-checked there: the asking client's view of whether a reaction is still available is a moment old by
// the time the answer matters, and the answering client is the one that writes.
//
// AUTOMATED CREATURES ARE NOT ASKED. A monster the GM handed over has a planner to decide for it, and a
// dialog per goblin per departure is the "long chain of approvals" the brief rules out. The offer is for
// the creatures nobody is playing for you.
//
// WHAT IS DELIBERATELY NOT OFFERED — a list that is now empty of the two spells it used to name. Counterspell
// arrived in v0.4.3 through the `casting` trigger, and Silvery Barbs in v0.4.4 through `success`; both of the
// old refusals were about a window that did not exist yet, and both windows exist because the damage and save
// layers hold their verdicts open for the Shield and legendary-resistance questions. What is still unoffered is
// a reaction to an ABILITY CHECK, and that one is honest: nothing here holds a check's verdict open, because a
// check produces information a GM reads rather than a consequence somebody applies.

import { MODULE_ID, log } from "../constants";
import { rollerForActor } from "../util/gm";
import { moduleActive, moduleSetting } from "../util/modules";
import { promptChoice, type Choice } from "../util/prompt";
import { askUser, registerQuery } from "../util/queries";
import { readActions, type CreatureAction } from "../tactics/actions";
import { useActionAt } from "../tactics/execute";
import { hasReaction, spend } from "./economy/ledger";
import { claimOffer, releaseOffer } from "./reaction-once";
import { isReactionPromptEnabled } from "../settings";
import { acBoostOf, isPolearmWeapon, midiPromptsReactions } from "../system/dnd5e-reactions";
import { counterspellReady, isCounterspell, isCounterspellAction } from "../system/dnd5e-counterspell";
import { isSilveryBarbs } from "../system/dnd5e-barbs";
import { readHp } from "../core/tracker";

const QUERY = "reaction";

/** Why the creature is being asked. Each one filters the options and words the sentence differently. */
export type ReactionTrigger = "opportunity" | "enter" | "hurt" | "incoming" | "casting" | "success";

export interface OfferRequest {
  actorUuid: string;
  /** The reacting creature's token, so its own name and side can be read. */
  tokenUuid: string;
  /** Whom the reaction would be aimed at, and whose name goes in the sentence. */
  targetUuid?: string;
  targetName: string;
  trigger: ReactionTrigger;
  /**
   * For `incoming`: how much the attack roll beat the recorded AC by. An AC bonus is only worth offering
   * when it would actually turn the hit into a miss, and the margin is the only way to know that.
   *
   * For `success`: the same number, and it does NOT filter anything — a d20 can move by nineteen, so no
   * margin makes a reroll pointless. It is shown, because "beat it by 1" and "beat it by 12" are the
   * difference between a slot well spent and a slot thrown away, and only the person can weigh that.
   */
  margin?: number;
  /**
   * For `casting`: the spell being cast, so the sentence names what is worth interrupting.
   * For `success`: what the roll was for, which serves the same purpose.
   */
  spell?: string;
}

export interface OfferAnswer {
  taken: boolean;
  /** What was used, for the log and the receipt. */
  label?: string;
  /** Set when the thing taken raises AC, so the asking client can settle the attack again. */
  acBonus?: number;
  /**
   * For `casting`: the save DC the countered creature rolls against.
   *
   * Read on the client that owns the Counterspell, because that is where the spellcasting DC actually
   * lives — the asking client's reading of somebody else's sheet is a copy, and this one decides a contest.
   */
  dc?: number;
}

/** Register the answering half. Must run on EVERY client: the addressee is whoever owns the creature. */
export function registerReactionOffers(): void {
  registerQuery(QUERY, async (data: any) => {
    const request = data?.request as OfferRequest | undefined;
    if (!request?.actorUuid) return { taken: false };
    return await resolveHere(request);
  });
}

/**
 * Should this creature be asked rather than played for it?
 *
 * Kept here so both the reaction layer and the damage layer get one answer. `hasReaction` and the status
 * checks live with the caller, which already had them; this is only the "is anybody home" half.
 */
export function offerable(actor: any, trigger: ReactionTrigger = "opportunity"): boolean {
  if (!isReactionPromptEnabled(actor)) return false;
  // Midi prompts for "I was hit" and "I was damaged" at its stock settings, and for nothing else — not a
  // departure, not an enter-reach, not a cast, not somebody else's good roll. Two dialogs for one hit is
  // the double-ask this whole layer exists to avoid, so those two halves are its; the triggers it never
  // dispatches stay ours.
  if (
    trigger !== "opportunity" &&
    trigger !== "enter" &&
    trigger !== "casting" &&
    trigger !== "success" &&
    midiPromptsReactions()
  )
    return false;
  const owner = rollerForActor(actor);
  if (owner) return true;
  // Nobody owns it, so it is the GM's to answer — provided one is connected to answer with.
  return Boolean((game.users as any)?.activeGM);
}

/**
 * Put the offer to whoever plays this creature and report what they did.
 *
 * A false answer is the normal case and is not a failure: nobody was connected, the clock ran out on a
 * depleting option, or they said no. Callers must treat all three the same way, because from here they
 * are the same thing — no reaction was taken.
 */
export async function offerReaction(actor: any, request: OfferRequest): Promise<OfferAnswer> {
  if (!offerable(actor, request.trigger)) return { taken: false };
  const owner = rollerForActor(actor) ?? String((game.users as any)?.activeGM?.id ?? "");
  if (!owner) return { taken: false };

  // Comfortably longer than the countdown the far client enforces. A transport that gave up first would
  // report "no reaction" while the person was still reading their options, which is the one outcome worse
  // than not asking at all.
  const answer = await askUser<OfferAnswer>(owner, QUERY, { request }, { timeout: 30000 });
  return answer ?? { taken: false };
}

/** Everything from here down runs on the client that owns the creature. */
async function resolveHere(request: OfferRequest): Promise<OfferAnswer> {
  const lock = String(request.actorUuid ?? "");
  // Before any await: two concurrent queries both pass `hasReaction` until the first spend.
  if (!claimOffer(lock)) return { taken: false };

  try {
    return await settleOffer(request);
  } finally {
    releaseOffer(lock);
  }
}

async function settleOffer(request: OfferRequest): Promise<OfferAnswer> {
  const actor: any = await resolve(request.actorUuid);
  if (!actor) return { taken: false };

  const token: any = await resolve(request.tokenUuid);
  const target: any = request.targetUuid ? await resolve(request.targetUuid) : null;

  // Re-checked on the writing client, because the asking client's reading is a moment old and this is the
  // client that will spend the reaction.
  const combatant = combatantFor(token);
  if (!combatant || !hasReaction(combatant)) return { taken: false };

  const options = optionsFor(actor, request, target);
  if (!options.length) return { taken: false };

  const preferred = timeoutChoice(options, request.trigger);
  const choices: Choice[] = options.map((option, index) => ({
    id: String(index),
    label: option.name,
    hint: hintFor(option, request),
  }));
  const nothing = "none";
  choices.push({
    id: nothing,
    label: game.i18n.localize("NOODLRHOOKS.Reaction.Offer.Decline"),
    hint: game.i18n.localize("NOODLRHOOKS.Reaction.Offer.DeclineHint"),
  });

  const picked = await promptChoice({
    title: game.i18n.format("NOODLRHOOKS.Reaction.Offer.Title", {
      name: String(token?.name ?? actor?.name ?? ""),
    }),
    body: sentence(request, token),
    choices,
    defaultId: preferred === null ? nothing : String(options.indexOf(preferred)),
  });
  if (picked === nothing) return { taken: false };

  const chosen = options[Number(picked)];
  if (!chosen) return { taken: false };

  // Spent BEFORE the use, not after: `useActionAt` can take seconds (a targeting confirmation, a roll
  // dialog), and a second trigger arriving in that window would otherwise find the reaction unspent and
  // offer it again. The ledger is turn-stamped, so an over-spend cannot leak into the next round.
  spend(actor, game.combat, combatant, "reaction", false);
  notifyMidi(actor);

  const boost = acBoostOf(chosen.item, actor);
  // Read BEFORE the use, because using the spell spends the slot and a sheet mid-update is a bad place to
  // read a derived number from. The DC decides the contest, so the asking client is told it explicitly
  // rather than left to look it up on a sheet it does not own.
  const dc =
    request.trigger === "casting" ? (counterspellReady(actor)?.dc ?? undefined) : undefined;
  try {
    // A reaction that raises AC is cast on oneself; everything else is pointed at whatever provoked it.
    await useActionAt(chosen, boost ? token : (target ?? token), { asReaction: true });
  } catch (err) {
    log(`reaction offer: ${actor?.name} could not use ${chosen.name}:`, err);
    return { taken: true, label: chosen.name, acBonus: boost?.bonus, dc };
  }
  return { taken: true, label: chosen.name, acBonus: boost?.bonus, dc };
}

/**
 * The reactions worth putting in front of somebody for this trigger.
 *
 * Capped, and sorted before capping. A wizard has a dozen reaction-economy items and a dialog listing all
 * of them in six seconds is not a decision, it is a wall of text — so the most relevant few are offered
 * and the rest are left to the sheet, which is where somebody who wants an unusual one will go anyway.
 */
const MAX_OPTIONS = 4;

function optionsFor(actor: any, request: OfferRequest, target: any): CreatureAction[] {
  const all = readActions(actor).filter((action) => action.available);
  const gap = separation(request, target);

  if (request.trigger === "casting") {
    // Exactly one thing interrupts a cast, and offering anything else alongside it would invite spending a
    // reaction on a swing that does not stop the spell. Range is checked by the asking client against the
    // spell's own 60 feet, so it is not re-checked against a generic reach here.
    return all.filter((action) => isCounterspell(action.item)).slice(0, MAX_OPTIONS);
  }

  if (request.trigger === "success") {
    // One spell spoils a roll, and offering a swing beside it would invite spending a reaction on something
    // that does not touch the die. Range is the spell's own 60 feet, checked by the asking client.
    return all.filter((action) => isSilveryBarbs(action.item)).slice(0, MAX_OPTIONS);
  }

  if (request.trigger === "incoming") {
    // Only things that would change the answer. A +5 offered against an attack that beat the AC by nine is
    // a spell slot spent to be hit anyway, and offering it invites exactly that mistake.
    const margin = Number(request.margin ?? 0);
    return all
      .filter((action) => {
        if (action.economy !== "reaction") return false;
        const boost = acBoostOf(action.item, actor);
        return Boolean(boost && boost.bonus > margin);
      })
      .slice(0, MAX_OPTIONS);
  }

  const reactions = all.filter(
    (action) =>
      action.economy === "reaction" &&
      (action.kind === "attack" || action.kind === "control" || action.kind === "heal") &&
      !isCounterspellAction(action) &&
      reaches(action, gap),
  );

  if (request.trigger === "enter") {
    // Reactive Strike is "make one melee attack with that weapon" — the Quarterstaff, Spear, or
    // Heavy+Reach item, not Unarmed Strike and not the utility activity the feat ships as.
    // Range is not re-tested here: the route walk already decided they entered, and a second
    // centre-to-centre read is the 8-ft-vs-5-ft lie that hid the staff from a Large mover.
    return all
      .filter(
        (action) =>
          action.kind === "attack" &&
          action.melee &&
          (action.economy === "action" || action.economy === "free") &&
          isPolearmWeapon(action.item),
      )
      .sort((a, b) => b.range - a.range)
      .slice(0, MAX_OPTIONS);
  }

  if (request.trigger === "opportunity") {
    // An opportunity attack is not a sheet entry in any system: it is an ordinary melee attack spent as a
    // reaction. So the best melee swing is offered alongside anything the sheet calls a reaction, and it
    // goes first, because it is what the trigger is named after. The swing itself is not range-filtered:
    // they have already left, so a 5 ft weapon would fail a live gap check by construction.
    const swings = all
      .filter(
        (action) =>
          action.kind === "attack" &&
          action.melee &&
          (action.economy === "action" || action.economy === "free"),
      )
      .sort((a, b) => b.range - a.range)
      .slice(0, 1);
    return [...swings, ...reactions].slice(0, MAX_OPTIONS);
  }

  return reactions.slice(0, MAX_OPTIONS);
}

/**
 * What the clock is allowed to pick.
 *
 * The whole rule in one function: a renewing resource may be spent by a timeout, a depleting one may not.
 * A reaction is itself renewing — unspent, it is gone at the end of the round — so a plain swing with a
 * halberd is a free yes. A Shield, a Hellish Rebuke and a limited-use monster ability are all somebody's
 * husbanded resource, and nothing but a person may spend one.
 */
export function timeoutChoice(
  options: CreatureAction[],
  trigger: ReactionTrigger,
): CreatureAction | null {
  // An AC boost always costs something (a slot, a limited use) and is always the difference between being
  // hit and not, so it is exactly the case where the person has to answer. Never defaulted to either way.
  if (trigger === "incoming") return null;
  // Counterspell is a third-level slot, every time, with no free version of itself anywhere. Refused
  // explicitly rather than left to `depleting` below: that field is read off a sheet, and a sheet that
  // reported it wrongly would have a clock spending somebody's slot — which is the one thing the whole
  // default rule exists to prevent.
  if (trigger === "casting") return null;
  // Silvery Barbs is a slot spent on a gamble — the fresh die may be higher and the success stands anyway —
  // which makes it the least defensible thing a clock could ever spend for somebody. Same explicit refusal as
  // Counterspell's, and for the same reason: not left to `depleting`, which is read off a sheet.
  if (trigger === "success") return null;
  return options.find((option) => !option.depleting) ?? null;
}

function hintFor(option: CreatureAction, request: OfferRequest): string {
  const boost = acBoostOf(option.item, null);
  if (boost && request.trigger === "incoming") {
    return game.i18n.format("NOODLRHOOKS.Reaction.Offer.HintAc", { bonus: String(boost.bonus) });
  }
  if (request.trigger === "success" && Number.isFinite(Number(request.margin))) {
    // The number that decides whether this is worth a slot: a reroll has to find this much to spoil the roll.
    return game.i18n.format("NOODLRHOOKS.Reaction.Offer.HintMargin", {
      margin: String(Number(request.margin)),
    });
  }
  return option.depleting
    ? game.i18n.localize("NOODLRHOOKS.Reaction.Offer.HintCosts")
    : game.i18n.localize("NOODLRHOOKS.Reaction.Offer.HintFree");
}

function sentence(request: OfferRequest, token: any): string {
  const key =
    request.trigger === "opportunity"
      ? "NOODLRHOOKS.Reaction.Offer.Leaving"
      : request.trigger === "enter"
        ? "NOODLRHOOKS.Reaction.Offer.Entering"
        : request.trigger === "incoming"
          ? "NOODLRHOOKS.Reaction.Offer.Incoming"
          : request.trigger === "casting"
          ? "NOODLRHOOKS.Reaction.Offer.Casting"
          : request.trigger === "success"
            ? "NOODLRHOOKS.Reaction.Offer.Success"
            : "NOODLRHOOKS.Reaction.Offer.Hurt";
  return game.i18n.format(key, {
    name: String(token?.name ?? ""),
    target: request.targetName,
    spell: String(request.spell ?? ""),
  });
}

/** Can this option reach at all? Unknown separation offers everything rather than nothing. */
function reaches(action: CreatureAction, gap: number | null): boolean {
  if (gap === null) return true;
  return action.range >= gap;
}

function separation(request: OfferRequest, target: any): number | null {
  const from = (target as any)?.object?.center ?? (target as any)?.center;
  if (!from) return null;
  const self = tokenObjectOf(request.tokenUuid);
  if (!self?.center) return null;
  try {
    const measured = (canvas as any)?.grid?.measurePath?.([self.center, from]);
    if (measured?.distance !== undefined) return Number(measured.distance);
  } catch {
    /* gridless and older grid shapes fall through */
  }
  const scale = Number((canvas as any)?.dimensions?.distance ?? 5);
  const size = Number((canvas as any)?.dimensions?.size ?? 100);
  return (Math.hypot(from.x - self.center.x, from.y - self.center.y) / size) * scale;
}

function tokenObjectOf(uuid: string): any {
  try {
    const doc: any = (globalThis as any).fromUuidSync?.(uuid);
    return doc?.object ?? doc ?? null;
  } catch {
    return null;
  }
}

async function resolve(uuid: string): Promise<any> {
  try {
    return await (globalThis as any).fromUuid?.(uuid);
  } catch {
    return null;
  }
}

function combatantFor(token: any): any {
  const id = String(token?.id ?? token?.document?.id ?? "");
  return (game.combat as any)?.combatants?.find?.(
    (c: any) => String(c?.tokenId ?? c?.token?.id ?? "") === id,
  );
}

/** Alive enough to react. Shared with the reaction layer, which had it first. */
export function alive(actor: any): boolean {
  const hp = readHp(actor);
  return !hp || hp.value === null || hp.value > 0;
}

/** Conditions that take a creature's reaction away entirely. */
const CANNOT_REACT = ["incapacitated", "paralyzed", "stunned", "unconscious", "petrified", "dead"];

/**
 * Is this creature in a state where a reaction is legal?
 *
 * A paralysed ogre does not swing at anybody, and letting one do so is the sort of rules break that makes
 * the whole feature untrustworthy. Read from status ids, which every system registers, rather than from a
 * helper belonging to some module.
 */
export function canReact(actor: any): boolean {
  try {
    const statuses: any = actor?.statuses;
    for (const status of CANNOT_REACT) if (statuses?.has?.(status)) return false;
  } catch {
    /* an unreadable status set is not evidence of incapacity */
  }
  return true;
}

/**
 * Mark the reaction spent in our ledger and, where midi is present, in midi's.
 *
 * Not for our own bookkeeping — the ledger is authoritative and works alone — but because midi skips any
 * reaction activity whose owner has spent their reaction, which makes its own prompt suppress itself
 * instead of asking a second time. Silently inert unless the table set midi's Enforce Reactions to All or
 * Display Only (its default is "none", verified in midi 14.0.11 source); harmless either way.
 */
export function notifyMidi(actor: any): void {
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
 * Has another module claimed opportunity attacks?
 *
 * Gambit's Premades implements them properly, and two modules both reacting means the party is hit twice
 * for one departure. It is the only current implementation I know of, and this is a name check rather than
 * a dependency: if it is absent, nothing here changes.
 */
export function opportunityTaken(): boolean {
  if (!moduleActive("gambits-premades")) return false;
  // Unreadable (undefined) defers, because two attacks per departure is worse than none.
  return moduleSetting("gambits-premades", "Opportunity Attack") !== false;
}

export function surveyOffers(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  if (!actor) return { note: "select a token" };
  const owner = rollerForActor(actor);
  return {
    module: MODULE_ID,
    creature: String(token?.name ?? ""),
    promptsEnabled: isReactionPromptEnabled(actor),
    askedOf: owner ? String((game.users as any)?.get?.(owner)?.name ?? owner) : "the GM",
    canReact: canReact(actor),
    reactions: readActions(actor)
      .filter((action) => action.economy === "reaction")
      .map((action) => ({
        name: action.name,
        available: action.available,
        depleting: action.depleting,
        acBonus: acBoostOf(action.item, actor)?.bonus ?? null,
      })),
  };
}
