// Who may Dash with a bonus action instead of an action. D&D 5e ONLY.
//
// Dash costs your Action by the general rule, and the general rule is wrong for two of the twelve base
// classes. A Rogue with Cunning Action and a Monk with Step of the Wind Dash as a **bonus action, for
// free**, and Expeditious Retreat hands the same thing to Sorcerers, Wizards and Warlocks for the
// duration of the spell (user, 2026-08-06). Charging a rogue's Action for a Dash is not a rounding error:
// it silently deletes the class feature the player took the subclass for, and it does so on the most
// routine thing a rogue does all night.
//
// The bonus action is preferred whenever a source for it exists and the slot is free, because that is the
// entire purpose of these features — nobody takes Cunning Action in order to keep paying full price. The
// Action remains a legal way to Dash and is used when the bonus action is already spent.
//
// HOW EACH IS RECOGNISED, in the order tried:
//   * `flags.noodlr.bonusDash` — the escape hatch, for anything this list has never heard of. Set it with
//     an ordinary Active Effect and no code here needs to change.
//   * `system.identifier` on a feature the creature owns. Stable across dnd5e versions and localisations,
//     which item names are not: this is the same mechanism that reads Extra Attack.
//   * an Active Effect whose name mentions the spell. dnd5e's concentration effect is named
//     "Concentrating: <spell>", so the spell's own name is what has to be matched rather than the prefix.
//   * an item name, as a last resort, for homebrew and imported sheets that carry no identifier.

import { isDnd5e } from "./dnd5e-rewards";

export interface DashSource {
  label: string;
  /** `system.identifier` values on an owned feature that grant it. */
  identifiers?: string[];
  /** Matched against the names of the creature's items and active effects. */
  pattern?: RegExp;
  /** True when the grant only holds while an effect is running, so an owned item is not enough. */
  effectOnly?: boolean;
}

const BONUS_DASH: DashSource[] = [
  {
    label: "Cunning Action",
    identifiers: ["cunning-action"],
    pattern: /cunning\s*action/i,
  },
  {
    // 2024 folds Step of the Wind into Monk's Focus; 2014 has it as its own feature under Ki. Both
    // spellings are listed because a table may be running either, and a converted sheet may carry both.
    label: "Step of the Wind",
    identifiers: ["step-of-the-wind", "monks-focus", "fleet-step", "ki"],
    pattern: /step\s*of\s*the\s*wind/i,
  },
  {
    // Owning the spell grants nothing; it has to be running. Named without the "Concentrating:" prefix
    // on purpose — that prefix is localised, and the spell's name inside it is not.
    label: "Expeditious Retreat",
    pattern: /expeditious\s*retreat/i,
    effectOnly: true,
  },
];

function names(collection: any): string[] {
  const out: string[] = [];
  for (const entry of collection ?? []) {
    const name = String(entry?.name ?? "").trim();
    if (name) out.push(name);
  }
  return out;
}

/** Identifiers of every feature the creature owns, lower-cased. */
function identifiers(actor: any): Set<string> {
  const out = new Set<string>();
  for (const item of actor?.items ?? []) {
    const id = String(item?.system?.identifier ?? "")
      .trim()
      .toLowerCase();
    if (id) out.add(id);
  }
  return out;
}

/**
 * What lets this creature Dash as a bonus action, if anything. Returns the feature's name, for the
 * chat line, or null when the Action is the only way it can Dash.
 */
export function bonusDashSource(actor: any): string | null {
  if (!actor) return null;

  try {
    const flagged = actor.getFlag?.("noodlr", "bonusDash");
    if (flagged) return typeof flagged === "string" ? flagged : "a feature";
  } catch {
    /* absent is the normal case */
  }

  const owned = identifiers(actor);
  const effectNames = names(actor.appliedEffects ?? actor.effects);
  const itemNames = names(actor.items);

  for (const source of BONUS_DASH) {
    if (source.pattern && effectNames.some((name) => source.pattern!.test(name)))
      return source.label;
    if (source.effectOnly) continue;
    if (source.identifiers?.some((id) => owned.has(id))) return source.label;
    if (source.pattern && itemNames.some((name) => source.pattern!.test(name))) return source.label;
  }
  return null;
}

/** An activity or item that IS the Dash action, rather than one that changes what Dash costs. */
const DASH = /^\s*dash\s*$/i;

function flagged(doc: any, key: string): boolean {
  try {
    return Boolean(doc?.flags?.noodlr?.[key]);
  } catch {
    return false;
  }
}

/**
 * Is pressing this the Dash action?
 *
 * Needed because Dash exists twice over: as a thing the module infers from movement, and — in any world
 * carrying the 2024 PHB action items — as a real feature with a real activation that a player can click,
 * which Argon puts on the action bar. Charging both is how a rogue lost its bonus action to Cunning Action
 * and then its whole Action to the movement that followed (measured in the 2026-08-07 census). Whoever
 * charges has to record the Dash itself, not merely the slot, and that means recognising one.
 *
 * The activity name is the primary signal and is checked first: a multi-purpose feature keeps its
 * activities named ("Cunning Action" holds Dash, Disengage and Hide), and midi only renames the ones whose
 * names were left at the default. The single-purpose Dash item is the case midi DOES rename — its activity
 * reads "Midi Use" — so that one is recognised by the item's identifier instead.
 */
export function isDashActivity(item: any, activity: any): boolean {
  if (!isDnd5e()) return false;
  const owner = item ?? activity?.item ?? null;
  if (!owner) return false;

  if (flagged(activity, "dash") || flagged(owner, "dashActivity")) return true;
  if (DASH.test(String(activity?.name ?? ""))) return true;

  const identifier = String(owner?.system?.identifier ?? "")
    .trim()
    .toLowerCase();
  if (identifier === "dash") return true;
  // Only when the sheet states no identifier, so a world that deliberately re-identified the feature is
  // not overruled by what it happens to be called. Same discipline as the damage-rider table.
  return !identifier && DASH.test(String(owner?.name ?? ""));
}
