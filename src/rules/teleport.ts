// Caster-hop teleports must land or the spend is undone.
//
// dnd5e consumes the slot in `Activity#use` and then does not auto-plan — TeleportActivity's
// `_triggerSubsequentActions` is an explicit TODO. Foundry's own `#planTeleport` then waits
// for `token.planMovement` — a drag-the-token ruler. A hop can go through walls, so a drag
// is the wrong capture. We take one canvas click, blink there with walls ignored, and never
// call `planTeleport` for a self hop. Occupied dest under Movement Automation Full can still
// constrain a blink back to the origin while `moved === true`. Compare `_source`, then refund.

import { log } from "../constants";
import { isDnd5e } from "../system/dnd5e-rewards";
import { measureBetween } from "../core/positioning";
import {
  formatTeleportTrace,
  hopCenterFromCorner,
  hopIsSameSquare,
  hopSquareFromClick,
  hopWithinRange,
  isSelfTeleport,
  originMoved,
  plannedDestinations,
  plannedHopSummary,
  shouldReplaceTeleportTokens,
  teleportActivationType,
  teleportClickHint,
  teleportClickIsOnBoard,
  teleportDistanceLabel,
  teleportLanded,
  teleportMaxDistance,
  tokenOrigin,
} from "../system/dnd5e-teleport";
import { speakerFor } from "../util/speaker";
import { isAutomating } from "./economy/enforce";
import { refund, slotFor } from "./economy/ledger";

let lastNote = "teleport: no self-teleport has been settled this session";
const TRAIL_CAP = 24;
const trail: string[] = [];
const settling = new Set<string>();
const lastUseResults = new WeakMap<object, any>();
let pickActive = false;

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
    /* selection is a courtesy so the player sees who is hopping */
  }
}

