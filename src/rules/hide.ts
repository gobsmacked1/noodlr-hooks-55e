// Taking the Hide action, which Foundry has no way to do.
//
// dnd5e ships no Hide action item. Rogues get one inside Cunning Action, a Shadow gets Shadow Stealth and
// a goblin gets Nimble Escape — each an activity that stamps the `hiding` status and rolls nothing — but a
// fighter who steps behind a pillar has no button anywhere in the interface. Since v0.4.43 the status is
// the declaration that makes a creature contested, so "no button" would mean "most of the party can never
// hide", which is worse than the bug we just fixed. This is that button.
//
// WHAT IT ENFORCES, from the 2024 glossary entry verbatim: "you must succeed on a Dexterity (Stealth)
// check DC 15 while you're Heavily Obscured or behind Three-Quarters Cover or Total Cover, and you must be
// out of any enemy's line of sight". Under legacy rules none of that exists — 2014's Hide entry defers the
// whole question to the GM — so the prerequisites and the DC are skipped and any roll becomes the DC.
//
// HOW THE PREREQUISITE IS ACTUALLY TESTED, and why it is per-enemy. The rules read as one global condition
// plus a line-of-sight clause, but every term in them is relative to a particular observer: you are behind
// cover *from someone*, and fog is between you and *someone*. So each enemy is asked separately whether
// this creature is beyond its reach of sight, and all of them must say yes. A guard you are standing in
// front of stops the whole thing, which is exactly what the rule intends.
//
// THE FIRST QUESTION IS WHETHER THE ENEMY CAN SEE YOU AT ALL, and getting that wrong made this check
// useless outdoors (reported from play, fixed v0.4.1). Until then "out of any enemy's line of sight" was
// implemented as "no wall blocks the line", which is not the same clause: a creature a hundred feet away
// in unlit woodland, whose darkvision reaches sixty, has no line of sight to anybody however few walls are
// in the way. The symptom was a rogue refused a hide "in plain view of" nine hostiles that the perception
// sweep had — correctly, using detection modes, ranges, light and darkness — decided could not see them,
// which is why no fight had started. Two parts of one module answering "can X see Y" differently is a bug
// whichever answer is right, so the question now goes to `rules/perception.ts` and this file only judges
// cover and screens for the enemies that vision says are genuinely watching.
//
// Cover is estimated by counting how many of the creature's corners an observer cannot draw a line to.
// Three of four is three-quarters, four of four is total. That is an approximation of a rule 5e states in
// terms of how much of the target is obscured, and it is the same approximation every cover module makes,
// because Foundry models no such quantity. It is stated here rather than hidden so nobody later mistakes
// it for exact.
//
// A GM can always overrule the check. `force` skips the prerequisites and the action cost while keeping
// the roll, because the interesting failure is a table that cannot hide in a situation the rules did not
// anticipate — a rafter, a crowd, a dust storm — and a hard refusal there is a worse experience than a
// permissive one.
//
// WHAT IT COSTS. An Action, or a bonus action for anything with Cunning Action, Nimble Escape or Shadow
// Stealth. Until v0.4.48 it cost nothing at all, which the census caught: a world carrying the 2024 PHB
// action items has a `Hide` feature that claims a real Action, so the two routes to the same outcome were
// priced differently and this was the free one.
//
// Unlike the activity veto in `economy/enforce.ts`, a creature with nothing left to spend is refused
// outright rather than asked. That is a deliberate divergence: the dialog there exists for features that
// legitimately break the general rule, and the ones that matter — Haste and its relatives — already work
// by raising the allowance through `flags.noodlr.extraAction`, so they never reach a refusal. Anything
// stranger than that is what `force` is for.

