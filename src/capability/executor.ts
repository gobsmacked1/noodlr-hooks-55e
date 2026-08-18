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
//   2. **A table decides who executes**, per event, and never this file by hand. A document hook
//      arrives on every client, so `isGM` being a role several clients hold means a troll would summon
//      four limbs per assistant GM without a gate. But `dnd5e.restCompleted` fires on the ACTING client
//      alone, and there the same gate discards the event outright whenever a player owns the actor.
//      `runsOn()` is the single answer; see its note in `integration/capability.ts`.
//   3. **Nothing throws outward.** A capability is an enhancement; a broken one must not take a turn,
//      a save or an attack down with it.

import { MODULE_ID, debug, log, warn } from "../constants";
import { isPrimaryGM } from "../util/gm";
import { narrator, speakerFor } from "../util/speaker";
import {
  isExecutable,
  isStanding,
  isTerminal,
  runsOn,
  type Capability,
  type CapabilityRule,
  type TriggerEvent,
} from "../integration/capability";
import { readRest } from "../system/dnd5e-rest";
import { bindingsFor } from "./bindings";
import { conditionsMet, type EvalContext, type Subject } from "./predicates";
import { describePredicate, describeRule, staticRefusal } from "./describe";
import { asQuantity, resolveQuantity } from "./quantity";
import {
  addCombatants,
  adjustUses,
  dealDamage,
  healActor,
  isDefeated,
  isSummoned,
  setCondition,
  summonCreature,
  summonedTokens,
  summonerKey,
  usesRemaining,
} from "./primitives";
import { duplicatesActivityDamage } from "./duplicate";
import { clearUse, noteRest, rollRecharge, spendUse, usesKey, usesLeft } from "./uses";
import { onDamageTaken } from "./damage-log";
import { noteRepeatSave } from "../rules/repeat-save";
import { sneakClaimedNatively } from "../rules/sneak";
import { ruleMatchesApplied } from "./applied";
import { registerAttackRollTriggers } from "./attack-roll";
import { registerConditionTriggers } from "./condition-applied";
import { registerMoveTriggers } from "./move";

// ---- Firing -------------------------------------------------------------------------------------

/**
 * Triggers a creature may still answer once it is out of the fight.
 *
 * Everything else stops at death, which is not a nicety: a troll flagged dead went on summoning a limb
 * a round for as long as the fight lasted, and "the corpse is still running its stat block" is
 * indistinguishable at the table from the module having lost its mind. These two are exempt because
 * they are ABOUT being at zero — a rule that fires when the creature drops cannot be gated on the
 * creature not having dropped.
 */
const POSTHUMOUS: readonly TriggerEvent[] = ["on_damage_taken", "on_zero_hp"];

/**
 * How many creatures one summoner may have standing at once, whatever its descriptor says.
 *
 * A runaway brake in the same spirit as `RUNAWAY_LIMIT` in the turn hooks, and it exists because a
 * summon is the one effect whose output becomes another input. Above the four limbs the worked example
 * needs, low enough that a miscompiled allowance fills a corner rather than the map.
 */
const MAX_STANDING = 8;

export interface TriggerContext extends EvalContext {
  /** Populated on `on_damage_taken`, so a rule can react to what actually landed. */
  damage?: { amount: number; types: string[] };
  /**
   * Populated on `on_activity_use`, and on `on_hit`/`on_miss`/`on_save_failed`/`on_save_succeeded` —
   * where it is load-bearing rather than informational, because `duplicatesActivityDamage` below
   * cannot refuse a restated damage line without it. Dispatching an attack or save trigger with this
   * unset silently doubles every weapon's or spell's damage.
   */
  activity?: any;
  /**
   * Populated on `on_condition_applied`. `fireTrigger` uses it to drop rules that are not about
   * the statuses that just landed — Nature's Ward must not strip poison because frightened did.
   */
  appliedStatuses?: string[];
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
      return ctx.trigger ?? ctx.attacker ?? ctx.target;
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
  // Narrowed to one writer only where the table says so. On an acting-client event this client IS the
  // one writer, and gating would discard every player's own rest. See `runsOn`.
  if (runsOn(event) === "primary-gm" && !isPrimaryGM()) return [];
  const outcomes: RuleOutcome[] = [];
  const actor = ctx.self?.actor;
  if (!actor) return outcomes;

