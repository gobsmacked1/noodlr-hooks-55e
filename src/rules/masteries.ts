// Weapon masteries that are not Push, Graze, or Nick.
//
// Push stays in `forced.ts` (token movement). Graze stays in `damage.ts` (flat modifier on a
// miss). Nick stays in the action ledger (a free Light swing). This file is Sap, Slow, Topple,
// Vex, and Cleave — the five the card labels have named since v0.7.46 and that nothing applied.
//
// HIT VERSUS DAMAGE. Sap, Topple and Cleave fire on a hit. Slow and Vex fire only when damage
// is actually dealt — immunity is not "dealt". Forced movement already listens on chat
// independently of auto-damage; hit masteries do the same, so they still run when the tray is
// left to a human. Slow/Vex file a short-lived pending and apply from `noteMasteryDamageDealt`,
// which `damage.ts` calls after a successful apply and which also listens on `dnd5e.damageActor`.
//
// CLEAVE'S DAMAGE CUT is stamped on the extra-attack's damage card (`flags.<ns>.cleaveCut`)
// and subtracted in `dnd5e.preCalculateDamage`. That hook fires on the client that presses
// Apply — a player, when auto-damage is off — so an in-memory Map on the GM would miss it.
// `applyRolledDamage` peeks the same cut for the receipt and passes the original parts to
// the system, or the hook would subtract twice.
//
// This file must not import `damage.ts` (cycle). `damage.ts` imports us.

import { COMBAT_SETTINGS, MODULE_ID, log } from "../constants";
import { durationPayload, worldOf } from "../capability/duration";
import { effectModes, writeTimedEffect } from "../capability/timed";
import { setCondition } from "../capability/primitives";
import { tokenDistance } from "../core/positioning";
import { isPrimaryGM } from "../util/gm";
import { FLAG_NAMESPACE } from "../util/flags";
import { speakerFor } from "../util/speaker";
import { isMasteriesEnabled } from "../settings";
import { useActionAt } from "../tactics/execute";
import {
  abilityModOf,
  canUseWeaponMastery,
  cleaveDamageAdjustment,
  cleaveReach,
  isAutomatedMastery,
  isDamageMastery,
  isHitMastery,
  isMeleeAttack,
  movementKeysOf,
  proficiencyBonus,
  slowAmount,
  toppleDc,
  type DamageMastery,
} from "../system/dnd5e-masteries";
import { collectDemanded, owedSecondsFor } from "./owed-roll";
import {
  activityOf,
  itemOf,
  masteryOf,
  readHits,
  speakerToken,
  tokenFromTokenUuid,
  type DamagePart,
} from "./cards";

const CLEAVE_FLAG = "cleaveTurn";
const PENDING_MS = 15_000;
const CLEAVE_PENDING_MS = 10_000;

interface PendingDamage {
  attackId: string;
  attackerUuid: string;
  targetUuid: string;
  mastery: DamageMastery;
  at: number;
}

const applied = new Set<string>();
const pendingDamage: PendingDamage[] = [];
const cleavePending = new Map<string, { cut: number; at: number }>();

function active(): boolean {
  return isPrimaryGM() && isMasteriesEnabled();
}

function claim(key: string): boolean {
  if (applied.has(key)) return true;
  if (applied.size > 500) applied.clear();
  applied.add(key);
  return false;
}

function turnStamp(): string {
  const combat: any = (globalThis as any).game?.combat;
  if (!combat?.started) return "";
  return `${String(combat.id ?? "")}:${Number(combat.round ?? 0)}:${Number(combat.turn ?? 0)}`;
}

function cleaveSpent(actor: any): boolean {
  const stamp = turnStamp();
  if (!stamp) return false;
  return String(actor?.getFlag?.(FLAG_NAMESPACE, CLEAVE_FLAG) ?? "") === stamp;
}

async function noteCleaveSpent(actor: any): Promise<void> {
  const stamp = turnStamp();
  if (!stamp || !actor) return;
  try {
    await actor.setFlag(FLAG_NAMESPACE, CLEAVE_FLAG, stamp);
  } catch {
    /* a creature we cannot write is one we are not playing */
  }
}

