// Dual-mode weapons: ask before a throw, spend one, pin a Tile unless Returning.
//
// `preUseActivity` is synchronous, so the prompt cannot live inside the hook.
// Same shape as the economy over-budget dialog: veto, ask, replay with
// `attackMode: "thrown"`. The replay does NOT use `cleared` — the first press
// never reached the ledger (range sits before the charge), so the retry has to
// be a normal use.
//
// dnd5e decrements quantity on a thrown attack that is not `ret`. We snapshot
// the count in `preRollAttack` and spend only if that decrement never landed.
// A name-only "Returning" match is restored if dnd5e already spent it.
//
// The pin is a scene Tile, not an Actor/Token. Dropping as `npc` made a Huge
// dagger, a creature sheet, and a loot-randomizer prompt — and a Token riding
// the target would vanish if that creature fled. Tiles stay on the scene.
// Tile create/delete is world rights: `askGm`.
//
// There is no Recover chat card. Hunting one button per dagger is the pace
// failure. A player vacuums every pin they own within 5 ft — one scoop, not
// one button. Walking onto that reach, the Token HUD, and a won fight each
// run the same test. Mercy leaves them (the captors hold the field). Out of
// combat there is nothing to pin for: the weapon stays in hand. NPC pins
// stay on the scene for HUD loot. Leftover `npc` tokens from v0.7.64 still
// pick up.

import { MODULE_ID, log } from "../constants";
import { isAttackRangeEnabled } from "../settings";
import { looksLikeVictory } from "./ammo";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  attackModeIsThrown,
  hasReturningProperty,
  hasThrownProperty,
  isReturningWeapon,
  isPlayerThrower,
  pinIsPlayerOwned,
  pinSizePx,
  quantityAfterThrow,
  thrownLootPayload,
  thrownStacksMatch,
  vacuumItemsLabel,
  withinPickupReach,
} from "../system/dnd5e-thrown";
import { shouldAutomate } from "../tactics/registry";
import { isPrimaryGM } from "../util/gm";
import { promptChoice } from "../util/prompt";
import { askGm, registerQuery } from "../util/queries";
import { speakerFor } from "../util/speaker";

const DROP_QUERY = "thrown-drop";
const CLEAR_QUERY = "thrown-clear";
const asking = new Set<string>();
const pendingThrow = new Set<string>();
const qtyBefore = new Map<string, { qty: number; at: number }>();
const vacuumed = new Set<string>();

function combatIdOf(combat: any): string {
  return String(combat?.id ?? "");
}

interface DropRequest {
  item: Record<string, unknown>;
  sceneId: string;
  x: number;
  y: number;
  name: string;
  img: string;
  ownerId?: string;
  ownerUuid?: string;
  ownerType?: string;
  playerOwned?: boolean;
}

interface ClearRequest {
  tileId?: string;
  tileIds?: string[];
  tokenId?: string;
  actorId?: string;
  sceneId: string;
}

export function notePendingThrow(activityUuid: string): void {
  if (!activityUuid) return;
  pendingThrow.add(activityUuid);
  setTimeout(() => pendingThrow.delete(activityUuid), 15_000);
}

export function isPendingThrow(activity: any): boolean {
  const uuid = String(activity?.uuid ?? "");
  return Boolean(uuid && pendingThrow.has(uuid));
}

function snapshotQuantity(item: any): void {
  const uuid = String(item?.uuid ?? "");
  const qty = Number(item?.system?.quantity);
  if (!uuid || !Number.isFinite(qty)) return;
  qtyBefore.set(uuid, { qty, at: Date.now() });
  setTimeout(() => {
    const rec = qtyBefore.get(uuid);
    if (rec && Date.now() - rec.at >= 14_000) qtyBefore.delete(uuid);
  }, 15_000);
}

/**
 * Ask whether to throw, then replay the use as a thrown attack.
 *
 * `driven` creatures throw without a dialog — the planner already chose the
 * thrown offering, and this path is the backstop when `attackMode` never
 * arrived. A timeout declines: losing the weapon is depleting.
 */
