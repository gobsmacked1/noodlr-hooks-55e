// Wild Shape / Polymorph / Shapechange — rider dump on revert, no restore icon.
//
// dnd5e already restores from the sheet header (`restoreTransformation`) and the sidebar.
// A token-corner / effects-panel badge was tried and never became a reliable click. Do not
// rebuild it. This file keeps `restoreOriginalForm` for the console API and strips leftover
// `noodlr-transformed` badges so an upgraded world does not keep showing a dead icon.
//
// Linked transforms also create a world Actor. dnd5e never copies items or coin back on revert.
// `carryFormLoot` stamps the form at create and writes new loot onto the original before the
// form is deleted — including a leftover a player revert left behind. After that copy, each
// leftover for that character is deleted one Actor at a time. A player revert never deletes
// (`game.user.isGM` only in dnd5e), so the delete is retried locally and otherwise asked of
// the GM. The temp folder is never emptied — another player may still be transformed.

import { debug, log, MODULE_ID, warn } from "../constants";
import { isPrimaryGM } from "../util/gm";
import { isTransformLootEnabled, transformFolderName } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import { askGm, registerQuery } from "../util/queries";
import {
  COIN_KEYS,
  FORM_LOOT_FLAG,
  addCurrency,
  currencyOf,
  hasCoin,
  isPolymorphed,
  isTransformBadge,
  itemIdOf,
  itemPayloadForCarry,
  leftoverKeepReason,
  planFormLoot,
  readFormLoot,
  stampFormLootOnCreateData,
} from "../system/dnd5e-transform";
import { scheduleDropAllRiders, scheduleRidingFit } from "./riding";

const REVERT_WRAP = "_noodlrFormLoot";
const DELETE_REPLAY = "formLootReplay";
const DISCARD_QUERY = "transform.discardLeftovers";
const carryInflight = new Map<string, Promise<CarryResult | null>>();
const discardInflight = new Map<string, Promise<number>>();

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

function actorById(id: string | undefined | null): any {
  if (!id) return null;
  try {
    return (game.actors as any)?.get?.(id) ?? null;
  } catch {
    return null;
  }
}

/**
 * Walk leftover → leftover → character. Player revert leaves `originalActor` on the
 * leftover; a second Wild Shape then points the new form at that leftover, not Drew.
 */
function originalOf(form: any): any {
  const seen = new Set<string>();
  let id = String(readFormLoot(form)?.originalActor || form?.flags?.dnd5e?.originalActor || "");
  let best: any = null;
  while (id && !seen.has(id)) {
    seen.add(id);
    const actor = actorById(id);
    if (!actor) break;
    best = actor;
    const next = readFormLoot(actor)?.originalActor || actor?.flags?.dnd5e?.originalActor;
    if (!next || String(next) === id) break;
    id = String(next);
  }
  return best;
}

function leftoversOf(originalId: string, exceptId?: string): any[] {
  const out: any[] = [];
  try {
    for (const actor of game.actors ?? []) {
      if (!actor || actor.id === exceptId || actor.id === originalId) continue;
      const snap = readFormLoot(actor);
      if (!snap || snap.copied) continue;
      const root = originalOf(actor);
      if (root?.id === originalId) out.push(actor);
    }
  } catch {
    /* directory unread */
  }
  return out;
}

function leftoverHasToken(actor: any): boolean {
  const id = String(actor?.id ?? "");
  if (!id) return false;
  try {
    const placed = actor.getActiveTokens?.(true, true);
    if (Array.isArray(placed) && placed.length) return true;
  } catch {
    /* sheet actor */
  }
  try {
    for (const scene of (game as any).scenes ?? []) {
      for (const token of scene.tokens ?? []) {
        if (String(token.actorId ?? "") === id) return true;
      }
    }
  } catch {
    /* scenes unread */
  }
  return false;
}

function leftoverPendingLoot(actor: any, snap: ReturnType<typeof readFormLoot>): boolean {
  if (!snap || snap.copied) return false;
  const plan = planFormLoot({ items: actor?.items, currency: currencyOf(actor), snapshot: snap });
  return Boolean(plan && (plan.items.length || hasCoin(plan.currency)));
}

