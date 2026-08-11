// Talking a creature round: the Influence action, and the attitudes that bend it.
//
// NOBODY ENFORCES ANY OF IT. dnd5e lists `influence`, `indifferent` and `hostile` in
// `CONFIG.DND5E.rules` and none of the three keys is read anywhere outside the config files — the
// coverage report's test for a rule that exists to be linked to and nothing else. The glossary
// entries are journal prose with a `[[/check per]]` enricher in them, which rolls a check and then
// compares it to nothing.
//
// THE LINE THIS DRAWS, and it is the whole design. The rule opens with "The DM then determines
// whether the monster feels willing, unwilling, or hesitant", and that judgement is not automatable:
// its inputs are a conversation, a relationship and a GM's sense of the creature. So it is ASKED,
// every time, and nothing here ever guesses it. What IS automated is everything downstream of the
// answer, all of which is arithmetic the table forgets rather than argues about:
//
//   * a willing creature simply does it, with no check called for;
//   * an unwilling one simply refuses, with no check called for, and — this is the part that gets
//     played wrong — no 24-hour lockout either, because no check was made;
//   * a hesitant one is rolled against DC 15, or its Intelligence score if that is higher;
//   * Friendly gives the roll Advantage, Hostile gives it Disadvantage;
//   * a failed check locks that approach on that creature for a day.
//
// WHY THE LOCKOUT IS WORTH THE CODE. It is the only part of the rule with memory, and memory is
// exactly what a table does not have — "you already tried that" is a ruling a GM has to remember
// across a session, per creature, per approach. It is also the part players lean on hardest, since
// the alternative to enforcing it is a party that persuades the same guard eleven times in a row.
//
// The four verbs this finally fires — PERSUADE, DECEIVE, INTIMIDATE, BRIBE, plus PARLEY for coaxing
// and amusing — have been declared in the behavior contract since the split with nothing triggering
// them. A listener that voices a guard captain's refusal has had nowhere to hear about it until now.

import { GENERAL_SETTINGS, MODULE_ID, log, warn } from "../constants";
import { isInfluenceEnabled } from "../settings";
import { narrator, speakerFor } from "../util/speaker";
import { isPrimaryGM } from "../util/gm";
import { announceRuling, requestBehavior } from "../integration/contract";
import { difficultyBand, generalRulesApply } from "../system/dnd5e-checks";
import {
  APPROACHES,
  approachApplies,
  attitudeOf,
  attitudeSwing,
  influenceDc,
} from "../system/dnd5e-influence";
import type { Approach, Attitude } from "../system/dnd5e-influence";

/** What the GM decided the creature feels about the request. */
export type Stance = "willing" | "hesitant" | "unwilling";

/** A day, in seconds, which is the unit `game.time.worldTime` counts in. */
const LOCKOUT_SECONDS = 24 * 60 * 60;

export interface InfluenceOptions {
  /** The creature doing the talking. */
  by: any;
  /** The creature being talked at. */
  target: any;
  /** Key into `APPROACHES`, or a bare skill id for an approach the table invented. */
  approach?: string;
  /** The GM's ruling. Asked for when omitted. */
  stance?: Stance;
  /** Skip the lockout and the approach gates. The GM's override for a situation the rules missed. */
  force?: boolean;
}

export interface InfluenceResult {
  outcome: "complied" | "refused" | "success" | "failure" | "blocked";
  reason: string;
  dc: number | null;
  total: number | null;
  attitude: Attitude | null;
}

function enabled(): boolean {
  return generalRulesApply() && isInfluenceEnabled();
}

/* -------------------------------------------- */
/*  The 24-hour lockout                          */
/* -------------------------------------------- */

interface Lock {
  /** When the lockout expires, on whichever clock was used. */
  until: number;
  /** "world" or "real" — recorded so the comparison is made against the clock that set it. */
  clock: "world" | "real";
  /** What was tried, for the message. */
  label: string;
}

/**
 * Which clock a lockout is measured on.
 *
 * The rule says 24 hours, and it means in-world hours. `game.time.worldTime` is the honest reading
 * and it is what a table that tracks travel and rests wants. But plenty of worlds never advance the
 * clock at all, and on those a world-time lockout would never expire — a creature refused once in
 * session two would still be refusing in session forty, which reads exactly like a bug.
 *
 * So the clock is chosen when the lock is SET and recorded on it: a world that has advanced its time
 * gets in-world hours, and one that has not gets real ones. Stamping the choice is what makes this
 * safe, since a world that starts tracking time later cannot then compare a real timestamp against a
 * world-time one and conclude the lockout has centuries to run.
 */
