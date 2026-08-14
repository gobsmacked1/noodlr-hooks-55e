// Running a compiled capability.
//
// This is the deterministic half of the compiler, and the half that runs during play. No model is
// called here, ever: a descriptor was compiled once at scene load and everything below is a lookup, a
// comparison, and a call into `primitives.ts`. That is what keeps the v0.4.22 decision intact — the
// per-turn model call is gone and it stays gone; the call moved to scene load.
//
// THREE RULES THIS FILE FOLLOWS WITHOUT EXCEPTION:
//
//   1. **Fail closed.** A guard that cannot be evaluated stops the rule. A rule whose effect kind has
//      no executor stops. A quantity that will not resolve stops. Every refusal is recorded with a
//      reason, because the capability sheet is what turns a silent non-firing into a fixable bug.
//   2. **The primary GM alone executes.** `isGM` is a role several clients can hold, and every trigger
//      here is a document hook that fires on all of them. Without the gate a troll summons four limbs
//      per assistant GM.
//   3. **Nothing throws outward.** A capability is an enhancement; a broken one must not take a turn,
//      a save or an attack down with it.

import { MODULE_ID, debug, log, warn } from "../constants";
import { isPrimaryGM } from "../util/gm";
import { narrator, speakerFor } from "../util/speaker";
import {
  isExecutable,
  isStanding,
  type Capability,
  type CapabilityRule,
  type TriggerEvent,
} from "../integration/capability";
import { bindingsFor } from "./bindings";
import { conditionsMet, type EvalContext, type Subject } from "./predicates";
import { asQuantity, resolveQuantity } from "./quantity";
import {
  addCombatants,
  adjustUses,
  dealDamage,
  healActor,
  setCondition,
  summonCreature,
  summonedTokens,
} from "./primitives";
import { clearUse, noteRest, rollRecharge, spendUse, usesKey, usesLeft } from "./uses";
import { onDamageTaken } from "./damage-log";
import { noteRepeatSave } from "../rules/repeat-save";

// ---- Firing -------------------------------------------------------------------------------------

export interface TriggerContext extends EvalContext {
  /** Populated on `on_damage_taken`, so a rule can react to what actually landed. */
  damage?: { amount: number; types: string[] };
  /** Populated on `on_activity_use`. */
  activity?: any;
}

export interface RuleOutcome {
  capability: string;
  ruleIndex: number;
  fired: boolean;
  /** Why not. Always set when `fired` is false, and shown on the capability sheet. */
  reason?: string;
}

/** Everything a rule needs beyond its own descriptor, gathered once per fire. */
function combatFor(actor: any): { combat: any; combatant: any } {
  const combat = (game as any)?.combat ?? null;
  const uuid = String(actor?.uuid ?? "");
  const combatant =
    combat?.combatants?.find?.((c: any) => String(c?.actor?.uuid ?? "") === uuid) ?? null;
  return { combat, combatant };
}

function subjectOf(which: unknown, ctx: TriggerContext): Subject | undefined {
  switch (String(which ?? "self")) {
    case "self":
      return ctx.self;
    case "target":
      return ctx.target;
    case "attacker":
      return ctx.attacker;
    case "trigger":
      return ctx.attacker ?? ctx.target;
    default:
      return undefined;
  }
}

/**
 * Fire every rule bound to `ctx.self` that listens for `event`.
 *
 * Sequential rather than concurrent, deliberately: two rules on one creature can both change its hit
 * points, and running them in parallel makes the order — and therefore the result — depend on which
 * document update returns first.
 */