function leftoversToDiscard(originalId: string): any[] {
  const out: any[] = [];
  if (!originalId) return out;
  try {
    for (const actor of game.actors ?? []) {
      if (!actor) continue;
      const snap = readFormLoot(actor);
      const keep = leftoverKeepReason({
        actorId: String(actor.id ?? ""),
        originalId,
        rootId: String(originalOf(actor)?.id ?? ""),
        snapshot: snap,
        polymorphed: isPolymorphed(actor),
        hasToken: leftoverHasToken(actor),
        pendingLoot: leftoverPendingLoot(actor, snap),
      });
      if (!keep) out.push(actor);
    }
  } catch {
    /* directory unread */
  }
  return out;
}

function canDeleteLeftover(actor: any): boolean {
  if (game.user?.isGM) return true;
  try {
    return Boolean(actor?.canUserModify?.(game.user, "delete"));
  } catch {
    return false;
  }
}

async function deleteLeftover(actor: any): Promise<boolean> {
  try {
    await actor.delete({ [MODULE_ID]: { [DELETE_REPLAY]: true } });
    return true;
  } catch (err) {
    warn(`transform: could not delete leftover ${String(actor?.name ?? actor?.id)}:`, err);
    return false;
  }
}

async function deleteLeftoversLocally(actors: any[]): Promise<string[]> {
  const leftover: string[] = [];
  for (const actor of actors) {
    const id = String(actor?.id ?? "");
    if (!id) continue;
    if (!canDeleteLeftover(actor) || !(await deleteLeftover(actor))) leftover.push(id);
  }
  return leftover;
}

async function handleDiscardQuery(data: any): Promise<{ deleted: number }> {
  if (!game.user?.isGM) return { deleted: 0 };
  const originalId = String(data?.originalId ?? "");
  const requested = new Set((Array.isArray(data?.ids) ? data.ids : []).map((id: unknown) => String(id)));
  let deleted = 0;
  for (const actor of leftoversToDiscard(originalId)) {
    if (requested.size && !requested.has(String(actor.id))) continue;
    if (await deleteLeftover(actor)) deleted += 1;
  }
  return { deleted };
}

/**
 * Delete spent leftover forms for this character. One Actor at a time — never the folder.
 * A player revert cannot delete (`game.user.isGM` in dnd5e), so leftovers the local client
 * cannot remove are asked of the GM. Null from that ask keeps them; the copy already landed.
 */
export async function discardFormLeftovers(subject: any): Promise<number> {
  if (!isDnd5e() || !isTransformLootEnabled()) return 0;
  const actor = actorOf(subject);
  const original = originalOf(actor) ?? (readFormLoot(actor) ? null : actor);
  const originalId = String(original?.id ?? actor?.id ?? "");
  if (!originalId) return 0;
  const prev = discardInflight.get(originalId);
  if (prev) return prev;
  const run = doDiscardLeftovers(originalId).finally(() => {
    if (discardInflight.get(originalId) === run) discardInflight.delete(originalId);
  });
  discardInflight.set(originalId, run);
  return run;
}