import { log, MODULE_ID } from "../constants";
import { narrator, speakerFor } from "../util/speaker";
import { tokenFor } from "../util/tokens";
import { affordable, payBill, slotLabel, turnBill, type TurnBill } from "./economy/bill";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  bonusHideSource,
  HIDING_STATUS,
  hideDc,
  hidesWithAdvantage,
  isHideActivity,
  rulesVersion,
} from "../system/dnd5e-stealth";
import { blocked, centerOf } from "../core/positioning";
import { screensBetween } from "../core/screens";
import { observersWhoSee } from "./perception";
import { reveal } from "./stealth";

/** Why a creature may or may not hide right now. */
export interface HideCheck {
  allowed: boolean;
  /**
   * Plain-language reason, safe to show the whole table.
   *
   * Deliberately says nothing about WHO is watching. The first version named every enemy that could see
   * the creature, and a player pressing Hide in a scene of nine hostiles was handed the entire roster —
   * names, count and creature types — by a failed action. That is a spoiler dressed as an error message,
   * and worse than an unhelpful one, because a player cannot un-know it.
   */
  reason: string;
  /** The same answer with the watchers named, for the GM's whisper and the console survey. */
  detail: string;
}

/** The outcome of actually taking the action. */
export interface HideResult {
  hidden: boolean;
  total: number | null;
  dc: number | null;
  /** Safe for the table. */
  reason: string;
  /** The same outcome with the watchers named, whispered to the GM. */
  detail: string;
}

/**
 * Is a fight actually running on this scene?
 *
 * By scene, not `game.combat` — that is the tracker's current selection, which is interface state and can
 * name an encounter on a scene nobody is looking at. Skulker's Fog of War turns on this answer.
 */
function fightIsOn(): boolean {
  const sceneId = String((canvas as any)?.scene?.id ?? "");
  if (!sceneId) return false;
  const combat: any = (game.combats as any)?.find?.((c: any) => String(c?.scene?.id) === sceneId);
  return Boolean(combat?.started);
}

/** What taking the Hide action costs, and who to bill. */
interface HideCost {
  bill: TurnBill | null;
  /** The feature that makes the bonus action legal, for the log. Empty on the ordinary Action path. */
  source: string;
}

/**
 * What Hide costs this creature right now. A null `bill` means nothing is charged — see `turnBill`.
 *
 * The bonus action wins when something grants it, falling back to the Action once it is gone: Hide
 * remains legal as an Action for everybody.
 */
function hideCost(token: any): HideCost {
  const actor = token?.actor;
  const source = actor ? bonusHideSource(actor) : "";
  if (source) {
    const bonus = turnBill(actor, "bonus");
    if (affordable(bonus)) return { bill: bonus, source };
  }
  return { bill: turnBill(actor, "action"), source: "" };
}

/** Creatures this one is trying not to be seen by: anything of the opposing disposition. */
function enemiesOf(token: any): any[] {
  const HOSTILE = (globalThis as any).CONST?.TOKEN_DISPOSITIONS?.HOSTILE ?? -1;
  const FRIENDLY = (globalThis as any).CONST?.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1;
  const mine = Number(token?.document?.disposition ?? 0);
  const theirs = mine === HOSTILE ? [FRIENDLY] : [HOSTILE];
  const defeated = (globalThis as any).CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";

  return ((canvas as any)?.tokens?.placeables ?? []).filter((other: any) => {
    if (!other?.actor || other.document?.hidden) return false;
    if (String(other.id) === String(token?.id)) return false;
    if (!theirs.includes(Number(other.document?.disposition))) return false;
    try {
      if (other.document?.hasStatusEffect?.(defeated)) return false;
    } catch {
      /* an unreadable status is not a reason to ignore a witness */
    }
    return true;
  });
}

/** The four corners of a token's occupied space, which is what cover is judged against. */
function corners(token: any): Array<{ x: number; y: number }> {
  const doc = token?.document ?? token;
  const grid = Number((canvas as any)?.grid?.size) || 100;
  const x = Number(doc?.x);
  const y = Number(doc?.y);
  const width = (Number(doc?.width) || 1) * grid;
  const height = (Number(doc?.height) || 1) * grid;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
  // Pulled a little inside the footprint: a ray to the exact corner grazes the wall a creature is pressed
  // against and reads as blocked from directions that plainly see it.
  const inset = Math.min(grid, width, height) * 0.1;
  return [
    { x: x + inset, y: y + inset },
    { x: x + width - inset, y: y + inset },
    { x: x + inset, y: y + height - inset },
    { x: x + width - inset, y: y + height - inset },
  ];
}

