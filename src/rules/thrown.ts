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
// Tile create/delete is world rights: `askGm`. Pickup writes the item on the
// picker's own sheet, then asks the GM to delete the pin. Recover on the chat
// card is the player path (Tiles layer is GM-oriented). Nearby Token HUD is
// the walk-over path. Leftover `npc` loot tokens from v0.7.64 still pick up.

import { MODULE_ID, log } from "../constants";
import { isAttackRangeEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  attackModeIsThrown,
  hasReturningProperty,
  hasThrownProperty,
  isReturningWeapon,
  pinSizePx,
  quantityAfterThrow,
  thrownLootPayload,
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

interface DropRequest {
  item: Record<string, unknown>;
  sceneId: string;
  x: number;
  y: number;
  name: string;
  img: string;
}

interface ClearRequest {
  tileId?: string;
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

  const generation = Number((game as any).release?.generation) || 0;
  Hooks.on(generation >= 13 ? "renderChatMessageHTML" : "renderChatMessage", wireRecover);

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
  await announceLanded(actor, request.name, target.name, result.tileId, request.sceneId, payload);
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

async function announceLanded(
  actor: any,
  name: string,
  targetName: string | undefined,
  tileId: string | undefined,
  sceneId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const line = targetName
    ? game.i18n.format("NOODLRHOOKS.Combat.AttackRange.LandsNear", {
        name: escape(name),
        target: escape(targetName),
      })
    : game.i18n.format("NOODLRHOOKS.Combat.AttackRange.Dropped", { name: escape(name) });
  const recover = game.i18n.localize("NOODLRHOOKS.Combat.AttackRange.Recover");
  try {
    const ChatMessage = (globalThis as any).ChatMessage;
    await ChatMessage.create({
      content:
        `<p>${line}</p>` +
        `<button type="button" data-action="noodlr-recover-thrown">${recover}</button>`,
      speaker: speakerFor(actor, String(actor?.name ?? "")),
      flags: {
        [MODULE_ID]: {
          thrownRecover: true,
          sceneId,
          tileId: tileId ?? "",
          item: payload,
        },
      },
    });
  } catch (err) {
    log("thrown: could not announce the landing:", err);
  }
}

function wireRecover(message: any, html: unknown): void {
  const flags = message?.flags?.[MODULE_ID];
  if (!flags?.thrownRecover) return;
  const root: HTMLElement | undefined =
    html instanceof HTMLElement ? html : ((html as any)?.[0] as HTMLElement | undefined);
  const button = root?.querySelector<HTMLButtonElement>('[data-action="noodlr-recover-thrown"]');
  if (!button) return;
  button.addEventListener("click", async () => {
    button.disabled = true;
    const ok = await recoverFromCard(flags);
    if (!ok) button.disabled = false;
  });
}

async function recoverFromCard(flags: any): Promise<boolean> {
  const scene = (game as any)?.scenes?.get?.(flags?.sceneId) ?? (canvas as any)?.scene;
  const tile = scene?.tiles?.get?.(flags?.tileId);
  if (!tile) {
    ui.notifications?.info(game.i18n.localize("NOODLRHOOKS.Combat.AttackRange.AlreadyGone"));
    return true;
  }
  return pickupTile(tile, { ignoreDistance: Boolean(game.user?.isGM) });
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
        flags: { [MODULE_ID]: { thrownLoot: true, item: request.item } },
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

function nearestReachableTile(token: any): any | null {
  const doc = token?.document ?? token;
  const scene = doc?.parent ?? (canvas as any)?.scene;
  const size = Number(scene?.grid?.size ?? (canvas as any)?.grid?.size) || 100;
  let best: any = null;
  let bestDist = Infinity;
  for (const tile of thrownTiles(scene)) {
    if (
      !withinPickupReach(
        { x: Number(doc?.x), y: Number(doc?.y), width: Number(doc?.width), height: Number(doc?.height) },
        {
          x: Number(tile.x),
          y: Number(tile.y),
          width: Number(tile.width),
          height: Number(tile.height),
        },
        size,
      )
    ) {
      continue;
    }
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
    const size = Number(scene?.grid?.size ?? (canvas as any)?.grid?.size) || 100;
    if (
      !from ||
      !withinPickupReach(
        { x: Number(from.x), y: Number(from.y), width: Number(from.width), height: Number(from.height) },
        {
          x: Number(doc.x),
          y: Number(doc.y),
          width: Number(doc.width),
          height: Number(doc.height),
        },
        size,
      )
    ) {
      ui.notifications?.warn(game.i18n.localize("NOODLRHOOKS.Combat.AttackRange.RecoverTooFar"));
      return false;
    }
  }
  const payload = doc.flags?.[MODULE_ID]?.item;
  if (!payload) return false;
  try {
    await picker.createEmbeddedDocuments("Item", [payload]);
  } catch (err) {
    log("thrown: could not add the picked-up item:", err);
    return false;
  }
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
  try {
    await picker.createEmbeddedDocuments("Item", [payload]);
  } catch (err) {
    log("thrown: could not add the leftover item:", err);
    return false;
  }
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
  const pin = nearestReachableTile(doc);
  if (pin) return pickupTile(pin, { ignoreDistance: false });
  return false;
}

async function clearPin(request: ClearRequest | undefined): Promise<{ ok: boolean }> {
  if (!request) return { ok: false };
  const scene = (game as any)?.scenes?.get?.(request.sceneId) ?? (canvas as any)?.scene;
  if (request.tileId) {
    try {
      await scene?.deleteEmbeddedDocuments?.("Tile", [request.tileId]);
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
    `pins on this scene: ${pins.map((t: any) => String(t.flags?.[MODULE_ID]?.item?.name ?? "pin")).join(" | ") || "none"}`,
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
