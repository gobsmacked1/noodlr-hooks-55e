// Dual-mode weapons: ask before a throw, drop a placeable unless Returning.
//
// `preUseActivity` is synchronous, so the prompt cannot live inside the hook.
// Same shape as the economy over-budget dialog: veto, ask, replay with
// `attackMode: "thrown"`. The replay does NOT use `cleared` — the first press
// never reached the ledger (range sits before the charge), so the retry has to
// be a normal use.
//
// dnd5e decrements quantity on a thrown attack that is not `ret`. We still
// create the ground token (the system never does) and delete a stack that
// hit zero. A name-only "Returning" match is restored if dnd5e already spent it.
//
// Token create is world rights: `askGm`. Pickup writes the item on the
// picker's own sheet, then asks the GM to delete the loot actor + token.

import { MODULE_ID, log } from "../constants";
import { isAttackRangeEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  attackModeIsThrown,
  hasReturningProperty,
  isReturningWeapon,
  lootActorType,
  thrownLootPayload,
} from "../system/dnd5e-thrown";
import { shouldAutomate } from "../tactics/registry";
import { isPrimaryGM } from "../util/gm";
import { promptChoice } from "../util/prompt";
import { askGm, registerQuery } from "../util/queries";

const DROP_QUERY = "thrown-drop";
const CLEAR_QUERY = "thrown-clear";
const FOLDER_NAME = "Dropped weapons";
const asking = new Set<string>();
const pendingThrow = new Set<string>();

interface DropRequest {
  item: Record<string, unknown>;
  sceneId: string;
  x: number;
  y: number;
  name: string;
  img: string;
}

interface ClearRequest {
  tokenId: string;
  actorId: string;
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
    return await dropLoot(data?.request as DropRequest | undefined);
  });
  registerQuery(CLEAR_QUERY, async (data: any) => {
    if (!isPrimaryGM()) return { ok: false };
    return await clearLoot(data?.request as ClearRequest | undefined);
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

  Hooks.on("renderTokenHUD", (app: any, html: any) => {
    if (!isAttackRangeEnabled()) return;
    const token = app?.object ?? app?.token;
    const doc = token?.document ?? token;
    if (!isLootToken(doc)) return;
    const root: HTMLElement | null = html instanceof HTMLElement ? html : (html?.[0] ?? null);
    if (!root) return;
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
      void pickupThrown(doc);
    });
    col.appendChild(btn);
  });
}

function applyPendingMode(config: any, dialog?: any): void {
  const subject = config?.subject;
  const activity = subject?.type ? subject : subject?.activity ?? subject;
  if (!isPendingThrow(activity)) return;
  config.attackMode = "thrown";
  const opts = config.rolls?.[0]?.options;
  if (opts && typeof opts === "object") opts.attackMode = "thrown";
  // They already answered Throw. Leaving the attack dialog open lets them pick
  // oneHanded and stab from 35 feet after the range gate has passed.
  if (dialog && typeof dialog === "object") dialog.configure = false;
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
  const target = landingSpot(activity);
  const scene = (canvas as any)?.scene;
  if (!scene || !target) {
    log("thrown: no scene or landing to drop on");
    await restoreThrown(item.actor, item, payload, false);
    return;
  }

  const actor = item.actor;
  const qty = Number(item.system?.quantity);
  let emptied = false;
  if (Number.isFinite(qty) && qty <= 0 && actor?.isOwner) {
    try {
      await actor.deleteEmbeddedDocuments("Item", [item.id]);
      emptied = true;
    } catch (err) {
      log("thrown: could not remove the empty stack:", err);
    }
  }

  const request: DropRequest = {
    item: payload,
    sceneId: String(scene.id),
    x: target.x,
    y: target.y,
    name: String(item.name ?? payload.name ?? "weapon"),
    img: String(item.img ?? payload.img ?? ""),
  };
  const result = await askGm<{ ok: boolean }>(DROP_QUERY, { request }, { timeout: 20_000 });
  if (result?.ok) return;
  log(`thrown: could not drop ${request.name} on the scene`);
  await restoreThrown(actor, item, payload, emptied);
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
    log("thrown: could not put the weapon back after a failed drop:", err);
  }
}

function landingSpot(activity: any): { x: number; y: number } | null {
  const live = [...((game as any)?.user?.targets ?? [])];
  const token = live[0] ?? null;
  const doc = token?.document ?? token;
  const x = Number(doc?.x);
  const y = Number(doc?.y);
  const size = Number((canvas as any)?.grid?.size) || 100;
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return { x: Math.round(x + size * 0.25), y: Math.round(y + size * 0.25) };
  }
  const from = activity?.actor?.getActiveTokens?.()?.[0] ?? activity?.actor?.token;
  const fx = Number(from?.document?.x ?? from?.x);
  const fy = Number(from?.document?.y ?? from?.y);
  if (Number.isFinite(fx) && Number.isFinite(fy)) return { x: fx, y: fy };
  return null;
}