export function askThenThrow(
  activity: any,
  usageConfig: any,
  dialogConfig: any,
  messageConfig: any,
  opts: { name: string; distance: number; short: number; long: number; driven: boolean },
): void {
  const key = String(activity?.uuid ?? activity?.item?.uuid ?? "");
  if (!key || asking.has(key)) return;
  asking.add(key);
  void (async () => {
    try {
      const automating = opts.driven || shouldAutomate(activity?.actor);
      if (!automating) {
        const choice = await promptChoice({
          title: game.i18n.localize("NOODLRHOOKS.Combat.AttackRange.ThrowTitle"),
          body: game.i18n.format("NOODLRHOOKS.Combat.AttackRange.ThrowBody", {
            name: opts.name,
            distance: String(Math.round(opts.distance)),
            short: String(Math.round(opts.short)),
            long: String(Math.round(opts.long)),
          }),
          choices: [
            {
              id: "throw",
              label: game.i18n.localize("NOODLRHOOKS.Combat.AttackRange.ThrowYes"),
              hint: game.i18n.localize("NOODLRHOOKS.Combat.AttackRange.ThrowYesHint"),
            },
            {
              id: "cancel",
              label: game.i18n.localize("NOODLRHOOKS.Combat.AttackRange.ThrowNo"),
              hint: game.i18n.localize("NOODLRHOOKS.Combat.AttackRange.ThrowNoHint"),
            },
          ],
          defaultId: "cancel",
        });
        if (choice !== "throw") {
          log(`thrown: ${opts.name} stayed in hand (${Math.round(opts.distance)} ft)`);
          return;
        }
      }
      await replayThrown(activity, usageConfig, dialogConfig, messageConfig);
    } catch (err) {
      log("thrown: ask failed:", err);
    } finally {
      asking.delete(key);
    }
  })();
}

async function replayThrown(
  activity: any,
  usageConfig: any,
  dialogConfig: any,
  messageConfig: any,
): Promise<void> {
  const uuid = String(activity?.uuid ?? "");
  notePendingThrow(uuid);
  snapshotQuantity(activity?.item);
  const nextUsage = { ...(usageConfig ?? {}), attackMode: "thrown" };
  try {
    const last = activity?.item?.getFlag?.("dnd5e", `last.${activity.id}`);
    if (activity?.item?.setFlag) {
      await activity.item.setFlag("dnd5e", `last.${activity.id}`, {
        ...(last && typeof last === "object" ? last : {}),
        attackMode: "thrown",
      });
    }
  } catch (err) {
    log("thrown: could not stamp last attackMode:", err);
  }
  try {
    await activity.use(nextUsage, dialogConfig ?? {}, messageConfig ?? {});
  } catch (err) {
    log("thrown: replay did not resolve:", err);
  }
}

export function registerThrown(): void {
  registerQuery(DROP_QUERY, async (data: any) => {
    if (!isPrimaryGM()) return { ok: false };
    return await dropPin(data?.request as DropRequest | undefined);
  });
  registerQuery(CLEAR_QUERY, async (data: any) => {
    if (!isPrimaryGM()) return { ok: false };
    return await clearPin(data?.request as ClearRequest | undefined);
  });

  if (!isDnd5e()) return;
  const Hooks = (globalThis as any).Hooks;
  if (!Hooks?.on) return;

  // V1 only — mutation is idempotent, but the V1/V2 pair is the Lucky trap.
  Hooks.on("dnd5e.preRollAttack", (config: any, dialog: any) => applyPendingMode(config, dialog));

  Hooks.on("dnd5e.postRollAttack", (rolls: any[], data: any) => {
    try {
      void afterThrownRoll(rolls, data);
    } catch (err) {
      log("thrown: postRollAttack failed:", err);
    }
  });

  Hooks.on("combatStart", (combat: any) => {
    vacuumed.delete(combatIdOf(combat));
  });
  Hooks.on("deleteCombat", (combat: any) => {
    try {
      void vacuumPlayerThrown(combat);
    } catch (err) {
      log("thrown: deleteCombat vacuum failed:", err);
    }
  });
  Hooks.on("updateToken", (doc: any, changed: any) => {
    if (changed?.x == null && changed?.y == null && changed?.elevation == null) return;
    scheduleWalkVacuum(doc);
  });

  Hooks.on("renderTokenHUD", (app: any, html: any) => {
    if (!isAttackRangeEnabled()) return;
    const token = app?.object ?? app?.token;
    const doc = token?.document ?? token;
    const root: HTMLElement | null = html instanceof HTMLElement ? html : (html?.[0] ?? null);
    if (!root) return;
    if (isLootToken(doc)) {
      addHudPickup(root, () => void pickupLeftoverToken(doc));
      return;
    }
    if (hasVacuumableNear(doc)) {
      addHudPickup(root, () => void vacuumAround(doc, { ownerOnly: true, actor: doc.actor }));
      return;
    }
    const pin = nearestReachableTile(doc);
    if (pin) addHudPickup(root, () => void pickupTile(pin, { ignoreDistance: false }));
  });

  Hooks.on("renderTileHUD", (app: any, html: any) => {
    if (!isAttackRangeEnabled()) return;
    const tile = app?.object ?? app?.document;
    const doc = tile?.document ?? tile;
    if (!isLootTile(doc)) return;
    const root: HTMLElement | null = html instanceof HTMLElement ? html : (html?.[0] ?? null);
    if (!root) return;
    addHudPickup(root, () => void pickupTile(doc, { ignoreDistance: Boolean(game.user?.isGM) }));
  });
}

