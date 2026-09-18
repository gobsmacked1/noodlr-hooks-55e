// Caster-hop teleports must land or the spend is undone.
//
// dnd5e consumes the slot in `Activity#use` and then does not auto-plan — TeleportActivity's
// `_triggerSubsequentActions` is an explicit TODO. `planTeleport` only runs if a token is
// already controlled; otherwise it warns and returns null with the slot already gone. An
// occupied destination under Movement Automation Full can also constrain a blink back to
// the origin while `moved === true`. Compare `_source`, then refund.

import { log } from "../constants";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  formatTeleportTrace,
  isSelfTeleport,
  originMoved,
  plannedDestinations,
  plannedHopSummary,
  shouldReplaceTeleportTokens,
  teleportActivationType,
  teleportClickHint,
  teleportDistanceLabel,
  teleportLanded,
  tokenOrigin,
} from "../system/dnd5e-teleport";
import { speakerFor } from "../util/speaker";
import { isAutomating } from "./economy/enforce";
import { refund, slotFor } from "./economy/ledger";

let lastNote = "teleport: no self-teleport has been settled this session";
const TRAIL_CAP = 24;
const trail: string[] = [];
const settling = new Set<string>();

function note(line: string): void {
  lastNote = line;
  trail.push(line);
  if (trail.length > TRAIL_CAP) trail.splice(0, trail.length - TRAIL_CAP);
  log(line);
}

function trace(step: string, facts: Record<string, string | number | boolean | null | undefined> = {}): void {
  note(`teleport: ${formatTeleportTrace(step, facts)}`);
}

function namesOf(tokens: Iterable<any> | null | undefined): string {
  const names: string[] = [];
  for (const token of tokens ?? []) {
    const name = String(token?.name ?? token?.document?.name ?? token?.id ?? "").trim();
    if (name) names.push(name);
  }
  return names.join(",") || "none";
}