  for (const binding of bindingsFor(actor)) {
    const capability = binding.capability;
    if (capability.status === "rejected") continue;
    if (!bindingAppliesToActivity(binding, usedItemOf(ctx))) continue;

    // IF IT CANNOT BE PAID FOR, NONE OF IT HAPPENS. A compiler is free to split one ability into a
    // `spend_resource` rule and a separate effect rule on the same trigger, and when it does, that
    // spend is the ONLY thing standing between the sheet's allowance and an unlimited ability — each
    // rule carries its own `uses`, so the effect rule has no allowance of its own to run out. That is
    // how a Troll with "4/day" on the sheet summoned a fifth limb: the spend reported an empty pool
    // and the summon beside it went ahead regardless, silently, with no "N left" line to notice.
    //
    // Deliberately narrow. A failed spend is unambiguously "cannot pay"; other failures are not —
    // a status that was already present must not stop the damage that accompanies it.
    //
    // Paying comes first, whatever order the descriptor happens to list its rules in. A stable sort, so
    // everything else keeps the order it was written in.
    const firing = (capability.rules ?? [])
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => {
        if (rule.trigger?.event !== event) return false;
        if (event === "on_condition_applied") {
          return ruleMatchesApplied(rule, ctx.appliedStatuses ?? []);
        }
        return true;
      })
      .sort(
        (a, b) =>
          Number(b.rule.effect?.kind === "spend_resource") -
          Number(a.rule.effect?.kind === "spend_resource"),
      );

