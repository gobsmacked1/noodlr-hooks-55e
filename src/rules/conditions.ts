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
  ac5eOwnsDodging,
  attackIsMelee,
  attackModifiers,
  autoFailsSave,
  critOnHitWithin5,
  hasStatus,
  isDodging,
  isIncapacitated,
  rangedNearbyFoeOwned,
  visibilityAttackRulesOwned,
} from "../system/dnd5e-conditions";
import { sightModifiers } from "./unseen";
import { isDnd5e } from "../system/dnd5e-rewards";
import { blocked, centerOf } from "../core/positioning";

function enabled(): boolean {
  return isDnd5e() && isConditionAutomationEnabled() && !ac5eOwnsConditions();
}

/**
 * Dodge is gated separately, because the two stand-asides are not the same size.
 *
 * `ac5eOwnsConditions()` is true at AC5e's stock settings while its Dodge entry is switched off, so
 * sharing one gate would hand the rule to a module that has been told not to enforce it. See
 * `ac5eOwnsDodging()` for the settings and the line numbers.
 */
function dodgeEnabled(): boolean {
  return isDnd5e() && isConditionAutomationEnabled() && !ac5eOwnsDodging();
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

/**
 * Can the dodger see who is attacking it? The Dodge benefit hangs on this and nothing else does.
 *
 * An approximation, and stated as one: a sight ray between the two centres, plus the obvious refusal for
 * a Blinded creature. It is not the per-creature detection-mode sweep `rules/perception.ts` runs, which
 * would be the right answer and cannot be afforded inside a synchronous pre-roll hook that fires on
 * every attack in the fight. It fails toward granting the Disadvantage: an unreadable canvas returns
 * null from `blocked`, and a creature that took the Dodge action should get what it paid for unless
 * something is definitely in the way.
 */
function dodgerSees(dodger: any, dodgerToken: any, attackerToken: any): boolean {
  if (hasStatus(dodger, "blinded")) return false;
  const from = centerOf(dodgerToken);
  const to = centerOf(attackerToken);
  if (!from || !to) return true;
  return blocked(from, to, "sight") !== true;
}

function applyAttackFlags(config: any): void {
  const attacker = actorOfAttack(config);
  const activity = activityOf(config);
  if (!attacker) return;
  const target = primaryTarget();
  const melee = attackIsMelee(activity);
  const fearVis = fearSourceVisible(attacker);
  const mods = enabled()
    ? attackModifiers(attacker, target?.actor ?? null, melee, { fearSourceVisible: fearVis })
    : { advantage: [] as string[], disadvantage: [] as string[] };

  // "Attack rolls against you have Disadvantage if you can see the attacker." Folded in here rather
  // than into `attackModifiers` because it needs both tokens, and that function is deliberately pure
  // over actors so the planner and the survey can call it with nothing placed.
  if (dodgeEnabled() && target?.actor && isDodging(target.actor)) {
    if (dodgerSees(target.actor, target.token, controlledTokenFor(attacker))) {
      mods.disadvantage.push("vs:dodging");
    }
  }

  // Unseen attacker, unseen target, and a ranged shot taken beside an enemy. Gated separately from
  // the status matrix because their contenders are separate: AC5e ships visibility ON and its range
  // checks OFF, so on the same table the first two are its and the third is nobody's but ours.
  if (isConditionAutomationEnabled()) {
    const geometry = sightModifiers({
      attackerToken: controlledTokenFor(attacker),
      targetToken: target?.token,
      melee,
      skipVisibility: visibilityAttackRulesOwned(),
      skipCrowding: rangedNearbyFoeOwned(),
    });
    mods.advantage.push(...geometry.advantage);
    mods.disadvantage.push(...geometry.disadvantage);
  }

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

/**
 * "You make Dexterity saving throws with Advantage" — the other half of the Dodge action.
 *
 * Written onto the config AND the first roll's options, the same pair `applyAttackFlags` sets, because
 * dnd5e reads the roll's own options when it applies keybindings and a config-only flag can be lost.
 */
function applySaveAdvantage(config: any): void {
  if (!dodgeEnabled()) return;
  if (String(config?.ability ?? "").toLowerCase() !== "dex") return;
  const actor = config?.subject ?? null;
  if (!isDodging(actor)) return;

  config.advantage = true;
  const roll = config.rolls?.[0];
  if (roll) {
    roll.options ??= {};
    roll.options.advantage = true;
  }
  log(`conditions: ${String(actor?.name)} is Dodging — DEX save at advantage`);
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

/**
 * Auto-fail first, then Dodge. Returning false cancels the roll.
 *
 * The auto-fail gate is repeated inside rather than left to the async announcement: cancelling is the
 * synchronous `return false`, so a check that lived only in the message would kill the roll while saying
 * nothing about it, with the feature switched off. Dodge answers to its own gate — see `dodgeEnabled`.
 */
function onPreRollSave(config: any, dialog: any, message: any): boolean | undefined {
  if (enabled()) {
    const actor = config?.subject;
    const ability = String(config?.ability ?? "");
    if (autoFailsSave(actor, ability)) {
      void autoFailSave(config, dialog, message);
      return false;
    }
  }
  applySaveAdvantage(config);
  return undefined;
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
      return onPreRollSave(config, dialog, message);
    } catch (err) {
      log("conditions: preRollSavingThrow failed:", err);
    }
  });
  Hooks.on("dnd5e.preRollSavingThrowV2", (config: any, dialog: any, message: any) => {
    try {
      return onPreRollSave(config, dialog, message);
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
    dodgeEnabled: dodgeEnabled(),
    settingOn: isConditionAutomationEnabled(),
    ac5eOwns: ac5eOwnsConditions(),
    ac5eOwnsDodge: ac5eOwnsDodging(),
    visibilityOwnedElsewhere: visibilityAttackRulesOwned(),
    rangedNearbyOwnedElsewhere: rangedNearbyFoeOwned(),
    attackerDodging: actor ? isDodging(actor) : null,
    targetDodging: target?.actor ? isDodging(target.actor) : null,
    system: String((game as any).system?.id ?? ""),
    attacker: actor?.name ?? null,
    incapacitated: actor ? isIncapacitated(actor) : null,
    target: target?.actor?.name ?? null,
    distance: dist,
    attackModifiers: mods,
    // Reported for BOTH melee and ranged whatever the survey's `melee` says, because the question a
    // GM brings here is "why did that shot have Disadvantage", and answering only about a melee swing
    // hides the crowding rule exactly when it is being asked about.
    sightMelee: sightModifiers({ attackerToken: token, targetToken: target?.token, melee: true }),
    sightRanged: sightModifiers({ attackerToken: token, targetToken: target?.token, melee: false }),
    critOnHitWithin5: target?.actor ? critOnHitWithin5(target.actor) : null,
  };
}