function actorTypes(): string[] {
  const ctor = (CONFIG as any).Actor?.documentClass ?? (globalThis as any).Actor;
  const listed = ctor?.TYPES ?? (CONFIG as any).Actor?.types ?? [];
  return [...listed].map((t: unknown) => String(t ?? ""));
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "unknown");
}

async function dropLoot(request: DropRequest | undefined): Promise<{ ok: boolean }> {
  if (!request?.sceneId || !request.item) return { ok: false };
  const scene = (game as any)?.scenes?.get?.(request.sceneId);
  if (!scene) return { ok: false };
  const folder = await ensureFolder();
  const Actor = (CONFIG as any).Actor?.documentClass ?? (globalThis as any).Actor;
  if (!Actor?.create) return { ok: false };
  const type = lootActorType(actorTypes());
  if (!type) {
    log("thrown: no Actor type is available to hold a dropped weapon");
    return { ok: false };
  }
  const img = request.img || String(request.item.img ?? "");
  const observer = (globalThis as any).CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
  const base = {
    name: request.name,
    type,
    img,
    folder: folder?.id ?? null,
    ownership: { default: observer },
    items: [request.item],
    flags: { [MODULE_ID]: { thrownLoot: true } },
    prototypeToken: {
      actorLink: false,
      name: request.name,
      texture: { src: img },
      width: 0.5,
      height: 0.5,
      disposition: 0,
      displayName: 30,
    },
  };
  let actor: any;
  try {
    actor = await Actor.create(base);
  } catch (err) {
    log(`thrown: loot actor create failed (${type}): ${reason(err)}`);
    return { ok: false };
  }
  if (!actor?.id) {
    log(`thrown: loot actor create returned nothing (${type})`);
    return { ok: false };
  }
  try {
    await scene.createEmbeddedDocuments("Token", [
      {
        actorId: actor.id,
        actorLink: false,
        name: request.name,
        texture: { src: img },
        x: request.x,
        y: request.y,
        width: 0.5,
        height: 0.5,
        disposition: 0,
        displayName: 30,
        flags: { [MODULE_ID]: { thrownLoot: true, item: request.item } },
      },
    ]);
  } catch (err) {
    log(`thrown: loot token create failed: ${reason(err)}`);
    try {
      await actor.delete();
    } catch {
      /* leftover actor is recoverable */
    }
    return { ok: false };
  }
  log(`thrown: ${request.name} lands at ${request.x},${request.y}`);
  try {
    ui.notifications?.info(
      game.i18n.format("NOODLRHOOKS.Combat.AttackRange.Dropped", { name: request.name }),
    );
  } catch {
    /* a toast is courtesy */
  }
  return { ok: true };
}

async function ensureFolder(): Promise<any | null> {
  const existing = [...((game as any)?.folders ?? [])].find(
    (f: any) => f?.type === "Actor" && f.name === FOLDER_NAME,
  );
  if (existing) return existing;
  const FolderCls = (CONFIG as any).Folder?.documentClass ?? (globalThis as any).Folder;
  if (typeof FolderCls?.create !== "function") return null;
  try {
    return await FolderCls.create({ name: FOLDER_NAME, type: "Actor", sorting: "a" });
  } catch (err) {
    log("thrown: could not create the dropped-weapons folder:", err);
    return null;
  }
}

function isLootToken(doc: any): boolean {
  const flags = doc?.flags?.[MODULE_ID] ?? doc?.document?.flags?.[MODULE_ID];
  if (flags?.thrownLoot) return true;
  const actor = doc?.actor ?? doc?.document?.actor;
  return Boolean(actor?.flags?.[MODULE_ID]?.thrownLoot);
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

export async function pickupThrown(token: any): Promise<boolean> {
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
    log("thrown: could not add the picked-up item:", err);
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
  if (!result?.ok) log("thrown: loot token was not cleared after pickup");
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

async function clearLoot(request: ClearRequest | undefined): Promise<{ ok: boolean }> {
  if (!request?.tokenId) return { ok: false };
  const scene = (game as any)?.scenes?.get?.(request.sceneId) ?? (canvas as any)?.scene;
  try {
    if (scene?.deleteEmbeddedDocuments) {
      await scene.deleteEmbeddedDocuments("Token", [request.tokenId]);
    }
  } catch (err) {
    log("thrown: could not delete the loot token:", err);
  }
  if (request.actorId) {
    try {
      await (game as any)?.actors?.get?.(request.actorId)?.delete?.();
    } catch (err) {
      log("thrown: could not delete the loot actor:", err);
    }
  }
  return { ok: true };
}

export function surveyThrown(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const loot = [...((canvas as any)?.tokens?.placeables ?? [])].filter((t: any) =>
    isLootToken(t.document ?? t),
  );
  const lines = [
    `module: ${MODULE_ID}`,
    `pending throws: ${pendingThrow.size}`,
    `dropped on this scene: ${loot.map((t: any) => String(t.name)).join(" | ") || "none"}`,
    `selected: ${String(token?.name ?? "—")}`,
  ];
  console.log(lines.join("\n"));
  return { pending: pendingThrow.size, dropped: loot.map((t: any) => String(t.name)) };
}
