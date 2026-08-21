// Token riding — sit on a larger creature, follow it, hop off.
//
// v1: eligibility, mount / dismount, follow after the mount moves, half-Speed stamp, stand aside
// for Rideable. Parked: Dash/Disengage/Dodge-only on a controlled mount, falling-off saves,
// opportunity-attack "you or the mount", anatomy, drag-onto-token automount.
//
// Rideable deletes `x`/`y` in `preUpdateToken`. We never do that. A rider who tries to walk is
// refused (`preMoveToken` returns false) and told to click the saddle. Follow uses
// `options.noodlrRiding === "follow"`, which `isForcedMovement` treats as displacement so it does
// not provoke a second OA.

import { GENERAL_SETTINGS, MODULE_ID, debug, log, warn } from "../constants";
import { centerOf, measureBetween, type Point } from "../core/positioning";
import { isRidingEnabled } from "../settings";
import { interactReach } from "./interact";
import {
  RIDING_FLAG,
  RIDING_STATUS_IMG,
  defaultControlled,
  encumbranceMaxOf,
  encumbranceValueOf,
  isOurRidingBadge,
  judgeMount,
  type MountCostStamp,
  type MountRefuse,
  mountCostFeet,
  mountCostFromStamp,
  registerRidingStatus,
  rideableOwns,
  ridingBadgePayload,
  sizeRankOf,
  walkSpeedOf,
} from "../system/dnd5e-riding";
import { FLAG_NAMESPACE, readFlag } from "../util/flags";
import { wireEffectClicks } from "../util/token-badge";

export interface RidingFlag {
  mount: string;
  controlled?: boolean;
}

const COST_FLAG = "mountCost";

function notify(key: string): void {
  try {
    ui.notifications?.warn(game.i18n.localize(key));
  } catch {
    /* courtesy */
  }
}

function info(key: string, data?: Record<string, string>): void {
  try {
    const text = data ? game.i18n.format(key, data) : game.i18n.localize(key);
    ui.notifications?.info(text);
  } catch {
    /* courtesy */
  }
}

function refuseKey(reason: MountRefuse): string {
  const map: Record<MountRefuse, string> = {
    rideable: "NOODLRHOOKS.General.Riding.Rideable",
    same: "NOODLRHOOKS.General.Riding.Same",
    "already-riding": "NOODLRHOOKS.General.Riding.AlreadyRiding",
    occupied: "NOODLRHOOKS.General.Riding.Occupied",
    loop: "NOODLRHOOKS.General.Riding.Loop",
    size: "NOODLRHOOKS.General.Riding.Size",
    disposition: "NOODLRHOOKS.General.Riding.Disposition",
    carrying: "NOODLRHOOKS.General.Riding.Carrying",
    "too-far": "NOODLRHOOKS.General.Riding.TooFar",
    speed: "NOODLRHOOKS.General.Riding.Speed",
  };
  return map[reason];
}

export function ridingOn(doc: any): RidingFlag | null {
  const raw = readFlag(doc, RIDING_FLAG);
  if (!raw || typeof raw !== "object") return null;
  const mount = String((raw as RidingFlag).mount ?? "");
  if (!mount) return null;
  return { mount, controlled: (raw as RidingFlag).controlled === true };
}

function tokenDoc(id: string): any | null {
  try {
    return (canvas as any)?.scene?.tokens?.get?.(id) ?? null;
  } catch {
    return null;
  }
}

function allTokenDocs(): any[] {
  try {
    return [...((canvas as any)?.scene?.tokens ?? [])].filter(Boolean);
  } catch {
    return [];
  }
}

function ridingMap(): Record<string, string | undefined> {
  const map: Record<string, string | undefined> = {};
  for (const doc of allTokenDocs()) {
    const flag = ridingOn(doc);
    if (flag) map[String(doc.id)] = flag.mount;
  }
  return map;
}

function ridersOf(mountId: string): any[] {
  return allTokenDocs().filter((doc) => ridingOn(doc)?.mount === mountId);
}

function dispositionOf(doc: any): number {
  const n = Number(doc?.disposition ?? doc?._source?.disposition);
  return Number.isFinite(n) ? n : 0;
}

function riderIsPlayer(doc: any): boolean {
  const actor = doc?.actor;
  if (!actor) return false;
  if (actor.type === "character") return true;
  try {
    return Boolean(actor.hasPlayerOwner);
  } catch {
    return false;
  }
}

function tokenRadiusFeet(doc: any, gridDistance: number): number {
  const w = Number(doc?.width) || 1;
  const h = Number(doc?.height) || 1;
  return (Math.max(w, h) / 2) * gridDistance;
}

