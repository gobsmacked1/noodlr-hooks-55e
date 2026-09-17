// T targets the hovered token, and a leftover "me" is not a Witch Bolt.
//
// Foundry binds T to `core.target` — the Target *tool* toggle — not
// `core.targetToken` (hover then setTarget). Argon's picker clicks that tool
// on and shows `0/1 Targets`. Pressing T then turns the tool *off*, so further
// clicks select. A player can only select a token they own, which is how Witch
// Bolt looked like it could only target the caster. Live `setTarget` on the
// Dire Wolf still worked; the key just never called it.
//
// `rangepickerclear` defaults false, so a leftover self-target auto-completes
// the picker at 1/1 as the caster. Drop that leftover when the Target tool
// comes on (before Argon's count check) and refuse a pointed creature activity
// whose only live target is still the caster. Never a veto inside
// `template-targets` — that listener only mutates.

import { log } from "../constants";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  actorTokenIds,
  isSelfOnlyTargetSet,
  needsExternalCreatureTarget,
  tokenIdOf,
} from "../system/dnd5e-target";
import { isAutomating } from "./economy/enforce";

let lastNote = "target-pick: T has not targeted a hovered token this session";
let listening = false;

function note(line: string): void {
  lastNote = line;
  log(line);
}

function typingInField(event: KeyboardEvent): boolean {
  const el = event.target as HTMLElement | null;
  if (!el) return false;
  const tag = String(el.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return Boolean(el.closest?.("input, textarea, select, [contenteditable='true']"));
}

function hoveredToken(): any {
  return (globalThis as any).canvas?.tokens?.hover ?? null;
}

function liveTargets(): any[] {
  return [...((globalThis as any).game?.user?.targets ?? [])];
}

function release(token: any): void {
  try {
    token?.setTarget?.(false, { releaseOthers: false });
  } catch {
    /* a leftover that will not clear is still refused at use */
  }
}

/** Controlled tokens only — Healing Word on another owned PC must survive. */
export function dropControlledSelfLeftover(targets: any[], controlled: any[]): any[] {
  const mine = controlled.map(tokenIdOf).filter(Boolean);
  const ids = targets.map(tokenIdOf);
  if (!isSelfOnlyTargetSet(ids, mine)) return [];
  return targets;
}

function dropControlledLeftoverLive(): void {
  const dropped = dropControlledSelfLeftover(
    liveTargets(),
    [...((globalThis as any).canvas?.tokens?.controlled ?? [])],
  );
  if (!dropped.length) return;
  for (const token of dropped) release(token);
  note(
    `target-pick: dropped leftover self-target (${dropped.map((t) => String(t?.name ?? "?")).join(" | ")})`,
  );
}

function onTargetToolClick(event: Event): void {
  const el = (event.target as Element | null)?.closest?.("[data-tool=\"target\"]");
  if (!el) return;
  dropControlledLeftoverLive();
}

function onTargetKey(event: KeyboardEvent): void {
  if (event.code !== "KeyT" || event.repeat) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (typingInField(event)) return;
  const hover = hoveredToken();
  if (!hover || typeof hover.setTarget !== "function") return;
  try {
    hover.setTarget(true, { releaseOthers: !event.shiftKey });
  } catch (err) {
    note(`target-pick: could not target ${String(hover?.name ?? "?")}: ${err}`);
    return;
  }
  note(`target-pick: T targeted ${String(hover?.name ?? "a token")}`);
  // Consume even when the tool looks off: Foundry's T binding is the Target
  // *tool* toggle and often registers before we do. Leaving it to fire turns
  // targeting off and the next click selects instead.
  event.preventDefault();
  event.stopImmediatePropagation();
}

function notifySelfOnly(): void {
  const i18n = (globalThis as any).game?.i18n;
  const text =
    i18n?.localize?.("NOODLRHOOKS.Combat.Target.SelfOnly") ||
    "That needs a creature other than you. Hover them and press T.";
  try {
    (globalThis as any).ui?.notifications?.warn?.(text);
  } catch {
    /* the console line is the fallback */
  }
}

/**
 * Refuse a pointed creature activity whose only target is the caster.
 *
 * Returns false to cancel the use (slot unspent). Empty is allowed — the sheet
 * path still picks at the attack roll.
 */
export function refuseSelfOnlyCreatureTarget(activity: any, targets: any[], actor: any): boolean {
  if (!needsExternalCreatureTarget(activity)) return false;
  const sceneTokens = [
    ...((globalThis as any).canvas?.tokens?.placeables ?? []),
    ...targets,
  ];
  const mine = actorTokenIds(actor, sceneTokens);
  return isSelfOnlyTargetSet(targets.map(tokenIdOf), mine);
}

export function registerTargetPick(): void {
  if (!isDnd5e()) return;
  if (!listening && typeof document !== "undefined") {
    listening = true;
    document.addEventListener("keydown", onTargetKey, true);
    document.addEventListener("click", onTargetToolClick, true);
  }
  Hooks.on("dnd5e.preUseActivity", (activity: any) => {
    try {
      if (isAutomating()) return;
      const actor = activity?.actor ?? activity?.item?.actor;
      const targets = liveTargets();
      if (!refuseSelfOnlyCreatureTarget(activity, targets, actor)) return;
      for (const token of targets) release(token);
      notifySelfOnly();
      note(
        `target-pick: refused ${String(activity?.item?.name ?? activity?.name ?? "activity")} ` +
          "— the only target was the caster",
      );
      return false;
    } catch (err) {
      log("target-pick: could not refuse a self-only target:", err);
    }
  });
}

export function surveyTargetPick(): { report: string } {
  log(lastNote);
  return { report: lastNote };
}