/**
 * How much of this creature the observer cannot see, from 0 to 1.
 *
 * Returns null when the wall geometry cannot be read at all, which must never be confused with "no cover":
 * an unreadable canvas has to fail toward refusing the hide, not toward granting it.
 */
function coverFrom(observer: any, token: any): number | null {
  const eye = centerOf(observer);
  const points = corners(token);
  if (!eye || points.length === 0) return null;

  let seen = 0;
  let tested = 0;
  for (const point of points) {
    const result = blocked(eye, point, "sight");
    if (result === null) continue;
    tested += 1;
    if (!result) seen += 1;
  }
  if (tested === 0) return null;
  return 1 - seen / tested;
}

/** Is there a fog bank, a darkness or an illusion standing between these two? */
function obscuredFrom(observer: any, token: any): boolean {
  try {
    return screensBetween(observer, token).some((screen) => screen.absolute);
  } catch {
    return false;
  }
}

/**
 * May this creature take the Hide action where it is standing?
 *
 * Pure: it reads the canvas and answers. Nothing here writes, so the token HUD can call it to decide
 * whether to even offer the button.
 */
export function canHide(token: any): HideCheck {
  const allow = (reason: string): HideCheck => ({ allowed: true, reason, detail: reason });
  if (!isDnd5e()) return allow("no 5e prerequisites to check");
  if (rulesVersion() === "legacy") return allow("2014 rules leave the prerequisites to the GM");

  const enemies = enemiesOf(token);
  if (enemies.length === 0) return allow("nobody is watching");

  // "Out of any enemy's line of sight" is answered by the perception layer, not by our own geometry: a
  // creature that cannot see you at all is not an enemy you have to break line of sight from. This is
  // where distance, darkness, darkvision range and invisibility enter the rule, and their absence is what
  // made this check refuse hides in situations no enemy could possibly have noticed.
  const watching = observersWhoSee(enemies, token);

  const exposed: string[] = [];
  for (const enemy of enemies) {
    if (!watching.has(String(enemy.id))) continue;
    if (obscuredFrom(enemy, token)) continue;
    const cover = coverFrom(enemy, token);
    if (cover === null) {
      exposed.push(`${String(enemy.name)} (could not read the walls)`);
      continue;
    }
    if (cover >= 0.75) continue;
    exposed.push(String(enemy.name));
  }

  if (exposed.length === 0) {
    return allow(
      watching.size === 0
        ? "out of every enemy's line of sight"
        : "heavily obscured or behind cover from everyone watching",
    );
  }
  return {
    allowed: false,
    reason:
      "there is nowhere to hide from here — the Hide action needs Heavily Obscured, or Three-Quarters " +
      "or Total Cover, and to be out of the line of sight of anything that can see you",
    detail: `in plain view of ${exposed.join(", ")}`,
  };
}

/**
 * Take the Hide action: check where you are, roll, and become hidden if it worked.
 *
 * The roll is a real Foundry roll on the creature's own sheet, never a number we invent — the same
 * doctrine as everywhere else in the module. Its total is written as the DC directly rather than left for
 * the chat watcher to notice, because this client already knows the number and should not depend on which
 * other client saw the message.
 */