export function withinMountReach(
  rider: any,
  mount: any,
  measure: (a: Point, b: Point) => number = measureBetween,
  gridDistance = interactReach(),
): boolean {
  const from = centerOf(rider);
  const to = centerOf(mount);
  if (!from || !to) return false;
  const reach = gridDistance + tokenRadiusFeet(rider, gridDistance) + tokenRadiusFeet(mount, gridDistance);
  return measure(from, to) <= reach + 0.05;
}

function seatOf(mount: any, rider: any): { x: number; y: number; elevation: number } | null {
  const gs = Number((canvas as any)?.grid?.size) || 100;
  const mx = Number(mount?._source?.x ?? mount?.x);
  const my = Number(mount?._source?.y ?? mount?.y);
  if (!Number.isFinite(mx) || !Number.isFinite(my)) return null;
  const mw = (Number(mount.width) || 1) * gs;
  const mh = (Number(mount.height) || 1) * gs;
  const rw = (Number(rider.width) || 1) * gs;
  const rh = (Number(rider.height) || 1) * gs;
  return {
    x: mx + mw / 2 - rw / 2,
    y: my + mh / 2 - rh / 2,
    elevation: Number(mount._source?.elevation ?? mount.elevation ?? 0),
  };
}

function combatStamp(actor: any): MountCostStamp | null {
  const combat = (game as any).combat;
  if (!combat?.started) return null;
  const combatant = actor?.token?.combatant ?? actor?.getActiveTokens?.()?.[0]?.combatant;
  if (!combatant) return null;
  const speed = walkSpeedOf(actor);
  const cost = speed === null ? 0 : mountCostFeet(speed);
  if (cost <= 0) return null;
  return {
    combat: String(combat.id ?? ""),
    combatant: String(combatant.id ?? ""),
    round: Number(combat.round) || 0,
    cost,
  };
}

export function mountCostThisTurn(actor: any, combat: any, combatant: any): number {
  const stamp = readFlag(actor, COST_FLAG) as MountCostStamp | undefined;
  return mountCostFromStamp(
    stamp,
    String(combat?.id ?? ""),
    String(combatant?.id ?? ""),
    Number(combat?.round) || 0,
  );
}

async function stampCost(actor: any): Promise<void> {
  const stamp = combatStamp(actor);
  if (!stamp || !actor) return;
  try {
    await actor.setFlag(FLAG_NAMESPACE, COST_FLAG, stamp);
  } catch (err) {
    warn("riding: could not stamp mount cost:", err);
  }
}

async function presentBadge(actor: any): Promise<void> {
  if (!actor?.isOwner) return;
  const existing = [...(actor.effects ?? [])].filter(isOurRidingBadge);
  if (existing.length > 1) {
    for (const extra of existing.slice(1)) {
      try {
        await extra.delete();
      } catch {
        /* leftover */
      }
    }
    return;
  }
  if (existing.length === 1) return;
  registerRidingStatus();
  try {
    await actor.createEmbeddedDocuments("ActiveEffect", [ridingBadgePayload(actor)]);
  } catch (err) {
    warn(`riding: could not present badge on ${String(actor.name)}:`, err);
  }
}

async function stripBadge(actor: any): Promise<void> {
  if (!actor?.isOwner) return;
  for (const effect of [...(actor.effects ?? [])].filter(isOurRidingBadge)) {
    try {
      await effect.delete();
    } catch (err) {
      warn(`riding: could not drop badge on ${String(actor.name)}:`, err);
    }
  }
}

function judgeDocs(rider: any, mount: any, opts?: { force?: boolean }): ReturnType<typeof judgeMount> {
  if (opts?.force) return { ok: true };
  const speed = walkSpeedOf(rider?.actor);
  const combatOn = Boolean((game as any).combat?.started);
  return judgeMount({
    rideableActive: rideableOwns(),
    riderId: String(rider.id),
    mountId: String(mount.id),
    riderAlreadyOn: ridingOn(rider)?.mount,
    mountHasRider: ridersOf(String(mount.id)).some((d) => d.id !== rider.id),
    ridingOf: ridingMap(),
    riderRank: sizeRankOf(rider.actor),
    mountRank: sizeRankOf(mount.actor),
    riderDisposition: dispositionOf(rider),
    mountDisposition: dispositionOf(mount),
    riderIsPlayer: riderIsPlayer(rider),
    mountMax: encumbranceMaxOf(mount.actor),
    riderBurden: encumbranceValueOf(rider.actor),
    inReach: withinMountReach(rider, mount),
    speed,
    checkSpeed: combatOn && speed !== null,
  });
}