export async function fireTrigger(
  event: TriggerEvent,
  ctx: TriggerContext,
): Promise<RuleOutcome[]> {
  if (!isPrimaryGM()) return [];
  const outcomes: RuleOutcome[] = [];
  const actor = ctx.self?.actor;
  if (!actor) return outcomes;

  for (const binding of bindingsFor(actor)) {
    const capability = binding.capability;
    if (capability.status === "rejected") continue;

    for (let index = 0; index < (capability.rules ?? []).length; index++) {
      const rule = capability.rules[index];
      if (rule.trigger?.event !== event) continue;
      try {
        outcomes.push(await runRule(capability, rule, index, ctx));
      } catch (err) {
        // Rule 3. A broken descriptor is a capability-sheet problem, not a wrecked turn.
        warn(`capability "${capability.label}" rule ${index} threw:`, err);
        outcomes.push({
          capability: capability.label,
          ruleIndex: index,
          fired: false,
          reason: `threw: ${String(err)}`,
        });
      }
    }
  }

  if (outcomes.length) debug(`capabilities on ${event}`, outcomes);
  return outcomes;
}

async function runRule(
  capability: Capability,
  rule: CapabilityRule,
  index: number,
  ctx: TriggerContext,
): Promise<RuleOutcome> {
  const label = capability.label;
  const no = (reason: string): RuleOutcome => ({
    capability: label,
    ruleIndex: index,
    fired: false,
    reason,
  });

  if (rule.adjudication === "gm") return no("left to the GM by design");
  if (rule.adjudication === "narration") {
    // Handed to noodlr as a behavior request rather than performed here. Nothing in this module can
    // give a corpse a voice, and nothing in it should try.
    return no("narration: routed to the companion module");
  }
  if (!isExecutable(rule)) return no("no executor for this effect or one of its guards");

  const actor = ctx.self.actor;
  const { combat, combatant } = combatFor(actor);
  const key = usesKey(capability.id, index);

  if (rule.uses) {
    let state = usesLeft(actor, key, rule.uses, combat, combatant);
    if (state.remaining <= 0 && rule.uses.per === "recharge" && rule.uses.recharge) {
      const recharged = await rollRecharge(actor, rule.uses.recharge);
      if (recharged) {
        await clearUse(actor, key);
        state = usesLeft(actor, key, rule.uses, combat, combatant);
      }
    }
    if (state.remaining <= 0)
      return no(`no uses left (${state.spent}/${state.max} per ${rule.uses.per})`);
  }

  const guards = conditionsMet(rule.condition, { ...ctx, combat, combatant });
  if (!guards.met) return no(guards.blockedBy ?? "a condition was not met");

  const ran = await applyEffect(capability, rule, ctx);
  if (!ran.ok) return no(ran.reason ?? "the effect did nothing");

  if (rule.uses) await spendUse(actor, key, rule.uses, combat, combatant);
  announce(capability, rule, ctx, ran.detail ?? "");
  return { capability: label, ruleIndex: index, fired: true };
}

// ---- The effects --------------------------------------------------------------------------------

interface EffectResult {
  ok: boolean;
  reason?: string;
  /** One short clause for the chat card, in the creature's own terms. */
  detail?: string;
}

