// Dropping to 0 HP actually means something.
//
// Stock dnd5e floors hit points at zero and never applies Unconscious, Dead, Defeated, or death-save
// failures from damage. Instant death (excess ≥ max HP) is prose only. This layer closes that gap
// via dnd5e's own applyDamage hooks — no patching, and we stand aside when midi's Add Dead is on.
//
// Register on every client: the updating user's client is the one that writes (same gate as bloodied).

import { log, MODULE_ID } from "../constants";
import { speakerFor } from "../util/speaker";
import { announceRuling } from "../integration/contract";
import { getEconomyMode, isDyingAutomationEnabled, honorImportantNpcDeathSaves } from "../settings";
import { check, spend } from "./economy/ledger";
import { firstAidDc } from "../system/dnd5e-checks";
import {
  deathFailuresFromDamage,
  hpSnapshot,
  isInstantDeath,
  midiOwnsDying,
  usesDeathSaves,
} from "../system/dnd5e-dying";
import { isDnd5e } from "../system/dnd5e-rewards";
import { hasStatus } from "../system/dnd5e-conditions";

interface PendingDamage {
  oldHp: number;
  oldTemp: number;
  maxHp: number;
  amount: number;
  critical: boolean;
  failures: number;
  successes: number;
  hadUnconscious: boolean;
  hadDead: boolean;
  hadStable: boolean;
}

interface UndoEntry {
  uuid: string;
  reason: string;
  failures: number;
  successes: number;
  unconscious: boolean;
  dead: boolean;
  stable: boolean;
  combatantDefeated: { id: string; defeated: boolean }[];
}

/** One-shot bridge from preApplyDamage → applyDamage (same tick, same client). */
const pending = new Map<string, PendingDamage>();

/** Death-save outcomes we still need to finish after stock writes counters. */
const pendingSave = new Map<string, "dead" | "stable">();

const undoStack: UndoEntry[] = [];
const UNDO_CAP = 40;

function enabled(): boolean {
  return isDnd5e() && isDyingAutomationEnabled() && !midiOwnsDying();
}

function actorKey(actor: any): string {
  return String(actor?.uuid ?? actor?.id ?? "");
}

function messageIsCritical(options: any): boolean {
  try {
    const msg =
      options?.originatingMessage ??
      options?.origin ??
      (typeof options?.originatingMessage === "string" ? null : options?.originatingMessage);
    const doc =
      msg && typeof msg === "object"
        ? msg
        : typeof options?.origin === "string"
          ? (foundry as any)?.utils?.fromUuidSync?.(options.origin)
          : null;
    const rolls: any[] = doc?.rolls ?? [];
    for (const r of rolls) {
      if (r?.isCritical) return true;
      if (r?.d20?.options?.criticalSuccess != null && r?.isCritical !== false) {
        // Attack rolls expose isCritical; damage rolls often ride the attack message.
        if (r?.options?.type === "attack" || r?.dice?.[0]?.faces === 20) {
          if (r.isCritical) return true;
        }
      }
    }
    const targets = doc?.flags?.dnd5e?.targets;
    if (Array.isArray(targets) && targets.some((t: any) => t?.isCritical)) return true;
  } catch {
    // ignore
  }
  return Boolean(options?.isCritical || options?.critical);
}

function capturePending(actor: any, amount: number, options: any): void {
  if (!enabled() || !(amount > 0)) return;
  const key = actorKey(actor);
  if (!key) return;
  const snap = hpSnapshot(actor);
  pending.set(key, {
    oldHp: snap.value,
    oldTemp: snap.temp,
    maxHp: snap.max,
    amount,
    critical: messageIsCritical(options),
    failures: snap.failures,
    successes: snap.successes,
    hadUnconscious: hasStatus(actor, "unconscious"),
    hadDead: hasStatus(actor, "dead"),
    hadStable: hasStatus(actor, "stable"),
  });
}

async function setStatus(actor: any, statusId: string, active: boolean): Promise<void> {
  try {
    if (active === hasStatus(actor, statusId)) return;
    await actor.toggleStatusEffect(statusId, { active });
  } catch (err) {
    log(`dying: could not set ${statusId}=${active} on ${actor?.name}:`, err);
  }
}

