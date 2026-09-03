// Applying compiled advantage, disadvantage and standing grants at the moment a roll is built.
//
// TWO READERS, ONE HOOK. An AE we wrote (Ray of Frost's Slow is not this file; Reckless Attack's
// "until your next turn" is) is found by flag. A standing `always` grant is found by query. An
// `on_attack_roll` grant is evaluated here as well, because that trigger is dispatched from the
// chat card — which is AFTER the roll — and Advantage on the roll that just posted is a turn too
// late. Reckless Attack's first swing is the specimen.
//
// This file never calls `fireTrigger`. Announcing and spending uses stay on the executor path, so
// a grant that also creates an AE for later rolls still has one card. Applying Advantage twice is
// harmless; posting two cards is not.
//
// Fail toward leaving the roll alone. An unreadable effect or an unmet guard is silence, not a
// forced Advantage.
//
// `config.subject` IS THE ACTIVITY (`AttackActivity#rollAttack` sets `rollConfig.subject = this`).
// Treating it as the creature — the first reading of the hook's name — walked an empty effect
// list and an empty binding map, so Reckless Attack announced Advantage after every Halberd
// swing and never changed the die. Unwrap via `subject.actor`. AC5e does the same.

import { MODULE_ID, log } from "../constants";
import { isStanding } from "../integration/capability";
import { bindingsFor } from "./bindings";
import { itemIsInPlay } from "./live-item";
import { conditionsMet, type EvalContext } from "./predicates";
import { standingGrants } from "./standing";

export type RollKind = "attack" | "save" | "check";

interface GrantHit {
  advantage: boolean;
  disadvantage: boolean;
  source: string;
  consume?: boolean;
  effect?: any;
}

/**
 * A grant that names `params.vs` only applies against that creature.
 *
 * Missing vs on the roll + a vs filter on the AE = fail closed (no grant). Vex is "your next
 * attack against *that* creature"; granting it on a swing at somebody else would spend the AE
 * and change the wrong die. A grant with no `vs` is unchanged — Reckless Attack and every
 * compiled standing grant.
 */
export function vsMatches(params: Record<string, unknown>, vs: any): boolean {
  const want = String(params.vs ?? "").trim();
  if (!want) return true;
  if (!vs) return false;
  const have = String(vs.uuid ?? vs.actor?.uuid ?? "");
  if (!have) return false;
  return have === want || String(vs.actor?.uuid ?? "") === want;
}

function rollTypesOf(raw: unknown): Set<string> {
  const text = String(raw ?? "")
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  const out = new Set<string>();
  if (!text || text === "any" || text === "all") {
    out.add("attack");
    out.add("save");
    out.add("check");
    return out;
  }
  if (/\battack\b|\bweapon\b|\bmwak\b|\brwak\b|\bmsak\b|\brsak\b/.test(text)) out.add("attack");
  if (/\bsave\b|\bsaving\b/.test(text)) out.add("save");
  if (/\bcheck\b|\bskill\b|\bability\b/.test(text)) out.add("check");
  if (out.size === 0) out.add(text.includes("attack") ? "attack" : text);
  return out;
}

function matchesRoll(
  params: Record<string, unknown>,
  kind: RollKind,
  ability: string,
  skill: string,
): boolean {
  if (!rollTypesOf(params.rollType).has(kind)) return false;
  const wantAbility = String(params.ability ?? "")
    .trim()
    .toLowerCase();
  if (wantAbility && wantAbility !== ability) return false;
  const wantSkill = String(params.skill ?? "")
    .trim()
    .toLowerCase();
  if (wantSkill && wantSkill !== skill) return false;
  return true;
}

function fromEffect(
  effect: any,
  kind: RollKind,
  ability: string,
  skill: string,
  vs?: any,
): GrantHit | null {
  const flag = effect?.flags?.[MODULE_ID]?.timed;
  if (!flag || effect?.disabled || effect?.duration?.expired) return null;
  if (flag.kind !== "grant_advantage" && flag.kind !== "impose_disadvantage") return null;
  const params = (flag.params ?? {}) as Record<string, unknown>;
  if (!matchesRoll(params, kind, ability, skill)) return null;
  if (!vsMatches(params, vs)) return null;
  return {
    advantage: flag.kind === "grant_advantage",
    disadvantage: flag.kind === "impose_disadvantage",
    source: String(flag.capability ?? effect.name ?? "compiled"),
    consume: params.consume === true,
    effect,
  };
}