function addHudPickup(root: HTMLElement, onClick: () => void): void {
  const col = root.querySelector(".col.left");
  if (!col || col.querySelector("[data-noodlr-pickup]")) return;
  const btn = document.createElement("div");
  btn.className = "control-icon";
  btn.setAttribute("data-noodlr-pickup", "1");
  btn.title = game.i18n.localize("NOODLRHOOKS.Combat.AttackRange.HudPickup");
  btn.innerHTML = `<i class="fa-solid fa-hand"></i>`;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  });
  col.appendChild(btn);
}

function applyPendingMode(config: any, dialog?: any): void {
  const subject = config?.subject;
  const activity = subject?.type ? subject : subject?.activity ?? subject;
  const pending = isPendingThrow(activity);
  if (pending) {
    config.attackMode = "thrown";
    const opts = config.rolls?.[0]?.options;
    if (opts && typeof opts === "object") opts.attackMode = "thrown";
    // They already answered Throw. Leaving the attack dialog open lets them pick
    // oneHanded and stab from 35 feet after the range gate has passed.
    if (dialog && typeof dialog === "object") dialog.configure = false;
  }
  const item = activity?.item;
  const mode = config?.attackMode ?? config?.rolls?.[0]?.options?.attackMode;
  if (pending || attackModeIsThrown(mode) || hasThrownProperty(item)) {
    snapshotQuantity(item);
  }
}

async function afterThrownRoll(rolls: any[], data: any): Promise<void> {
  if (!isAttackRangeEnabled()) return;
  const activity = data?.subject;
  const last = activity?.item?.getFlag?.("dnd5e", `last.${activity?.id}`);
  const mode = rolls?.[0]?.options?.attackMode ?? last?.attackMode;
  if (!attackModeIsThrown(mode)) return;
  const item = activity?.item;
  if (!item) return;

  const returning = isReturningWeapon(item);
  if (returning) {
    if (!hasReturningProperty(item)) {
      const qty = Number(item.system?.quantity);
      if (Number.isFinite(qty)) {
        try {
          await item.update({ "system.quantity": qty + 1 });
        } catch (err) {
          log("thrown: could not restore a name-only Returning weapon:", err);
        }
      }
    }
    log(`thrown: ${String(item.name)} returns to the hand`);
    return;
  }

  const payload = thrownLootPayload(item);
  if (!payload) return;
  const actor = item.actor;
  const emptied = await spendThrown(item, actor);
  const playerOwned = isPlayerThrower(actor);

  // Out of combat there is no fight to walk back to. The spend already
  // happened; put the copy back so the sheet never lost it.
  if (playerOwned && !(game as any).combat?.started) {
    await restoreThrown(actor, item, payload, emptied);
    log(`thrown: ${String(item.name)} stays with ${actor?.name} (no fight to pin for)`);
    return;
  }

  const target = landingSpot(activity);
  const scene = (canvas as any)?.scene;
  if (!scene || !target) {
    log("thrown: no scene or landing to drop on");
    await restoreThrown(actor, item, payload, emptied);
    return;
  }

  const request: DropRequest = {
    item: payload,
    sceneId: String(scene.id),
    x: target.x,
    y: target.y,
    name: String(item.name ?? payload.name ?? "weapon"),
    img: String(item.img ?? payload.img ?? ""),
    ownerId: String(actor?.id ?? ""),
    ownerUuid: String(actor?.uuid ?? ""),
    ownerType: String(actor?.type ?? ""),
    playerOwned,
  };
  const result = await askGm<{ ok: boolean; tileId?: string }>(
    DROP_QUERY,
    { request },
    { timeout: 20_000 },
  );
  if (!result?.ok) {
    log(`thrown: could not pin ${request.name} on the scene`);
    await restoreThrown(actor, item, payload, emptied);
    return;
  }
  await announceLanded(actor, request.name, target.name);
}