async function setCombatantDefeated(
  actor: any,
  defeated: boolean,
): Promise<{ id: string; defeated: boolean }[]> {
  const prior: { id: string; defeated: boolean }[] = [];
  try {
    const combatants =
      game.combat?.getCombatantsByActor?.(actor) ??
      (game.combat?.combatants ?? []).filter(
        (c: any) => c?.actor === actor || c?.actorId === actor?.id,
      );
    for (const c of combatants) {
      prior.push({ id: String(c.id), defeated: Boolean(c.defeated) });
      if (Boolean(c.defeated) !== defeated) {
        await c.update({ defeated });
      }
    }
  } catch (err) {
    log("dying: combatant defeated update failed:", err);
  }
  return prior;
}

async function announce(actor: any, text: string, undoable: boolean): Promise<void> {
  try {
    const ChatMessage = (globalThis as any).ChatMessage;
    const escape = foundry.utils.escapeHTML;
    const button = undoable
      ? `<button type="button" data-action="noodlr-undo-dying">${game.i18n.localize(
          "NOODLRHOOKS.Combat.Dying.Undo",
        )}</button>`
      : "";
    await ChatMessage.create({
      content: `<p>${escape(text)}</p>${button}`,
      speaker: speakerFor(actor),
      flags: { [MODULE_ID]: { dying: true } },
    });
  } catch (err) {
    log("dying: could not announce:", err);
  }
  // Every dying-layer message is a ruling worth a narrator knowing about. `undo` is offered only
  // where the card offers it, so a listener can never promise the table a reversal we cannot make.
  await announceRuling({
    kind: "dying",
    summary: text,
    detail: { undoable },
    actor,
    undo: undoable ? async () => undoDying() : undefined,
  });
}

function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry);
  while (undoStack.length > UNDO_CAP) undoStack.shift();
}

async function becomeDead(actor: any, reason: string, before: PendingDamage): Promise<void> {
  const combatantDefeated = await setCombatantDefeated(actor, true);
  pushUndo({
    uuid: actorKey(actor),
    reason,
    failures: before.failures,
    successes: before.successes,
    unconscious: before.hadUnconscious,
    dead: before.hadDead,
    stable: before.hadStable,
    combatantDefeated,
  });
  if (hasStatus(actor, "unconscious")) await setStatus(actor, "unconscious", false);
  if (hasStatus(actor, "stable")) await setStatus(actor, "stable", false);
  await setStatus(actor, "dead", true);
  await announce(
    actor,
    game.i18n.format("NOODLRHOOKS.Combat.Dying.Dead", {
      name: String(actor.name ?? "Someone"),
      reason,
    }),
    true,
  );
}

async function becomeUnconscious(actor: any, before: PendingDamage): Promise<void> {
  const combatantDefeated = await setCombatantDefeated(actor, false);
  pushUndo({
    uuid: actorKey(actor),
    reason: "unconscious",
    failures: before.failures,
    successes: before.successes,
    unconscious: before.hadUnconscious,
    dead: before.hadDead,
    stable: before.hadStable,
    combatantDefeated,
  });
  if (hasStatus(actor, "dead")) await setStatus(actor, "dead", false);
  if (hasStatus(actor, "stable")) await setStatus(actor, "stable", false);
  await setStatus(actor, "unconscious", true);
  await announce(
    actor,
    game.i18n.format("NOODLRHOOKS.Combat.Dying.Unconscious", {
      name: String(actor.name ?? "Someone"),
    }),
    true,
  );
}

async function addDeathFailures(actor: any, before: PendingDamage, add: number): Promise<void> {
  const death = actor.system?.attributes?.death;
  if (!death) return;
  const next = Math.min(3, (before.failures || 0) + add);
  pushUndo({
    uuid: actorKey(actor),
    reason: "failure",
    failures: before.failures,
    successes: before.successes,
    unconscious: before.hadUnconscious || hasStatus(actor, "unconscious"),
    dead: before.hadDead,
    stable: before.hadStable,
    combatantDefeated: [],
  });
  await actor.update({ "system.attributes.death.failure": next });
  if (hasStatus(actor, "stable")) await setStatus(actor, "stable", false);
  if (!hasStatus(actor, "unconscious") && !hasStatus(actor, "dead")) {
    await setStatus(actor, "unconscious", true);
  }
  await announce(
    actor,
    game.i18n.format("NOODLRHOOKS.Combat.Dying.Failure", {
      name: String(actor.name ?? "Someone"),
      add: String(add),
      failures: String(next),
    }),
    true,
  );
  if (next >= 3) {
    const snap = {
      ...before,
      failures: next,
      hadUnconscious: hasStatus(actor, "unconscious"),
      hadDead: hasStatus(actor, "dead"),
      hadStable: hasStatus(actor, "stable"),
    };
    await becomeDead(
      actor,
      game.i18n.localize("NOODLRHOOKS.Combat.Dying.Reason.ThreeFailures"),
      snap,
    );
  }
}