export async function takeHideAction(
  token: any,
  options: { force?: boolean } = {},
): Promise<HideResult> {
  const failed = (reason: string, extra: Partial<HideResult> = {}): HideResult => ({
    hidden: false,
    total: null,
    dc: null,
    reason,
    detail: reason,
    ...extra,
  });

  const actor = token?.actor;
  if (!actor) return failed("no actor to hide");

  const prerequisites = canHide(token);
  if (!prerequisites.allowed && !options.force) {
    return failed(prerequisites.reason, { detail: prerequisites.detail });
  }

  // Hide costs a slot, and this is the one route to the action that was not charging for it. Refused
  // before the roll rather than after, so a player is not asked for dice they were never going to keep;
  // charged after, so a cancelled dialog costs nothing. A failed check still spends the action, which is
  // the rule.
  const cost = options.force ? { bill: null, source: "" } : hideCost(token);
  if (!affordable(cost.bill)) {
    const slot = slotLabel(cost.bill!.slot);
    return failed(`no ${slot} left this turn`);
  }

  const advantage = hidesWithAdvantage(actor, fightIsOn());

  let total: number | null = null;
  try {
    const rolls: any[] = (await actor.rollSkill({ skill: "ste", advantage })) ?? [];
    const value = Number(rolls?.[0]?.total);
    total = Number.isFinite(value) ? value : null;
  } catch (err) {
    log(`could not roll ${String(token?.name)}'s Stealth:`, err);
    return failed("the Stealth roll failed");
  }
  // A cancelled roll dialog is a player changing their mind, not a failure to hide.
  if (total === null) return failed("the roll was cancelled");

  if (cost.bill) {
    payBill(cost.bill);
    log(
      `hide: ${String(token?.name)} spent its ${cost.bill.slot} action` +
        `${cost.source ? ` (${cost.source})` : ""}`,
    );
  }

  const dc = hideDc();
  if (dc !== null && total < dc) {
    return failed(`rolled ${total} against DC ${dc}`, { total, dc });
  }

  try {
    await token.document.setFlag(MODULE_ID, "stealth", { dc: total, ts: Date.now() });
    if (!token.document.hasStatusEffect?.(HIDING_STATUS)) {
      await actor.toggleStatusEffect?.(HIDING_STATUS, { active: true });
    }
  } catch (err) {
    log(`could not hide ${String(token?.name)}:`, err);
    return failed("the hiding status could not be applied", { total, dc });
  }

  log(
    `hide: ${String(token.name)} is hidden at DC ${total}` +
      `${advantage ? " (Fog of War gave advantage)" : ""}`,
  );
  return {
    hidden: true,
    total,
    dc,
    reason: prerequisites.reason,
    detail: prerequisites.detail,
  };
}

/**
 * The GM-or-player entry point: hide every selected token and report what happened.
 *
 * Announced in chat rather than logged quietly, because the DC is a number the table needs — a GM ruling
 * on whether a guard notices has to know what the guard is trying to beat, and a player who rolled well
 * deserves to see it land.
 */
export async function hideSelected(options: { force?: boolean } = {}): Promise<void> {
  const selected: any[] = (canvas as any)?.tokens?.controlled ?? [];
  if (selected.length === 0) {
    ui.notifications?.warn(game.i18n.localize("NOODLRHOOKS.Combat.Hide.NoSelection"));
    return;
  }

  const outcomes: HideOutcome[] = [];
  for (const token of selected) {
    outcomes.push({ token, result: await takeHideAction(token, options) });
  }
  await postHide(outcomes);
}

/** One creature and what happened when it tried. */
interface HideOutcome {
  token: any;
  result: HideResult;
}

/** One creature's outcome, worded for the table. */
function hideLine(token: any, result: HideResult): string {
  const name = foundry.utils.escapeHTML(String(token?.name ?? "?"));
  return result.hidden
    ? `<strong>${name}</strong> ${game.i18n.format("NOODLRHOOKS.Combat.Hide.Hidden", {
        dc: String(result.total),
      })}`
    : `<strong>${name}</strong> ${game.i18n.format("NOODLRHOOKS.Combat.Hide.Failed", {
        reason: foundry.utils.escapeHTML(result.reason),
      })}`;
}