export function registerMasteries(): void {
  const Hooks = (globalThis as any).Hooks;
  if (!Hooks?.on) return;

  Hooks.on("createChatMessage", (message: any) => {
    stampCleaveCard(message);
    void examine(message, message?.flags).catch((err) => log("masteries failed:", err));
  });
  Hooks.on("updateChatMessage", (message: any, changed: any) => {
    stampCleaveCard(message);
    void examine(message, changed?.flags).catch((err) => log("masteries failed:", err));
  });
  // Every client: the Apply button runs `applyDamage` where it was pressed. A pending Map
  // that only the primary GM holds never reaches a player's click.
  Hooks.on("dnd5e.preCalculateDamage", (_actor: any, damages: any, options: any) => {
    try {
      cutCleaveOnApply(damages, options);
    } catch (err) {
      log("masteries: Cleave trim failed:", err);
    }
  });
  Hooks.on("dnd5e.damageActor", (actor: any, changes: any) => {
    if (!active()) return;
    if (Number(changes?.total) > 0) void noteMasteryDamageDealt(actor);
  });
  Hooks.on("deleteCombat", () => {
    applied.clear();
    pendingDamage.length = 0;
    cleavePending.clear();
  });
}

async function examine(message: any, changedFlags: any): Promise<void> {
  if (!active()) return;

  const midi = changedFlags?.["midi-qol"];
  if (midi?.hitTargetUuids) {
    await fromHits(message, midiHits(midi.hitTargetUuids));
    return;
  }

  const rollType = String(message?.flags?.dnd5e?.roll?.type ?? "");
  if (changedFlags && !changedFlags?.dnd5e) return;
  if (rollType !== "attack") return;

  const reading = readHits(message);
  await fromHits(message, reading.hits);
}

function midiHits(uuids: unknown): any[] {
  return (Array.isArray(uuids) ? uuids : [])
    .map((u) => tokenFromTokenUuid(String(u)))
    .filter(Boolean);
}

async function fromHits(message: any, hits: any[]): Promise<void> {
  if (!hits.length) return;
  const item = itemOf(message);
  const activity = activityOf(message, item);
  const attackerDoc = speakerToken(message?.speaker);
  const attacker = attackerDoc?.actor;
  const mastery = masteryOf(message, item, attacker);
  if (!isAutomatedMastery(mastery)) return;
  if (!attacker) return;

  const attackId = String(message?.id ?? "");
  if (!attackId) return;

  for (const targetDoc of hits) {
    const target = targetDoc?.actor;
    if (!target) continue;
    const targetUuid = String(target.uuid ?? "");
    const key = `${attackId}:${mastery}:${targetUuid}`;
    if (claim(key)) continue;

    if (isHitMastery(mastery)) {
      if (mastery === "sap") await applySap(attacker, target);
      else if (mastery === "topple") await applyTopple(attacker, target, activity, item, attackId, targetDoc);
      else if (mastery === "cleave") await applyCleave(attacker, attackerDoc, targetDoc, activity, item);
    } else if (isDamageMastery(mastery)) {
      filePending({
        attackId,
        attackerUuid: String(attacker.uuid ?? ""),
        targetUuid,
        mastery,
        at: Date.now(),
      });
    }
  }
}

function filePending(row: PendingDamage): void {
  const now = Date.now();
  for (let i = pendingDamage.length - 1; i >= 0; i--) {
    if (now - pendingDamage[i].at > PENDING_MS) pendingDamage.splice(i, 1);
  }
  pendingDamage.push(row);
}

/**
 * Slow and Vex: damage was actually dealt to this creature.
 *
 * Called from `applyRolledDamage` after a successful apply (HP or temp HP dropped) and from
 * `dnd5e.damageActor` when `changes.total > 0`. Idempotent per attack + mastery + target.
 */
export async function noteMasteryDamageDealt(actor: any): Promise<void> {
  if (!active()) return;
  const uuid = String(actor?.uuid ?? "");
  if (!uuid) return;
  const now = Date.now();
  const due: PendingDamage[] = [];
  for (let i = pendingDamage.length - 1; i >= 0; i--) {
    const row = pendingDamage[i];
    if (now - row.at > PENDING_MS) {
      pendingDamage.splice(i, 1);
      continue;
    }
    if (row.targetUuid !== uuid) continue;
    pendingDamage.splice(i, 1);
    due.push(row);
  }
  for (const row of due) {
    const key = `${row.attackId}:${row.mastery}:dealt:${row.targetUuid}`;
    if (claim(key)) continue;
    if (row.mastery === "slow") await applySlow(row);
    else await applyVex(row);
  }
}