async function followMount(rider: any, mount: any): Promise<void> {
  const seat = seatOf(mount, rider);
  if (!seat) return;
  const x = Number(rider._source?.x ?? rider.x);
  const y = Number(rider._source?.y ?? rider.y);
  const elev = Number(rider._source?.elevation ?? rider.elevation ?? 0);
  if (Math.abs(x - seat.x) < 1 && Math.abs(y - seat.y) < 1 && Math.abs(elev - seat.elevation) < 0.01) {
    return;
  }
  try {
    await rider.update(
      { x: Math.round(seat.x), y: Math.round(seat.y), elevation: seat.elevation },
      { noodlrRiding: "follow" },
    );
  } catch (err) {
    warn(`riding: follow failed for ${String(rider.name)}:`, err);
  }
}

async function syncControlledInitiative(rider: any, mount: any, controlled: boolean): Promise<void> {
  if (!controlled) return;
  const combat = (game as any).combat;
  if (!combat?.started) return;
  const riderC = rider.combatant;
  const mountC = mount.combatant;
  if (!riderC || !mountC) return;
  const init = Number(riderC.initiative);
  if (!Number.isFinite(init)) return;
  if (Number(mountC.initiative) === init) return;
  try {
    await mountC.update({ initiative: init });
  } catch (err) {
    debug("riding: could not match mount initiative:", err);
  }
}

export async function mountTokens(rider: any, mount: any, opts?: { force?: boolean }): Promise<boolean> {
  if (!isRidingEnabled() && !opts?.force) return false;
  if (rideableOwns()) {
    notify("NOODLRHOOKS.General.Riding.Rideable");
    return false;
  }
  const riderDoc = rider?.document ?? rider;
  const mountDoc = mount?.document ?? mount;
  if (!riderDoc || !mountDoc) return false;
  const verdict = judgeDocs(riderDoc, mountDoc, opts);
  if (!verdict.ok) {
    notify(refuseKey(verdict.reason));
    return false;
  }
  const controlled = defaultControlled(dispositionOf(mountDoc));
  try {
    await riderDoc.setFlag(FLAG_NAMESPACE, RIDING_FLAG, { mount: String(mountDoc.id), controlled });
    await stampCost(riderDoc.actor);
    await presentBadge(riderDoc.actor);
    await followMount(riderDoc, mountDoc);
    await syncControlledInitiative(riderDoc, mountDoc, controlled);
    info("NOODLRHOOKS.General.Riding.Mounted", {
      rider: String(riderDoc.name ?? "?"),
      mount: String(mountDoc.name ?? "?"),
    });
    return true;
  } catch (err) {
    warn("riding: mount failed:", err);
    return false;
  }
}

export async function dismountToken(rider: any, opts?: { silent?: boolean }): Promise<boolean> {
  const riderDoc = rider?.document ?? rider;
  if (!riderDoc || !ridingOn(riderDoc)) return false;
  try {
    await riderDoc.unsetFlag(FLAG_NAMESPACE, RIDING_FLAG);
    await stampCost(riderDoc.actor);
    await stripBadge(riderDoc.actor);
    if (!opts?.silent) {
      info("NOODLRHOOKS.General.Riding.Dismounted", { rider: String(riderDoc.name ?? "?") });
    }
    return true;
  } catch (err) {
    warn("riding: dismount failed:", err);
    return false;
  }
}

export async function mountSelected(): Promise<unknown> {
  const controlled = [...((canvas as any)?.tokens?.controlled ?? [])];
  const targets = [...((game as any)?.user?.targets ?? [])];
  if (!controlled.length) {
    notify("NOODLRHOOKS.General.Riding.NoSelection");
    return { ok: false };
  }
  if (!targets.length) {
    notify("NOODLRHOOKS.General.Riding.NoTarget");
    return { ok: false };
  }
  let n = 0;
  for (const rider of controlled) {
    for (const mount of targets) {
      if (await mountTokens(rider, mount)) n += 1;
    }
  }
  return { ok: n > 0, mounted: n };
}

export async function dismountSelected(): Promise<unknown> {
  const controlled = [...((canvas as any)?.tokens?.controlled ?? [])];
  if (!controlled.length) {
    notify("NOODLRHOOKS.General.Riding.NoSelection");
    return { ok: false };
  }
  let n = 0;
  for (const token of controlled) {
    if (await dismountToken(token)) n += 1;
  }
  return { ok: n > 0, dismounted: n };
}

