// Wild Shape / Polymorph / Shapechange — rider dump on revert, no restore icon.
//
// dnd5e already restores from the sheet header (`restoreTransformation`) and the sidebar.
// A token-corner / effects-panel badge was tried and never became a reliable click. Do not
// rebuild it. This file keeps `restoreOriginalForm` for the console API and strips leftover
// `noodlr-transformed` badges so an upgraded world does not keep showing a dead icon.

import { debug, log, warn } from "../constants";
import { isDnd5e } from "../system/dnd5e-rewards";
import { isPolymorphed, isTransformBadge } from "../system/dnd5e-transform";
import { scheduleDropAllRiders, scheduleRidingFit } from "./riding";

/** One strip at a time per actor — transform fires several hooks for one revert. */
const inflight = new Map<string, Promise<void>>();

function notify(key: string): void {
  try {
    ui.notifications?.warn(game.i18n.localize(key));
  } catch {
    /* courtesy */
  }
}

function actorKey(actor: any): string {
  return String(actor?.uuid ?? actor?.id ?? "");
}

function actorOf(subject: any): any {
  return subject?.actor ?? subject?.document?.actor ?? subject ?? null;
}

export async function restoreOriginalForm(subject: any): Promise<boolean> {
  const actor = actorOf(subject);
  if (!actor) return false;
  debug("transform: restore requested for", String(actor.name ?? actor.id ?? "?"));
  if (!actor.isOwner) {
    notify("NOODLRHOOKS.General.TransformUndo.NoOwner");
    return false;
  }
  if (!isPolymorphed(actor)) {
    notify("NOODLRHOOKS.General.TransformUndo.NotTransformed");
    return false;
  }
  if (typeof actor.revertOriginalForm !== "function") {
    notify("NOODLRHOOKS.General.TransformUndo.NotTransformed");
    return false;
  }
  try {
    const tokens = tokensOfActor(actor);
    const result = await actor.revertOriginalForm({ renderSheet: false });
    if (result == null && isPolymorphed(actor)) {
      warn("transform: revertOriginalForm returned nothing and the actor is still transformed");
      notify("NOODLRHOOKS.General.TransformUndo.NotTransformed");
      return false;
    }
    for (const token of tokens) scheduleDropAllRiders(token);
    scheduleRidingFit();
    return true;
  } catch (err) {
    warn("transform: revertOriginalForm failed:", err);
    return false;
  }
}

async function stripLeftoverBadges(actor: any): Promise<void> {
  const key = actorKey(actor);
  if (!key) return;
  const prev = inflight.get(key);
  if (prev) {
    try {
      await prev;
    } catch {
      /* first pass already logged */
    }
    return doStrip(actor);
  }
  const run = doStrip(actor).finally(() => {
    if (inflight.get(key) === run) inflight.delete(key);
  });
  inflight.set(key, run);
  await run;
}

async function doStrip(actor: any): Promise<void> {
  if (!isDnd5e() || !actor) return;
  const existing = [...(actor.effects ?? [])].filter(isTransformBadge);
  if (!existing.length) return;
  if (!actor.isOwner) return;
  for (const effect of existing) {
    try {
      await effect.delete();
    } catch (err) {
      warn(`transform: could not drop leftover badge on ${String(actor.name)}:`, err);
    }
  }
}

function tokensOfActor(actor: any): any[] {
  try {
    const placed = actor?.getActiveTokens?.(true, true);
    if (Array.isArray(placed) && placed.length) return placed;
  } catch {
    /* sheet actor without a canvas */
  }
  const id = String(actor?.id ?? "");
  return tokensOnScene()
    .map((t) => t?.document ?? t)
    .filter((d) => String(d?.actorId ?? d?.actor?.id ?? "") === id);
}

function tokensOnScene(): any[] {
  try {
    return [...((canvas as any)?.scene?.tokens ?? [])]
      .map((d: any) => d?.object ?? d)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function registerTransformWatch(): void {
  Hooks.on("updateActor", (actor: any) => {
    void stripLeftoverBadges(actor);
  });
  Hooks.on("updateToken", (doc: any, changed: any) => {
    if (changed?.actorId !== undefined || changed?.flags?.dnd5e) {
      void stripLeftoverBadges(doc?.actor);
    }
  });
  Hooks.on("canvasReady", () => {
    for (const token of tokensOnScene()) {
      void stripLeftoverBadges(token.actor ?? token.document?.actor);
    }
  });
  if ((canvas as any)?.ready) {
    for (const token of tokensOnScene()) {
      void stripLeftoverBadges(token.actor ?? token.document?.actor);
    }
  }
  debug("transform watch registered (restore is the character sheet)");
}

export function surveyTransform(): unknown {
  const tokens = tokensOnScene();
  const lines = [`transform: sheet restore only — ${tokens.length} token(s)`];
  for (const token of tokens) {
    const actor = token.actor ?? token.document?.actor;
    if (!actor) continue;
    const form = isPolymorphed(actor);
    const badges = [...(actor.effects ?? [])].filter(isTransformBadge);
    if (!form && !badges.length) continue;
    lines.push(
      `  ${String(token.name ?? actor.name)} polymorphed=${form} leftoverBadge=${badges.length}` +
        (badges.length ? " — STRIP on next sync" : ""),
    );
  }
  const block = lines.join("\n");
  log(block);
  return { text: block, tokens: tokens.length };
}