function fromParams(
  kindName: string,
  params: Record<string, unknown>,
  source: string,
  roll: RollKind,
  ability: string,
  skill: string,
  vs?: any,
): GrantHit | null {
  if (kindName !== "grant_advantage" && kindName !== "impose_disadvantage") return null;
  if (!matchesRoll(params, roll, ability, skill)) return null;
  if (!vsMatches(params, vs)) return null;
  return {
    advantage: kindName === "grant_advantage",
    disadvantage: kindName === "impose_disadvantage",
    source,
    consume: params.consume === true,
  };
}

function collect(actor: any, kind: RollKind, ability: string, skill: string, vs?: any): GrantHit[] {
  const hits: GrantHit[] = [];
  if (!actor) return hits;

  for (const effect of actor.effects ?? []) {
    const hit = fromEffect(effect, kind, ability, skill, vs);
    if (hit) hits.push(hit);
  }

  for (const grant of standingGrants(actor)) {
    if (!grant.active) continue;
    const hit = fromParams(grant.kind, grant.params, grant.capability, kind, ability, skill, vs);
    if (hit) hits.push(hit);
  }

  if (kind === "attack") {
    const ctx: EvalContext = {
      self: { actor, token: actor?.token?.object ?? actor?.getActiveTokens?.()?.[0] },
      target: vs ? { actor: vs, token: vs?.token?.object ?? vs?.getActiveTokens?.()?.[0] } : undefined,
      attacker: { actor },
    };
    for (const binding of bindingsFor(actor)) {
      if (binding.capability.status === "rejected") continue;
      if (!itemIsInPlay(binding.item, actor)) continue;
      for (const rule of binding.capability.rules ?? []) {
        if (isStanding(rule)) continue;
        if (rule.trigger?.event !== "on_attack_roll") continue;
        if (rule.adjudication !== "engine") continue;
        const effectKind = String(rule.effect?.kind ?? "");
        if (effectKind !== "grant_advantage" && effectKind !== "impose_disadvantage") continue;
        const guards = conditionsMet(rule.condition, ctx);
        if (!guards.met) continue;
        const hit = fromParams(
          effectKind,
          rule.effect as Record<string, unknown>,
          binding.capability.label,
          kind,
          ability,
          skill,
          vs,
        );
        if (hit) hits.push(hit);
      }
    }
  }

  return hits;
}

function applyToConfig(config: any, hits: GrantHit[]): void {
  if (!hits.length) return;
  const adv = hits.filter((h) => h.advantage);
  const dis = hits.filter((h) => h.disadvantage);
  // dnd5e's applyKeybindings reads these flags, THEN stamps advantageMode. Setting the
  // mode ourselves as well is what survives a dialog that already decided "Normal".
  const modes = (globalThis as any).CONFIG?.Dice?.D20Roll?.ADV_MODE ?? { ADVANTAGE: 1, DISADVANTAGE: -1, NORMAL: 0 };
  if (adv.length) config.advantage = true;
  if (dis.length) config.disadvantage = true;
  const roll = config.rolls?.[0];
  if (roll) {
    roll.options ??= {};
    if (adv.length) roll.options.advantage = true;
    if (dis.length) roll.options.disadvantage = true;
    if (adv.length && !dis.length) roll.options.advantageMode = modes.ADVANTAGE;
    else if (!adv.length && dis.length) roll.options.advantageMode = modes.DISADVANTAGE;
  }
  const actor = actorOf(config);
  log(
    `grants: ${String(actor?.name ?? "?")}` +
      (adv.length ? ` ADV[${adv.map((h) => h.source).join(",")}]` : "") +
      (dis.length ? ` DIS[${dis.map((h) => h.source).join(",")}]` : ""),
  );
}

