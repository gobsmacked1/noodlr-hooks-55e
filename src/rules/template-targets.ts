// A template spell must not inherit whoever was last clicked.
//
// dnd5e snapshots `game.user.targets` into `flags.dnd5e.targets` on the usage card BEFORE
// `preUseActivity` and BEFORE `#placeTemplate` (`mixin.mjs` `messageFlags` at :140, hook at :222,
// place at :845). Auto-saves then treat that list as "who this Fireball is for" and roll them
// immediately. A Dire Wolf still targeted from Ray of Frost Dex-saves against a sphere that has
// not been drawn, and that the caster could put anywhere.
//
// Clearing the live selection is not enough: the card already holds a copy. This rewrites
// `messageConfig.data.flags.dnd5e.targets` as well. One door, on the using client.
//
// Never a veto. A second `preUseActivity` listener that returns false is how Hide and Dash
// double-charged; this one only mutates. Skipped while `isAutomating()` so a later Phase 5
// placement that sets a catch-list then calls `use()` is not wiped on the way through.

import { log } from "../constants";
import { isDnd5e } from "../system/dnd5e-rewards";
import { isAutomating } from "./economy/enforce";

/** The dnd5e area type on this activity, or inherited from its item. */
export function templateSpecOf(activity: any): { type: string; size: number; width?: number } {
  const own = activity?.target?.template ?? {};
  if (activity?.target?.override === true) {
    return { type: String(own.type ?? "").trim(), size: Number(own.size) || 0, width: num(own.width) };
  }
  const item = activity?.item?.system?.target?.template ?? activity?.item?.target?.template ?? {};
  const type = String(own.type || item.type || "").trim();
  const size = Number(own.size || item.size) || 0;
  const width = num(own.width) ?? num(item.width);
  return { type, size, width };
}

function num(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function linkedSpellOf(activity: any): any {
  if (String(activity?.type ?? "").toLowerCase() !== "cast") return null;
  if (activity?.cachedSpell?.system?.activities) return activity.cachedSpell;
  const uuid = String(activity?.spell?.uuid ?? "");
  if (!uuid) return null;
  try {
    const sync = (foundry as any)?.utils?.fromUuidSync ?? (globalThis as any).fromUuidSync;
    const doc = typeof sync === "function" ? sync(uuid) : null;
    return doc?.system?.activities ? doc : null;
  } catch {
    return null;
  }
}

/**
 * The activity that actually describes the area.
 *
 * A Cast wrapper (Archmage Spellcasting → Lightning Bolt) has no template of its own.
 * `CastActivity.use` forwards to the cached spell, and that is what `#placeTemplate` reads.
 */
export function templateActivityOf(activity: any): any {
  if (templateSpecOf(activity).type) return activity;
  const spell = linkedSpellOf(activity);
  const raw = spell?.system?.activities;
  const list: any[] = raw?.contents ?? (Array.isArray(raw) ? raw : []);
  return list.find((a) => templateSpecOf(a).type) ?? activity;
}

/** Does this activity place a MeasuredTemplate before it is "released"? */
export function placesTemplate(activity: any): boolean {
  if (templateSpecOf(activity).type) return true;
  const placer = templateActivityOf(activity);
  return placer !== activity && Boolean(templateSpecOf(placer).type);
}

/**
 * Empty the snapshot dnd5e already wrote onto the usage message.
 *
 * Returns whether anything was there — the hook logs only when it actually dropped a leftover.
 */
export function stripUsageTargets(messageConfig: any): boolean {
  const flags = messageConfig?.data?.flags?.dnd5e;
  if (!flags) return false;
  const had = Array.isArray(flags.targets) && flags.targets.length > 0;
  flags.targets = [];
  return had;
}

export function forgetLeftoverTargets(activity: any, messageConfig: any): boolean {
  if (!placesTemplate(activity)) return false;
  if (isAutomating()) return false;
  const had = stripUsageTargets(messageConfig);
  clearLiveTargets();
  if (had) {
    log("template: dropped leftover targets; the area decides who is in it");
  }
  return true;
}

export function registerTemplateTargets(): void {
  if (!isDnd5e()) return;
  Hooks.on(
    "dnd5e.preUseActivity",
    (activity: any, _usage: any, _dialog: any, messageConfig: any) => {
      try {
        forgetLeftoverTargets(activity, messageConfig);
      } catch (err) {
        log("template: could not drop leftover targets:", err);
      }
    },
  );
}

function clearLiveTargets(): void {
  const user: any = (globalThis as any).game?.user;
  if (typeof user?.updateTokenTargets === "function") {
    user.updateTokenTargets([]);
    return;
  }
  user?.targets?.clear?.();
}
