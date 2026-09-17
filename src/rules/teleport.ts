// Self-range teleports (Misty Step) must land or the spend is undone.
//
// dnd5e consumes the slot in `Activity#use` and then does not auto-plan — TeleportActivity's
// `_triggerSubsequentActions` is an explicit TODO. `planTeleport` only runs if a token is
// already controlled; otherwise it warns and returns null with the slot already gone. An
// occupied destination under Movement Automation Full can also constrain a blink back to
// the origin while `moved === true`. Compare `_source`, then refund.

import { log } from "../constants";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  isSelfTeleport,
  shouldReplaceTeleportTokens,
  teleportActivationType,
  teleportLanded,
  tokenOrigin,
} from "../system/dnd5e-teleport";
import { speakerFor } from "../util/speaker";
import { isAutomating } from "./economy/enforce";
import { refund, slotFor } from "./economy/ledger";

let lastNote = "teleport: no self-teleport has been settled this session";
const settling = new Set<string>();

function note(line: string): void {
  lastNote = line;
  log(line);
}

function placeableOf(activity: any): any {
  const doc = typeof activity?.getUsageToken === "function" ? activity.getUsageToken() : null;
  const id = String(doc?.id ?? "");
  const layer: any[] = (globalThis as any).canvas?.tokens?.placeables ?? [];
  if (id) {
    const onCanvas = layer.find((t) => String(t?.id ?? t?.document?.id ?? "") === id);
    if (onCanvas) return onCanvas;
    if (doc?.object) return doc.object;
  }
  const actor = activity?.actor ?? activity?.item?.actor;
  const tokens: any[] = actor?.getActiveTokens?.(true) ?? actor?.getActiveTokens?.() ?? [];
  return tokens[0] ?? null;
}

function controlCaster(placeable: any): void {
  if (!placeable || typeof placeable.control !== "function") return;
  try {
    placeable.control({ releaseOthers: true });
  } catch {
    /* selection is a courtesy so planTeleport sees a token */
  }
}

function injectCasterToken(activity: any, config: any): boolean {
  if (!isSelfTeleport(activity)) return false;
  if (!config || typeof config !== "object") return false;
  const placeable = placeableOf(activity);
  if (!placeable) return false;
  const casterId = String(placeable?.id ?? placeable?.document?.id ?? "");
  const current = Array.isArray(config.tokens) ? config.tokens : [];
  const currentIds = current.map((t: any) => String(t?.id ?? t?.document?.id ?? ""));
  if (!shouldReplaceTeleportTokens(currentIds, casterId)) return false;
  controlCaster(placeable);
  config.tokens = [placeable];
  return true;
}

function snapshot(placeable: any): Map<string, { x: number; y: number }> {
  const map = new Map<string, { x: number; y: number }>();
  const origin = tokenOrigin(placeable);
  const id = String(placeable?.id ?? placeable?.document?.id ?? "");
  if (id && origin) map.set(id, origin);
  return map;
}

function landedAfter(before: Map<string, { x: number; y: number }>, placeable: any, planned: unknown): boolean {
  if (teleportLanded(before, planned)) return true;
  const id = String(placeable?.id ?? placeable?.document?.id ?? "");
  const prev = id ? before.get(id) : undefined;
  const now = tokenOrigin(placeable);
  return Boolean(prev && now && (prev.x !== now.x || prev.y !== now.y));
}

async function refundTeleport(activity: any, results: any): Promise<void> {
  const consumed = results?.updates ?? results?.message?.system?.deltas;
  try {
    if (consumed && typeof activity?.refund === "function") {
      await activity.refund(consumed);
    }
  } catch (err) {
    log("teleport: could not refund the consumed deltas:", err);
  }
  const slot = slotFor(teleportActivationType(activity));
  const actor = activity?.actor ?? activity?.item?.actor;
  const combat = (globalThis as any).game?.combat;
  const combatant =
    combat?.combatants?.find?.(
      (c: any) => c.actor === actor || String(c.actorId ?? "") === String(actor?.id ?? ""),
    ) ?? actor?.token?.combatant;
  if (slot && actor) {
    try {
      refund(actor, combat, combatant, slot);
    } catch (err) {
      log("teleport: could not refund the action slot:", err);
    }
  }
  const name = String(activity?.item?.name ?? activity?.name ?? "Teleport");
  const slotLabel = slot ?? "action";
  const i18n = (globalThis as any).game?.i18n;
  const warn =
    i18n?.localize?.("NOODLRHOOKS.Combat.Teleport.NoLand") ||
    "The teleport did not land. The spell slot and the action used to cast it have been returned.";
  try {
    (globalThis as any).ui?.notifications?.warn?.(warn);
  } catch {
    /* the chat line is the fallback */
  }
  const content =
    i18n?.format?.("NOODLRHOOKS.Combat.Teleport.Refunded", { name, slot: slotLabel }) ||
    `${name}'s teleport did not land — slot and ${slotLabel} returned.`;
  try {
    await (globalThis as any).ChatMessage?.create?.({
      speaker: speakerFor(actor),
      content,
    });
  } catch {
    /* notify already fired */
  }
  note(`teleport: ${name} did not land — refunded ${slotLabel}`);
}

async function finishSelfTeleport(activity: any, results: any): Promise<void> {
  const key = String(results?.message?.id ?? "");
  if (key) {
    if (settling.has(key)) return;
    settling.add(key);
  }
  const placeable = placeableOf(activity);
  controlCaster(placeable);
  const before = snapshot(placeable);
  let planned: unknown = null;
  try {
    if (typeof activity?.planTeleport === "function") {
      planned = await activity.planTeleport();
    }
  } catch (err) {
    log("teleport: planTeleport threw:", err);
    planned = null;
  }
  if (landedAfter(before, placeable, planned)) {
    note(`teleport: ${String(activity?.item?.name ?? "Teleport")} landed`);
    return;
  }
  await refundTeleport(activity, results);
}

export function registerTeleport(): void {
  if (!isDnd5e()) return;
  Hooks.on("dnd5e.preTeleport", (activity: any, config: any) => {
    try {
      if (injectCasterToken(activity, config)) {
        log("teleport: injected the caster token — planTeleport had nobody controlled");
      }
    } catch (err) {
      log("teleport: could not inject the caster:", err);
    }
  });
  Hooks.on("dnd5e.postUseActivity", (activity: any, _usage: any, results: any) => {
    try {
      if (!isSelfTeleport(activity)) return;
      if (isAutomating()) return;
      void finishSelfTeleport(activity, results);
    } catch (err) {
      log("teleport:", err);
    }
  });
}

export function surveyTeleport(): { report: string } {
  log(lastNote);
  return { report: lastNote };
}
