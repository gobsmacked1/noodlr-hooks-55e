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

import { log, MODULE_ID } from "../../constants";
import { narrator, speakerFor } from "../../util/speaker";
import { getEconomyMode } from "../config";
import { check, spend } from "../economy/ledger";
import { isDnd5e } from "../systems/dnd5e-rewards";
import {
  bonusHideSource,
  HIDING_STATUS,
  hideDc,
  hidesWithAdvantage,
  rulesVersion,
} from "../systems/dnd5e-stealth";
import { blocked, centerOf } from "./positioning";
import { screensBetween } from "./screens";

/** Why a creature may or may not hide right now. */
export interface HideCheck {
  allowed: boolean;
  /** Plain-language reason, shown to whoever pressed the button. */
  reason: string;
}

/** The outcome of actually taking the action. */
export interface HideResult {
  hidden: boolean;
  total: number | null;
  dc: number | null;
  reason: string;
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
  slot: "action" | "bonus";
  /** The feature that makes the bonus action legal, for the log. Empty on the ordinary Action path. */
  source: string;
  combat: any;
  combatant: any;
  actor: any;
}

/**
 * What Hide costs this creature right now, or null when nothing should be charged.
 *
 * Null outside a started fight and outside the creature's own turn, matching the movement cap and the
 * activity veto: there is no turn to be over budget in during downtime, and a GM hiding a token during prep
 * is not spending anything. The bonus action wins when something grants it, falling back to the Action once
 * it is gone — Hide remains legal as an Action for everybody.
 */
function hideCost(token: any): HideCost | null {
  const combat: any = game.combat;
  if (!combat?.started) return null;

  const combatant = token?.document?.combatant;
  if (!combatant || String(combatant.id) !== String(combat.combatant?.id ?? "")) return null;

  const actor = token?.actor;
  if (!actor) return null;

  const source = bonusHideSource(actor);
  if (source && check(actor, combat, combatant, "bonus", false).allowed) {
    return { slot: "bonus", source, combat, combatant, actor };
  }
  return { slot: "action", source: "", combat, combatant, actor };
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
  if (!isDnd5e()) return { allowed: true, reason: "no 5e prerequisites to check" };
  if (rulesVersion() === "legacy") {
    return { allowed: true, reason: "2014 rules leave the prerequisites to the GM" };
  }

  const enemies = enemiesOf(token);
  if (enemies.length === 0) return { allowed: true, reason: "nobody is watching" };

  const exposed: string[] = [];
  for (const enemy of enemies) {
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
    return { allowed: true, reason: "heavily obscured or behind cover from everyone watching" };
  }
  return {
    allowed: false,
    reason: `in plain view of ${exposed.join(", ")} — the Hide action needs Heavily Obscured, or Three-Quarters or Total Cover, and to be out of every enemy's line of sight`,
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
  const actor = token?.actor;
  if (!actor) return { hidden: false, total: null, dc: null, reason: "no actor to hide" };

  const prerequisites = canHide(token);
  if (!prerequisites.allowed && !options.force) {
    return { hidden: false, total: null, dc: null, reason: prerequisites.reason };
  }

  // Hide costs a slot, and this is the one route to the action that was not charging for it. Refused
  // before the roll rather than after, so a player is not asked for dice they were never going to keep;
  // charged after, so a cancelled dialog costs nothing. A failed check still spends the action, which is
  // the rule.
  const cost = hideCost(token);
  if (cost && !options.force && getEconomyMode() !== "off") {
    if (!check(cost.actor, cost.combat, cost.combatant, cost.slot, false).allowed) {
      const slot = cost.slot === "bonus" ? "bonus action" : "action";
      return { hidden: false, total: null, dc: null, reason: `no ${slot} left this turn` };
    }
  }

  const advantage = hidesWithAdvantage(actor, fightIsOn());

  let total: number | null = null;
  try {
    const rolls: any[] = (await actor.rollSkill({ skill: "ste", advantage })) ?? [];
    const value = Number(rolls?.[0]?.total);
    total = Number.isFinite(value) ? value : null;
  } catch (err) {
    log(`could not roll ${String(token?.name)}'s Stealth:`, err);
    return { hidden: false, total: null, dc: null, reason: "the Stealth roll failed" };
  }
  // A cancelled roll dialog is a player changing their mind, not a failure to hide.
  if (total === null)
    return { hidden: false, total: null, dc: null, reason: "the roll was cancelled" };

  if (cost) {
    spend(cost.actor, cost.combat, cost.combatant, cost.slot, false);
    log(
      `hide: ${String(token?.name)} spent its ${cost.slot} action` +
        `${cost.source ? ` (${cost.source})` : ""}`,
    );
  }

  const dc = hideDc();
  if (dc !== null && total < dc) {
    return { hidden: false, total, dc, reason: `rolled ${total} against DC ${dc}` };
  }

  try {
    await token.document.setFlag(MODULE_ID, "stealth", { dc: total, ts: Date.now() });
    if (!token.document.hasStatusEffect?.(HIDING_STATUS)) {
      await actor.toggleStatusEffect?.(HIDING_STATUS, { active: true });
    }
  } catch (err) {
    log(`could not hide ${String(token?.name)}:`, err);
    return { hidden: false, total, dc, reason: "the hiding status could not be applied" };
  }

  log(
    `hide: ${String(token.name)} is hidden at DC ${total}` +
      `${advantage ? " (Fog of War gave advantage)" : ""}`,
  );
  return { hidden: true, total, dc, reason: prerequisites.reason };
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

  const lines: string[] = [];
  for (const token of selected) {
    const result = await takeHideAction(token, options);
    const name = foundry.utils.escapeHTML(String(token?.name ?? "?"));
    lines.push(
      result.hidden
        ? `<strong>${name}</strong> ${game.i18n.format("NOODLRHOOKS.Combat.Hide.Hidden", {
            dc: String(result.total),
          })}`
        : `<strong>${name}</strong> ${game.i18n.format("NOODLRHOOKS.Combat.Hide.Failed", {
            reason: foundry.utils.escapeHTML(result.reason),
          })}`,
    );
  }

  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content: `<p>${lines.join("</p><p>")}</p>`,
    // One token means the card is that creature's; several means it is a summary and belongs to nobody.
    // Named either way, because an unsigned card is stamped with the author's assigned character.
    speaker: selected.length === 1 ? speakerFor(selected[0]) : narrator(),
    flags: { [MODULE_ID]: { hide: true } },
  });
}

/** What the prerequisites say about every selected token, without rolling anything. */
export function surveyHide(): unknown {
  const rows = ((canvas as any)?.tokens?.controlled ?? []).map((token: any) => {
    const prerequisites = canHide(token);
    const cost = hideCost(token);
    return {
      token: String(token?.name ?? "?"),
      allowed: prerequisites.allowed,
      reason: prerequisites.reason,
      costs: cost
        ? `${cost.slot}${cost.source ? ` (${cost.source})` : ""}`
        : "nothing — not its turn",
      advantage: hidesWithAdvantage(token?.actor, fightIsOn()),
      dc: hideDc(),
      watchers: enemiesOf(token).map((e: any) => ({
        name: String(e.name),
        cover: coverFrom(e, token),
        obscured: obscuredFrom(e, token),
      })),
    };
  });
  const report = { rules: rulesVersion(), selected: rows };
  console.log(`[${MODULE_ID}] hide survey\n${JSON.stringify(report, null, 2)}`);
  return report;
}