async function postHide(outcomes: HideOutcome[]): Promise<void> {
  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content: `<p>${outcomes.map(({ token, result }) => hideLine(token, result)).join("</p><p>")}</p>`,
    // One token means the card is that creature's; several means it is a summary and belongs to nobody.
    // Named either way, because an unsigned card is stamped with the author's assigned character.
    speaker: outcomes.length === 1 ? speakerFor(outcomes[0].token) : narrator(),
    flags: { [MODULE_ID]: { hide: true } },
  });
  await whisperHideDetail(outcomes);
}

/**
 * The half of the ruling only the GM may read.
 *
 * A refused hide has to say enough for the player to act on — move, find cover, try elsewhere — without
 * handing them a roster of everything on the map. So the sentence goes to the table and the names come
 * here. The whisper is skipped entirely when the detail says nothing the public line did not, which is
 * every successful hide, so this adds no noise to an ordinary session.
 */
async function whisperHideDetail(outcomes: HideOutcome[]): Promise<void> {
  const lines = outcomes
    .filter(({ result }) => result.detail && result.detail !== result.reason)
    .map(
      ({ token, result }) =>
        `<strong>${foundry.utils.escapeHTML(String(token?.name ?? "?"))}</strong>: ` +
        foundry.utils.escapeHTML(result.detail),
    );
  if (lines.length === 0) return;

  const gms: string[] =
    (game.users as any)?.filter?.((u: any) => u?.isGM)?.map((u: any) => u.id) ?? [];
  if (gms.length === 0) return;

  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content: `<p>${lines.join("</p><p>")}</p>`,
    whisper: gms,
    speaker: narrator(),
    flags: { [MODULE_ID]: { hide: true } },
  });
}

/**
 * The sheet's own Hide button, routed through the rule above.
 *
 * Returns true when it has taken the action over, and the caller cancels the activity.
 *
 * WHY THIS EXISTS. `takeHideAction` was reachable only from `api.hide()` — there is no toolbar tool and no
 * keybind — while any world carrying the 2024 PHB action items has a `Hide` feature on every character
 * sheet, which Argon puts on the action bar. So the button a player actually presses spent an Action and
 * did nothing else: no cover or line-of-sight prerequisite, no Stealth roll, no banked DC, leaving
 * `hidingState()` to fall back to passive Stealth if the item happened to stamp the status at all. Two
 * entrances to one action, priced the same and enforcing differently, is the third time this shape has bitten
 * (see Dash and the Attack declaration in `system/dnd5e-declarations.ts`).
 *
 * The activity is cancelled rather than allowed to run alongside, because it has nothing left to contribute
 * once we have rolled and stamped the status, and letting it post its own card would say a second, quieter
 * thing about the same action. The cost is charged inside `takeHideAction` exactly once, which is why the
 * economy layer must hand over here rather than charge on the way past.
 *
 * CANCELLING THE ACTIVITY IS NOT ENOUGH, because the bar that drew the button does not care what the
 * activity returned. Argon's `_onLeftClick` (`echDnd5e.js:1146-1162`) uses the actor's item and then, on
 * the next line and outside any success test, toggles the status its own button definition names:
 *
 *     success = this.actorItem ? await this.activity.use(...) : await this.createChatMessage();
 *     if (this.statusId) { const status = ...; if (status) this.actor.toggleStatusEffect(status.id); }
 *
 * So a refused hide still stamped `hiding`, and `hidingState` reads a status with no banked number as
 * hiding at passive Stealth — a player was told they could not hide and was hidden anyway, for free. It is
 * a TOGGLE and it is not awaited, which makes the other direction just as wrong: pressing Hide while
 * already hidden turns the status off underneath a successful roll. Hence the reconcile below, and hence
 * the snapshot taken here rather than inside `takeHideAction`: this is the last moment before another
 * module's unawaited write, so it is the only place the prior state can still be read.
 */