async function applyEffect(
  capability: Capability,
  rule: CapabilityRule,
  ctx: TriggerContext,
): Promise<EffectResult> {
  const effect = rule.effect;
  const self = ctx.self;
  const subject = subjectOf(effect.target, ctx);
  const quantityFor = (raw: unknown) =>
    resolveQuantity(asQuantity(raw), {
      actor: self.actor,
      token: self.token,
      spellLevel: ctx.spellLevel,
    });

  switch (effect.kind) {
    case "damage": {
      if (!subject?.actor) return { ok: false, reason: "no target for the damage" };
      const amount = await quantityFor(effect.amount);
      if (amount === null) return { ok: false, reason: "the amount would not resolve" };
      const ok = await dealDamage(subject.actor, {
        amount,
        damageType: effect.damageType ? String(effect.damageType) : undefined,
        origin: capability.label,
      });
      return { ok, detail: `${amount} ${String(effect.damageType ?? "")} damage`.trim() };
    }

    case "heal": {
      const who = subject?.actor ?? self.actor;
      const amount = await quantityFor(effect.amount);
      if (amount === null) return { ok: false, reason: "the amount would not resolve" };
      const ok = await healActor(who, { amount, temporary: Boolean(effect.temporary) });
      return { ok, detail: `regains ${amount} hit points` };
    }

    case "apply_status": {
      const who = subject?.actor ?? ctx.target?.actor;
      if (!who) return { ok: false, reason: "no target for the condition" };
      const status = String(effect.status).toLowerCase();
      const ok = await setCondition(who, status, true);
      // A descriptor that states a DC and an ability alongside the status is stating the escape
      // clause too — "repeat the save at the end of each of its turns" — so register it here rather
      // than asking the compiler for a second rule that would only ever accompany this one.
      if (ok) {
        const dc = Number(effect.dc);
        const ability = String(effect.ability ?? "");
        if (Number.isFinite(dc) && ability) {
          await noteRepeatSave(who, { status, ability, dc, source: capability.label });
        }
      }
      return { ok, reason: ok ? undefined : `already ${status}`, detail: `is ${status}` };
    }

    case "remove_status": {
      const who = subject?.actor ?? self.actor;
      const status = String(effect.status).toLowerCase();
      const ok = await setCondition(who, status, false);
      return { ok, reason: ok ? undefined : `was not ${status}`, detail: `is no longer ${status}` };
    }

    case "summon_creature": {
      const count = (await quantityFor(effect.count)) ?? 1;
      // A cap stated on the effect is about the creature, not about the rule: "up to four at a time"
      // survives the limbs being destroyed and re-summoned, which a `uses` allowance would not.
      const standing = summonedTokens(String(self.actor?.uuid ?? "")).length;
      const wanted = Math.max(0, Math.round(count));
      if (wanted <= 0) return { ok: false, reason: "nothing to summon" };

      const created = await summonCreature(self.token ?? self.actor, {
        creature: String(effect.creature),
        count: wanted,
        placement: (effect.placement as any) ?? "self_space",
        disposition: (effect.disposition as any) ?? "same_as_summoner",
        tag: capability.id,
      });
      if (created.length === 0) return { ok: false, reason: "nothing could be placed" };

      if (effect.initiative !== undefined || (game as any)?.combat?.started) {
        const placement =
          effect.initiative === "after_summoner" || effect.initiative === undefined
            ? { after: findCombatant(self.actor) }
            : { initiative: Number(effect.initiative) };
        await addCombatants(created, placement);
      }
      return {
        ok: true,
        detail: `${created.length} ${String(effect.creature)}${created.length === 1 ? "" : "s"} appear${standing ? ` (${standing + created.length} now)` : ""}`,
      };
    }

    case "initiative_position": {
      const combatant = findCombatant(self.actor);
      if (!combatant) return { ok: false, reason: "not in the turn order" };
      const relative = subjectOf(effect.relativeTo, ctx);
      const anchor = relative ? findCombatant(relative.actor) : null;
      const position =
        effect.position === "after" && anchor
          ? Number(anchor.initiative) - 0.01
          : effect.position === "before" && anchor
            ? Number(anchor.initiative) + 0.01
            : Number(effect.position);
      if (!Number.isFinite(position)) return { ok: false, reason: "no initiative to move to" };
      await combatant.update({ initiative: position });
      return { ok: true, detail: `moves to initiative ${position}` };
    }

    case "spend_resource":
    case "recover_resource": {
      const amount = (await quantityFor(effect.amount)) ?? 1;
      const item = findItem(self.actor, String(effect.resource));
      if (!item) return { ok: false, reason: `no item named "${String(effect.resource)}"` };
      const delta = effect.kind === "spend_resource" ? -Math.abs(amount) : Math.abs(amount);
      const left = await adjustUses(item, delta);
      if (left === null) return { ok: false, reason: `"${item.name}" has no limited uses` };
      return { ok: true, detail: `${item.name}: ${left} left` };
    }

    case "displace": {
      // Delegated to the forced-movement layer, which already knows every trap: top-left versus
      // centre coordinates, the zero-cost movement action, walls, scene edges and the undo card.
      const who = subject ?? ctx.target;
      if (!who?.token) return { ok: false, reason: "no token to move" };
      const distance = await quantityFor(effect.distance);
      if (distance === null) return { ok: false, reason: "the distance would not resolve" };
      const direction = String(effect.direction) === "toward" ? "toward" : "away";
      const { shove } = await import("../rules/shove");
      const result = await shove({
        token: who.token,
        by: self.token,
        direction: direction as any,
        distance,
        label: capability.label,
        // The card this file posts already names the capability; two would be noise.
        announce: false,
      });
      if (result.moved <= 0) return { ok: false, reason: result.reason ?? "it did not move" };
      return {
        ok: true,
        detail: `is ${direction === "away" ? "pushed" : "pulled"} ${result.moved} feet`,
      };
    }

    case "extra_attack":
      // A standing grant, not an event. Read by the action ledger through
      // `capabilityAttacksPerAction`; there is nothing to do at the moment it "fires".
      return { ok: false, reason: "a standing grant, applied by the action ledger" };

    default:
      return { ok: false, reason: `no executor for effect "${String(effect.kind)}"` };
  }
}