    let unpaid = "";
    for (const { rule, index } of firing) {
      if (unpaid) {
        outcomes.push({
          capability: capability.label,
          ruleIndex: index,
          fired: false,
          reason: `not paid for: ${unpaid}`,
        });
        continue;
      }
      try {
        if (
          event === "on_move" &&
          rule.effect?.kind === "damage" &&
          (rule.effect.target === undefined || rule.effect.target === null)
        ) {
          // Ashardalon's Stride in the live cache left target unset; `subjectOf` would default
          // that to the mover and the caster would burn themselves. See `capability/move.ts`.
          outcomes.push({
            capability: capability.label,
            ruleIndex: index,
            fired: false,
            reason: "on_move damage left its target unset — refusing to guess the mover",
          });
          continue;
        }
        const outcome = await runRule(capability, rule, index, ctx, binding.item);
        if (!outcome.fired && rule.effect?.kind === "spend_resource") {
          unpaid = outcome.reason ?? "the resource could not be spent";
        }
        outcomes.push(outcome);
        continue;
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

/** One warning per rule per session; the fault is in the descriptor, not in the turn. */
const reportedDoubles = new Set<string>();

async function runRule(
  capability: Capability,
  rule: CapabilityRule,
  index: number,
  ctx: TriggerContext,
  /** The feature the prose came from, where the binding knows it. Read only to refuse. */
  item?: any,
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
  if (isTerminal(rule)) {
    // Distinguished from the generic refusal below because the two need different answers from a
    // reader: one is "nothing runs this yet", this one is "nothing ever will". See RESERVED_STATUSES.
    return no("a compiled rule may not kill; a creature at 0 hit points is the dying layer's");
  }
  if (!isExecutable(rule)) return no("no executor for this effect or one of its guards");

  // A rule whose effect a hand-written layer of this module already performs. Same shape as the
  // terminal refusal above and for the same reason: the descriptor is a true reading, and running it
  // beside the layer that owns the mechanic doubles it silently.
  const claimed = sneakClaimedNatively(rule, item);
  if (claimed) return no(claimed);

  if (!POSTHUMOUS.includes(rule.trigger?.event as TriggerEvent) && isDefeated(ctx.self)) {
    return no("the creature is out of the fight");
  }

  // Checked before any state is read or spent, because this refusal is about the RULE rather than the
  // moment: an ability that restates its own printed damage will do so on every hit for as long as the
  // descriptor exists, and a use spent on it would be spent for nothing.
  if (ctx.activity) {
    const doubled = duplicatesActivityDamage(rule, ctx.activity);
    if (doubled) {
      // Warned, once, because this is a compile fault rather than table state and it is invisible in
      // play: the arithmetic simply comes out right, which is the whole reason the guard exists.
      const seen = `${capability.id}:${index}`;
      if (!reportedDoubles.has(seen)) {
        reportedDoubles.add(seen);
        warn(`capability "${label}" restates damage the platform already rolls: ${doubled}`);
      }
      return no(doubled);
    }
  }

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
      const restored = await healActor(who, { amount, temporary: Boolean(effect.temporary) });
      if (restored === null) return { ok: false, reason: "the hit points could not be written" };
      // A regeneration on a creature at full health is not a firing. Reporting one is what made a
      // correctly-clamped heal read as runaway healing; spending a limited use for it would be worse.
      if (restored === 0) return { ok: false, reason: "already at full hit points" };
      const kind = effect.temporary ? "temporary hit points" : "hit points";
      return { ok: true, detail: `regains ${restored} ${kind}` };
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
      const wanted = Math.max(0, Math.round(count));
      if (wanted <= 0) return { ok: false, reason: "nothing to summon" };

      // A SUMMONED CREATURE MAY NOT SUMMON. The one effect whose output is another input, and the
      // stock bestiary already closes the circle: a Troll's Loathsome Limbs makes a Troll Limb, and a
      // Troll Limb's Troll Spawn makes a Troll. Read as instructions rather than as the once-a-day and
      // once-in-24-hours-on-a-12 they really are, that is an exponential curve, and no allowance on
      // either rule can stop it because each generation gets a fresh ledger. Refusing the second link
      // costs nothing a GM cannot do by hand and cannot be argued with at the table.
      if (isSummoned(self)) {
        return { ok: false, reason: "a summoned creature may not summon" };
      }

      // A cap on how many stand at once, which is a different question from how often the rule may
      // fire: "up to four at a time" survives the limbs being destroyed and re-summoned, which a
      // `uses` allowance would not.
      const standing = summonedTokens(summonerKey(self)).length;
      if (standing + wanted > MAX_STANDING) {
        return { ok: false, reason: `already has ${standing} summoned creatures standing` };
      }

      const created = await summonCreature(self.token ?? self.actor, {
        creature: String(effect.creature),
        count: wanted,
        placement: (effect.placement as any) ?? "self_space",
        disposition: (effect.disposition as any) ?? "same_as_summoner",
        tag: capability.id,
      });
      if (created.length === 0) return { ok: false, reason: "nothing could be placed" };

      if (effect.initiative !== undefined || (game as any)?.combat?.started) {
        // ANYTHING THAT IS NOT A NUMBER MEANS "BEHIND ME". `Number("after_summoner")` is NaN, and NaN
        // reached `createEmbeddedDocuments` as an explicit initiative — which Foundry rejects outright
        // (`[Combatant5e] validation errors: initiative: must be a number`), so the limb was never
        // enlisted here at all and the perception sweep enlisted it a moment later with a rolled
        // initiative instead. The visible symptom was three console errors and a creature that should
        // act immediately after its summoner turning up in a random slot. `insert_combatant` three
        // cases below had the `Number.isFinite` guard all along; this branch never got it.
        const explicit = Number(effect.initiative);
        await addCombatants(
          created,
          Number.isFinite(explicit)
            ? { initiative: explicit }
            : { after: findCombatant(self.actor) },
        );
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

      // AN EMPTY POOL IS A REFUSAL, NOT A SPEND OF NOTHING. `adjustUses` clamps, so once a 4/day item
      // reached zero it went on reporting "0 left" and success forever — and where the descriptor
      // splits the ability into a spend rule and a separate effect rule, that success is the only
      // thing standing between the sheet's allowance and an unlimited one. Same shape as the heal that
      // restored nothing and announced fifteen.
      const before = usesRemaining(item);
      if (before === null) return { ok: false, reason: `"${item.name}" has no limited uses` };
      const spending = effect.kind === "spend_resource";
      if (spending && before <= 0) return { ok: false, reason: `"${item.name}" has no uses left` };

      const left = await adjustUses(item, spending ? -Math.abs(amount) : Math.abs(amount));
      if (left === null) return { ok: false, reason: `"${item.name}" has no limited uses` };
      if (left === before) return { ok: false, reason: `"${item.name}" is already at ${left}` };
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

/**
 * A spell's (or weapon's) compiled riders are about THAT item. Binding every `on_save_failed`
 * on the caster and firing them all is how Otto's Irresistible Dance charmed the Assassin
 * when Hold Person's save failed (2026-08-18). Feats that watch any save still fire.
 *
 * Exported so a test can pin the split without a scene.
 */
export function bindingAppliesToActivity(binding: { item?: any }, usedItem: any): boolean {
  if (!usedItem || !binding.item) return true;
  if (sameItem(binding.item, usedItem)) return true;
  const type = String(binding.item.type ?? "");
  return type !== "spell" && type !== "consumable" && type !== "weapon";
}

function usedItemOf(ctx: TriggerContext): any {
  return ctx.activity?.item ?? ctx.activity?.parent ?? null;
}

function sameItem(a: any, b: any): boolean {
  if (a === b) return true;
  const aId = String(a?.id ?? "");
  const bId = String(b?.id ?? "");
  if (aId && aId === bId) return true;
  const aUuid = String(a?.uuid ?? "");
  const bUuid = String(b?.uuid ?? "");
  return Boolean(aUuid) && aUuid === bUuid;
}

/** Say what happened, in the creature's own voice, so the table can see the rule fire. */
function announce(
  capability: Capability,
  rule: CapabilityRule,
  ctx: TriggerContext,
  detail: string,
): void {
  try {
    // The effect names who it happened to. Naming `self` here is why "Hold Person: Bardo is
    // paralyzed" appeared on a card signed as the caster while the Assassin actually froze.
    const who = subjectOf(rule.effect?.target, ctx) ?? ctx.self;
    const subject = who.token ?? who.actor;
    const name = String(who.actor?.name ?? "The creature");
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
 *
 * NOTHING HERE GATES ON THE CLIENT. Every listener hands straight to `fireTrigger`, which reads
 * `runsOn()`; a second gate beside a hook is how one event drifts out of step with the table that is
 * supposed to be the only answer to who executes.
 */
export function registerCapabilityExecutor(): void {
  if (registered) return;
  registered = true;

  // on_damage_taken. Off the ledger rather than off a Foundry hook, so the amount and the damage
  // types arrive together — which is the whole reason the ledger exists.
  onDamageTaken((event) => {
    void fireTrigger("on_damage_taken", {
      self: { actor: event.actor, token: tokenOf(event.actor) },
      damage: { amount: event.amount, types: event.types },
    });
  });

  // on_zero_hp, from the same ledger event: cheaper and more reliable than a second actor watcher.
  onDamageTaken((event) => {
    const hp = Number(event.actor?.system?.attributes?.hp?.value);
    if (hp !== 0) return;
    void fireTrigger("on_zero_hp", { self: { actor: event.actor, token: tokenOf(event.actor) } });
  });

  // on_turn_start / on_turn_end. `updateCombat` reports the turn AFTER it changed, so the creature
  // whose turn just ended is read from the hook's own `changes`, not from the tracker.
  //
  // `onTurnChange` runs on EVERY client, which is what keeps `previousCombatant` honest — it is
  // module-level state, and a client that skipped the bookkeeping would name the wrong creature as
  // having just finished the first time it did participate. `fireTrigger` narrows the execution.
  Hooks.on("updateCombat", (combat: any, changes: any, _options: any, _userId: string) => {
    if (changes?.turn === undefined && changes?.round === undefined) return;
    void onTurnChange(combat);
  });

  Hooks.on("deleteCombat", () => {
    previousCombatant = null;
  });

  // on_short_rest / on_long_rest, plus the ledger bump that makes a rest-scoped allowance readable
  // again. `periodStamp` derives "which rest are we after" from a counter on the actor, and until this
  // was wired a compiled 1/day or per-short-rest rule spent its charge once and never got it back.
  //
  // ORDER IS LOAD-BEARING: the counter is awaited BEFORE any rule fires, because a recovery rule
  // carrying its own `uses: 1/long_rest` would otherwise be checked against the period that just
  // ended and read as already spent — the ability would refuse itself on the very rest that renews it.
  //
  // `readRest` decides what fired and why the ledger's answer is deliberately looser. Not gated here;
  // see the note above `registerCapabilityExecutor`.
  Hooks.on("dnd5e.restCompleted", (actor: any, result: any, config: any) => {
    if (!actor) return;
    const rest = readRest(result, config);
    void (async () => {
      await noteRest(actor, rest.long);
      for (const event of rest.triggers) {
        await fireTrigger(event, { self: { actor, token: tokenOf(actor) } });
      }
    })();
  });

  // on_activity_use. The hook fires on the client that pressed the button and `runsOn` still says
  // primary GM, so a player's own use reaches `fireTrigger` and is discarded there — a known gap with
  // a reason, recorded at the table entry rather than worked around here.
  Hooks.on("dnd5e.postUseActivity", (activity: any) => {
    const actor = activity?.actor;
    if (!actor) return;
    void fireTrigger("on_activity_use", {
      self: { actor, token: tokenOf(actor) },
      activity,
      spellLevel: Number(activity?.item?.system?.level) || undefined,
    });
  });

  // The three remaining Phase 3 events. Each lives in its own file for the same reason `on_hit`
  // does: the compiler has one word for two opposite readings, and the direction has to be
  // decided once, in the open. Hooks stay in those files; `runsOn` still gates execution.
  registerAttackRollTriggers();
  registerConditionTriggers();
  registerMoveTriggers();

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

/**
 * Diagnostics: every capability bound to the selected token, and whether each rule can run.
 *
 * PRINTS A FLAT TEXT BLOCK AS WELL AS RETURNING THE OBJECT, and that is not cosmetic. v0.6.2 added
 * `guards` here precisely so the Troll's missing "while Bloodied" would be visible, and the next
 * capture still could not answer the question — because a browser console renders a nested return
 * value as `Object { selected: 1, report: (1) […] }` and what gets pasted into a bug report is that
 * collapsed line. The one diagnostic in the same capture that arrived intact was `testMove`, which
 * prints a string.
 *
 * The general rule, and it applies to every survey in this module: **a diagnostic whose output has to
 * be expanded by hand before it says anything has not reported anything.** Depth is what costs you —
 * an object is fine, an object of arrays of objects is a disclosure triangle.
 */
export function surveyCapabilities(): Record<string, unknown> {
  const tokens: any[] = (canvas as any)?.tokens?.controlled ?? [];
  if (tokens.length === 0) log("select a token first — this reports what is bound to it");
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
          // THE GUARDS, and their absence is the single most useful thing this survey can report.
          // Every other field here describes a rule that fires; `guards` is the only one that says
          // WHEN, and a rule firing at the wrong time is what gets reported from a table. The Troll
          // shedding limbs at full health (2026-08-15) was two rounds of back-and-forth precisely
          // because this survey could show that a summon was bound and running and could not show
          // that its "while Bloodied" had gone missing in compilation.
          guards: (rule.condition ?? []).map(describePredicate),
          // Reported here rather than only at the moment of refusal: this one is a compile fault that
          // does not show up as an error at the table, it shows up as an ability hitting twice as hard
          // as the book says, so it has to be visible to anybody reading the compiled ability. Through
          // `staticRefusal` rather than one predicate of its own — see the note there for the session
          // where this console and the capability sheet gave different answers about one descriptor.
          doubles: staticRefusal(rule, binding.item) || undefined,
          // In English, because a reviewer skims twenty of these looking for the wrong one. Same
          // renderer as the capability sheet, so the console and the window cannot disagree.
          reads: describeRule(rule),
        })),
      })),
    };
  });
  log(`capabilities — copy everything below this line:\n${renderSurvey(report)}`);
  return { selected: report.length, report };
}