/** How much to drop from a Cleave extra-attack. Card flag first — that is what a player can see. */
export function peekCleaveCut(actor: any, message?: any): number {
  const fromCard = Number(message?.flags?.[MODULE_ID]?.cleaveCut);
  if (Number.isFinite(fromCard) && fromCard > 0) return Math.trunc(fromCard);
  const uuid = String(actor?.uuid ?? "");
  if (!uuid) return 0;
  const pending = cleavePending.get(uuid);
  if (!pending) return 0;
  if (Date.now() - pending.at > CLEAVE_PENDING_MS) return 0;
  return pending.cut > 0 ? pending.cut : 0;
}

export function applyCleaveCut(parts: DamagePart[], cut: number): DamagePart[] {
  if (cut <= 0 || !parts.length) return parts;
  const first = { ...parts[0], value: Math.max(0, Number(parts[0].value) - cut) };
  return [first, ...parts.slice(1)];
}

/**
 * Strip the (positive) ability modifier and consume the in-memory pending.
 *
 * Tests use this. Live apply peeks and lets `preCalculateDamage` subtract, or a skipped
 * auto-damage path would eat the pending and leave the Apply button on the full roll.
 */
export function trimCleaveDamage(actor: any, parts: DamagePart[], message?: any): DamagePart[] {
  const cut = peekCleaveCut(actor, message);
  if (cut <= 0) return parts;
  const uuid = String(actor?.uuid ?? "");
  if (uuid) cleavePending.delete(uuid);
  return applyCleaveCut(parts, cut);
}

function stampCleaveCard(message: any): void {
  if (!isPrimaryGM()) return;
  if (String(message?.flags?.dnd5e?.roll?.type ?? "") !== "damage") return;
  if (Number(message?.flags?.[MODULE_ID]?.cleaveCut) > 0) return;
  const attacker = speakerToken(message?.speaker)?.actor;
  const uuid = String(attacker?.uuid ?? "");
  const pending = cleavePending.get(uuid);
  if (!pending || Date.now() - pending.at > CLEAVE_PENDING_MS || pending.cut <= 0) return;
  cleavePending.delete(uuid);
  try {
    void message.setFlag?.(MODULE_ID, "cleaveCut", pending.cut);
  } catch (err) {
    log("masteries: could not stamp Cleave cut:", err);
  }
}

function cutCleaveOnApply(damages: any, options: any): void {
  if (!Array.isArray(damages) || !damages.length) return;
  const msg = options?.originatingMessage ?? options?.origin;
  const attacker = speakerToken(msg?.speaker)?.actor;
  const cut = peekCleaveCut(attacker, msg);
  if (cut <= 0) return;
  const value = Number(damages[0]?.value);
  if (!Number.isFinite(value)) return;
  damages[0].value = Math.max(0, value - cut);
}

function oneTurn(attacker: any, until: "sourceStart" | "sourceEnd") {
  return durationPayload(
    { value: 1, units: "turns" },
    until,
    worldOf({ self: { actor: attacker } }),
  );
}

async function applySap(attacker: any, target: any): Promise<void> {
  const duration = oneTurn(attacker, "sourceStart");
  if (!duration) return;
  const created = await writeTimedEffect({
    actor: target,
    name: "Sap",
    img: "icons/skills/melee/strike-sword-blood-red.webp",
    duration,
    key: { kind: "impose_disadvantage", capability: "mastery-sap", ruleIndex: 0 },
    params: { rollType: "attack", consume: true },
  });
  if (!created) return;
  await announce(target, "NOODLRHOOKS.Combat.Masteries.Sap", {
    name: String(target.name ?? "?"),
    by: String(attacker.name ?? "?"),
  });
}