async function spendThrown(item: any, actor: any): Promise<boolean> {
  const uuid = String(item?.uuid ?? "");
  const snap = qtyBefore.get(uuid);
  if (uuid) qtyBefore.delete(uuid);
  const live = actor?.items?.get?.(item.id) ?? item;
  const after = Number(live?.system?.quantity);
  const before = snap?.qty ?? after;
  const { next, alreadySpent } = quantityAfterThrow(before, after);
  if (!actor?.isOwner) return Number.isFinite(next) && next <= 0;
  try {
    if (!alreadySpent && live && Number.isFinite(after) && next !== after) {
      await live.update({ "system.quantity": next });
    }
    if (next <= 0 && live?.id) {
      await actor.deleteEmbeddedDocuments("Item", [live.id]);
      return true;
    }
  } catch (err) {
    log("thrown: could not spend the thrown weapon:", err);
  }
  return false;
}

async function announceLanded(actor: any, name: string, targetName: string | undefined): Promise<void> {
  const line = targetName
    ? game.i18n.format("NOODLRHOOKS.Combat.AttackRange.LandsNear", {
        name: escape(name),
        target: escape(targetName),
      })
    : game.i18n.format("NOODLRHOOKS.Combat.AttackRange.Dropped", { name: escape(name) });
  try {
    const ChatMessage = (globalThis as any).ChatMessage;
    await ChatMessage.create({
      content: `<p>${line}</p>`,
      speaker: speakerFor(actor, String(actor?.name ?? "")),
    });
  } catch (err) {
    log("thrown: could not announce the landing:", err);
  }
}

async function restoreThrown(
  actor: any,
  item: any,
  payload: Record<string, unknown>,
  emptied: boolean,
): Promise<void> {
  if (!actor?.isOwner) return;
  try {
    if (emptied) await actor.createEmbeddedDocuments("Item", [payload]);
    else {
      const live = actor.items?.get?.(item.id);
      const now = Number(live?.system?.quantity);
      if (live && Number.isFinite(now)) await live.update({ "system.quantity": now + 1 });
    }
  } catch (err) {
    log("thrown: could not put the weapon back after a failed pin:", err);
  }
}

function landingSpot(activity: any): { x: number; y: number; name?: string } | null {
  const live = [...((game as any)?.user?.targets ?? [])];
  const token = live[0] ?? null;
  const doc = token?.document ?? token;
  const x = Number(doc?.x);
  const y = Number(doc?.y);
  const size = Number((canvas as any)?.grid?.size) || 100;
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return {
      x: Math.round(x + size * 0.25),
      y: Math.round(y + size * 0.25),
      name: String(doc?.name ?? token?.name ?? ""),
    };
  }
  const from = activity?.actor?.getActiveTokens?.()?.[0] ?? activity?.actor?.token;
  const fx = Number(from?.document?.x ?? from?.x);
  const fy = Number(from?.document?.y ?? from?.y);
  if (Number.isFinite(fx) && Number.isFinite(fy)) return { x: fx, y: fy };
  return null;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "unknown");
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === "&"
      ? "&amp;"
      : ch === "<"
        ? "&lt;"
        : ch === ">"
          ? "&gt;"
          : ch === '"'
            ? "&quot;"
            : "&#39;",
  );
}

