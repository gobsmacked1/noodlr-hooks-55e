// Wild Shape / Polymorph / Shapechange — rider dump on revert, no restore icon.
//
// dnd5e already restores from the sheet header (`restoreTransformation`) and the sidebar.
// A token-corner / effects-panel badge was tried and never became a reliable click. Do not
// rebuild it. This file keeps `restoreOriginalForm` for the console API and strips leftover
// `noodlr-transformed` badges so an upgraded world does not keep showing a dead icon.
//
// Linked transforms also create a world Actor. dnd5e never copies items or coin back on revert.
// `carryFormLoot` stamps the form at create and writes new loot onto the original before the
// form is deleted — including a leftover a player revert left behind.

import { debug, log, MODULE_ID, warn } from "../constants";
import { isPrimaryGM } from "../util/gm";
import { isTransformLootEnabled, transformFolderName } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  FORM_LOOT_FLAG,
  addCurrency,
  currencyOf,
  hasCoin,
  isPolymorphed,
  isTransformBadge,
  itemIdOf,
  itemPayloadForCarry,
  planFormLoot,
  readFormLoot,
  stampFormLootOnCreateData,
} from "../system/dnd5e-transform";
import { scheduleDropAllRiders, scheduleRidingFit } from "./riding";

const REVERT_WRAP = "_noodlrFormLoot";
const DELETE_REPLAY = "formLootReplay";
const carryInflight = new Map<string, Promise<CarryResult | null>>();

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

type CarryResult = { items: number; coin: string; name: string; skipped?: string };

function formatCoin(bag: ReturnType<typeof currencyOf>): string {
  const parts = (["pp", "gp", "ep", "sp", "cp"] as const)
    .filter((k) => (bag[k] ?? 0) > 0)
    .map((k) => `${bag[k]}${k}`);
  return parts.length ? parts.join(" ") : "no coin";
}

function originalOf(form: any): any {
  const snap = readFormLoot(form);
  const id = snap?.originalActor || form?.flags?.dnd5e?.originalActor;
  if (!id) return null;
  try {
    return (game.actors as any)?.get?.(id) ?? null;
  } catch {
    return null;
  }
}

/**
 * Copy items and coin acquired on `form` onto its original Actor, then mark the snapshot copied.
 * Safe to call twice: a second pass sees `copied` and no-ops.
 */
export async function carryFormLoot(form: any): Promise<CarryResult | null> {
  if (!isDnd5e() || !form || !isTransformLootEnabled()) return null;
  const key = actorKey(form);
  const prev = key ? carryInflight.get(key) : undefined;
  if (prev) return prev;
  const run = doCarry(form).finally(() => {
    if (key && carryInflight.get(key) === run) carryInflight.delete(key);
  });
  if (key) carryInflight.set(key, run);
  return run;
}

async function doCarry(form: any): Promise<CarryResult | null> {
  let snap = readFormLoot(form);
  const plan = planFormLoot({ items: form.items, currency: currencyOf(form), snapshot: snap });
  if (!plan || !snap) return null;
  const original = originalOf(form);
  const name = String(original?.name ?? form?.name ?? "?");
  if (!original) {
    warn("transform: form loot has no original Actor — nothing to copy onto");
    return { items: 0, coin: "no coin", name, skipped: "no-original" };
  }
  if (!plan.items.length && !hasCoin(plan.currency)) {
    await markCopied(form, snap);
    return { items: 0, coin: "no coin", name };
  }
  try {
    // Persist progress after each half so a retry cannot duplicate what already landed.
    if (plan.items.length) {
      const payloads = plan.items.map(itemPayloadForCarry);
      await original.createEmbeddedDocuments("Item", payloads);
      const added = plan.items.map(itemIdOf).filter(Boolean);
      snap = { ...snap, itemIds: [...snap.itemIds, ...added] };
      await markProgress(form, snap);
    }
    if (hasCoin(plan.currency)) {
      const next = addCurrency(currencyOf(original), plan.currency);
      await original.update({ "system.currency": next });
      snap = { ...snap, currency: currencyOf(form) };
      await markProgress(form, snap);
    }
    await markCopied(form, snap);
  } catch (err) {
    warn("transform: could not copy form loot:", err);
    try {
      ui.notifications?.error(game.i18n.localize("NOODLRHOOKS.General.TransformLoot.Failed"));
    } catch {
      /* courtesy */
    }
    return { items: 0, coin: "no coin", name, skipped: "write-failed" };
  }
  const result: CarryResult = { items: plan.items.length, coin: formatCoin(plan.currency), name };
  if (result.items || hasCoin(plan.currency)) {
    try {
      ui.notifications?.info(
        game.i18n.format("NOODLRHOOKS.General.TransformLoot.Carried", {
          items: result.items,
          coin: result.coin,
          name,
        }),
      );
    } catch {
      /* courtesy */
    }
    log(`transform: carried ${result.items} item(s) and ${result.coin} → ${name}`);
  }
  return result;
}

async function markProgress(form: any, snap: NonNullable<ReturnType<typeof readFormLoot>>): Promise<void> {
  try {
    await form.setFlag(MODULE_ID, FORM_LOOT_FLAG, snap);
  } catch (err) {
    warn("transform: could not update form-loot stamp:", err);
  }
}