async function resolveAppliedDamage(actor: any): Promise<void> {
  if (!enabled()) {
    pending.delete(actorKey(actor));
    return;
  }
  const key = actorKey(actor);
  const before = pending.get(key);
  pending.delete(key);
  if (!before) return;

  const { oldHp, oldTemp, maxHp, amount, critical } = before;
  const honor = honorImportantNpcDeathSaves();
  const saves = usesDeathSaves(actor, honor);

  // Instant death: excess past 0 ≥ max HP (works on the drop and while already at 0).
  if (isInstantDeath(oldHp, oldTemp, maxHp, amount)) {
    if (!hasStatus(actor, "dead")) {
      await becomeDead(
        actor,
        game.i18n.localize("NOODLRHOOKS.Combat.Dying.Reason.Massive"),
        before,
      );
    }
    return;
  }

  // Already at 0 (or below): damage adds death-save failures for creatures that use them.
  if (oldHp <= 0) {
    if (hasStatus(actor, "dead")) return;
    if (!saves) {
      // Ordinary NPC already should be dead; repair a missing mark.
      if (!hasStatus(actor, "dead")) {
        await becomeDead(
          actor,
          game.i18n.localize("NOODLRHOOKS.Combat.Dying.Reason.ZeroHp"),
          before,
        );
      }
      return;
    }
    const add = deathFailuresFromDamage(critical);
    await addDeathFailures(actor, before, add);
    return;
  }

  // Crossing into 0 from positive HP.
  const newHp = Number(actor.system?.attributes?.hp?.value ?? 0) || 0;
  if (newHp > 0 || oldHp <= 0) return;

  if (saves) {
    if (!hasStatus(actor, "unconscious") && !hasStatus(actor, "dead")) {
      await becomeUnconscious(actor, before);
    }
  } else if (!hasStatus(actor, "dead")) {
    await becomeDead(actor, game.i18n.localize("NOODLRHOOKS.Combat.Dying.Reason.ZeroHp"), before);
  }
}

/**
 * Direct HP edits (and anything else that skips applyDamage) still need a drop-to-0 response.
 * Damage-at-0 with no HP change cannot be seen here — that path only exists through applyDamage.
 */