export function interceptHideActivity(activity: any): boolean {
  const actor = activity?.actor;
  if (!actor || !isHideActivity(activity?.item, activity)) return false;

  // No token means no geometry, so there is no prerequisite to test and nothing to stamp. Fail toward
  // letting the sheet do whatever it would have done, rather than cancelling into silence.
  const token = tokenFor(actor);
  if (!token) {
    log(`hide: ${String(actor?.name)} has no token on this scene; leaving the sheet's Hide alone`);
    return false;
  }

  const wasHiding = Boolean(token.document?.hasStatusEffect?.(HIDING_STATUS));

  // The hook is synchronous and the roll is not, so the answer is given now and the work runs after. Any
  // failure has to surface: a cancelled activity that then silently does nothing is the worst outcome
  // available, because it looks exactly like the button being dead.
  void (async () => {
    try {
      const result = await takeHideAction(token);
      await postHide([{ token, result }]);
      // A refusal leaves whatever the creature had before it pressed the button; a success means hidden.
      await reconcileHiding(token, result.hidden || wasHiding, result);
    } catch (err) {
      log(`hide: the sheet's Hide button failed for ${String(token?.name)}:`, err);
      ui.notifications?.error(game.i18n.localize("NOODLRHOOKS.Combat.Hide.Unexpected"));
    }
  })();
  return true;
}

/**
 * How long to let another module's unawaited status write land before correcting it.
 *
 * Sized for one document update round trip rather than measured, because the thing being waited for is a
 * promise nobody awaited and there is nothing to observe. Too short and the correction lands first and is
 * then overwritten; too long and a player watches a status flicker. Under a second either way.
 */
const SETTLE_MS = 600;

/**
 * Make the `hiding` status say what the ruling said, whatever else has written to it.
 *
 * Only reached from the sheet-button path, because that is the only path with a third party in it:
 * `api.hide()` and the survey have nobody racing them. Deliberately idempotent and quiet — in a world with
 * no action bar installed, nothing here ever has anything to correct.
 */
async function reconcileHiding(token: any, intended: boolean, result: HideResult): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, SETTLE_MS));

  const doc = token?.document;
  if (!doc) return;
  const present = Boolean(doc.hasStatusEffect?.(HIDING_STATUS));
  if (present === intended) return;

  if (intended) {
    log(`hide: something cleared ${String(token?.name)}'s hiding status; putting it back`);
    try {
      await token.actor?.toggleStatusEffect?.(HIDING_STATUS, { active: true });
    } catch (err) {
      log(`could not restore ${String(token?.name)}'s hiding status:`, err);
    }
    return;
  }

  // `reveal` rather than a bare toggle: it clears the banked number as well as the status, and leaving a
  // stale number behind is what makes a status arriving from anywhere else read as a real hide.
  await reveal(token, `the Hide action did not succeed (${result.reason})`);
}

/** What the prerequisites say about every selected token, without rolling anything. */
export function surveyHide(): unknown {
  const rows = ((canvas as any)?.tokens?.controlled ?? []).map((token: any) => {
    const prerequisites = canHide(token);
    const cost = hideCost(token);
    const enemies = enemiesOf(token);
    // The whole point of the survey is telling a refusal apart from a misreading, so `sees` is reported
    // beside the cover figure: an enemy that cannot see the creature is not counted whatever its cover.
    const watching = observersWhoSee(enemies, token);
    return {
      token: String(token?.name ?? "?"),
      allowed: prerequisites.allowed,
      reason: prerequisites.reason,
      detail: prerequisites.detail,
      costs: cost.bill
        ? `${cost.bill.slot}${cost.source ? ` (${cost.source})` : ""}`
        : "nothing — not its turn",
      advantage: hidesWithAdvantage(token?.actor, fightIsOn()),
      dc: hideDc(),
      watchers: enemies.map((e: any) => ({
        name: String(e.name),
        sees: watching.has(String(e.id)),
        cover: coverFrom(e, token),
        obscured: obscuredFrom(e, token),
      })),
    };
  });
  const report = { rules: rulesVersion(), selected: rows };
  console.log(`[${MODULE_ID}] hide survey\n${JSON.stringify(report, null, 2)}`);
  return report;
}