async function markCopied(form: any, snap: NonNullable<ReturnType<typeof readFormLoot>>): Promise<void> {
  try {
    await form.setFlag(MODULE_ID, FORM_LOOT_FLAG, { ...snap, copied: true });
  } catch (err) {
    warn("transform: could not mark form loot copied:", err);
  }
}

function wrapRevertOriginalForm(): void {
  const proto = (CONFIG as any).Actor?.documentClass?.prototype;
  if (!proto?.revertOriginalForm || proto.revertOriginalForm[REVERT_WRAP]) return;
  const original = proto.revertOriginalForm;
  async function wrapped(this: any, options?: object) {
    await carryFormLoot(this);
    return original.call(this, options);
  }
  (wrapped as any)[REVERT_WRAP] = true;
  proto.revertOriginalForm = wrapped;
}

function divertCreateData(host: any, _source: any, d: any): void {
  if (!isDnd5e() || !d) return;
  if (isTransformLootEnabled()) stampFormLootOnCreateData(d, host);
  const folderId = findFormFolderId();
  if (folderId) d.folder = folderId;
}

function findFormFolderId(): string | null {
  const name = transformFolderName();
  if (!name) return null;
  try {
    const folders = (game as any).folders;
    const match = [...(folders ?? [])].find((f: any) => f?.type === "Actor" && String(f.name) === name);
    return match?.id ?? null;
  } catch {
    return null;
  }
}

async function ensureFormFolder(): Promise<void> {
  if (!isDnd5e() || !isPrimaryGM()) return;
  const name = transformFolderName();
  if (!name || findFormFolderId()) return;
  try {
    const FolderCls = (CONFIG as any).Folder?.documentClass ?? (globalThis as any).Folder;
    await FolderCls.create({ name, type: "Actor", sorting: "a" });
    debug("transform: created Actors folder", name);
  } catch (err) {
    warn("transform: could not create form folder:", err);
  }
}

function deleteIsReplay(options: any): boolean {
  return Boolean(options?.[MODULE_ID]?.[DELETE_REPLAY]);
}

async function replayDeleteAfterCarry(actor: any, options: any): Promise<void> {
  const result = await carryFormLoot(actor);
  if (result?.skipped === "write-failed") return;
  const next = { ...(options && typeof options === "object" ? options : {}) };
  next[MODULE_ID] = { ...(next[MODULE_ID] ?? {}), [DELETE_REPLAY]: true };
  try {
    await actor.delete(next);
  } catch (err) {
    warn("transform: replayed delete after loot carry failed:", err);
  }
}

export function registerTransformWatch(): void {
  wrapRevertOriginalForm();
  void ensureFormFolder();
  Hooks.on("dnd5e.transformActor", divertCreateData);
  Hooks.on("dnd5e.transformActorV2", divertCreateData);
  Hooks.on("preDeleteActor", (actor: any, options: any) => {
    if (!isTransformLootEnabled() || deleteIsReplay(options)) return;
    const snap = readFormLoot(actor);
    if (!snap || snap.copied) return;
    const plan = planFormLoot({ items: actor.items, currency: currencyOf(actor), snapshot: snap });
    if (!plan || (!plan.items.length && !hasCoin(plan.currency))) return;
    void replayDeleteAfterCarry(actor, options);
    return false;
  });
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
  const folder = transformFolderName();
  const folderId = findFormFolderId();
  const lines = [
    `transform: sheet restore only — ${tokens.length} token(s)`,
    `  loot=${isTransformLootEnabled() ? "on" : "off"} folder=${folder || "(original)"}` +
      (folder ? ` id=${folderId ?? "MISSING"}` : ""),
  ];
  for (const token of tokens) {
    const actor = token.actor ?? token.document?.actor;
    if (!actor) continue;
    const form = isPolymorphed(actor);
    const badges = [...(actor.effects ?? [])].filter(isTransformBadge);
    const loot = readFormLoot(actor);
    if (!form && !badges.length && !loot) continue;
    lines.push(
      `  ${String(token.name ?? actor.name)} polymorphed=${form} leftoverBadge=${badges.length}` +
        (loot
          ? ` loot=${loot.copied ? "copied" : `${loot.itemIds.length} stamped`} original=${loot.originalActor}`
          : "") +
        (badges.length ? " — STRIP on next sync" : ""),
    );
  }
  try {
    for (const actor of game.actors ?? []) {
      const loot = readFormLoot(actor);
      if (!loot || loot.copied) continue;
      const onScene = tokens.some((t) => (t.actor ?? t.document?.actor)?.id === actor.id);
      if (onScene) continue;
      lines.push(
        `  leftover ${String(actor.name)} folder=${String(actor.folder?.name ?? actor.folder ?? "—")}` +
          ` stamped=${loot.itemIds.length} original=${loot.originalActor}`,
      );
    }
  } catch {
    /* directory unread */
  }
  const block = lines.join("\n");
  log(block);
  return { text: block, tokens: tokens.length };
}
