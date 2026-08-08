// Ending the Invisibility spell when the rules say it ends — and leaving Greater Invisibility alone.
//
// The 2024 spell states its own undoing: "The spell ends early immediately after the target makes an
// attack roll, deals damage, or casts a spell." Greater Invisibility says no such thing, and that single
// sentence is the entire difference between a second-level slot and a fourth-level one. dnd5e automates
// neither: both spells apply an Active Effect carrying the `invisible` status, both have `changes: []`,
// and the break condition exists only as English in the description.
//
// Midi does clear it — and clears it under `removeHiddenInvis`, the same rule that clears hiding, which
// means a table with midi on has been quietly deleting Greater Invisibility on the first attack for as
// long as they have had it. That is the specific mistake this file exists not to make. Hiding and magical
// invisibility are separate states with separate enders, and they are switched separately.
//
// WHICH EFFECT. Names, via `dnd5e-stealth.ts::invisibilityBreak`, because there is nothing else to go on:
// the status is `invisible` for both spells, for a Potion of Invisibility, and for a will-o'-wisp's innate
// ability. Two things are deliberately skipped. A CONCENTRATION effect belongs to the caster, so a wizard
// who made someone else invisible does not lose their own spell by swinging a dagger — matched against
// `actor.concentration.effects` rather than by the localised "Concentrating:" prefix. And an effect that
// is not a spell at all is left alone by the name table returning null for anything without "invisib" in
// it, which is why a potion keeps working exactly as it did before this file existed.

import { log } from "../constants";
import { isInvisibilityBreakEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import { invisibilityBreak } from "../system/dnd5e-stealth";

type Trigger = "attack" | "damage" | "cast";

/**
 * Watch for the three things that end an Invisibility.
 *
 * All three hooks fire on the client that acted, which is the client that owns the creature, so it can
 * delete its own effect without a relay. Nothing here runs on a bystander's browser.
 */
export function registerInvisibilityHooks(): void {
  Hooks.on("dnd5e.rollAttack", (_rolls: any[], data: any) => {
    // The `[[/attack]]` enricher fires this with a null subject; that roll belongs to nobody.
    const actor = data?.subject?.actor;
    if (actor) void breakInvisibility(actor, "attack");
  });

  Hooks.on("dnd5e.rollDamage", (_rolls: any[], data: any) => {
    const actor = data?.subject?.actor;
    if (actor) void breakInvisibility(actor, "damage");
  });

  Hooks.on("dnd5e.postUseActivity", (activity: any) => {
    if (activity?.item?.type === "spell") void breakInvisibility(activity?.actor, "cast");
  });
}

/** Is this effect the caster's own concentration rather than the invisibility itself? */
function isConcentration(actor: any, effect: any): boolean {
  try {
    return Boolean(actor?.concentration?.effects?.has?.(effect));
  } catch {
    return false;
  }
}

/**
 * End any invisibility on this creature that the given action breaks.
 *
 * Deleting rather than disabling, because dnd5e's own spell durations delete, and a disabled effect left
 * on the sheet reads as "still invisible, somehow switched off" to anyone looking at the token.
 */
export async function breakInvisibility(actor: any, trigger: Trigger): Promise<void> {
  if (!isDnd5e() || !actor || !isInvisibilityBreakEnabled()) return;

  const doomed: any[] = [];
  try {
    for (const effect of actor.appliedEffects ?? actor.effects ?? []) {
      if (effect?.disabled) continue;
      const spell = invisibilityBreak(String(effect?.name ?? ""));
      if (!spell || !spell.breaksOn.includes(trigger)) continue;
      if (isConcentration(actor, effect)) continue;
      // An effect applied by a spell cast on someone else lives on the target's actor, so the one we can
      // delete is the one whose parent is this actor. A transferred effect from an item is not ours.
      if (effect?.parent?.id && String(effect.parent.id) !== String(actor.id)) continue;
      doomed.push({ effect, label: spell.label });
    }
  } catch (err) {
    log("could not read effects while checking invisibility:", err);
    return;
  }

  for (const { effect, label } of doomed) {
    try {
      await effect.delete();
      log(`invisibility: ${label} on ${String(actor.name)} ended — ${trigger}`);
    } catch (err) {
      log(`could not end ${label} on ${String(actor.name)}:`, err);
    }
  }
}