async function dropPin(request: DropRequest | undefined): Promise<{ ok: boolean; tileId?: string }> {
  if (!request?.sceneId || !request.item) return { ok: false };
  const scene = (game as any)?.scenes?.get?.(request.sceneId);
  if (!scene?.createEmbeddedDocuments) return { ok: false };
  const size = pinSizePx(Number(scene.grid?.size ?? (canvas as any)?.grid?.size) || 100);
  const img = request.img || String(request.item.img ?? "") || "icons/svg/item-bag.svg";
  try {
    const created = await scene.createEmbeddedDocuments("Tile", [
      {
        texture: { src: img },
        x: request.x,
        y: request.y,
        width: size,
        height: size,
        z: 100,
        hidden: false,
        locked: false,
        overhead: false,
        flags: {
          [MODULE_ID]: {
            thrownLoot: true,
            item: request.item,
            ownerId: request.ownerId ?? "",
            ownerUuid: request.ownerUuid ?? "",
            ownerType: request.ownerType ?? "",
            playerOwned: request.playerOwned === true,
          },
        },
      },
    ]);
    const tile = created?.[0];
    if (!tile?.id) {
      log(`thrown: tile create returned nothing for ${request.name}`);
      return { ok: false };
    }
    log(`thrown: ${request.name} pinned at ${request.x},${request.y} (${size}px)`);
    return { ok: true, tileId: String(tile.id) };
  } catch (err) {
    log(`thrown: tile create failed: ${reason(err)}`);
    return { ok: false };
  }
}

function isLootTile(doc: any): boolean {
  const flags = doc?.flags?.[MODULE_ID] ?? doc?.document?.flags?.[MODULE_ID];
  if (!flags?.thrownLoot) return false;
  if (doc?.documentName === "Token" || doc?.actor || doc?.actorId) return false;
  return true;
}

function isLootToken(doc: any): boolean {
  if (isLootTile(doc)) return false;
  const flags = doc?.flags?.[MODULE_ID] ?? doc?.document?.flags?.[MODULE_ID];
  if (flags?.thrownLoot) return true;
  const actor = doc?.actor ?? doc?.document?.actor;
  return Boolean(actor?.flags?.[MODULE_ID]?.thrownLoot);
}

function thrownTiles(scene?: any): any[] {
  const tiles = scene?.tiles?.contents ?? scene?.tiles ?? [];
  return [...tiles].filter((t: any) => t?.flags?.[MODULE_ID]?.thrownLoot);
}

function tokenBox(doc: any): { x: number; y: number; width: number; height: number } {
  return {
    x: Number(doc?.x),
    y: Number(doc?.y),
    width: Number(doc?.width),
    height: Number(doc?.height),
  };
}

function tileBox(tile: any): { x: number; y: number; width: number; height: number } {
  return {
    x: Number(tile?.x),
    y: Number(tile?.y),
    width: Number(tile?.width),
    height: Number(tile?.height),
  };
}

function gridOf(scene: any): { size: number; distance: number } {
  return {
    size: Number(scene?.grid?.size ?? (canvas as any)?.grid?.size) || 100,
    distance: Number(scene?.grid?.distance ?? (canvas as any)?.grid?.distance) || 5,
  };
}

function reachTo(token: any, tile: any, scene?: any): boolean {
  const grid = gridOf(scene ?? token?.parent ?? (canvas as any)?.scene);
  return withinPickupReach(tokenBox(token), tileBox(tile), grid.size, grid.distance);
}

function pinOwnedBy(flags: any, actor: any): boolean {
  if (!pinIsPlayerOwned(flags) || !actor) return false;
  const id = String(actor.id ?? "");
  const uuid = String(actor.uuid ?? "");
  return (Boolean(id) && flags.ownerId === id) || (Boolean(uuid) && flags.ownerUuid === uuid);
}