async function applySlow(row: PendingDamage): Promise<void> {
  const attacker: any = await resolve(row.attackerUuid);
  const target: any = await resolve(row.targetUuid);
  if (!attacker || !target) return;
  const duration = oneTurn(attacker, "sourceStart");
  if (!duration) return;
  const modes = effectModes();
  const changes = movementKeysOf(target).map((t) => ({
    key: `system.attributes.movement.${t}`,
    mode: modes.add,
    value: String(slowAmount()),
  }));
  const created = await writeTimedEffect({
    actor: target,
    name: "Slow",
    img: "icons/magic/time/hourglass-yellow.webp",
    duration,
    changes,
    key: { kind: "modify_speed", capability: "mastery-slow", ruleIndex: 0 },
  });
  if (!created) return;
  await announce(target, "NOODLRHOOKS.Combat.Masteries.Slow", {
    name: String(target.name ?? "?"),
    by: String(attacker.name ?? "?"),
  });
}

async function applyVex(row: PendingDamage): Promise<void> {
  const attacker: any = await resolve(row.attackerUuid);
  const target: any = await resolve(row.targetUuid);
  if (!attacker || !target) return;
  const duration = oneTurn(attacker, "sourceEnd");
  if (!duration) return;
  const created = await writeTimedEffect({
    actor: attacker,
    name: "Vex",
    img: "icons/skills/targeting/crosshair-mark-rough-pink.webp",
    duration,
    key: {
      kind: "grant_advantage",
      capability: `mastery-vex:${row.targetUuid}`,
      ruleIndex: 0,
    },
    params: { rollType: "attack", vs: row.targetUuid, consume: true },
  });
  if (!created) return;
  await announce(attacker, "NOODLRHOOKS.Combat.Masteries.Vex", {
    name: String(attacker.name ?? "?"),
    target: String(target.name ?? "?"),
  });
}

async function applyTopple(
  attacker: any,
  target: any,
  activity: any,
  item: any,
  usageId: string,
  targetDoc: any,
): Promise<void> {
  const mod = abilityModOf(attacker, activity, item);
  const pb = proficiencyBonus(attacker);
  const dc = mod == null || pb == null ? null : toppleDc(mod, pb);
  if (dc == null) {
    log(`masteries: Topple skipped — unreadable DC on ${String(attacker.name)}`);
    return;
  }
  const tokenId = String(targetDoc?.id ?? "");
  const tokenUuid = String(targetDoc?.uuid ?? target?.uuid ?? "");
  const answer = await collectDemanded(
    {
      kind: "save",
      actorUuid: String(target.uuid ?? ""),
      tokenUuid,
      tokenId,
      ability: "con",
      dc,
      source: "Topple",
      usageId: `${usageId}:topple`,
      seconds: owedSecondsFor(target),
    },
    {
      tokenId,
      name: String(target.name ?? "?"),
      kind: "save",
      ability: "con",
      dc,
      source: "Topple",
    },
  );
  const total = Number(answer?.total);
  const failed = answer?.rolled && Number.isFinite(total) && total < dc;
  if (!failed) {
    await announce(target, "NOODLRHOOKS.Combat.Masteries.ToppleOk", {
      name: String(target.name ?? "?"),
      dc: String(dc),
    });
    return;
  }
  await setCondition(target, "prone", true);
  await announce(target, "NOODLRHOOKS.Combat.Masteries.Topple", {
    name: String(target.name ?? "?"),
    dc: String(dc),
    total: String(Math.trunc(total)),
  });
}

async function applyCleave(
  attacker: any,
  attackerDoc: any,
  firstDoc: any,
  activity: any,
  item: any,
): Promise<void> {
  if (!isMeleeAttack(activity, item)) return;
  if (cleaveSpent(attacker)) return;

  const second = pickCleaveTarget(attackerDoc, firstDoc, cleaveReach(activity, item));
  if (!second) return;

  await noteCleaveSpent(attacker);
  const mod = abilityModOf(attacker, activity, item) ?? 0;
  const cut = cleaveDamageAdjustment(mod);
  const uuid = String(attacker.uuid ?? "");
  if (uuid && cut > 0) cleavePending.set(uuid, { cut, at: Date.now() });

  try {
    await useActionAt(
      { item, activity, name: String(item?.name ?? activity?.name ?? "Cleave") },
      second,
      { skipEconomy: true },
    );
  } catch (err) {
    if (uuid) cleavePending.delete(uuid);
    log(`masteries: Cleave extra attack failed:`, err);
    return;
  }

  await announce(attacker, "NOODLRHOOKS.Combat.Masteries.Cleave", {
    name: String(attacker.name ?? "?"),
    target: String(second?.name ?? second?.actor?.name ?? "?"),
  });
}

