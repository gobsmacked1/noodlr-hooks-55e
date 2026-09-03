// 2024 Sentinel: Guardian (OA after Disengage or hitting someone else) and Halt (Speed 0).
//
// Leave-reach OA stays Disengage-exempt. Guardian is "immediately after they take the
// Disengage action", not a second leave. Piercing leave-Disengage would be two chances
// at one reaction. Granted Withdraw is not that action.
//
// Halt applies to any Opportunity Attack a Sentinel hits with — leave, Guardian
// Disengage, Guardian attack-other. Not Polearm enter, not hurt, not incoming.
// Stop the remaining path *before* writing Speed 0, or the token finishes the walk.

import { MODULE_ID, log } from "../constants";
import { durationPayload, worldOf } from "../capability/duration";
import { effectModes, writeTimedEffect } from "../capability/timed";
import { movementKeysOf } from "../system/dnd5e-masteries";
import {
  guardianDisengageApplies,
  hasSentinel,
  withinSentinelReach,
} from "../system/dnd5e-sentinel";
import { isPrimaryGM } from "../util/gm";
import { askGm, registerQuery } from "../util/queries";
import { speakerFor } from "../util/speaker";
import { readActions, type CreatureAction } from "../tactics/actions";
import { shouldAutomate } from "../tactics/registry";
import { useActionAt } from "../tactics/execute";
import { readHits, rollType, speakerToken } from "./cards";
import { hasHalted, writeHalted } from "./halt-state";
import { haltMovement, isHeld } from "./move-hold";
import {
  clearAllOpportunitySwings,
  clearOpportunitySwing,
  noteOpportunitySwing,
  pendingOpportunityTarget,
} from "./oa-swing";
import { alive, canReact, offerReaction, offerable } from "./offer";
import { hasReaction, spend, stampFor } from "./economy/ledger";
import { trackReaction } from "./reaction-wait";

const claimed = new Set<string>();
const seenHalt = new Set<string>();
const seenGuardian = new Set<string>();

function tokenFor(combatant: any): any {
  return combatant?.token?.object ?? combatant?.token ?? null;
}

function tokenDocOf(token: any): any {
  return token?.document ?? token ?? null;
}

function matchesUuid(doc: any, uuid: string): boolean {
  if (!doc || !uuid) return false;
  return (
    String(doc.uuid ?? "") === uuid ||
    String(doc.actor?.uuid ?? "") === uuid ||
    String(doc.actor?.token?.uuid ?? "") === uuid
  );
}

function claimGuardian(watcherId: string, key: string): boolean {
  const id = `${watcherId}|${key}`;
  if (claimed.has(id)) return false;
  claimed.add(id);
  return true;
}

function bestMelee(actor: any): CreatureAction | undefined {
  let best: CreatureAction | undefined;
  for (const action of readActions(actor)) {
    if (!action.available || !action.melee || action.kind !== "attack") continue;
    if (action.economy !== "action" && action.economy !== "free") continue;
    if (!best || action.range > best.range) best = action;
  }
  return best;
}

async function swingOpportunity(combatant: any, token: any, target: any): Promise<boolean> {
  const actor = combatant?.actor;
  if (!actor || !hasReaction(combatant) || !canReact(actor) || !alive(actor)) return false;
  const automated = shouldAutomate(combatant);
  if (automated) {
    const action = bestMelee(actor);
    if (!action) return false;
    spend(actor, game.combat, combatant, "reaction", false);
    noteOpportunitySwing(actor, target);
    try {
      await useActionAt(action, target, { asReaction: true, reactionTrigger: "opportunity" });
    } catch (err) {
      log(`sentinel: ${String(combatant?.name)} could not swing:`, err);
    }
    return true;
  }
  if (!offerable(actor, "opportunity")) return false;
  const answer = await offerReaction(actor, {
    actorUuid: String(actor.uuid ?? ""),
    tokenUuid: String(token?.document?.uuid ?? token?.uuid ?? ""),
    targetUuid: String(target?.document?.uuid ?? target?.uuid ?? "") || undefined,
    targetName: String(target?.name ?? ""),
    trigger: "opportunity",
  });
  return answer.taken;
}