function hopWorldFacts(activity: any, placeable: any): Record<string, string | number | boolean> {
  const origin = tokenOrigin(placeable);
  const canvas = (globalThis as any).canvas;
  const game = (globalThis as any).game;
  const autom = String(game?.settings?.get?.("dnd5e", "movementAutomation") ?? "unread");
  const tool = String(game?.activeTool ?? canvas?.activeLayer?.name ?? "");
  return {
    name: String(activity?.item?.name ?? activity?.name ?? "Teleport"),
    type: String(activity?.type ?? ""),
    self: isSelfTeleport(activity),
    auto: isAutomating(),
    canPlan: activity?.canPlanTeleport !== false,
    range: `${String(activity?.range?.units ?? "")}/${String(activity?.item?.system?.range?.units ?? "")}`,
    affects: String(activity?.target?.affects?.type ?? activity?.item?.system?.target?.affects?.type ?? ""),
    max: teleportDistanceLabel(activity) || "unread",
    origin: origin ? `${Math.round(origin.x)},${Math.round(origin.y)}` : "none",
    controlled: namesOf(canvas?.tokens?.controlled),
    targets: namesOf(game?.user?.targets),
    autom,
    tool: tool || "unread",
  };
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

function clearLeftoverTargets(): void {
  const targets = [...((globalThis as any).game?.user?.targets ?? [])];
  for (const token of targets) {
    try {
      token?.setTarget?.(false, { releaseOthers: false });
    } catch {
      /* a leftover that will not clear is still not the destination */
    }
  }
}

function promptEmptySquare(activity: any): void {
  const distance = teleportDistanceLabel(activity);
  const i18n = (globalThis as any).game?.i18n;
  const text =
    (distance
      ? i18n?.format?.("NOODLRHOOKS.Combat.Teleport.ClickSquare", { distance })
      : i18n?.localize?.("NOODLRHOOKS.Combat.Teleport.ClickSquareAny")) || teleportClickHint(distance);
  try {
    (globalThis as any).ui?.notifications?.info?.(text);
  } catch {
    /* the console line still names the click */
  }
  const name = String(activity?.item?.name ?? activity?.name ?? "Teleport");
  trace("awaiting-click", { name, max: distance || "unread" });
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

async function forceLand(planned: unknown, before: Map<string, { x: number; y: number }>): Promise<boolean> {
  let any = false;
  for (const { token, dest } of plannedDestinations(planned)) {
    const id = String(token?.id ?? token?.document?.id ?? "");
    const prev = id ? before.get(id) : undefined;
    if (prev && prev.x === dest.x && prev.y === dest.y) continue;
    const doc = token?.document ?? token;
    if (typeof doc?.move !== "function") continue;
    const actions: any = (globalThis as any).CONFIG?.Token?.movement?.actions;
    const action = actions?.blink ? "blink" : actions?.displace ? "displace" : undefined;
    const waypoint: Record<string, unknown> = {
      x: Math.round(dest.x),
      y: Math.round(dest.y),
      explicit: true,
      checkpoint: true,
    };
    if (Number.isFinite(dest.elevation as number)) waypoint.elevation = dest.elevation;
    if (action) waypoint.action = action;
    try {
      await doc.move(waypoint, {
        method: "api",
        constrainOptions: { ignoreWalls: true, ignoreCost: true, ignoreTokens: true },
        autoRotate: false,
        showRuler: false,
      });
    } catch (err) {
      log("teleport: force-land threw:", err);
      continue;
    }
    if (originMoved(prev ?? null, tokenOrigin(token))) any = true;
  }
  return any;
}

async function refundTeleport(activity: any, results: any): Promise<void> {
  const consumed = results?.message?.system?.deltas;
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
  trace("refund", { name, slot: slotLabel });
}

/** Chat-card Teleport never hits `postUseActivity` — force-land the plan if the blink snapped home. */
async function settlePlannedHop(activity: any, results: any): Promise<void> {
  const dests = plannedDestinations(results);
  if (
    dests.some(({ token, dest }) => {
      const now = tokenOrigin(token);
      return Boolean(now && now.x === dest.x && now.y === dest.y);
    })
  ) {
    trace("landed", { name: String(activity?.item?.name ?? "Teleport"), how: "card" });
    return;
  }
  const before = snapshot(placeableOf(activity));
  if (await forceLand(results, before)) {
    trace("force-land", { name: String(activity?.item?.name ?? "Teleport"), how: "card" });
  }
}

async function finishSelfTeleport(activity: any, results: any): Promise<void> {
  const key = String(results?.message?.id ?? "");
  if (key) {
    if (settling.has(key)) {
      trace("settle-skip", { name: String(activity?.item?.name ?? "Teleport"), why: "already-settling" });
      return;
    }
    settling.add(key);
  }
  const placeable = placeableOf(activity);
  controlCaster(placeable);
  const before = snapshot(placeable);
  trace("plan-open", hopWorldFacts(activity, placeable));
  const started = Date.now();
  let planned: unknown = null;
  try {
    if (typeof activity?.planTeleport === "function") {
      planned = await activity.planTeleport();
    } else {
      trace("plan-abort", { why: "no-planTeleport" });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    trace("plan-throw", { why: reason || err?.constructor?.name || "Error" });
    planned = null;
  }
  const hop = plannedHopSummary(planned);
  const now = tokenOrigin(placeable);
  trace("plan-done", {
    dest: hop.dest,
    movedFlag: hop.movedFlag,
    rows: hop.rows,
    source: now ? `${Math.round(now.x)},${Math.round(now.y)}` : "none",
    ms: Date.now() - started,
  });
  if (landedAfter(before, placeable, planned)) {
    trace("landed", { name: String(activity?.item?.name ?? "Teleport"), how: "plan" });
    return;
  }
  if (await forceLand(planned, before)) {
    const after = tokenOrigin(placeable);
    trace("force-land", {
      name: String(activity?.item?.name ?? "Teleport"),
      source: after ? `${Math.round(after.x)},${Math.round(after.y)}` : "none",
    });
    return;
  }
  await refundTeleport(activity, results);
}

export function registerTeleport(): void {
  if (!isDnd5e()) return;
  Hooks.on("dnd5e.preTeleport", (activity: any, config: any) => {
    try {
      const leftover = [...((globalThis as any).game?.user?.targets ?? [])].length;
      const injected = injectCasterToken(activity, config);
      if (isSelfTeleport(activity)) {
        clearLeftoverTargets();
        promptEmptySquare(activity);
      }
      trace("pre", {
        name: String(activity?.item?.name ?? "Teleport"),
        self: isSelfTeleport(activity),
        injected,
        tokens: namesOf(config?.tokens),
        leftover,
        max: Number.isFinite(config?.maxDistance) ? config.maxDistance : "unread",
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      trace("pre-throw", { why: reason || "Error" });
    }
  });
  Hooks.on("dnd5e.preUseActivity", (activity: any) => {
    try {
      if (String(activity?.type ?? "").toLowerCase() !== "teleport" && !isSelfTeleport(activity)) return;
      trace("use", hopWorldFacts(activity, placeableOf(activity)));
    } catch {
      /* diagnostic only */
    }
  });
  Hooks.on("dnd5e.postUseActivity", (activity: any, _usage: any, results: any) => {
    try {
      if (String(activity?.type ?? "").toLowerCase() !== "teleport" && !isSelfTeleport(activity)) return;
      if (!isSelfTeleport(activity)) {
        trace("post-skip", { why: "not-self", type: String(activity?.type ?? "") });
        return;
      }
      if (isAutomating()) {
        trace("post-skip", { why: "automating" });
        return;
      }
      void finishSelfTeleport(activity, results);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      trace("post-throw", { why: reason || "Error" });
    }
  });
  Hooks.on("dnd5e.postTeleport", (activity: any, results: any) => {
    try {
      const hop = plannedHopSummary(results);
      trace("post-teleport", {
        name: String(activity?.item?.name ?? "Teleport"),
        self: isSelfTeleport(activity),
        dest: hop.dest,
        movedFlag: hop.movedFlag,
      });
      if (!isSelfTeleport(activity)) return;
      if (isAutomating()) return;
      void settlePlannedHop(activity, results);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      trace("post-teleport-throw", { why: reason || "Error" });
    }
  });
}

export function surveyTeleport(): { report: string } {
  const report = trail.length ? trail.join("\n") : lastNote;
  log(report);
  return { report };
}