async function onHpChanged(
  actor: any,
  changes: { hp: number; temp: number; total: number },
  userId: string,
): Promise<void> {
  if (!enabled()) return;
  if (userId !== game.userId) return;
  if (pending.has(actorKey(actor))) return; // applyDamage path owns this update

  const newHp = Number(actor.system?.attributes?.hp?.value ?? 0) || 0;
  const honor = honorImportantNpcDeathSaves();
  const saves = usesDeathSaves(actor, honor);

  // Healed above 0: clear dying marks. Death counters are already reset by stock preUpdateHP.
  if (changes.total > 0 && newHp > 0) {
    const had =
      hasStatus(actor, "unconscious") || hasStatus(actor, "dead") || hasStatus(actor, "stable");
    if (!had) return;
    const before: PendingDamage = {
      oldHp: 0,
      oldTemp: 0,
      maxHp: hpSnapshot(actor).max,
      amount: 0,
      critical: false,
      failures: Number(actor.system?.attributes?.death?.failure ?? 0) || 0,
      successes: Number(actor.system?.attributes?.death?.success ?? 0) || 0,
      hadUnconscious: hasStatus(actor, "unconscious"),
      hadDead: hasStatus(actor, "dead"),
      hadStable: hasStatus(actor, "stable"),
    };
    const combatantDefeated = await setCombatantDefeated(actor, false);
    pushUndo({
      uuid: actorKey(actor),
      reason: "heal",
      failures: before.failures,
      successes: before.successes,
      unconscious: before.hadUnconscious,
      dead: before.hadDead,
      stable: before.hadStable,
      combatantDefeated,
    });
    await setStatus(actor, "dead", false);
    await setStatus(actor, "unconscious", false);
    await setStatus(actor, "stable", false);
    await announce(
      actor,
      game.i18n.format("NOODLRHOOKS.Combat.Dying.Revived", {
        name: String(actor.name ?? "Someone"),
      }),
      true,
    );
    return;
  }

  // Dropped to 0 by a non-applyDamage update (rare; token bar goes through applyDamage).
  if (changes.total < 0 && newHp <= 0) {
    const oldHpApprox = newHp - changes.hp;
    if (oldHpApprox > 0) {
      const before: PendingDamage = {
        oldHp: oldHpApprox,
        oldTemp: 0,
        maxHp: hpSnapshot(actor).max,
        amount: Math.abs(changes.total),
        critical: false,
        failures: Number(actor.system?.attributes?.death?.failure ?? 0) || 0,
        successes: Number(actor.system?.attributes?.death?.success ?? 0) || 0,
        hadUnconscious: hasStatus(actor, "unconscious"),
        hadDead: hasStatus(actor, "dead"),
        hadStable: hasStatus(actor, "stable"),
      };
      if (saves) {
        if (!hasStatus(actor, "unconscious") && !hasStatus(actor, "dead")) {
          await becomeUnconscious(actor, before);
        }
      } else if (!hasStatus(actor, "dead")) {
        await becomeDead(
          actor,
          game.i18n.localize("NOODLRHOOKS.Combat.Dying.Reason.ZeroHp"),
          before,
        );
      }
    }
  }
}

/** Capture intent before stock writes; apply statuses after in postRollDeathSave. */
function onDeathSave(
  _rolls: any[],
  details: { chatString?: string; subject?: any; updates?: any },
): void {
  if (!enabled()) return;
  const actor = details?.subject;
  if (!actor) return;
  const key = actorKey(actor);
  const failures = Number(details?.updates?.["system.attributes.death.failure"]);
  if (Number.isFinite(failures) && failures >= 3) {
    pendingSave.set(key, "dead");
    return;
  }
  if (details?.chatString === "DND5E.DeathSaveSuccess") {
    pendingSave.set(key, "stable");
  }
}

/**
 * After a death save resolves and stock has written counters: 3 failures → Dead (stock only chats);
 * 3 successes → Stable (stock clears counters, leaves no status).
 */
async function onPostDeathSave(_rolls: any[], data: { subject?: any }): Promise<void> {
  if (!enabled()) return;
  const actor = data?.subject;
  if (!actor) return;
  if (!actor.isOwner && !game.user?.isGM) return;

  const key = actorKey(actor);
  const intent = pendingSave.get(key);
  pendingSave.delete(key);
  if (!intent) return;

  try {
    const snap = hpSnapshot(actor);
    if (intent === "dead" && !hasStatus(actor, "dead")) {
      const before: PendingDamage = {
        oldHp: snap.value,
        oldTemp: snap.temp,
        maxHp: snap.max,
        amount: 0,
        critical: false,
        failures: snap.failures,
        successes: snap.successes,
        hadUnconscious: hasStatus(actor, "unconscious"),
        hadDead: false,
        hadStable: hasStatus(actor, "stable"),
      };
      await becomeDead(
        actor,
        game.i18n.localize("NOODLRHOOKS.Combat.Dying.Reason.ThreeFailures"),
        before,
      );
      return;
    }
    if (
      intent === "stable" &&
      snap.value <= 0 &&
      !hasStatus(actor, "dead") &&
      !hasStatus(actor, "stable")
    ) {
      if (!hasStatus(actor, "unconscious")) await setStatus(actor, "unconscious", true);
      await setStatus(actor, "stable", true);
      await announce(
        actor,
        game.i18n.format("NOODLRHOOKS.Combat.Dying.Stable", {
          name: String(actor.name ?? "Someone"),
        }),
        false,
      );
    }
  } catch (err) {
    log("dying: post death-save follow-up failed:", err);
  }
}