function pickCleaveTarget(attackerDoc: any, firstDoc: any, reach: number): any | null {
  const adjacent = Number((globalThis as any).canvas?.scene?.grid?.distance ?? 5) || 5;
  const scene = (globalThis as any).canvas?.scene;
  const docs: any[] = [...(scene?.tokens?.contents ?? scene?.tokens ?? [])];
  let best: { doc: any; dist: number } | null = null;
  for (const doc of docs) {
    if (!doc || String(doc.id) === String(attackerDoc?.id)) continue;
    if (String(doc.id) === String(firstDoc?.id)) continue;
    if (outOfFight(doc)) continue;
    if (!isHostilePair(attackerDoc, doc)) continue;
    const fromFirst = tokenDistance(firstDoc, doc);
    const fromAttacker = tokenDistance(attackerDoc, doc);
    if (fromFirst > adjacent || fromAttacker > reach) continue;
    if (!best || fromAttacker < best.dist) best = { doc, dist: fromAttacker };
  }
  return best?.doc ?? null;
}

function isHostilePair(a: any, b: any): boolean {
  const SECRET = (globalThis as any).CONST?.TOKEN_DISPOSITIONS?.SECRET ?? -2;
  const da = Number((a?.document ?? a)?.disposition ?? 0);
  const db = Number((b?.document ?? b)?.disposition ?? 0);
  if (da === SECRET || db === SECRET) return false;
  if (da === 0) return db < 0;
  if (db === 0) return da < 0;
  return da * db < 0;
}

function outOfFight(doc: any): boolean {
  const actor = doc?.actor;
  if (!actor) return true;
  if (doc.hasStatusEffect?.("dead") || actor.statuses?.has?.("dead")) return true;
  const hp = actor.system?.attributes?.hp?.value;
  return typeof hp === "number" && hp <= 0;
}

async function resolve(uuid: string): Promise<any> {
  if (!uuid) return null;
  try {
    return (await (globalThis as any).fromUuid?.(uuid)) ?? null;
  } catch {
    return null;
  }
}

async function announce(subject: any, key: string, data: Record<string, string>): Promise<void> {
  try {
    await (globalThis as any).ChatMessage.create({
      content: `<p>${(globalThis as any).game.i18n.format(key, data)}</p>`,
      speaker: speakerFor(subject),
      flags: { [MODULE_ID]: { mastery: true } },
    });
  } catch (err) {
    log("masteries: could not announce:", err);
  }
}

export function surveyMasteries(): unknown {
  const token: any = (globalThis as any).canvas?.tokens?.controlled?.[0];
  const actor = token?.actor;
  const item = actor?.items?.find?.((i: any) => String(i?.system?.mastery ?? ""));
  const lines = [
    `module: ${MODULE_ID}`,
    `setting (${COMBAT_SETTINGS.masteries}): ${isMasteriesEnabled() ? "on" : "off"}`,
    `creature: ${String(token?.name ?? "— select a token —")}`,
    `weapon mastery on a sheet item: ${item ? `${String(item.name)} → ${String(item.system.mastery)}` : "none listed"}`,
    `wielder entitled to that tag: ${
      item
        ? canUseWeaponMastery(actor, item, String(item.system.mastery))
          ? "yes"
          : "no — proficiency is not Weapon Mastery"
        : "—"
    }`,
    `cleave spent this turn: ${actor ? (cleaveSpent(actor) ? "yes" : "no") : "—"}`,
    `pending Slow/Vex: ${pendingDamage.length}`,
    `applied this fight: ${applied.size}`,
    `Push / Graze / Nick: other layers (forced / auto-damage / economy)`,
  ];
  console.log(lines.join("\n"));
  return {
    enabled: isMasteriesEnabled(),
    selected: String(token?.name ?? ""),
    cleaveSpent: actor ? cleaveSpent(actor) : null,
    pending: pendingDamage.length,
  };
}

/** Exported so a test can pin the pending / trim / claim arithmetic without a scene. */
export function __masteriesInternals() {
  return {
    claim,
    filePending,
    pendingDamage,
    cleavePending,
    applied,
    turnStamp,
    cleaveSpent,
    pickCleaveTarget,
    isHostilePair,
    stampCleaveCard,
    cutCleaveOnApply,
  };
}