function currentClock(): { clock: "world" | "real"; now: number } {
  const worldTime = Number((game as any)?.time?.worldTime);
  if (Number.isFinite(worldTime) && worldTime > 0) return { clock: "world", now: worldTime };
  return { clock: "real", now: Math.floor(Date.now() / 1000) };
}

function locksOn(target: any): Record<string, Lock> {
  const doc = target?.document ?? target;
  try {
    return (doc?.getFlag?.(MODULE_ID, "influenceLocks") ?? {}) as Record<string, Lock>;
  } catch {
    return {};
  }
}

/** Is this approach still shut off on this creature? Returns the lock, or null. */
export function lockFor(target: any, approach: Approach): Lock | null {
  const lock = locksOn(target)[approach.verb];
  if (!lock) return null;
  const { clock, now } = currentClock();
  // A lock set on a different clock than the one running now is honoured only if it has not plainly
  // expired on its own terms; comparing across clocks is meaningless, so a mismatch is let through.
  if (lock.clock !== clock) return null;
  return now < Number(lock.until) ? lock : null;
}

async function setLock(target: any, approach: Approach): Promise<void> {
  const doc = target?.document ?? target;
  const { clock, now } = currentClock();
  const locks = { ...locksOn(target) };
  locks[approach.verb] = {
    until: now + LOCKOUT_SECONDS,
    clock,
    label: approach.label,
  };
  try {
    await doc?.setFlag?.(MODULE_ID, "influenceLocks", locks);
  } catch (err) {
    warn("influence: could not record the 24-hour lockout:", err);
  }
}

/**
 * Lift every lockout on the selected tokens, or on everything when nothing is selected.
 *
 * "(or a duration set by the DM)" is in the rule itself, and this is that duration made operable
 * without a setting nobody would find: the GM decides the party has waited long enough and says so.
 */
export async function clearInfluenceLocks(): Promise<number> {
  const selected: any[] = (canvas as any)?.tokens?.controlled ?? [];
  const tokens = selected.length ? selected : ((canvas as any)?.tokens?.placeables ?? []);
  let cleared = 0;
  for (const token of tokens) {
    if (Object.keys(locksOn(token)).length === 0) continue;
    try {
      await (token.document ?? token)?.unsetFlag?.(MODULE_ID, "influenceLocks");
      cleared += 1;
    } catch (err) {
      warn(`influence: could not clear the lockouts on ${String(token?.name)}:`, err);
    }
  }
  log(`influence: cleared lockouts on ${cleared} creature(s)`);
  return cleared;
}

/* -------------------------------------------- */
/*  Attitude                                     */
/* -------------------------------------------- */

/**
 * Pin an attitude on a creature, overruling what its token disposition implies.
 *
 * Written to the token rather than the actor deliberately: attitude is a stance this particular
 * guard holds toward this particular party, and writing it to the actor would make every future copy
 * of that guard start out already won over.
 */
export async function setAttitude(token: any, attitude: Attitude): Promise<void> {
  await (token?.document ?? token)?.setFlag?.(MODULE_ID, "attitude", attitude);
  log(`influence: ${String(token?.name)} is now ${attitude}`);
}

/* -------------------------------------------- */
/*  The action                                   */
/* -------------------------------------------- */

/** Ask the GM what the creature feels about the request. */
async function askStance(target: any, approach: Approach): Promise<Stance | null> {
  const DialogV2: any = (foundry as any)?.applications?.api?.DialogV2;
  const question = game.i18n.format("NOODLRHOOKS.General.Influence.Ask", {
    name: String(target?.name ?? "?"),
    approach: approach.label,
  });
  if (typeof DialogV2?.wait !== "function") {
    // No dialog API is not a reason to refuse the roll. Hesitant is the branch the rule spends all
    // its text on and the only one that involves dice, so it is the right thing to assume.
    return "hesitant";
  }
  try {
    const answer = await DialogV2.wait({
      window: { title: game.i18n.localize("NOODLRHOOKS.General.Influence.Title") },
      content: `<p>${question}</p>`,
      buttons: [
        {
          action: "willing",
          label: game.i18n.localize("NOODLRHOOKS.General.Influence.Willing"),
        },
        {
          action: "hesitant",
          label: game.i18n.localize("NOODLRHOOKS.General.Influence.Hesitant"),
          default: true,
        },
        {
          action: "unwilling",
          label: game.i18n.localize("NOODLRHOOKS.General.Influence.Unwilling"),
        },
      ],
      rejectClose: false,
      modal: true,
    });
    if (answer === "willing" || answer === "hesitant" || answer === "unwilling") return answer;
  } catch {
    /* a closed dialog is the GM declining to rule, which is a cancellation, not a hesitant */
  }
  return null;
}