async function doDiscardLeftovers(originalId: string): Promise<number> {
  const actors = leftoversToDiscard(originalId);
  if (!actors.length) return 0;
  const names = actors.map((a) => String(a.name ?? a.id));
  const remaining = await deleteLeftoversLocally(actors);
  let deleted = actors.length - remaining.length;
  if (remaining.length) {
    const answer = await askGm<{ deleted: number }>(
      DISCARD_QUERY,
      { originalId, ids: remaining },
      { timeout: 30000 },
    );
    if (answer == null) {
      debug(
        "transform: leftover form(s) kept — no GM to delete them:",
        remaining.join(", "),
      );
    } else {
      deleted += answer.deleted ?? 0;
    }
  }
  if (deleted) log(`transform: deleted ${deleted} leftover form(s) for ${originalId}: ${names.join(", ")}`);
  return deleted;
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

/** Carry this form, then every other uncopied leftover that walks to the same original. */
async function carryAllFormLoot(form: any): Promise<CarryResult | null> {
  const result = await carryFormLoot(form);
  const original = originalOf(form);
  if (!original?.id) return result;
  for (const other of leftoversOf(original.id, form?.id)) {
    await carryFormLoot(other);
  }
  return result;
}

function currencyUpdate(current: ReturnType<typeof currencyOf>, extra: ReturnType<typeof currencyOf>): Record<string, number> {
  const next = addCurrency(current, extra);
  const update: Record<string, number> = {};
  for (const key of COIN_KEYS) {
    if ((extra[key] ?? 0) > 0) update[`system.currency.${key}`] = next[key];
  }
  return update;
}

async function doCarry(form: any): Promise<CarryResult | null> {
  let snap = readFormLoot(form);
  const purse = currencyOf(form);
  const plan = planFormLoot({ items: form.items, currency: purse, snapshot: snap });
  if (!plan || !snap) return null;
  const original = originalOf(form);
  const name = String(original?.name ?? form?.name ?? "?");
  if (!original || original.id === form.id) {
    warn("transform: form loot has no original Actor — nothing to copy onto");
    return { items: 0, coin: "no coin", name, skipped: "no-original" };
  }
  if (hasCoin(purse) && !hasCoin(plan.currency)) {
    warn(
      `transform: ${String(form.name)} holds ${formatCoin(purse)} but the stamp already had that purse — not adding again`,
    );
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
      const update = currencyUpdate(currencyOf(original), plan.currency);
      await original.update(update);
      snap = { ...snap, currency: purse };
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
    log(
      `transform: carried ${result.items} item(s) and ${result.coin} → ${name} (${original.id}) from ${String(form.name)} (${form.id})`,
    );
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
    await carryAllFormLoot(this);
    const originalActor = originalOf(this);
    const result = await original.call(this, options);
    await discardFormLeftovers(originalActor ?? this);
    return result;
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
  const result = await carryAllFormLoot(actor);
  if (result?.skipped === "write-failed") return;
  const next = { ...(options && typeof options === "object" ? options : {}) };
  next[MODULE_ID] = { ...(next[MODULE_ID] ?? {}), [DELETE_REPLAY]: true };
  try {
    await actor.delete(next);
  } catch (err) {
    warn("transform: replayed delete after loot carry failed:", err);
  }
}

function folderIdOf(actor: any): string {
  const folder = actor?.folder;
  if (!folder) return "";
  return String(folder.id ?? folder);
}

async function parkFormInFolder(actor: any): Promise<void> {
  if (!readFormLoot(actor)) return;
  const folderId = findFormFolderId();
  if (!folderId || folderIdOf(actor) === folderId) return;
  if (!actor.isOwner && !isPrimaryGM()) return;
  try {
    await actor.update({ folder: folderId });
    debug("transform: moved leftover", String(actor.name), "into", transformFolderName());
  } catch (err) {
    warn("transform: could not move leftover into the temp folder:", err);
  }
}

export function registerTransformWatch(): void {
  wrapRevertOriginalForm();
  registerQuery(DISCARD_QUERY, handleDiscardQuery);
  void ensureFormFolder();
  Hooks.on("dnd5e.transformActor", divertCreateData);
  Hooks.on("dnd5e.transformActorV2", divertCreateData);
  Hooks.on("createActor", (actor: any) => {
    void parkFormInFolder(actor);
  });
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
      const keep = leftoverKeepReason({
        actorId: String(actor.id ?? ""),
        originalId: String(originalOf(actor)?.id ?? loot.originalActor),
        rootId: String(originalOf(actor)?.id ?? ""),
        snapshot: loot,
        polymorphed: isPolymorphed(actor),
        hasToken: leftoverHasToken(actor),
        pendingLoot: leftoverPendingLoot(actor, loot),
      });
      lines.push(
        `  leftover ${String(actor.name)} folder=${String(actor.folder?.name ?? actor.folder ?? "—")}` +
          ` stamped=${loot.itemIds.length} purse=${formatCoin(currencyOf(actor))} original=${loot.originalActor}` +
          ` root=${originalOf(actor)?.id ?? "?"}` +
          ` discard=${keep ?? "yes"}`,
      );
    }
  } catch {
    /* directory unread */
  }
  const block = lines.join("\n");
  log(block);
  return { text: block, tokens: tokens.length };
}