function nearbyOwnedPins(token: any, actor: any): any[] {
  const doc = token?.document ?? token;
  const scene = doc?.parent ?? (canvas as any)?.scene;
  return thrownTiles(scene).filter((tile: any) => {
    if (!reachTo(doc, tile, scene)) return false;
    return pinOwnedBy(tile.flags?.[MODULE_ID], actor);
  });
}

function hasVacuumableNear(token: any): boolean {
  const doc = token?.document ?? token;
  const actor = doc?.actor;
  if (!isPlayerThrower(actor)) return false;
  return nearbyOwnedPins(doc, actor).length > 0;
}

function nearestReachableTile(token: any): any | null {
  const doc = token?.document ?? token;
  const scene = doc?.parent ?? (canvas as any)?.scene;
  let best: any = null;
  let bestDist = Infinity;
  for (const tile of thrownTiles(scene)) {
    if (!reachTo(doc, tile, scene)) continue;
    const dx = Number(doc?.x) - Number(tile.x);
    const dy = Number(doc?.y) - Number(tile.y);
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      best = tile;
      bestDist = dist;
    }
  }
  return best;
}

const WALK_VACUUM_MS = 400;
const walkTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleWalkVacuum(doc: any): void {
  if (!isPrimaryGM() || !isAttackRangeEnabled()) return;
  const actor = doc?.actor;
  if (!isPlayerThrower(actor)) return;
  const id = String(doc?.id ?? "");
  if (!id) return;
  const prev = walkTimers.get(id);
  if (prev) clearTimeout(prev);
  walkTimers.set(
    id,
    setTimeout(() => {
      walkTimers.delete(id);
      void vacuumAround(doc, { ownerOnly: true, actor });
    }, WALK_VACUUM_MS),
  );
}

async function giveThrownTo(actor: any, payload: Record<string, unknown>): Promise<boolean> {
  if (!actor || !payload) return false;
  const items = [...(actor.items?.contents ?? actor.items ?? [])];
  const match = items.find((item: any) => thrownStacksMatch(item, payload));
  try {
    if (match) {
      const qty = Number(match.system?.quantity ?? 0) || 0;
      await match.update({ "system.quantity": qty + 1 });
      return true;
    }
    await actor.createEmbeddedDocuments("Item", [payload]);
    return true;
  } catch (err) {
    log("thrown: could not return the weapon to the sheet:", err);
    return false;
  }
}

async function vacuumAround(
  token: any,
  opts: { ownerOnly: boolean; actor?: any },
): Promise<number> {
  const doc = token?.document ?? token;
  const actor = opts.actor ?? doc?.actor ?? pickerActor();
  if (!actor) {
    ui.notifications?.warn(game.i18n.localize("NOODLRHOOKS.Combat.AttackRange.NoHands"));
    return 0;
  }
  const scene = doc?.parent ?? (canvas as any)?.scene;
  const pins = thrownTiles(scene).filter((tile: any) => {
    if (!reachTo(doc, tile, scene)) return false;
    if (!opts.ownerOnly) return true;
    return pinOwnedBy(tile.flags?.[MODULE_ID], actor);
  });
  if (!pins.length) return 0;

  const counts = new Map<string, number>();
  const cleared: string[] = [];
  for (const tile of pins) {
    const payload = tile.flags?.[MODULE_ID]?.item;
    if (!payload) continue;
    const ok = await giveThrownTo(actor, payload);
    if (!ok) continue;
    const name = String(payload.name ?? "weapon");
    counts.set(name, (counts.get(name) ?? 0) + 1);
    cleared.push(String(tile.id));
  }
  if (!cleared.length) return 0;

  const result = await askGm<{ ok: boolean }>(
    CLEAR_QUERY,
    {
      request: {
        tileIds: cleared,
        sceneId: String(scene?.id ?? ""),
      },
    },
    { timeout: 20_000 },
  );
  if (!result?.ok) log("thrown: pins were not cleared after vacuum");

  const items = vacuumItemsLabel([...counts.entries()].map(([name, count]) => ({ name, count })));
  try {
    const ChatMessage = (globalThis as any).ChatMessage;
    await ChatMessage.create({
      content: `<p>${game.i18n.format("NOODLRHOOKS.Combat.AttackRange.Vacuumed", {
        name: escape(String(actor.name ?? "someone")),
        items: escape(items),
      })}</p>`,
      speaker: speakerFor(actor, String(actor.name ?? "")),
    });
  } catch (err) {
    log("thrown: could not announce the vacuum:", err);
  }
  return cleared.length;
}