function findCombatant(actor: any): any {
  const uuid = String(actor?.uuid ?? "");
  return (game as any)?.combat?.combatants?.find?.(
    (c: any) => String(c?.actor?.uuid ?? "") === uuid,
  );
}

/** An item by name, case-insensitively. Names are what a descriptor can refer to; ids are not. */
function findItem(actor: any, name: string): any {
  const wanted = String(name ?? "").toLowerCase();
  if (!wanted) return null;
  for (const item of actor?.items ?? []) {
    if (String(item?.name ?? "").toLowerCase() === wanted) return item;
  }
  return null;
}

/** Say what happened, in the creature's own voice, so the table can see the rule fire. */
function announce(
  capability: Capability,
  rule: CapabilityRule,
  ctx: TriggerContext,
  detail: string,
): void {
  try {
    const subject = ctx.self.token ?? ctx.self.actor;
    const name = String(ctx.self.actor?.name ?? "The creature");
    const body = detail
      ? `<strong>${capability.label}:</strong> ${name} ${detail}.`
      : `<strong>${capability.label}</strong>`;
    const ChatMessage = (globalThis as any).ChatMessage;
    if (!ChatMessage) return;
    void ChatMessage.create({
      speaker: subject ? speakerFor(subject) : narrator(),
      content: `<p>${body}</p>`,
      flags: { [MODULE_ID]: { capability: capability.id, rule: rule.trigger?.event } },
    });
  } catch (err) {
    // Losing the card is a cosmetic failure; the rule already happened.
    debug("could not post a capability card", err);
  }
}

// ---- Wiring -----------------------------------------------------------------------------------

let registered = false;

/**
 * Attach the executor to the events the trigger vocabulary names.
 *
 * Only the events with a real hook behind them are wired. The rest are legitimate compiler output and
 * simply never fire — which the capability sheet shows as inert, rather than the module pretending.
 */