/**
 * Make an Influence attempt.
 *
 * The roll is a real Foundry skill check on the influencing creature's own sheet, with the attitude's
 * Advantage or Disadvantage passed to it — never a number invented here, and never a flat roll that
 * the GM is then asked to remember to modify.
 */
export async function influence(options: InfluenceOptions): Promise<InfluenceResult> {
  const { by, target } = options;
  const none: InfluenceResult = {
    outcome: "blocked",
    reason: "",
    dc: null,
    total: null,
    attitude: null,
  };
  if (!by?.actor || !target?.actor) {
    return { ...none, reason: "select who is talking and target who is being talked to" };
  }
  if (!enabled()) return { ...none, reason: "the Influence layer is off" };

  const approach = APPROACHES[String(options.approach ?? "persuade")] ?? APPROACHES.persuade;
  const reading = attitudeOf(target);

  if (!options.force) {
    const applies = approachApplies(approach, target.actor);
    if (!applies.ok) {
      return { ...none, reason: applies.reason, attitude: reading.attitude };
    }
    const lock = lockFor(target, approach);
    if (lock) {
      return {
        ...none,
        attitude: reading.attitude,
        reason: game.i18n.format("NOODLRHOOKS.General.Influence.Locked", {
          approach: approach.label,
          name: String(target?.name ?? "?"),
        }),
      };
    }
  }

  const stance = options.stance ?? (await askStance(target, approach));
  if (!stance) return { ...none, attitude: reading.attitude, reason: "no ruling was given" };

  // The two branches with no dice in them. Note that an unwilling refusal sets no lockout: the rule
  // hangs the 24 hours on "a failed check", and no check was made.
  if (stance === "willing") {
    const result: InfluenceResult = {
      outcome: "complied",
      reason: game.i18n.localize("NOODLRHOOKS.General.Influence.WillingReason"),
      dc: null,
      total: null,
      attitude: reading.attitude,
    };
    await report(by, target, approach, reading.attitude, result);
    return result;
  }
  if (stance === "unwilling") {
    const result: InfluenceResult = {
      outcome: "refused",
      reason: game.i18n.localize("NOODLRHOOKS.General.Influence.UnwillingReason"),
      dc: null,
      total: null,
      attitude: reading.attitude,
    };
    await report(by, target, approach, reading.attitude, result);
    return result;
  }

  const dc = influenceDc(target.actor);
  const swing = attitudeSwing(reading.attitude);

  let total: number | null = null;
  try {
    const rolls: any[] =
      (await by.actor.rollSkill({
        skill: approach.skill,
        advantage: swing.advantage,
        disadvantage: swing.disadvantage,
      })) ?? [];
    const value = Number(rolls?.[0]?.total);
    total = Number.isFinite(value) ? value : null;
  } catch (err) {
    warn(`influence: could not roll ${approach.label} for ${String(by?.name)}:`, err);
    return { ...none, attitude: reading.attitude, reason: "the check could not be rolled" };
  }
  if (total === null) {
    return { ...none, attitude: reading.attitude, reason: "the roll was cancelled" };
  }

  // Meets it beats it, the same convention the stealth contest uses.
  const succeeded = total >= dc;
  if (!succeeded) await setLock(target, approach);

  const result: InfluenceResult = {
    outcome: succeeded ? "success" : "failure",
    reason: game.i18n.format(
      succeeded
        ? "NOODLRHOOKS.General.Influence.SuccessReason"
        : "NOODLRHOOKS.General.Influence.FailureReason",
      { total: String(total), dc: String(dc) },
    ),
    dc,
    total,
    attitude: reading.attitude,
  };
  await report(by, target, approach, reading.attitude, result);
  return result;
}

