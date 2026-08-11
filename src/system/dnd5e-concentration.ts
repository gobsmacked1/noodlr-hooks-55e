// Losing Concentration when the rules say you lose it. D&D 5e ONLY.
//
// This is the narrowest gap of the three we have closed so far, and the most surprising, because the
// system does nearly all of the work and then throws the answer away. Verified against dnd5e 5.3.3:
//
//   * It tracks concentration properly — `actor.concentration` returns the items and effects, the
//     effect is created on use (`activity/mixin.mjs:470`), and casting a second concentration spell
//     ends the first (`mixin.mjs:251`). The one-at-a-time rule is genuinely automated.
//   * On damage it computes the right DC and posts a prompt: `onUpdateHP`
//     (`data/actor/templates/attributes.mjs:548-552`) calls `challengeConcentration({ dc:
//     getConcentrationDC(damage) })`, and `getConcentrationDC` (`actor.mjs:471`) is
//     `clamp(floor(damage / 2), 10, modern ? 30 : Infinity)` — correct for both editions, cap
//     included.
//   * `rollConcentration` (`actor.mjs:1709`) builds the save correctly too: the ability from
//     `system.attributes.concentration.ability` or the configured default, the save bonus, and the
//     advantage mode, which is how War Caster and friends already reach the roll.
//
// And then: nothing. `challengeConcentration` posts a whispered card with a button. `rollConcentration`
// evaluates the save, fires two hooks, and returns. **No code path in the system calls
// `endConcentration` from a saving throw.** The only callers are the item being deleted, the effect
// being deleted, two context menus, and starting a new concentration. The card renders the failure in
// red and the spell stays up.
//
// So the two things missing are the two ends of the sentence: nobody presses the button, and nobody
// reads the verdict. The third gap is quieter — "Your Concentration ends if you have the Incapacitated
// condition or you die" (2024 PHB; the 2014 wording is "incapacitated or if you die") is enforced
// nowhere at all, so a Held or Unconscious wizard keeps their Wall of Force.
//
// This file is the rule table. The hook engine that uses it lives in `rules/concentration.ts`.

import { midiConfig, midiOn } from "../util/modules";
import { isDnd5e } from "./dnd5e-rewards";
import { hasStatus } from "./dnd5e-conditions";
import { rulesVersion } from "./dnd5e-stealth";

/** The effects that represent something this creature is concentrating on. */
export function concentrationEffects(actor: any): any[] {
  try {
    const effects = actor?.concentration?.effects;
    if (!effects) return [];
    return Array.from(effects as Iterable<any>);
  } catch {
    return [];
  }
}

export function isConcentrating(actor: any): boolean {
  return concentrationEffects(actor).length > 0;
}

/**
 * Readable names for what is being concentrated on.
 *
 * The effect's own name is "Concentrating: Bless" in most worlds, so the item name behind
 * `flags.dnd5e.item` reads better on a chat card. Falls back through both.
 */
export function concentrationLabels(actor: any): string[] {
  const labels: string[] = [];
  for (const effect of concentrationEffects(actor)) {
    let label = "";
    try {
      const data = effect?.getFlag?.("dnd5e", "item") ?? effect?.flags?.dnd5e?.item;
      label = String(data?.name ?? actor?.items?.get?.(data?.id)?.name ?? "");
    } catch {
      label = "";
    }
    if (!label) label = String(effect?.name ?? "");
    if (label) labels.push(label);
  }
  return labels;
}

/**
 * DC 10 or half the damage taken, whichever is higher — capped at 30 under the 2024 rules.
 *
 * Ask the actor first: `getConcentrationDC` is the system's own method and already knows the edition,
 * so a future rules change lands for free. The local arithmetic only exists for the case where the
 * method is missing, and it is deliberately identical rather than "improved".
 */
export function concentrationDC(actor: any, damage: number): number {
  const taken = Math.max(0, Math.floor(Number(damage) || 0));
  try {
    const dc = Number(actor?.getConcentrationDC?.(taken));
    if (Number.isFinite(dc)) return dc;
  } catch {
    // fall through to the local copy
  }
  const half = Math.floor(taken / 2);
  const cap = rulesVersion() === "modern" ? 30 : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(half, 10), cap);
}

export interface SaveVerdict {
  /** True only when a roll is readably below its DC. An unreadable roll never breaks concentration. */
  failed: boolean;
  total: number | null;
  dc: number | null;
}

/**
 * Did this save fail?
 *
 * Several rolls can arrive at once (a Concentration save is a single d20, but the roll API is plural
 * and midi's own handler treats any failure as failure). `isFailure` needs a DC to mean anything and
 * returns false without one — but `rollConcentration` defaults `target` to 10, so in practice every
 * concentration roll carries one. Where it genuinely cannot be read the answer is "not failed",
 * because leaving a spell up is the recoverable error and cancelling one is not.
 */
export function readVerdict(rolls: any): SaveVerdict {
  const list: any[] = Array.isArray(rolls) ? rolls : rolls ? [rolls] : [];
  let failed = false;
  let total: number | null = null;
  let dc: number | null = null;
  for (const roll of list) {
    const t = Number(roll?.total);
    if (Number.isFinite(t) && total === null) total = t;
    const target = Number(roll?.options?.target);
    if (Number.isFinite(target) && dc === null) dc = target;
    if (roll?.isFailure === true) failed = true;
  }
  return { failed, total, dc };
}

/**
 * A reason concentration is already over, with no save to be made.
 *
 * Hit points are checked as well as the status because of when this is asked: `dnd5e.damageActor`
 * fires from inside `Actor#update`, which resolves before `applyDamage` returns, so the Unconscious
 * that our dying layer applies has not landed yet. The hit point total has. Reading only the status
 * would put a Concentration save in front of a character who is already on the floor.
 */
export function breaksConcentration(actor: any): "dead" | "incapacitated" | "zero" | null {
  if (!actor) return null;
  if (hasStatus(actor, "dead")) return "dead";
  if (hasStatus(actor, "incapacitated")) return "incapacitated";
  const hp = Number(actor?.system?.attributes?.hp?.value);
  if (Number.isFinite(hp) && hp <= 0) return "zero";
  return null;
}

/**
 * Is midi-qol handling concentration, so that we must not?
 *
 * Midi's `doConcentrationCheck` is `"chat"` by default, which posts its own request card in place of
 * the system's, and its `dnd5e.rollConcentration` listener ends concentration on a failure when
 * `removeConcentration` is on (also the default). So midi already owns the verdict; what it does not
 * do is press the button either.
 *
 * We stand aside from the whole feature rather than adding only the missing half, and the reason is
 * ordering rather than politeness. Suppressing the stock prompt means writing
 * `options.dnd5e.concentrationCheck = false` during `preUpdateActor` — and midi writes that same
 * property from its own `preUpdateActor` handler (`Hooks.ts:237`). Whichever registers last wins,
 * which is not a thing to build a rule on. Setting midi's concentration handling to "None" hands the
 * whole job here.
 */
export function midiOwnsConcentration(): boolean {
  if (!isDnd5e()) return false;
  return midiOn(midiConfig()?.doConcentrationCheck);
}

/** The system's own master switch. With it off, there is no concentration to maintain. */
export function systemTracksConcentration(): boolean {
  try {
    return !game.settings.get("dnd5e", "disableConcentration");
  } catch {
    return true;
  }
}