/** One line per rule, flat, so nothing has to be expanded to be read. */
function renderSurvey(report: any[]): string {
  if (report.length === 0) return "  (nothing selected)";
  const out: string[] = [];
  for (const creature of report) {
    out.push(`${creature.name} — ${creature.capabilities.length} compiled ability/abilities`);
    if (creature.capabilities.length === 0) {
      out.push("    (none bound — either nothing compiled, or the cache has not warmed)");
    }
    for (const ability of creature.capabilities) {
      out.push(`  ${ability.label} [${ability.status}]`);
      for (const [i, rule] of ability.rules.entries()) {
        const where = rule.runs ? "runs" : rule.standing ? "standing" : "INERT";
        out.push(`    ${i}. on ${rule.on} -> ${rule.does}  (${where}, ${rule.uses})`);
        // Printed even when empty, and the empty case is the whole point: "guards: NONE" on a summon
        // is the Troll bug stated in four characters, whereas an omitted line reads as a rule that
        // simply has no conditions to show.
        out.push(
          rule.guards.length
            ? `       guards: ${rule.guards.join(" AND ")}`
            : "       guards: NONE — fires whenever the trigger does",
        );
        if (rule.doubles) out.push(`       REFUSED: ${rule.doubles}`);
        out.push(`       reads: ${rule.reads}`);
      }
    }
  }
  return out.join("\n");
}