/** Player-owned pins within 5 ft of each character, after a fight the party won. */
export async function vacuumPlayerThrown(
  combat: any,
  opts?: { victory?: boolean },
): Promise<void> {
  if (!isPrimaryGM()) return;
  const id = combatIdOf(combat);
  if (!id || vacuumed.has(id)) return;
  vacuumed.add(id);
  const victory = opts?.victory ?? looksLikeVictory(combat);
  if (!victory || !isAttackRangeEnabled()) return;

  for (const c of combat?.combatants ?? []) {
    const actor = (c as any)?.actor;
    if (!isPlayerThrower(actor)) continue;
    const token = (c as any)?.token ?? actor?.getActiveTokens?.()?.[0];
    if (!token) continue;
    try {
      await vacuumAround(token, { ownerOnly: true, actor });
    } catch (err) {
      log(`thrown: vacuum for ${String(actor?.name)} failed:`, err);
    }
  }
}

function pickerActor(): any | null {
  const controlled = [...((canvas as any)?.tokens?.controlled ?? [])];
  for (const token of controlled) {
    const actor = token?.actor;
    if (actor && !actor.flags?.[MODULE_ID]?.thrownLoot && actor.isOwner) return actor;
  }
  const assigned = (game as any)?.user?.character;
  if (assigned) return assigned;
  return null;
}

function pickerTokenDoc(): any | null {
  const controlled = [...((canvas as any)?.tokens?.controlled ?? [])];
  for (const token of controlled) {
    const doc = token?.document ?? token;
    if (doc && !isLootToken(doc) && !isLootTile(doc)) return doc;
  }
  const assigned = (game as any)?.user?.character;
  const token = assigned?.getActiveTokens?.()?.[0];
  return token?.document ?? token ?? null;
}

async function pickupTile(
  tile: any,
  opts: { ignoreDistance: boolean },
): Promise<boolean> {
  const doc = tile?.document ?? tile;
  if (!doc?.flags?.[MODULE_ID]?.thrownLoot) return false;
  const picker = pickerActor();
  if (!picker) {
    ui.notifications?.warn(game.i18n.localize("NOODLRHOOKS.Combat.AttackRange.NoHands"));
    return false;
  }
  if (!opts.ignoreDistance) {
    const from = pickerTokenDoc();
    const scene = doc.parent ?? (canvas as any)?.scene;
    if (!from || !reachTo(from, doc, scene)) {
      ui.notifications?.warn(game.i18n.localize("NOODLRHOOKS.Combat.AttackRange.RecoverTooFar"));
      return false;
    }
  }
  const payload = doc.flags?.[MODULE_ID]?.item;
  if (!payload) return false;
  if (!(await giveThrownTo(picker, payload))) return false;
  const result = await askGm<{ ok: boolean }>(
    CLEAR_QUERY,
    {
      request: {
        tileId: String(doc.id),
        sceneId: String(doc.parent?.id ?? (canvas as any)?.scene?.id ?? ""),
      },
    },
    { timeout: 20_000 },
  );
  if (!result?.ok) log("thrown: pin was not cleared after pickup");
  try {
    ui.notifications?.info(
      game.i18n.format("NOODLRHOOKS.Combat.AttackRange.PickedUp", {
        name: String(payload.name ?? "weapon"),
      }),
    );
  } catch {
    /* courtesy */
  }
  return true;
}

