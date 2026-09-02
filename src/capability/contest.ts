// When a compiled rider is allowed to mutate the table.
//
// THE HOLE. `on_activity_use` fires the moment the button is pressed. Stunning Strike's save has
// not been rolled yet, let alone bought with a legendary resistance, and a compiler that filed
// `grant_advantage` / `modify_speed` / `apply_status` on that event writes them anyway. The Monk
// keeps "Stunning Strike: Advantage" after the Beholder spends a resistance (2026-09-02). Using
// the ability is not the verdict.
//
// TWO GATES, both evidence, neither a spell name:
//
//   1. **Use is not a contest.** An activity that attacks or demands a save must not apply
//      contest-contingent kinds from `on_activity_use`. Those wait for `on_hit` / `on_miss` /
//      `on_save_failed` / `on_save_succeeded`. Reckless Attack stays: its activity is a Utility,
//      so this gate does not see a roll.
//   2. **The item's `onSave` flags outrank the compiler's success branch.** DDB Stunning Strike
//      ships one effect, `onSave: false` (stun on a fail). The compiler still emitted 2024
//      consolation (Speed + Advantage) on `on_save_succeeded`. A succeeded save — including one
//      Legendary Resistance just bought — must not apply a compiled rider the sheet never
//      declared. No effect links means the compiler is the only source (Hold Person on a
//      creature trait) and both events stay legal.
//
// A prompt cannot be relied on to file these on the right event. Same instinct as
// `duplicatesActivityDamage`. Do not recompile the world to "fix" the descriptors.

import type { CapabilityRule } from "../integration/capability";

/** Kinds that describe what happens AFTER a roll, not the fact that the button was pressed. */
export const CONTEST_CONTINGENT = new Set<string>([
  "apply_status",
  "remove_status",
  "grant_advantage",
  "impose_disadvantage",
  "modify_speed",
  "damage",
  "heal",
  "summon_creature",
  "forced_movement",
]);

export interface SaveBranches {
  fail: boolean;
  succeed: boolean;
  /** No effect links — the compiler is the only account of either branch. */
  unspecified: boolean;
}

function listOf(value: unknown): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  const rec = value as { contents?: unknown; [Symbol.iterator]?: () => Iterator<unknown> };
  if (Array.isArray(rec.contents)) return rec.contents;
  if (typeof rec[Symbol.iterator] === "function") return [...(value as Iterable<unknown>)];
  if (typeof value === "object") return Object.values(value as Record<string, unknown>);
  return [];
}

function ownContest(activity: any): boolean {
  const type = String(activity?.type ?? "").toLowerCase();
  if (type === "save" || type === "attack") return true;
  if (activity?.save && (activity.save.ability || activity.save.dc || activity.save.dc?.value)) {
    return true;
  }
  if (activity?.attack) return true;
  return false;
}

/**
 * The activity that actually attacks or demands a save.
 *
 * A Cast wrapper (Spellcasting → Hold Person) has no save of its own. Prefer a cached spell
 * already sitting on the activity — do not resolve a UUID here; this file stays Foundry-free.
 */
export function contestActivityOf(activity: unknown): any {
  const raw = activity as any;
  if (!raw) return raw;
  if (ownContest(raw)) return raw;
  if (String(raw.type ?? "").toLowerCase() !== "cast") return raw;
  const spell = raw.cachedSpell ?? raw.spell;
  const list = listOf(spell?.system?.activities);
  return list.find((a) => ownContest(a)) ?? raw;
}

export function activityResolvesByContest(activity: unknown): boolean {
  return ownContest(contestActivityOf(activity));
}

export function itemSaveBranches(activity: unknown): SaveBranches {
  const resolved = contestActivityOf(activity);
  const links = listOf(resolved?.effects);
  if (links.length === 0) return { fail: false, succeed: false, unspecified: true };
  let fail = false;
  let succeed = false;
  for (const link of links) {
    if (link?.onSave === true) succeed = true;
    else fail = true;
  }
  return { fail, succeed, unspecified: false };
}

export function activitiesOf(item: unknown): any[] {
  return listOf((item as { system?: { activities?: unknown } })?.system?.activities);
}

/** The save or attack activity a sheet review should judge a compiled rider against. */
export function primaryContestActivity(item: unknown): unknown {
  const list = activitiesOf(item);
  if (list.length === 0) return undefined;
  return (
    list.find((a) => String(a?.type ?? "").toLowerCase() === "save") ??
    list.find((a) => String(a?.type ?? "").toLowerCase() === "attack") ??
    list.find((a) => activityResolvesByContest(a)) ??
    list[0]
  );
}

/**
 * Why this rule must not run against this activity, or "" if it may.
 *
 * `activity` is the thing just used (runtime) or `primaryContestActivity(item)` (the sheet).
 */
export function contestRefusal(rule: CapabilityRule, activity: unknown): string {
  const event = String(rule.trigger?.event ?? "");
  const kind = String(rule.effect?.kind ?? "");
  if (!CONTEST_CONTINGENT.has(kind)) return "";

  if (event === "on_activity_use" && activityResolvesByContest(activity)) {
    return "this ability resolves by a roll — the rider waits for a hit or a save, not the button";
  }

  if (event !== "on_save_failed" && event !== "on_save_succeeded") return "";
  const branches = itemSaveBranches(activity);
  if (branches.unspecified) return "";
  if (event === "on_save_succeeded" && !branches.succeed) {
    return "the activity has no onSave:true effect — a succeeded save applies nothing compiled";
  }
  if (event === "on_save_failed" && !branches.fail) {
    return "the activity has no failed-save effect — a failed save applies nothing compiled";
  }
  return "";
}

/**
 * Timed AEs that must not survive a bought save.
 *
 * Stamped `event` is the authority. Unstamped leftovers from before this gate are the kinds
 * Stunning Strike wrote on the Monk and the Beholder — Advantage / Disadvantage / Speed — and
 * only those, because an unstamped `apply_status` might be a legitimate lasting condition
 * from another rule on the same capability.
 */
export function isFailContingentFlag(
  flag: { capability?: unknown; event?: unknown; kind?: unknown } | null | undefined,
  capabilityIds: ReadonlySet<string>,
): boolean {
  if (!flag || !capabilityIds.has(String(flag.capability ?? ""))) return false;
  const event = String(flag.event ?? "");
  if (event === "on_save_succeeded" || event === "on_hit" || event === "on_miss") return false;
  if (event === "on_activity_use" || event === "on_save_failed") return true;
  const kind = String(flag.kind ?? "");
  return kind === "grant_advantage" || kind === "impose_disadvantage" || kind === "modify_speed";
}
