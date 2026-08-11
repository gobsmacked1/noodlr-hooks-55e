// Apply the 2024 condition rules that dnd5e leaves as prose.
//
// Stock never reads `conditionEffects.attackDisadvantage`, never looks at a target's statuses when
// building an attack, never auto-fails Str/Dex for Paralyzed, and never turns a hit within 5 ft of a
// Paralyzed/Unconscious creature into a critical. Nested Incapacitated is applied but nothing blocks
// activity use. This file is the missing enforcement, via dnd5e's own pre-roll hooks — no patching,
// no midi dependency (midi's optional rules for this default off anyway).
//
// Register on EVERY client: the hooks fire on the rolling client, which is often a player.

import { log, MODULE_ID } from "../constants";
import { speakerFor } from "../util/speaker";
import { announceRuling } from "../integration/contract";
import { isConditionAutomationEnabled } from "../settings";
import {
  ac5eOwnsConditions,
  attackIsMelee,
  attackModifiers,
  autoFailsSave,
  critOnHitWithin5,
  hasStatus,
  isIncapacitated,
} from "../system/dnd5e-conditions";
import { isDnd5e } from "../system/dnd5e-rewards";

function enabled(): boolean {
  return isDnd5e() && isConditionAutomationEnabled() && !ac5eOwnsConditions();
}