/**
 * Post the outcome, then offer it to anyone who can voice the creature's answer.
 *
 * In that order on purpose. The card is the mechanical record and has to land whether or not anything
 * is listening; the behavior request is the optional half, and a narrator that rewrites the guard's
 * refusal into dialogue is adding to a ruling that has already been made rather than making it.
 */
async function report(
  by: any,
  target: any,
  approach: Approach,
  attitude: Attitude,
  result: InfluenceResult,
): Promise<void> {
  const swing = attitudeSwing(attitude);
  const detail: Record<string, unknown> = {
    approach: approach.label,
    skill: approach.skill,
    attitude,
    advantage: swing.advantage,
    disadvantage: swing.disadvantage,
    dc: result.dc,
    total: result.total,
    outcome: result.outcome,
    band: result.dc === null ? null : difficultyBand(result.dc),
  };

  const summary = game.i18n.format("NOODLRHOOKS.General.Influence.Summary", {
    by: String(by?.name ?? "?"),
    approach: approach.label,
    name: String(target?.name ?? "?"),
    reason: result.reason,
  });

  try {
    const ChatMessage = (globalThis as any).ChatMessage;
    await ChatMessage.create({
      content: `<p>${foundry.utils.escapeHTML(summary)}</p>`,
      speaker: speakerFor(by) ?? narrator(),
      flags: { [MODULE_ID]: { influence: detail } },
    });
  } catch (err) {
    warn("influence: could not post the result:", err);
  }

  await announceRuling({
    kind: "influence",
    summary,
    detail,
    actor: target.actor,
    token: target,
    combat: game.combat,
  });

  // `incoming`, because the creature whose voice is wanted is the one being leaned on rather than
  // the one doing the leaning. Handing over `by` instead would name a player character as the
  // speaker, and noodlr voices NPCs.
  await requestBehavior({
    verb: approach.verb,
    actor: target.actor,
    token: target,
    target: by,
    incoming: true,
    context: { ...detail, by: String(by?.name ?? "?") },
  });
}

/* -------------------------------------------- */
/*  Diagnostics                                  */
/* -------------------------------------------- */

/** What an Influence attempt against each target would face right now. */
export function surveyInfluence(): unknown {
  const by: any = (canvas as any)?.tokens?.controlled?.[0];
  const targets = Array.from((game.user?.targets ?? []) as Set<any>);
  const clock = currentClock();

  const rows = targets.map((target: any) => {
    const reading = attitudeOf(target);
    const swing = attitudeSwing(reading.attitude);
    const dc = influenceDc(target.actor);
    return {
      target: String(target?.name ?? "?"),
      attitude: reading.attitude,
      attitudeFrom: reading.source,
      dc,
      band: difficultyBand(dc),
      rollsWith: swing.advantage ? "advantage" : swing.disadvantage ? "disadvantage" : "straight",
      approaches: Object.entries(APPROACHES).map(([key, approach]) => ({
        key,
        skill: approach.skill,
        applies: approachApplies(approach, target.actor),
        lockedUntil: lockFor(target, approach)?.until ?? null,
      })),
    };
  });

  const report = {
    enabled: enabled(),
    setting: GENERAL_SETTINGS.influence,
    by: String(by?.name ?? "— select the creature doing the talking —"),
    clock,
    targets: rows.length ? rows : "— target the creatures being talked to —",
    // Stated rather than left implicit, because it is the boundary the whole design turns on.
    notAutomated: [
      "willing / hesitant / unwilling — the GM is asked every time and nothing guesses it",
      "whether a hostile creature is beyond persuading at all, which the glossary leaves to the GM",
    ],
  };
  log("influence survey", report);
  return report;
}

/** GM entry point: influence every targeted creature with the selected one. */
export async function influenceTargets(
  options: Omit<InfluenceOptions, "by" | "target"> = {},
): Promise<unknown> {
  if (!isPrimaryGM() && !game.user?.isGM) {
    return { error: "the GM rules on this one" };
  }
  const by: any = (canvas as any)?.tokens?.controlled?.[0];
  const targets = Array.from((game.user?.targets ?? []) as Set<any>);
  if (!by || targets.length === 0) {
    return { error: "select who is talking and target who is being talked to" };
  }
  const results: Record<string, InfluenceResult> = {};
  for (const target of targets) {
    results[String(target?.name ?? "?")] = await influence({ ...options, by, target });
  }
  return results;
}