async function eachAdjacentSentinel(
  around: any,
  exceptActor: any,
  key: string,
  swingAt: any,
): Promise<void> {
  const combat: any = game.combat;
  if (!combat?.started || !around) return;
  for (const combatant of combat.combatants ?? []) {
    if (String(combatant?.actor?.id ?? "") === String(exceptActor?.id ?? "")) continue;
    if (!hasSentinel(combatant?.actor)) continue;
    if (combatant?.isDefeated || !alive(combatant?.actor)) continue;
    if (!hasReaction(combatant)) continue;
    if (!canReact(combatant.actor)) continue;
    const token = tokenFor(combatant);
    if (!withinSentinelReach(token, around)) continue;
    const watcherId = String(combatant?.id ?? "");
    if (!claimGuardian(watcherId, key)) continue;
    await swingOpportunity(combatant, token, swingAt);
  }
}

export async function offerGuardianDisengage(actor: any, token: any): Promise<void> {
  if (!isPrimaryGM() || !actor) return;
  const around = tokenDocOf(token) ?? actor?.getActiveTokens?.(true, true)?.[0];
  if (!around) return;
  const combat: any = game.combat;
  const combatant = (combat?.combatants ?? []).find?.(
    (c: any) => String(c?.actor?.id ?? "") === String(actor.id ?? ""),
  );
  const stamp = combatant && combat ? stampFor(combat, combatant) : String(actor.id ?? "");
  await eachAdjacentSentinel(around, actor, `disengage:${actor.id}:${stamp}`, around);
}

export function notifyGuardianDisengage(activity: any, granted: boolean, isDisengage: boolean): void {
  if (!guardianDisengageApplies(granted, isDisengage)) return;
  const actor = activity?.actor;
  if (!actor) return;
  const token = actor?.getActiveTokens?.(true, true)?.[0] ?? actor?.token;
  if (isPrimaryGM()) {
    void offerGuardianDisengage(actor, token);
    return;
  }
  void askGm("sentinel.guardianDisengage", {
    actorUuid: String(actor.uuid ?? ""),
    tokenUuid: String(token?.document?.uuid ?? token?.uuid ?? ""),
  });
}

async function applyHalt(sentinel: any, moverDoc: any): Promise<void> {
  const mover = moverDoc?.actor;
  if (!mover || !hasSentinel(sentinel)) return;

  await haltMovement(moverDoc);

  const duration = durationPayload(
    { value: 1, units: "turns" },
    "targetEnd",
    worldOf({ self: { actor: sentinel }, target: { actor: mover } }),
  );
  if (duration) {
    const modes = effectModes();
    const changes = movementKeysOf(mover).map((key) => ({
      key: `system.attributes.movement.${key}`,
      mode: modes.override,
      value: "0",
    }));
    await writeTimedEffect({
      actor: mover,
      name: "Halt",
      img: "icons/magic/movement/trail-streak-impact.webp",
      duration,
      changes,
      key: { kind: "modify_speed", capability: "sentinel-halt", ruleIndex: 0 },
    });
  }
  await writeHalted(mover);

  try {
    await (globalThis as any).ChatMessage.create({
      content: `<p>${game.i18n.format("NOODLRHOOKS.Combat.Sentinel.Halt", {
        name: String(mover.name ?? "?"),
        by: String(sentinel.name ?? "?"),
      })}</p>`,
      speaker: speakerFor(sentinel),
      flags: { [MODULE_ID]: { sentinel: "halt" } },
    });
  } catch (err) {
    log("sentinel: could not announce Halt:", err);
  }
}