function abilityOf(config: any): string {
  return String(
    config?.ability ?? config?.subject?.ability ?? config?.rolls?.[0]?.data?.ability ?? "",
  )
    .trim()
    .toLowerCase();
}

/**
 * dnd5e 5.x puts the Activity on `config.subject`, not the Actor (`attack.mjs:128`).
 * Reading `subject` as the creature is why Reckless Attack wrote AEs after every
 * Halberd swing and never touched the die that just posted.
 */
function actorOf(config: any): any {
  const subject = config?.subject ?? null;
  if (isActor(subject)) return subject;
  if (subject?.actor) return subject.actor;
  if (isActor(config?.actor)) return config.actor;
  return config?.actor ?? null;
}

function isActor(doc: any): boolean {
  if (!doc) return false;
  if (doc.documentName === "Actor") return true;
  const uuid = String(doc.uuid ?? "");
  if (uuid.startsWith("Actor.") && !uuid.includes(".Item.") && !uuid.includes(".Activity.")) return true;
  return false;
}

function skillOf(config: any): string {
  return String(config?.skill ?? config?.rolls?.[0]?.data?.skill ?? "")
    .trim()
    .toLowerCase();
}

function targetActorOf(config: any): any {
  const uuid = config?.targets?.[0]?.uuid ?? config?.target?.uuid;
  if (!uuid) {
    const first = [...((globalThis as any).game?.user?.targets ?? [])][0];
    return first?.actor ?? null;
  }
  try {
    return (globalThis as any).fromUuidSync?.(uuid)?.actor ?? (globalThis as any).fromUuidSync?.(uuid) ?? null;
  } catch {
    return null;
  }
}

async function consumeHits(hits: GrantHit[]): Promise<void> {
  for (const hit of hits) {
    if (!hit.consume || !hit.effect) continue;
    try {
      if (typeof hit.effect.delete === "function") await hit.effect.delete();
    } catch (err) {
      log("grants: could not consume timed grant:", err);
    }
  }
}

function onPreRoll(config: any, kind: RollKind): void {
  const actor = actorOf(config);
  const hits = collect(actor, kind, abilityOf(config), skillOf(config), kind === "attack" ? targetActorOf(config) : undefined);
  applyToConfig(config, hits);
  void consumeHits(hits);
}

export function registerGrantHooks(): void {
  const Hooks = (globalThis as any).Hooks;
  if (!Hooks?.on) return;

  // Both V1 and V2 fire for the same roll (`basic-roll.mjs`). Setting advantage twice is a no-op.
  Hooks.on("dnd5e.preRollAttack", (config: any) => {
    try {
      onPreRoll(config, "attack");
    } catch (err) {
      log("grants: preRollAttack failed:", err);
    }
  });
  Hooks.on("dnd5e.preRollAttackV2", (config: any) => {
    try {
      onPreRoll(config, "attack");
    } catch (err) {
      log("grants: preRollAttackV2 failed:", err);
    }
  });
  Hooks.on("dnd5e.preRollSavingThrow", (config: any) => {
    try {
      onPreRoll(config, "save");
    } catch (err) {
      log("grants: preRollSavingThrow failed:", err);
    }
  });
  Hooks.on("dnd5e.preRollSavingThrowV2", (config: any) => {
    try {
      onPreRoll(config, "save");
    } catch (err) {
      log("grants: preRollSavingThrowV2 failed:", err);
    }
  });
  Hooks.on("dnd5e.preRollSkill", (config: any) => {
    try {
      onPreRoll(config, "check");
    } catch (err) {
      log("grants: preRollSkill failed:", err);
    }
  });
  Hooks.on("dnd5e.preRollAbilityCheck", (config: any) => {
    try {
      onPreRoll(config, "check");
    } catch (err) {
      log("grants: preRollAbilityCheck failed:", err);
    }
  });
}

/** Exported so a test can pin the rollType matching without a scene. */
export function __grantsInternals() {
  return { rollTypesOf, matchesRoll, vsMatches, collect, actorOf, abilityOf, applyToConfig };
}