function cancelFoundryPlanner(placeable: any): void {
  try {
    if (placeable?._movementPlanningContext) placeable._cancelMovementPlanning?.();
  } catch {
    /* a leftover drag planner from a previous hop must not steal this click */
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

function notify(text: string, kind: "info" | "warn" = "info"): void {
  try {
    (globalThis as any).ui?.notifications?.[kind]?.(text);
  } catch {
    /* the console line still names the click */
  }
}

function promptClickDestination(activity: any): void {
  const distance = teleportDistanceLabel(activity);
  const i18n = (globalThis as any).game?.i18n;
  const text =
    (distance
      ? i18n?.format?.("NOODLRHOOKS.Combat.Teleport.ClickSquare", { distance })
      : i18n?.localize?.("NOODLRHOOKS.Combat.Teleport.ClickSquareAny")) || teleportClickHint(distance);
  notify(text);
  const name = String(activity?.item?.name ?? activity?.name ?? "Teleport");
  trace("awaiting-click", { name, max: distance || "unread" });
}

function boardElement(): EventTarget | null {
  const canvas = (globalThis as any).canvas;
  return canvas?.app?.canvas ?? canvas?.app?.view ?? (globalThis as any).document?.getElementById?.("board") ?? null;
}

function gridSize(): number {
  return Number((globalThis as any).canvas?.grid?.size) || 100;
}

function snapHopCorner(placeable: any, click: { x: number; y: number }): { x: number; y: number } {
  const canvas = (globalThis as any).canvas;
  const grid = canvas?.grid;
  let corner = hopSquareFromClick(click, gridSize());
  try {
    const top = typeof grid?.getTopLeftPoint === "function" ? grid.getTopLeftPoint(click) : null;
    if (Number.isFinite(top?.x) && Number.isFinite(top?.y)) corner = { x: top.x, y: top.y };
  } catch {
    /* hopSquareFromClick is the fallback */
  }
  const doc = placeable?.document ?? placeable;
  try {
    const snapped = doc?.getSnappedPosition?.(corner);
    if (Number.isFinite(snapped?.x) && Number.isFinite(snapped?.y)) return { x: snapped.x, y: snapped.y };
  } catch {
    /* unsnapped square is still a destination */
  }
  return { x: Math.round(corner.x), y: Math.round(corner.y) };
}

function clickCanvasPoint(event: PointerEvent): { x: number; y: number } | null {
  const canvas = (globalThis as any).canvas;
  try {
    const pos = canvas?.canvasCoordinatesFromClient?.({ x: event.clientX, y: event.clientY });
    if (Number.isFinite(pos?.x) && Number.isFinite(pos?.y)) return { x: pos.x, y: pos.y };
  } catch {
    /* no board */
  }
  return null;
}

function hopRangeOk(activity: any, placeable: any, dest: { x: number; y: number }): boolean {
  const max = teleportMaxDistance(activity);
  const origin = tokenOrigin(placeable);
  if (!origin) return true;
  const doc = placeable?.document ?? placeable;
  const from = hopCenterFromCorner(origin, doc, gridSize());
  const to = hopCenterFromCorner(dest, doc, gridSize());
  return hopWithinRange(measureBetween(from, to), max);
}

function pickHopClick(activity: any, placeable: any): Promise<{ x: number; y: number; elevation?: number } | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: { x: number; y: number; elevation?: number } | null) => {
      if (done) return;
      done = true;
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      trace("pick-cancel", { why: "escape" });
      finish(null);
    };
    const onPointer = (event: PointerEvent) => {
      if (done) return;
      if (!teleportClickIsOnBoard(event.target, boardElement())) return;
      if (event.button === 2) {
        event.preventDefault();
        event.stopImmediatePropagation();
        trace("pick-cancel", { why: "right-click" });
        finish(null);
        return;
      }
      if (event.button !== 0) return;
      const click = clickCanvasPoint(event);
      if (!click) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const dest = snapHopCorner(placeable, click);
      const origin = tokenOrigin(placeable);
      const distance = teleportDistanceLabel(activity);
      const i18n = (globalThis as any).game?.i18n;
      if (hopIsSameSquare(origin, dest)) {
        notify(
          i18n?.localize?.("NOODLRHOOKS.Combat.Teleport.SameSquare") ||
            "That is where you already stand. Click a different square, or press Esc to cancel.",
          "warn",
        );
        trace("click-same", { dest: `${Math.round(dest.x)},${Math.round(dest.y)}` });
        return;
      }
      if (!hopRangeOk(activity, placeable, dest)) {
        notify(
          (distance
            ? i18n?.format?.("NOODLRHOOKS.Combat.Teleport.TooFar", { distance })
            : i18n?.localize?.("NOODLRHOOKS.Combat.Teleport.TooFar")) ||
            `That square is too far${distance ? ` (max ${distance})` : ""}. Click a closer spot, or press Esc to cancel.`,
          "warn",
        );
        trace("click-far", { dest: `${Math.round(dest.x)},${Math.round(dest.y)}`, max: distance || "unread" });
        return;
      }
      const elevation = Number(placeable?.document?.elevation ?? placeable?.elevation);
      trace("click", { dest: `${Math.round(dest.x)},${Math.round(dest.y)}` });
      finish(Number.isFinite(elevation) ? { ...dest, elevation } : dest);
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
  });
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
  const key = String(results?.message?.id ?? activity?.uuid ?? activity?.id ?? "hop");
  if (settling.has(key) || pickActive) {
    trace("settle-skip", { name: String(activity?.item?.name ?? "Teleport"), why: pickActive ? "picking" : "already-settling" });
    return;
  }
  settling.add(key);
  pickActive = true;
  const placeable = placeableOf(activity);
  cancelFoundryPlanner(placeable);
  clearLeftoverTargets();
  controlCaster(placeable);
  const before = snapshot(placeable);
  trace("pick-open", hopWorldFacts(activity, placeable));
  promptClickDestination(activity);
  const started = Date.now();
  let dest: { x: number; y: number; elevation?: number } | null = null;
  try {
    dest = placeable ? await pickHopClick(activity, placeable) : null;
    if (!placeable) trace("pick-abort", { why: "no-token" });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    trace("pick-throw", { why: reason || err?.constructor?.name || "Error" });
    dest = null;
  } finally {
    pickActive = false;
  }
  const now = tokenOrigin(placeable);
  trace("pick-done", {
    dest: dest ? `${Math.round(dest.x)},${Math.round(dest.y)}` : "none",
    source: now ? `${Math.round(now.x)},${Math.round(now.y)}` : "none",
    ms: Date.now() - started,
  });
  if (!dest) {
    settling.delete(key);
    await refundTeleport(activity, results);
    return;
  }
  const planned = [{ token: placeable, plan: { destination: dest } }];
  if (await forceLand(planned, before)) {
    const after = tokenOrigin(placeable);
    if (landedAfter(before, placeable, planned)) {
      trace("landed", {
        name: String(activity?.item?.name ?? "Teleport"),
        how: "click",
        dest: `${Math.round(dest.x)},${Math.round(dest.y)}`,
        source: after ? `${Math.round(after.x)},${Math.round(after.y)}` : "none",
      });
    } else {
      trace("force-land", {
        name: String(activity?.item?.name ?? "Teleport"),
        dest: `${Math.round(dest.x)},${Math.round(dest.y)}`,
        source: after ? `${Math.round(after.x)},${Math.round(after.y)}` : "none",
      });
    }
    return;
  }
  settling.delete(key);
  await refundTeleport(activity, results);
}

export function registerTeleport(): void {
  if (!isDnd5e()) return;
  Hooks.on("dnd5e.preTeleport", (activity: any, config: any) => {
    try {
      const leftover = [...((globalThis as any).game?.user?.targets ?? [])].length;
      const injected = injectCasterToken(activity, config);
      if (isSelfTeleport(activity) && !isAutomating()) {
        clearLeftoverTargets();
        cancelFoundryPlanner(placeableOf(activity));
        trace("pre", {
          name: String(activity?.item?.name ?? "Teleport"),
          self: true,
          veto: "click-not-drag",
          injected,
          leftover,
          max: Number.isFinite(config?.maxDistance) ? config.maxDistance : "unread",
        });
        const prior = lastUseResults.get(activity);
        if (!pickActive) void finishSelfTeleport(activity, prior ?? { message: null });
        return false;
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
      if (activity) lastUseResults.set(activity, results);
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