async function pickupLeftoverToken(token: any): Promise<boolean> {
  const doc = token?.document ?? token;
  if (!isLootToken(doc)) return false;
  const picker = pickerActor();
  if (!picker) {
    ui.notifications?.warn(game.i18n.localize("NOODLRHOOKS.Combat.AttackRange.NoHands"));
    return false;
  }
  const stored = doc.flags?.[MODULE_ID]?.item;
  const fromActor = doc.actor?.items?.contents?.[0] ?? doc.actor?.items?.[0];
  const payload = stored ?? (fromActor ? thrownLootPayload(fromActor) : null);
  if (!payload) return false;
  if (!(await giveThrownTo(picker, payload))) return false;
  const result = await askGm<{ ok: boolean }>(
    CLEAR_QUERY,
    {
      request: {
        tokenId: String(doc.id),
        actorId: String(doc.actorId ?? doc.actor?.id ?? ""),
        sceneId: String(doc.parent?.id ?? (canvas as any)?.scene?.id ?? ""),
      },
    },
    { timeout: 20_000 },
  );
  if (!result?.ok) log("thrown: leftover loot token was not cleared after pickup");
  try {
    ui.notifications?.info(
      game.i18n.format("NOODLRHOOKS.Combat.AttackRange.PickedUp", {
        name: String(payload.name ?? "weapon"),
      }),
    );
  } catch {
    /* courtesy */
  }
  return true;
}

/**
 * Pick up a pin, a leftover npc-loot token, or whatever is at the selected token's feet.
 */
export async function pickupThrown(target?: any): Promise<boolean> {
  const doc = target?.document ?? target;
  if (isLootTile(doc)) return pickupTile(doc, { ignoreDistance: Boolean(game.user?.isGM) });
  if (isLootToken(doc)) return pickupLeftoverToken(doc);
  if (isPlayerThrower(doc?.actor)) {
    return (await vacuumAround(doc, { ownerOnly: true, actor: doc.actor })) > 0;
  }
  const pin = nearestReachableTile(doc);
  if (pin) return pickupTile(pin, { ignoreDistance: false });
  return false;
}

async function clearPin(request: ClearRequest | undefined): Promise<{ ok: boolean }> {
  if (!request) return { ok: false };
  const scene = (game as any)?.scenes?.get?.(request.sceneId) ?? (canvas as any)?.scene;
  const tileIds = [
    ...(Array.isArray(request.tileIds) ? request.tileIds : []),
    ...(request.tileId ? [request.tileId] : []),
  ].filter((id) => id);
  if (tileIds.length) {
    try {
      await scene?.deleteEmbeddedDocuments?.("Tile", tileIds);
    } catch (err) {
      log("thrown: could not delete the pin:", err);
    }
  }
  if (request.tokenId) {
    try {
      await scene?.deleteEmbeddedDocuments?.("Token", [request.tokenId]);
    } catch (err) {
      log("thrown: could not delete the leftover loot token:", err);
    }
  }
  if (request.actorId) {
    try {
      await (game as any)?.actors?.get?.(request.actorId)?.delete?.();
    } catch (err) {
      log("thrown: could not delete the leftover loot actor:", err);
    }
  }
  return { ok: true };
}

export function surveyThrown(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const scene = (canvas as any)?.scene;
  const pins = thrownTiles(scene);
  const leftovers = [...((canvas as any)?.tokens?.placeables ?? [])].filter((t: any) =>
    isLootToken(t.document ?? t),
  );
  const lines = [
    `module: ${MODULE_ID}`,
    `pending throws: ${pendingThrow.size}`,
    `vacuum reach: 5 ft (closest occupied square to pin centre)`,
    `pins on this scene: ${
      pins
        .map((t: any) => {
          const f = t.flags?.[MODULE_ID];
          const name = String(f?.item?.name ?? "pin");
          const owner = f?.playerOwned ? String(f.ownerId || "player") : "npc";
          return `${name} (${owner})`;
        })
        .join(" | ") || "none"
    }`,
    `leftover npc drops: ${leftovers.map((t: any) => String(t.name)).join(" | ") || "none"}`,
    `selected: ${String(token?.name ?? "—")}`,
  ];
  console.log(lines.join("\n"));
  return {
    pending: pendingThrow.size,
    pins: pins.map((t: any) => String(t.flags?.[MODULE_ID]?.item?.name ?? t.id)),
    leftovers: leftovers.map((t: any) => String(t.name)),
  };
}
