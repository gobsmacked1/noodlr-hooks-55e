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
import { originatingUsageIdFromRoll, targetsOf, tokenFromActorUuid } from "./cards";
import {
  applyDamageCritDefault,
  damageActivityMayCrit,
  markAttackCritical,
  shouldForceCrit,
} from "./crit";

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
    const usageId = originatingUsageIdFromRoll(config, message);
    await ChatMessage.create({
      content: summary,
      speaker: speakerFor(actor?.token ?? actor, name),
      flags: {
        [MODULE_ID]: { conditionAutoFail: { ability, status: reason } },
        // The save layer joins this card to the activation the same way it joins a real
        // save. Without it, cancelling the roll leaves `success === null` forever, auto-damage
        // stands aside because auto-saves is on, and Apply sits there — Disintegrate vs a
        // paralyzed target is the specimen.
        ...(usageId ? { dnd5e: { originatingMessage: usageId } } : {}),
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

function targetsForCrit(roll: any): Array<{ token: any; actor: any; ac: number | null }> {
  const out: Array<{ token: any; actor: any; ac: number | null }> = [];
  for (const listed of targetsOf(roll?.parent ?? {})) {
    const doc = tokenFromActorUuid(listed.uuid);
    if (!doc) continue;
    let actor = doc.actor;
    if (!actor) {
      try {
        actor = (globalThis as any).fromUuidSync?.(listed.uuid);
      } catch {
        actor = null;
      }
    }
    if (!actor) continue;
    out.push({ token: doc, actor, ac: listed.ac });
  }
  if (out.length) return out;
  const one = primaryTarget();
  return one ? [one] : [];
}

function qualifyingCritTarget(
  attacker: any,
  roll: any,
  targets: Array<{ token: any; actor: any; ac: number | null }>,
): { target: { token: any; actor: any; ac: number | null }; reason: string; distance: number } | null {
  const aTok = controlledTokenFor(attacker);
  const total = Number(roll?.total);
  const fumble = Boolean(roll?.isFumble);
  for (const target of targets) {
    const reason = critOnHitWithin5(target.actor);
    const dist = aTok ? tokenDistance(aTok, target.token) : Number.POSITIVE_INFINITY;
    const ac = target.ac ?? Number(roll?.options?.target);
    if (
      shouldForceCrit({
        reason,
        distance: dist,
        isFumble: fumble,
        total,
        ac: Number.isFinite(ac) ? ac : null,
      })
    ) {
      return { target, reason: reason as string, distance: dist };
    }
  }
  return null;
}

/**
 * After a hit against Paralyzed/Unconscious within 5 ft, mark the attack critical so the damage
 * dialog reads `isCritical`.
 *
 * `dnd5e.rollAttack` fires AFTER `buildPost` has already serialized the roll onto the chat card.
 * Mutating the live object is not enough — `#rollDamage` reads `lastAttack.rolls[0].isCritical`
 * off that stored copy. Write the card back. Never pre-set criticalSuccess=1 (chat treats crits
 * as non-misses).
 */
function forceCritOnHit(rolls: any[], data: { subject?: any }): void {
  if (!enabled()) return;
  const roll = rolls?.[0];
  if (!roll) return;
  const attacker = data?.subject?.actor;
  if (!attacker) return;
  const hit = qualifyingCritTarget(attacker, roll, targetsForCrit(roll));
  if (!hit) return;

  try {
    if (!markAttackCritical(roll)) return;
    log(
      `conditions: ${attacker.name} hit ${hit.target.actor.name} within 5 ft (${hit.reason}) — forced critical`,
    );
    const message = roll.parent;
    if (typeof message?.update === "function") {
      void message.update({ rolls: rolls.map((r: any) => r.toJSON?.() ?? r) }).catch((err: unknown) => {
        log("conditions: could not persist forced critical onto the attack card:", err);
      });
    }
  } catch (err) {
    log("conditions: could not force critical:", err);
  }
}

/**
 * Default the damage dialog to Critical when the stored attack card still says it was not.
 *
 * Belt for the persist above: a click that wins the race, or a card we could not write, still
 * has to offer the extra dice. Only Attack activities — Fireball and a heal are not this rule.
 */
function defaultCritOnDamage(config: any, dialog: any): void {
  if (!enabled()) return;
  if (!damageActivityMayCrit(config?.subject?.type)) return;
  const attacker = config?.subject?.actor;
  if (!attacker) return;

  const associated = associatedAttackMessage(config);
  const roll = associated?.rolls?.[0];
  if (!roll) return;
  const targets = targetsForCrit({ parent: associated });
  const fallback = targets.length ? targets : primaryTarget() ? [primaryTarget()!] : [];
  const hit = qualifyingCritTarget(attacker, roll, fallback);
  if (!hit) return;

  applyDamageCritDefault(config, dialog);
  log(
    `conditions: damage dialog defaulted to critical vs ${hit.target.actor.name} (${hit.reason})`,
  );
}

function associatedAttackMessage(config: any): any {
  try {
    const el = config?.event?.target?.closest?.("[data-message-id]");
    const id = String(el?.dataset?.messageId ?? "");
    if (!id) return null;
    const usage = (game as any).messages?.get?.(id);
    const attacks = usage?.getAssociatedRolls?.("attack");
    if (Array.isArray(attacks) && attacks.length) return attacks[attacks.length - 1];
  } catch {
    // fall through
  }
  return null;
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

  // One of the pair, not both — they fire for the same rolls (`basic-roll.mjs`). Persisting
  // twice would rewrite the card twice.
  Hooks.on("dnd5e.rollAttack", (rolls: any[], data: any) => {
    try {
      forceCritOnHit(rolls, data);
    } catch (err) {
      log("conditions: rollAttack crit hook failed:", err);
    }
  });

  // Same: one of preRollDamage / V2. The dialog default is what a new player actually looks at.
  Hooks.on("dnd5e.preRollDamage", (config: any, dialog: any) => {
    try {
      defaultCritOnDamage(config, dialog);
    } catch (err) {
      log("conditions: preRollDamage crit default failed:", err);
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