function wireToken(token: any): void {
  if (!token || !isRidingEnabled()) return;
  wireEffectClicks(token, RIDING_STATUS_IMG, (t) => {
    void dismountToken(t?.document ?? t);
  });
}

function addHudButton(
  root: HTMLElement,
  attr: string,
  title: string,
  icon: string,
  onClick: () => void,
): void {
  const col = root.querySelector(".col.left");
  if (!col) return;
  if (col.querySelector(`[${attr}]`)) return;
  const btn = document.createElement("div");
  btn.className = "control-icon";
  btn.setAttribute(attr, "1");
  btn.title = title;
  btn.innerHTML = `<i class="${icon}"></i>`;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  });
  col.appendChild(btn);
}

function locChanged(changed: any): boolean {
  return changed?.x !== undefined || changed?.y !== undefined || changed?.elevation !== undefined;
}

export function registerRidingWatch(): void {
  registerRidingStatus();

  Hooks.on("preMoveToken", (doc: any, movement: any, operation: any) => {
    if (!isRidingEnabled()) return;
    if (rideableOwns()) return;
    if (operation?.noodlrRiding === "follow") return;
    if (!ridingOn(doc)) return;
    const method = String(movement?.method ?? "");
    if (method !== "dragging" && method !== "keyboard") return;
    notify("NOODLRHOOKS.General.Riding.WalkFirst");
    return false;
  });

  Hooks.on("updateToken", (doc: any, changed: any, operation: any) => {
    if (!isRidingEnabled() || rideableOwns()) return;
    if (operation?.noodlrRiding === "follow") return;
    if (!locChanged(changed)) return;
    for (const rider of ridersOf(String(doc.id))) {
      void followMount(rider, doc);
    }
  });

  Hooks.on("deleteToken", (doc: any) => {
    const id = String(doc?.id ?? "");
    if (!id) return;
    for (const rider of ridersOf(id)) {
      void dismountToken(rider, { silent: true });
    }
  });

  Hooks.on("refreshToken", (token: any) => {
    wireToken(token);
  });

  Hooks.on("canvasReady", () => {
    for (const token of (canvas as any)?.tokens?.placeables ?? []) wireToken(token);
  });

  Hooks.on("renderTokenHUD", (app: any, html: any) => {
    if (!isRidingEnabled() || rideableOwns()) return;
    const token = app?.object ?? app?.token;
    const doc = token?.document ?? token;
    if (!doc) return;
    const root: HTMLElement | null = html instanceof HTMLElement ? html : (html?.[0] ?? null);
    if (!root) return;
    if (ridingOn(doc)) {
      addHudButton(
        root,
        "data-noodlr-dismount",
        game.i18n.localize("NOODLRHOOKS.General.Riding.HudDismount"),
        "fa-solid fa-person-walking-arrow-right",
        () => {
          void dismountToken(doc);
        },
      );
      return;
    }
    const targets = [...((game as any)?.user?.targets ?? [])];
    if (!targets.length) return;
    addHudButton(
      root,
      "data-noodlr-mount",
      game.i18n.localize("NOODLRHOOKS.General.Riding.HudMount"),
      "fa-solid fa-horse",
      () => {
        void mountTokens(token, targets[0]);
      },
    );
  });

  if ((canvas as any)?.ready) {
    for (const token of (canvas as any)?.tokens?.placeables ?? []) wireToken(token);
  }

  Hooks.on("updateSetting", (_setting: any, _value: any, key?: string) => {
    if (key === `${MODULE_ID}.${GENERAL_SETTINGS.riding}` || key?.endsWith(`.${GENERAL_SETTINGS.riding}`)) {
      if (!isRidingEnabled()) {
        for (const doc of allTokenDocs()) {
          if (ridingOn(doc)) void dismountToken(doc, { silent: true });
        }
      }
    }
  });

  debug("riding watch registered");
}

export function surveyRiding(): unknown {
  const docs = allTokenDocs();
  const lines = [
    `riding: ${isRidingEnabled() ? "on" : "off"}` +
      (rideableOwns() ? " — standing aside for Rideable" : "") +
      ` — ${docs.length} token(s)`,
  ];
  for (const doc of docs) {
    const flag = ridingOn(doc);
    if (!flag) continue;
    const mount = tokenDoc(flag.mount);
    lines.push(
      `  ${String(doc.name)} on ${String(mount?.name ?? flag.mount)}` +
        (flag.controlled ? " (controlled)" : " (independent)"),
    );
  }
  const block = lines.join("\n");
  log(block);
  return { text: block, tokens: docs.length };
}