function tokenCenter(token: any): { x: number; y: number; elev: number } | null {
  const doc = token?.document ?? token;
  const x = Number(doc?.x);
  const y = Number(doc?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const grid = Number((canvas as any)?.grid?.size) || 0;
  const w = Number(doc?.width) || 1;
  const h = Number(doc?.height) || 1;
  return {
    x: x + (grid * w) / 2,
    y: y + (grid * h) / 2,
    elev: Number(doc?.elevation ?? 0) || 0,
  };
}

/** Scene-unit distance between two tokens, elevation-aware. */
function tokenDistance(a: any, b: any): number {
  const p1 = tokenCenter(a);
  const p2 = tokenCenter(b);
  if (!p1 || !p2) return Number.POSITIVE_INFINITY;
  const grid: any = (canvas as any)?.grid;
  let horizontal = Number.POSITIVE_INFINITY;
  try {
    if (typeof grid?.measurePath === "function") {
      const result = grid.measurePath([
        { x: p1.x, y: p1.y },
        { x: p2.x, y: p2.y },
      ]);
      const d = Number(result?.distance ?? result);
      if (Number.isFinite(d)) horizontal = d;
    }
  } catch {
    // fall through
  }
  if (!Number.isFinite(horizontal)) {
    const size = Number(grid?.size) || 100;
    const perSquare = Number(grid?.distance) || 5;
    horizontal = (Math.hypot(p2.x - p1.x, p2.y - p1.y) / size) * perSquare;
  }
  return Math.hypot(horizontal, p2.elev - p1.elev);
}

function controlledTokenFor(actor: any): any {
  if (!actor) return null;
  const controlled = (canvas as any)?.tokens?.controlled ?? [];
  for (const t of controlled) {
    if (t?.actor === actor || t?.document?.actorId === actor.id) return t;
  }
  // Prefer an active combatant token, then any placed token for this actor.
  const combatant = game.combat?.combatants?.find?.(
    (c: any) => c?.actor === actor || c?.actorId === actor.id,
  );
  if (combatant?.token?.object) return combatant.token.object;
  if (combatant?.token) return combatant.token;
  const tokens = actor.getActiveTokens?.(true) ?? actor.getActiveTokens?.() ?? [];
  return tokens[0] ?? null;
}

function primaryTarget(): { token: any; actor: any; ac: number | null } | null {
  const targets = Array.from((game.user as any)?.targets ?? []);
  if (!targets.length) return null;
  const token: any = targets[0];
  const actor = token?.actor ?? token?.document?.actor;
  let ac: number | null = null;
  try {
    const v = Number(actor?.system?.attributes?.ac?.value);
    if (Number.isFinite(v)) ac = v;
  } catch {
    ac = null;
  }
  return { token, actor, ac };
}

function activityOf(config: any): any {
  return config?.subject ?? null;
}

function actorOfAttack(config: any): any {
  const activity = activityOf(config);
  return activity?.actor ?? config?.subject?.actor ?? null;
}

/** Frightened: if we can find an origin token, only disadv when it is still "around". */
function fearSourceVisible(attacker: any): boolean | null {
  if (!hasStatus(attacker, "frightened")) return null;
  try {
    for (const effect of attacker.effects ?? []) {
      if (effect?.disabled) continue;
      const statuses = effect.statuses;
      const isFear =
        (statuses instanceof Set && statuses.has("frightened")) ||
        (Array.isArray(statuses) && statuses.includes("frightened"));
      if (!isFear) continue;
      const origin = String(effect.origin ?? "");
      if (!origin) return null; // apply disadv; caller may log
      // Best-effort: origin is often an Actor/Item uuid. Presence on the scene is enough.
      const doc = (foundry as any)?.utils?.fromUuidSync?.(origin);
      const token = doc?.object ?? doc?.token?.object ?? doc?.getActiveTokens?.()?.[0] ?? null;
      if (!token) return false;
      return true;
    }
  } catch {
    return null;
  }
  return null;
}

function applyAttackFlags(config: any): void {
  if (!enabled()) return;
  const attacker = actorOfAttack(config);
  const activity = activityOf(config);
  if (!attacker) return;
  const target = primaryTarget();
  const melee = attackIsMelee(activity);
  const fearVis = fearSourceVisible(attacker);
  const mods = attackModifiers(attacker, target?.actor ?? null, melee, {
    fearSourceVisible: fearVis,
  });
  if (!mods.advantage.length && !mods.disadvantage.length) return;

  if (mods.advantage.length) config.advantage = true;
  if (mods.disadvantage.length) config.disadvantage = true;
  // Per-roll options: applyKeybindings reads these too.
  const roll = config.rolls?.[0];
  if (roll) {
    roll.options ??= {};
    if (mods.advantage.length) roll.options.advantage = true;
    if (mods.disadvantage.length) roll.options.disadvantage = true;
  }
  log(
    `conditions: ${attacker.name} attack` +
      (mods.advantage.length ? ` ADV[${mods.advantage.join(",")}]` : "") +
      (mods.disadvantage.length ? ` DIS[${mods.disadvantage.join(",")}]` : "") +
      (target?.actor ? ` vs ${target.actor.name}` : ""),
  );
}

async function autoFailSave(config: any, dialog: any, message: any): Promise<boolean> {
  if (!enabled()) return true;
  const actor = config?.subject ?? null;
  const ability = String(config?.ability ?? "");
  const reason = autoFailsSave(actor, ability);
  if (!reason) return true;

  const name = String(actor?.name ?? "This creature");
  const abLabel = ability.toUpperCase() || "?";
  const summary = game.i18n.format("NOODLRHOOKS.Combat.Conditions.AutoFail", {
    name,
    ability: abLabel,
    status: reason,
  });
  ui.notifications?.info(
    game.i18n.format("NOODLRHOOKS.Combat.Conditions.AutoFailNotify", {
      name,
      ability: abLabel,
      status: reason,
    }),
  );
  try {
    const ChatMessage = (globalThis as any).ChatMessage;
    await ChatMessage.create({
      content: summary,
      speaker: speakerFor(actor, name),
      flags: {
        [MODULE_ID]: { conditionAutoFail: { ability, status: reason } },
      },
    });
  } catch (err) {
    log("conditions: failed to post auto-fail message:", err);
  }
  await announceRuling({
    kind: "condition",
    summary,
    detail: { rule: "auto-fail-save", ability, status: reason },
    actor,
  });
  // Cancel the real roll — a dialog would only invite a total that contradicts the rule.
  void dialog;
  void message;
  return false;
}

/**
 * After a hit against Paralyzed/Unconscious within 5 ft, mark the attack critical so the damage
 * button reads `isCritical`. Never pre-set criticalSuccess=1 (chat treats crits as non-misses).
 */
function forceCritOnHit(rolls: any[], data: { subject?: any }): void {
  if (!enabled()) return;
  const roll = rolls?.[0];
  if (!roll) return;
  const activity = data?.subject;
  const attacker = activity?.actor;
  const target = primaryTarget();
  if (!attacker || !target?.actor) return;
  const reason = critOnHitWithin5(target.actor);
  if (!reason) return;

  const aTok = controlledTokenFor(attacker);
  const dist = aTok ? tokenDistance(aTok, target.token) : Number.POSITIVE_INFINITY;
  if (dist > 5 + 0.01) return;

  if (roll.isFumble) return;
  const ac = target.ac ?? Number(roll.options?.target);
  const total = Number(roll.total);
  if (!Number.isFinite(ac) || !Number.isFinite(total) || total < ac) return;

  try {
    const d20 = roll.d20 ?? roll.dice?.[0];
    if (d20?.options) {
      d20.options.criticalSuccess = Number(d20.total ?? total);
    }
    roll.options ??= {};
    roll.options.criticalSuccess = Number(d20?.total ?? total);
    log(
      `conditions: ${attacker.name} hit ${target.actor.name} within 5 ft (${reason}) — forced critical`,
    );
  } catch (err) {
    log("conditions: could not force critical:", err);
  }
}

export function registerConditionHooks(): void {
  // Always register; each handler self-gates on system + setting so toggling mid-session works.

  Hooks.on("dnd5e.preRollAttack", (config: any) => {
    try {
      applyAttackFlags(config);
    } catch (err) {
      log("conditions: preRollAttack failed:", err);
    }
  });
  Hooks.on("dnd5e.preRollAttackV2", (config: any) => {
    try {
      applyAttackFlags(config);
    } catch (err) {
      log("conditions: preRollAttackV2 failed:", err);
    }
  });

  // The gate is repeated here rather than left to `autoFailSave`: cancelling is the synchronous
  // `return false`, so a check that lives only in the async announcement would kill the roll while
  // saying nothing about it — silently, and with the feature switched off.
  Hooks.on("dnd5e.preRollSavingThrow", (config: any, dialog: any, message: any) => {
    try {
      if (!enabled()) return;
      // Synchronous hook; kick the async post and cancel immediately when auto-fail applies.
      const actor = config?.subject;
      const ability = String(config?.ability ?? "");
      if (autoFailsSave(actor, ability)) {
        void autoFailSave(config, dialog, message);
        return false;
      }
    } catch (err) {
      log("conditions: preRollSavingThrow failed:", err);
    }
  });
  Hooks.on("dnd5e.preRollSavingThrowV2", (config: any, dialog: any, message: any) => {
    try {
      if (!enabled()) return;
      const actor = config?.subject;
      const ability = String(config?.ability ?? "");
      if (autoFailsSave(actor, ability)) {
        void autoFailSave(config, dialog, message);
        return false;
      }
    } catch (err) {
      log("conditions: preRollSavingThrowV2 failed:", err);
    }
  });

  Hooks.on("dnd5e.rollAttack", (rolls: any[], data: any) => {
    try {
      forceCritOnHit(rolls, data);
    } catch (err) {
      log("conditions: rollAttack crit hook failed:", err);
    }
  });
  Hooks.on("dnd5e.rollAttackV2", (rolls: any[], data: any) => {
    try {
      forceCritOnHit(rolls, data);
    } catch (err) {
      log("conditions: rollAttackV2 crit hook failed:", err);
    }
  });
}

/** Console diagnostic: what would apply for the controlled token vs its current target. */
export function surveyConditions(): unknown {
  const token = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  const target = primaryTarget();
  const melee = true;
  const mods = actor
    ? attackModifiers(actor, target?.actor ?? null, melee, {
        fearSourceVisible: fearSourceVisible(actor),
      })
    : { advantage: [], disadvantage: [] };
  const dist = actor && target?.token && token ? tokenDistance(token, target.token) : null;
  return {
    enabled: enabled(),
    settingOn: isConditionAutomationEnabled(),
    ac5eOwns: ac5eOwnsConditions(),
    system: String((game as any).system?.id ?? ""),
    attacker: actor?.name ?? null,
    incapacitated: actor ? isIncapacitated(actor) : null,
    target: target?.actor?.name ?? null,
    distance: dist,
    attackModifiers: mods,
    targetAutoFailStrDex: target?.actor ? autoFailsSave(target.actor, "str") : null,
    critOnHitWithin5: target?.actor ? critOnHitWithin5(target.actor) : null,
  };
}