function wireUndoButton(_message: unknown, html: unknown): void {
  if (!game.user?.isGM) return;
  const root: HTMLElement | undefined =
    html instanceof HTMLElement ? html : ((html as any)?.[0] as HTMLElement | undefined);
  const button = root?.querySelector<HTMLButtonElement>('[data-action="noodlr-undo-dying"]');
  if (!button) return;
  button.addEventListener("click", async () => {
    button.disabled = true;
    const restored = await undoDying();
    ui.notifications?.info(
      game.i18n.format("NOODLRHOOKS.Combat.Dying.Restored", { count: String(restored) }),
    );
  });
}

/** Put the last dying change back. GM escape hatch. */
export async function undoDying(): Promise<number> {
  const entry = undoStack.pop();
  if (!entry) return 0;
  try {
    const actor: any = await (globalThis as any).fromUuid?.(entry.uuid);
    if (!actor) return 0;
    await actor.update({
      "system.attributes.death.failure": entry.failures,
      "system.attributes.death.success": entry.successes,
    });
    await setStatus(actor, "dead", entry.dead);
    await setStatus(actor, "unconscious", entry.unconscious);
    await setStatus(actor, "stable", entry.stable);
    for (const c of entry.combatantDefeated) {
      const combatant = game.combat?.combatants?.get?.(c.id);
      if (combatant && Boolean(combatant.defeated) !== c.defeated) {
        await combatant.update({ defeated: c.defeated });
      }
    }
    return 1;
  } catch (err) {
    log("dying: undo failed:", err);
    return 0;
  }
}

/**
 * Administer First Aid: a DC 10 Wisdom (Medicine) check to stabilise a dying creature.
 *
 * The other half of `stable`, and the half nothing in the stack offers. Three successful death saves
 * already reach Stable through `onPostDeathSave` above, but the deliberate route — somebody kneeling
 * down and doing something about it — has no button anywhere, because 2024 files it under the Utilize
 * action and dnd5e ships no item for it. Same gap, and the same answer, as the Hide action.
 *
 * Costs whoever is helping their Action, charged after the roll so a cancelled dialog is free and
 * charged whether or not the check succeeded, which is the rule. A creature that is already Stable,
 * dead, or standing up is refused before any dice are asked for.
 */
export async function administerFirstAid(
  healer: any,
  patient: any,
): Promise<{ stabilized: boolean; total: number | null; dc: number; reason: string }> {
  const { dc, skill } = firstAidDc();
  const helper = healer?.actor ?? healer;
  const actor = patient?.actor ?? patient;
  const fail = (reason: string) => ({ stabilized: false, total: null, dc, reason });

  if (!helper || !actor) return fail("select who is helping and target who is dying");
  if (!enabled()) return fail("the dying layer is off");

  const snap = hpSnapshot(actor);
  if (snap.value > 0) return fail(`${String(actor.name)} is not dying`);
  if (hasStatus(actor, "dead")) return fail(`${String(actor.name)} is beyond first aid`);
  if (hasStatus(actor, "stable")) return fail(`${String(actor.name)} is already stable`);

  // Refused rather than asked when there is nothing left to spend, matching the Hide action: the
  // over-budget dialog exists for features that legitimately break the general rule, and kneeling
  // over a body is not one of them.
  const combat: any = game.combat;
  const combatant = healer?.document?.combatant;
  const onTheirTurn =
    combat?.started && combatant && String(combatant.id) === String(combat.combatant?.id ?? "");
  if (onTheirTurn && getEconomyMode() !== "off") {
    if (!check(helper, combat, combatant, "action", false).allowed) {
      return fail("no action left this turn");
    }
  }

  let total: number | null = null;
  try {
    const rolls: any[] = (await helper.rollSkill({ skill })) ?? [];
    const value = Number(rolls?.[0]?.total);
    total = Number.isFinite(value) ? value : null;
  } catch (err) {
    log("dying: could not roll the first-aid check:", err);
    return fail("the Medicine check failed to roll");
  }
  if (total === null) return fail("the roll was cancelled");

  if (onTheirTurn && getEconomyMode() !== "off") {
    spend(helper, combat, combatant, "action", false);
  }

  // Announced either way. A failure that says nothing looks like the button not working, and the
  // action was spent regardless — the table needs to see where it went.
  if (total < dc) {
    await announce(
      actor,
      game.i18n.format("NOODLRHOOKS.Combat.Dying.FirstAidFailed", {
        healer: String(helper.name ?? "Someone"),
        total: String(total),
        dc: String(dc),
      }),
      false,
    );
    return { stabilized: false, total, dc, reason: `rolled ${total} against DC ${dc}` };
  }

  await setStatus(actor, "stable", true);
  if (!hasStatus(actor, "unconscious")) await setStatus(actor, "unconscious", true);
  await announce(
    actor,
    game.i18n.format("NOODLRHOOKS.Combat.Dying.FirstAid", {
      healer: String(helper.name ?? "Someone"),
      name: String(actor.name ?? "someone"),
      total: String(total),
      dc: String(dc),
    }),
    false,
  );
  return { stabilized: true, total, dc, reason: `rolled ${total} against DC ${dc}` };
}