function considerAttackMessage(message: any): void {
  if (rollType(message) !== "attack") return;
  const id = String(message?.id ?? "");
  if (!id) return;

  const attackerDoc = speakerToken(message.speaker);
  const attackerActor = attackerDoc?.actor ?? null;
  const hits = readHits(message);
  if (hits.hits.length === 0 && hits.missed.length === 0) return;
  if (!isPrimaryGM()) return;

  if (attackerActor && !seenHalt.has(id)) {
    const wanted = pendingOpportunityTarget(String(attackerActor.uuid ?? ""));
    if (wanted) {
      const hit = hits.hits.find((doc) => matchesUuid(doc, wanted));
      if (hit && hasSentinel(attackerActor)) {
        seenHalt.add(id);
        clearOpportunitySwing(String(attackerActor.uuid ?? ""));
        void trackReaction(applyHalt(attackerActor, hit));
      } else if (hits.missed.some((doc) => matchesUuid(doc, wanted)) || hits.hits.length + hits.missed.length > 0) {
        if (!hit) clearOpportunitySwing(String(attackerActor.uuid ?? ""));
      }
    }
  }

  if (seenGuardian.has(id) || !attackerDoc || !attackerActor) return;
  if (hits.hits.length === 0) return;
  seenGuardian.add(id);
  const others = hits.hits.filter(
    (doc) => String(doc?.actor?.id ?? "") !== String(attackerActor.id ?? ""),
  );
  if (!others.length) return;
  void trackReaction(
    (async () => {
      const combat: any = game.combat;
      if (!combat?.started) return;
      for (const combatant of combat.combatants ?? []) {
        const sentinel = combatant?.actor;
        if (!hasSentinel(sentinel)) continue;
        if (String(sentinel?.id ?? "") === String(attackerActor.id ?? "")) continue;
        if (combatant?.isDefeated || !alive(sentinel) || !canReact(sentinel)) continue;
        if (!hasReaction(combatant)) continue;
        const token = tokenFor(combatant);
        if (!withinSentinelReach(token, attackerDoc)) continue;
        const hitSomeoneElse = hits.hits.some(
          (doc) => String(doc?.actor?.id ?? "") !== String(sentinel.id ?? ""),
        );
        if (!hitSomeoneElse) continue;
        if (!claimGuardian(String(combatant.id ?? ""), `attack:${id}`)) continue;
        await swingOpportunity(combatant, token, attackerDoc);
      }
    })(),
  );
}

export function registerSentinel(): void {
  registerQuery("sentinel.guardianDisengage", async (data) => {
    const fromUuid = (globalThis as any).fromUuid;
    const actor =
      data?.actorUuid && typeof fromUuid === "function" ? await fromUuid(String(data.actorUuid)) : null;
    const token =
      data?.tokenUuid && typeof fromUuid === "function" ? await fromUuid(String(data.tokenUuid)) : null;
    if (!actor) return false;
    await offerGuardianDisengage(actor, token);
    return true;
  });

  Hooks.on("createChatMessage", (message: any) => {
    try {
      considerAttackMessage(message);
    } catch (err) {
      log("sentinel: attack watch failed:", err);
    }
  });
  Hooks.on("updateChatMessage", (message: any) => {
    try {
      considerAttackMessage(message);
    } catch (err) {
      log("sentinel: attack watch failed:", err);
    }
  });
  Hooks.on("deleteCombat", () => {
    claimed.clear();
    seenHalt.clear();
    seenGuardian.clear();
    clearAllOpportunitySwings();
  });
}

export function surveySentinel(): unknown {
  const token: any = (globalThis as any).canvas?.tokens?.controlled?.[0];
  const actor = token?.actor;
  const combat: any = game.combat;
  const carriers: string[] = [];
  for (const combatant of combat?.combatants ?? []) {
    if (hasSentinel(combatant?.actor)) carriers.push(String(combatant?.name ?? "?"));
  }
  const lines = [
    `module: ${MODULE_ID}`,
    `creature: ${String(token?.name ?? "— select a token —")}`,
    `has Sentinel: ${actor ? (hasSentinel(actor) ? "yes" : "no") : "—"}`,
    `Halted this turn: ${actor ? (hasHalted(actor) ? "yes" : "no") : "—"}`,
    `in-motion hold: ${token?.document && isHeld(token.document) ? "paused" : "none"}`,
    `Sentinels in this fight: ${carriers.length ? carriers.join(" | ") : "none"}`,
    `Guardian does not pierce leave-Disengage; Halt is OA-hit only`,
  ];
  console.log(lines.join("\n"));
  return {
    selected: String(token?.name ?? ""),
    sentinel: actor ? hasSentinel(actor) : null,
    halted: actor ? hasHalted(actor) : null,
    held: Boolean(token?.document && isHeld(token.document)),
    carriers,
  };
}