export function registerCapabilityExecutor(): void {
  if (registered) return;
  registered = true;

  // on_damage_taken. Off the ledger rather than off a Foundry hook, so the amount and the damage
  // types arrive together — which is the whole reason the ledger exists.
  onDamageTaken((event) => {
    if (!isPrimaryGM()) return;
    void fireTrigger("on_damage_taken", {
      self: { actor: event.actor, token: tokenOf(event.actor) },
      damage: { amount: event.amount, types: event.types },
    });
  });

  // on_zero_hp, from the same ledger event: cheaper and more reliable than a second actor watcher.
  onDamageTaken((event) => {
    if (!isPrimaryGM()) return;
    const hp = Number(event.actor?.system?.attributes?.hp?.value);
    if (hp !== 0) return;
    void fireTrigger("on_zero_hp", { self: { actor: event.actor, token: tokenOf(event.actor) } });
  });

  // on_turn_start / on_turn_end. `updateCombat` reports the turn AFTER it changed, so the creature
  // whose turn just ended is read from the hook's own `changes`, not from the tracker.
  Hooks.on("updateCombat", (combat: any, changes: any, _options: any, _userId: string) => {
    if (!isPrimaryGM()) return;
    if (changes?.turn === undefined && changes?.round === undefined) return;
    void onTurnChange(combat);
  });

  Hooks.on("deleteCombat", () => {
    previousCombatant = null;
  });

  // Rest-scoped allowances come back. Not a trigger event — `periodStamp` derives "which rest are we
  // after" from a counter on the actor, and nothing anywhere was bumping it, so a compiled 1/day or
  // per-short-rest rule spent its charge once and never got it back for the rest of the campaign.
  //
  // Deliberately NOT gated on the primary GM: `Hooks.callAll` runs only on the client that performed
  // the rest, and that client is the one that owns the actor and can therefore write the flag. A GM
  // gate here would mean a player's own long rest restored nothing.
  Hooks.on("dnd5e.restCompleted", (actor: any, result: any, config: any) => {
    if (!actor) return;
    // dnd5e recovers per-day uses on any rest flagged as a new day, and our stamp conflates "day"
    // with "long rest" (one counter serves both), so a new day has to bump the long counter or a daily
    // rule never returns. The cost is that long-rest rules also come back on a new-day short rest,
    // which is the generous direction this ledger already errs in on purpose: a creature quietly
    // losing an ability is worse than one getting an extra use of it.
    const long =
      result?.type === "long" ||
      result?.longRest === true ||
      result?.newDay === true ||
      config?.newDay === true;
    void noteRest(actor, long);
  });

  // on_activity_use. Fires on the client that used it, so the gate inside `fireTrigger` decides.
  Hooks.on("dnd5e.postUseActivity", (activity: any) => {
    const actor = activity?.actor;
    if (!actor) return;
    void fireTrigger("on_activity_use", {
      self: { actor, token: tokenOf(actor) },
      activity,
      spellLevel: Number(activity?.item?.system?.level) || undefined,
    });
  });

  log("capability executor registered");
}

let previousCombatant: string | null = null;

async function onTurnChange(combat: any): Promise<void> {
  const current = combat?.combatant;
  const currentId = String(current?.id ?? "");
  if (currentId === previousCombatant) return;

  const ending = previousCombatant ? (combat?.combatants?.get?.(previousCombatant) ?? null) : null;
  previousCombatant = currentId || null;

  if (ending?.actor) {
    await fireTrigger("on_turn_end", {
      self: { actor: ending.actor, token: ending.token?.object ?? ending.token },
      combat,
      combatant: ending,
    });
  }
  if (current?.actor) {
    await fireTrigger("on_turn_start", {
      self: { actor: current.actor, token: current.token?.object ?? current.token },
      combat,
      combatant: current,
    });
  }
}

function tokenOf(actor: any): any {
  return actor?.token?.object ?? actor?.getActiveTokens?.()?.[0] ?? null;
}

/** Diagnostics: every capability bound to the selected token, and whether each rule can run. */
export function surveyCapabilities(): Record<string, unknown> {
  const tokens: any[] = (canvas as any)?.tokens?.controlled ?? [];
  const report = tokens.map((token) => {
    const actor = token?.actor;
    return {
      name: String(actor?.name ?? token?.name ?? "?"),
      capabilities: bindingsFor(actor).map((binding) => ({
        label: binding.capability.label,
        status: binding.capability.status,
        rules: binding.capability.rules.map((rule) => ({
          on: rule.trigger?.event,
          does: rule.effect?.kind,
          adjudication: rule.adjudication,
          runs: isExecutable(rule),
          // A standing fact is not dead code. `runs` answers "will a hook fire this", which is false
          // for every `always` rule by construction; `standing` answers "is this read when asked",
          // which is what a third of the compiled corpus actually does.
          standing: isStanding(rule),
          uses: rule.uses ? `${rule.uses.max} per ${rule.uses.per}` : "unlimited",
        })),
      })),
    };
  });
  log("capabilities:", report);
  return { selected: report.length, report };
}