/** GM/player entry point: the selected token gives first aid to whatever it has targeted. */
export async function firstAidTargets(): Promise<unknown> {
  const healer: any = (canvas as any)?.tokens?.controlled?.[0];
  const targets = Array.from((game.user?.targets ?? []) as Set<any>);
  if (!healer || targets.length === 0) {
    return { error: "select who is helping and target who is dying" };
  }
  const results: Record<string, unknown> = {};
  for (const patient of targets) {
    results[String(patient?.name ?? "?")] = await administerFirstAid(healer, patient);
  }
  return results;
}

export function registerDyingHooks(): void {
  Hooks.on("dnd5e.preApplyDamage", (actor: any, amount: number, _updates: any, options: any) => {
    try {
      capturePending(actor, amount, options);
    } catch (err) {
      log("dying: preApplyDamage failed:", err);
    }
  });

  Hooks.on("dnd5e.applyDamage", (actor: any, _amount: number, _options: any) => {
    try {
      // Pending was captured in preApplyDamage against the OLD hp. Do not re-read the actor here —
      // the update has already landed and would make every hit look like damage-at-zero.
      if (!pending.has(actorKey(actor))) return;
      void resolveAppliedDamage(actor);
    } catch (err) {
      log("dying: applyDamage failed:", err);
    }
  });

  Hooks.on("dnd5e.damageActor", (actor: any, changes: any, _changed: any, userId: string) => {
    try {
      void onHpChanged(actor, changes, userId);
    } catch (err) {
      log("dying: damageActor failed:", err);
    }
  });

  Hooks.on("dnd5e.healActor", (actor: any, changes: any, _changed: any, userId: string) => {
    try {
      void onHpChanged(actor, changes, userId);
    } catch (err) {
      log("dying: healActor failed:", err);
    }
  });

  Hooks.on("dnd5e.rollDeathSave", (rolls: any[], details: any) => {
    try {
      onDeathSave(rolls, details);
    } catch (err) {
      log("dying: rollDeathSave failed:", err);
    }
  });
  Hooks.on("dnd5e.rollDeathSaveV2", (rolls: any[], details: any) => {
    try {
      onDeathSave(rolls, details);
    } catch (err) {
      log("dying: rollDeathSaveV2 failed:", err);
    }
  });
  Hooks.on("dnd5e.postRollDeathSave", (rolls: any[], data: any) => {
    try {
      void onPostDeathSave(rolls, data);
    } catch (err) {
      log("dying: postRollDeathSave failed:", err);
    }
  });

  const renderHook =
    Number((game as any).release?.generation) >= 13 ? "renderChatMessageHTML" : "renderChatMessage";
  Hooks.on(renderHook, wireUndoButton);
}

export function surveyDying(): unknown {
  const token = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  const snap = actor ? hpSnapshot(actor) : null;
  return {
    enabled: enabled(),
    settingOn: isDyingAutomationEnabled(),
    midiOwns: midiOwnsDying(),
    honorImportantNpc: honorImportantNpcDeathSaves(),
    selected: actor?.name ?? null,
    type: actor?.type ?? null,
    usesDeathSaves: actor ? usesDeathSaves(actor, honorImportantNpcDeathSaves()) : null,
    hp: snap,
    statuses: actor
      ? {
          unconscious: hasStatus(actor, "unconscious"),
          dead: hasStatus(actor, "dead"),
          stable: hasStatus(actor, "stable"),
        }
      : null,
    undoDepth: undoStack.length,
  };
}
