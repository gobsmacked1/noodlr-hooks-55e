// A demanded roll that nobody has produced yet — a d20, or the damage dice on a confirmed hit.
//
// Unrolled weapon damage is the same skip as an unpressed save: the tracker moves, legendary
// actions fire, and a creature that should be bloodied or dead still takes its turn. Owed
// damage therefore uses this same list. The hold lasts until the dice exist AND (when
// auto-apply is on) hit points have had a chance to move — a bloody or a kill has to land
// before the next combatant acts.
//
// The system's card draws a button and waits. Anyone who never presses it still gets their turn,
// so a petrifying ray, a Grapple, a forced Deception, or a concentration check that nobody
// answered is a turn taken as if the demand never happened. That is the failure this exists
// to prevent. It is not a player-only gate and it is not save-only: a GM driving a combatant
// by hand can ignore a chat-card button just as a player can, and Mass Suggestion on four
// characters holds the tracker until all four dice exist.
//
// Three halves, and all three are load-bearing:
//
//   1. ASK on the owner's client. Two clocks (GM vs Players), 0–120 s. 0 means roll immediately,
//      no dialog. A non-zero clock defaults to "roll". Dismissing the dialog rolls. There is no
//      Skip. A timeout on a demanded verdict is not a reaction timeout — leaving it unanswered
//      is how the consequence is skipped.
//   2. HOLD initiative until EVERY owed line has a verdict. Legendary actions fire AFTER the
//      tracker has already moved (`onAdvance` → rays → `takeTurn`), so waiting only at `nextTurn`
//      is too late. The new current combatant must not act until the demand that just landed exists.
//   3. VETO End Turn / nextTurn, and an owing token's own walk and activity use, while the flag
//      is up. The prompt lives on the owner; the activation map lives on the GM; the combat flag
//      is what a player client can read.
//
// The clock rolls on the owner's client against that sheet. The GM is the last resort when the
// query never arrives (offline, transport timeout), never the first roll for a connected owner.

import { COMBAT_SETTINGS, MODULE_ID, log } from "../constants";
import { enabledForEither, isAutoRollDamageEnabled, isAutoSavesEnabled } from "../settings";
import { isPrimaryGM, isRollerFor, rollerForActor } from "../util/gm";
import { promptChoice } from "../util/prompt";
import { askUser, registerQuery } from "../util/queries";
import {
  activityOf,
  attackModeOf,
  isUsageCard,
  itemOf,
  originatingId,
  originatingMessageData,
  rollType,
  speakerToken,
  targetsOf,
  tokenFromActorUuid,
} from "./cards";

const QUERY = "owed-roll";

/** Fired when the last owed roll lands, so a held tracker can resume. */
export const OWED_CLEARED = `${MODULE_ID}.owedCleared`;

/** Default Player clock, and the fallback when a setting is unreadable. Same as a reaction. */
export const OWED_SECONDS = 6;

export const OWED_SECONDS_MIN = 0;
export const OWED_SECONDS_MAX = 120;

/** Floor on query patience when the clock is 0. The roll itself still has to cross the wire. */
export const OWED_TRANSPORT_MS = 30_000;

/** Extra seconds after the clock so the card can join before initiative gives up. */
export const OWED_SETTLE_MS = 5_000;

/** How long initiative will wait when both clocks are 0 (instant rolls plus settle). */
export const OWED_ADVANCE_BUDGET_MS = 20_000;

/** After the damage card exists, wait this long for auto-apply before releasing the tracker. */
export const OWED_DAMAGE_APPLY_MS = 4_000;

/** A usage card posted this tick may not have been filed yet. */
export const OWED_GRACE_MS = 750;

export type OwedKind = "save" | "check" | "concentration" | "damage";

export interface OwedRequest {
  kind: OwedKind;
  actorUuid: string;
  tokenUuid: string;
  tokenId: string;
  ability: string;
  skill?: string;
  dc: number;
  source: string;
  usageId: string;
  /** Seconds the owner's client waits. 0 = no prompt. Stamped by the asker so both sides agree. */
  seconds?: number;
  /** Damage only — activity uuids do not resolve through `fromUuid`. */
  itemUuid?: string;
  activityId?: string;
  isCritical?: boolean;
  attackMode?: string;
}

export interface OwedAnswer {
  rolled: boolean;
  already?: boolean;
  total?: number | null;
}

/** Plain, so it can live on a combat flag a player client reads. */
export interface OwedLine {
  tokenId: string;
  name: string;
  kind: OwedKind;
  ability: string;
  dc: number | null;
  source: string;
}

/** What the clock picks. Exported so a test can pin that it is never "skip". */
export const OWED_TIMEOUT_CHOICE = "roll" as const;

export function clampOwedSeconds(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return OWED_SECONDS;
  return Math.min(OWED_SECONDS_MAX, Math.max(OWED_SECONDS_MIN, Math.round(n)));
}

/**
 * Which clock an elected roller uses. Only a definite non-GM player gets the Player clock.
 * Unknown / no user / a GM (including assistants) uses the GM clock. Exported for tests.
 */
export function owedClockForUser(isGm: boolean | null | undefined): "gm" | "players" {
  return isGm === false ? "players" : "gm";
}

export function owedTransportMs(seconds: number): number {
  const s = clampOwedSeconds(seconds);
  return Math.max(OWED_TRANSPORT_MS, s * 1000 + 10_000);
}

export function owedAdvanceBudgetMs(gmSeconds: number, playerSeconds: number): number {
  const clock = Math.max(clampOwedSeconds(gmSeconds), clampOwedSeconds(playerSeconds));
  return Math.max(OWED_ADVANCE_BUDGET_MS, clock * 1000 + OWED_GRACE_MS + OWED_SETTLE_MS);
}

export function shouldPromptOwed(seconds: number): boolean {
  return clampOwedSeconds(seconds) > 0;
}

/**
 * Clock for an owed damage roll. Auto-roll is still a 0 *prompt* — no dialog.
 * Manual never uses a 0 clock: the GM's save timer is 0 so Fireball-on-goblins
 * does not prompt, and that must not silently auto-roll a player's (or a
 * hand-driven monster's) weapon damage. The 1.5 s beat after a confirmed hit
 * is `autoDamageBeatMs`, not this clock.
 */
export function owedDamageSeconds(autoRoll: boolean, clockSeconds: number): number {
  if (autoRoll) return 0;
  const clock = clampOwedSeconds(clockSeconds);
  return shouldPromptOwed(clock) ? clock : OWED_SECONDS;
}

/**
 * Pause after a confirmed hit before auto-rolled damage posts. Chat cards
 * otherwise land in the same breath and the table loses the attack. Not a
 * prompt — Shield / Barbs / Cutting Words have already answered. Misses,
 * graze, and a player "Roll" dialog skip this.
 */
export const AUTO_DAMAGE_BEAT_MS = 1500;

export function autoDamageBeatMs(autoRoll: boolean): number {
  return autoRoll ? AUTO_DAMAGE_BEAT_MS : 0;
}

/**
 * A confirmed attack hit still needs its damage dice. Automated turns used to
 * roll those in `finishActivity` beside the attack — that skipped the hit and
 * the reaction window. They go through this door now, same as a hand-driven
 * swing. Graze / miss / open / a Charm Ray with no parts are not this pass —
 * nor is a Fireball's save-then-damage button.
 */
export function shouldCollectOwedDamage(input: {
  verdict: string;
  activityType: string;
  hasDamageParts: boolean;
  alreadyRolled: boolean;
}): boolean {
  if (input.alreadyRolled) return false;
  if (input.verdict !== "hit") return false;
  if (input.activityType !== "attack") return false;
  return input.hasDamageParts;
}

function readOwedSeconds(which: "gm" | "players"): number {
  const key = which === "gm" ? COMBAT_SETTINGS.owedSecondsGm : COMBAT_SETTINGS.owedSecondsPlayers;
  const fallback = which === "gm" ? 0 : OWED_SECONDS;
  try {
    const raw = (globalThis as any).game?.settings?.get?.(MODULE_ID, key);
    if (raw === undefined || raw === null) return fallback;
    return clampOwedSeconds(raw);
  } catch {
    return fallback;
  }
}

export function owedSecondsGm(): number {
  return readOwedSeconds("gm");
}

export function owedSecondsPlayers(): number {
  return readOwedSeconds("players");
}

/** Seconds for the creature this demand is about — who `rollerForActor` names, not sheet type. */
export function owedSecondsFor(actor: any): number {
  return readOwedSeconds(owedClockForActor(actor));
}

function owedClockForActor(actor: any): "gm" | "players" {
  const id = actor ? rollerForActor(actor) : null;
  if (!id) return "gm";
  const user = (globalThis as any).game?.users?.get?.(id);
  return owedClockForUser(user?.isGM);
}

function stampClock(request: OwedRequest, actor: any): OwedRequest {
  if (request.seconds === undefined) request.seconds = owedSecondsFor(actor);
  return request;
}

export function owedKey(usageId: string, tokenId: string): string {
  return `${usageId}:${tokenId}`;
}

/**
 * Initiative only. HP edits, combatant adds, and flag writes must not freeze the tracker.
 * Exported so a test can pin it without a Foundry world.
 */
export function shouldBlockAdvance(owed: readonly OwedLine[], changed: unknown): boolean {
  if (!owed.length || !changed || typeof changed !== "object") return false;
  return "turn" in changed || "round" in changed;
}

let listSaves: () => OwedLine[] = () => [];

/** The save layer's outstanding unpaid saves. Called from `registerSaveResolution`. */
export function bindSaveOwed(fn: () => OwedLine[]): void {
  listSaves = fn;
}

const pendingChecks = new Map<string, OwedLine>();
const aborting = new Map<string, AbortController>();
const asking = new Set<string>();

let lastDemandAt = 0;
let lastOwedCount = 0;

export function noteOwedDemand(): void {
  lastDemandAt = Date.now();
}

export function owedRecentlyDemanded(): boolean {
  return Date.now() - lastDemandAt < 2_000;
}

export function owedOutstanding(): OwedLine[] {
  return [...listSaves(), ...pendingChecks.values()];
}

export function abortOwedPrompt(key: string): void {
  aborting.get(key)?.abort();
}

/** Register the answering half and the gates. Every client: the addressee is the owner. */
export function registerOwedRolls(): void {
  registerQuery(QUERY, async (data: any) => {
    const request = data?.request as OwedRequest | undefined;
    if (!request?.actorUuid) return { rolled: false };
    return await resolveHere(request);
  });

  Hooks.on("createChatMessage", (message: any) => {
    const usageId = originatingId(message);
    const type = rollType(message);
    if (
      usageId &&
      (type === "save" || type === "skill" || type === "ability" || type === "damage" || type === "healing")
    ) {
      const token = speakerToken(message?.speaker);
      if (token) abortOwedPrompt(owedKey(usageId, String(token.id ?? "")));
    }
    if (isPrimaryGM()) void maybeAskCheck(message);
  });

  Hooks.on("preUpdateCombat", (combat: any, changed: any) => {
    const owed = owedForGate(combat);
    if (!shouldBlockAdvance(owed, changed)) return;
    notifyBlocked(owed);
    log(`owed-roll: blocking initiative — ${owed.map((o) => o.name).join(", ")} still ${owed[0]?.kind ?? "owe"}`);
    return false;
  });

  Hooks.on("preMoveToken", (document: any, movement: any) => {
    if (!tokenOwesRoll(String(document?.id ?? ""))) return;
    const action = String(movement?.action ?? "");
    if (action === "displace" || action === "noodlrForce") return;
    const method = String(movement?.method ?? "");
    if (method && method !== "dragging" && method !== "keyboard") return;
    notifyBlocked(owedForGate((game as any).combat).filter((o) => o.tokenId === String(document.id)));
    return false;
  });

  Hooks.on("dnd5e.preUseActivity", (activity: any) => {
    const actor = activity?.actor;
    if (!actor) return;
    const owed = owedForGate((game as any).combat);
    if (!owed.length) return;
    const tokens: any[] = actor.getActiveTokens?.() ?? [];
    const hit = owed.find((o) =>
      tokens.some((t: any) => String(t?.id ?? t?.document?.id ?? "") === o.tokenId),
    );
    if (!hit) return;
    notifyBlocked([hit]);
    return false;
  });
}

/**
 * Put the demand on the owner's client and wait. Null when nobody was asked.
 *
 * A connected player rolls there (clock or button). Offline falls through so the
 * caller can roll on the GM as last resort.
 */
export async function requestOwedRoll(request: OwedRequest): Promise<OwedAnswer | null> {
  const actor: any = await resolve(request.actorUuid);
  stampClock(request, actor);
  const owner = (actor ? rollerForActor(actor) : null) ?? String((game.users as any)?.activeGM?.id ?? "");
  if (!owner) return null;
  return await askUser<OwedAnswer>(owner, QUERY, { request }, { timeout: owedTransportMs(request.seconds ?? 0) });
}

/**
 * Hold the line, produce a die, then drop the line.
 *
 * A clock of 0 on this creature's elected roller rolls immediately (configure: false) —
 * that is the GM-owned Fireball-on-goblins path. A positive clock always prompts, even
 * when this client is the roller, so a GM who set their timer to 6 is asked. A hung
 * query falls through to a GM roll. Used for checks, concentration, repeat
 * end-of-turn saves, and owed damage — anything that is not already filed on
 * the save-layer activation map.
 *
 * `after` runs while the line is still outstanding. Damage uses it so a bloody
 * or a kill lands before initiative can move, not a tick later.
 */
export async function collectDemanded(
  request: OwedRequest,
  line: OwedLine,
  after?: () => Promise<void>,
): Promise<OwedAnswer | null> {
  const key = owedKey(request.usageId, request.tokenId);
  if (asking.has(key)) return null;
  asking.add(key);
  pendingChecks.set(key, line);
  noteOwedDemand();
  void syncOwedFlag();
  try {
    const actor: any = await resolve(request.actorUuid);
    stampClock(request, actor);
    // Line is already outstanding, so End Turn stays blocked during the beat.
    if (request.kind === "damage" && !shouldPromptOwed(request.seconds ?? 0)) {
      const beat = autoDamageBeatMs(true);
      if (beat) await sleep(beat);
    }
    if (actor && isRollerFor(actor) && !shouldPromptOwed(request.seconds ?? 0)) {
      const local = await performOwedRoll(request, { configure: false });
      if (local.ok) {
        if (after) await after();
        return { rolled: true, total: local.total };
      }
    }
    const answer = await requestOwedRoll(request);
    if (answer?.already || answer?.rolled) {
      if (after) await after();
      return answer;
    }
    const fallback = await performOwedRoll(request, { configure: false });
    if (after) await after();
    return { rolled: fallback.ok, total: fallback.total };
  } finally {
    pendingChecks.delete(key);
    asking.delete(key);
    void syncOwedFlag();
  }
}

/**
 * A confirmed hit still needs its damage dice. Uses the same outstanding list as a
 * demanded save, so End Turn, nextTurn, walks, and activity use all wait. Called
 * after the reaction window — a Shield that turns the swing aside never reaches here.
 */
export async function collectOwedDamage(message: any, verdict: string): Promise<void> {
  const item = itemOf(message);
  const activity = activityOf(message, item);
  const parts = activity?.damage?.parts;
  const usageId = originatingId(message) || String(message?.id ?? "");
  const token = speakerToken(message?.speaker);
  const actor = token?.actor ?? message?.speakerActor ?? null;
  if (!usageId || !token || !actor || !item || !activity) return;

  if (
    !shouldCollectOwedDamage({
      verdict,
      activityType: String(activity.type ?? ""),
      hasDamageParts: Array.isArray(parts) && parts.length > 0,
      alreadyRolled: usageAlreadyHasDamage(usageId, String(message?.id ?? "")),
    })
  ) {
    return;
  }

  const tokenId = String(token.id ?? "");
  const source = String(item.name ?? activity.name ?? "");
  const request: OwedRequest = {
    kind: "damage",
    actorUuid: String(actor.uuid ?? ""),
    tokenUuid: String(token.uuid ?? ""),
    tokenId,
    ability: "",
    dc: 0,
    source,
    usageId,
    itemUuid: String(item.uuid ?? itemOf(message)?.uuid ?? ""),
    activityId: String(activity.id ?? ""),
    isCritical: Boolean(message?.rolls?.[0]?.isCritical),
    attackMode: attackModeOf(message) || undefined,
    seconds: owedDamageSeconds(isAutoRollDamageEnabled(actor), owedSecondsFor(actor)),
  };
  const line: OwedLine = {
    tokenId,
    name: String(token.name ?? actor.name ?? ""),
    kind: "damage",
    ability: "",
    dc: null,
    source,
  };
  const keys = [usageId, String(message?.id ?? "")].filter(Boolean);
  await collectDemanded(request, line, async () => {
    if (!enabledForEither(COMBAT_SETTINGS.autoDamage)) return;
    await waitForDamageLanded(keys);
  });
}

export async function waitForOwedRolls(budgetMs?: number): Promise<boolean> {
  const budget = budgetMs ?? owedAdvanceBudgetMs(owedSecondsGm(), owedSecondsPlayers());
  if (!owedRecentlyDemanded() && !owedOutstanding().length) return true;
  await sleep(OWED_GRACE_MS);
  const start = Date.now();
  while (owedOutstanding().length) {
    if (Date.now() - start >= budget) return owedOutstanding().length === 0;
    await sleep(200);
  }
  return true;
}

/** Stamp the combat so a player client can veto End Turn. Primary GM only. */
export async function syncOwedFlag(): Promise<void> {
  if (!isPrimaryGM()) return;
  const combat = (game as any).combat;
  const owed = owedOutstanding();
  if (owed.length === 0 && lastOwedCount > 0) {
    lastOwedCount = 0;
    try {
      Hooks.callAll(OWED_CLEARED);
    } catch {
      /* listener must not break settle */
    }
  } else {
    lastOwedCount = owed.length;
  }
  if (!combat?.id) return;
  const prev = combat.getFlag?.(MODULE_ID, "owed");
  if (sameOwed(prev, owed)) return;
  try {
    if (!owed.length) await combat.unsetFlag(MODULE_ID, "owed");
    else await combat.setFlag(MODULE_ID, "owed", owed);
  } catch (err) {
    log("owed-roll: could not stamp the combat flag:", err);
  }
}

export function surveyOwedRolls(): unknown {
  const combat = (game as any).combat;
  return {
    outstanding: owedOutstanding(),
    flagged: owedOnCombat(combat),
    recentlyDemanded: owedRecentlyDemanded(),
    asking: Array.from(asking),
    clock: { gm: owedSecondsGm(), players: owedSecondsPlayers() },
  };
}

function owedForGate(combat: any): OwedLine[] {
  if (isPrimaryGM()) {
    const local = owedOutstanding();
    if (local.length) return local;
  }
  return owedOnCombat(combat);
}

function owedOnCombat(combat: any): OwedLine[] {
  const raw = combat?.getFlag?.(MODULE_ID, "owed") ?? combat?.flags?.[MODULE_ID]?.owed;
  return Array.isArray(raw) ? (raw as OwedLine[]) : [];
}

function tokenOwesRoll(tokenId: string): boolean {
  if (!tokenId) return false;
  return owedForGate((game as any).combat).some((o) => o.tokenId === tokenId);
}

async function resolveHere(request: OwedRequest): Promise<OwedAnswer> {
  const key = owedKey(request.usageId, request.tokenId);
  const ac = new AbortController();
  aborting.set(key, ac);
  try {
    const actor: any = await resolve(request.actorUuid);
    const token: any = await resolve(request.tokenUuid);
    const seconds = clampOwedSeconds(request.seconds ?? owedSecondsFor(actor));
    if (!shouldPromptOwed(seconds)) {
      const result = await performOwedRoll(request, { configure: false });
      return { rolled: result.ok, total: result.total };
    }
    const name = String(token?.name ?? actor?.name ?? "");
    const picked = await promptChoice({
      title: game.i18n.localize("NOODLRHOOKS.OwedRoll.Title"),
      body: sentence(request, name),
      choices: [{ id: OWED_TIMEOUT_CHOICE, label: game.i18n.localize("NOODLRHOOKS.OwedRoll.Roll") }],
      defaultId: OWED_TIMEOUT_CHOICE,
      seconds,
      signal: ac.signal,
      abortId: "already",
    });
    if (picked === "already") return { rolled: true, already: true };
    const configured = await performOwedRoll(request, { configure: true });
    const result = configured.ok ? configured : await performOwedRoll(request, { configure: false });
    return { rolled: result.ok, total: result.total };
  } finally {
    aborting.delete(key);
  }
}

async function performOwedRoll(
  request: OwedRequest,
  opts: { configure: boolean },
): Promise<{ ok: boolean; total: number | null }> {
  const actor: any = await resolve(request.actorUuid);
  const token: any = await resolve(request.tokenUuid);
  if (!actor) return { ok: false, total: null };
  const ChatMessage = (globalThis as any).ChatMessage;
  const origin = originatingMessageData(request.usageId);
  const messageData = {
    data: {
      speaker: ChatMessage?.getSpeaker?.({ actor, token }) ?? { alias: String(actor.name ?? "") },
      ...origin,
    },
  };
  const dialog = { configure: opts.configure };
  try {
    let result: unknown;
    if (request.kind === "damage") {
      const item: any = await resolve(request.itemUuid ?? "");
      const activity =
        item?.system?.activities?.get?.(request.activityId) ??
        item?.system?.activities?.get?.(String(request.activityId ?? ""));
      if (!activity || typeof activity.rollDamage !== "function") return { ok: false, total: null };
      const rollCfg: { isCritical?: boolean; attackMode?: string } = {};
      if (request.isCritical) rollCfg.isCritical = true;
      if (request.attackMode) rollCfg.attackMode = request.attackMode;
      result = await activity.rollDamage(rollCfg, dialog, messageData);
    } else if (request.kind === "concentration") {
      result = await actor.rollConcentration({ target: request.dc }, dialog, messageData);
    } else if (request.kind === "save") {
      result = await actor.rollSavingThrow(
        { ability: request.ability, target: request.dc },
        dialog,
        messageData,
      );
    } else if (request.skill) {
      result = await actor.rollSkill(
        { skill: request.skill, ability: request.ability, target: request.dc },
        dialog,
        messageData,
      );
    } else {
      result = await actor.rollAbilityCheck(
        { ability: request.ability, target: request.dc },
        dialog,
        messageData,
      );
    }
    const roll = Array.isArray(result) ? result[0] : result;
    const total = Number((roll as { total?: unknown } | null)?.total);
    return {
      ok: Boolean(roll),
      total: Number.isFinite(total) ? total : null,
    };
  } catch (err) {
    log(`owed-roll: ${String(actor?.name)} could not roll:`, err);
    return { ok: false, total: null };
  }
}

async function maybeAskCheck(message: any): Promise<void> {
  if (!isAutoSavesEnabled()) return;
  if (!isUsageCard(message)) return;
  const item = itemOf(message);
  const activity = activityOf(message, item);
  if (String(activity?.type ?? "") !== "check") return;

  const usageId = String(message?.id ?? "");
  if (!usageId) return;
  const dc = Number(activity?.check?.dc?.value);
  if (!Number.isFinite(dc)) return;

  const associated = Array.from(activity?.check?.associated ?? []).map((a) => String(a));
  const skills = ((globalThis as any).CONFIG?.DND5E?.skills ?? {}) as Record<string, unknown>;
  const skill = associated.find((a) => a in skills);
  const ability = String(activity?.check?.ability ?? associated[0] ?? "");
  if (!ability && !skill) return;

  noteOwedDemand();
  const source = String(item?.name ?? activity?.name ?? "");
  const jobs: Promise<void>[] = [];
  for (const target of targetsOf(message)) {
    const doc = tokenFromActorUuid(target.uuid);
    const actor = doc?.actor;
    if (!doc || !actor) continue;
    const tokenId = String(doc.id ?? "");
    const key = owedKey(usageId, tokenId);
    if (asking.has(key) || pendingChecks.has(key)) continue;
    const request: OwedRequest = {
      kind: "check",
      actorUuid: String(actor.uuid ?? ""),
      tokenUuid: String(doc.uuid ?? ""),
      tokenId,
      ability: ability || "int",
      skill,
      dc,
      source,
      usageId,
    };
    const line: OwedLine = {
      tokenId,
      name: String(doc.name ?? target.name),
      kind: "check",
      ability: ability || skill || "",
      dc,
      source,
    };
    jobs.push(collectDemanded(request, line).then(() => undefined));
  }
  if (jobs.length) {
    void syncOwedFlag();
    await Promise.all(jobs);
    void syncOwedFlag();
  }
}

function sentence(request: OwedRequest, name: string): string {
  if (request.kind === "damage") {
    return game.i18n.format("NOODLRHOOKS.OwedRoll.BodyDamage", {
      name,
      source: request.source,
    });
  }
  const key =
    request.kind === "concentration"
      ? "NOODLRHOOKS.OwedRoll.BodyConcentration"
      : request.kind === "check"
        ? "NOODLRHOOKS.OwedRoll.BodyCheck"
        : "NOODLRHOOKS.OwedRoll.BodySave";
  return game.i18n.format(key, {
    name,
    ability: abilityLabel(request.ability),
    check: request.skill ? skillLabel(request.skill) : abilityLabel(request.ability),
    dc: String(request.dc),
    source: request.source,
  });
}

function notifyBlocked(owed: OwedLine[]): void {
  if (!owed.length) return;
  const first = owed[0]!;
  const text =
    owed.length === 1
      ? first.kind === "damage"
        ? game.i18n.format("NOODLRHOOKS.OwedRoll.BlockedDamage", {
            name: first.name,
            source: first.source,
          })
        : game.i18n.format("NOODLRHOOKS.OwedRoll.Blocked", {
            name: first.name,
            ability: abilityLabel(first.ability),
            source: first.source,
            dc: String(first.dc ?? "?"),
          })
      : game.i18n.format("NOODLRHOOKS.OwedRoll.BlockedMany", {
          name: first.name,
          more: String(owed.length - 1),
        });
  try {
    ui.notifications?.warn(text);
  } catch {
    log(`owed-roll: ${text}`);
  }
}

function abilityLabel(ability: string): string {
  const label = (globalThis as any).CONFIG?.DND5E?.abilities?.[ability]?.label;
  return label ? game.i18n.localize(label) : ability.toUpperCase();
}

function skillLabel(skill: string): string {
  const label = (globalThis as any).CONFIG?.DND5E?.skills?.[skill]?.label;
  return label ? game.i18n.localize(label) : skill;
}

function sameOwed(prev: unknown, next: OwedLine[]): boolean {
  const a = Array.isArray(prev) ? (prev as OwedLine[]) : [];
  if (a.length !== next.length) return false;
  const key = (o: OwedLine) => `${o.tokenId}:${o.kind}:${o.ability}:${o.dc}:${o.source}`;
  const left = a.map(key).sort().join("|");
  const right = next.map(key).sort().join("|");
  return left === right;
}

async function resolve(uuid: string): Promise<any> {
  if (!uuid) return null;
  try {
    return (await (globalThis as any).fromUuid?.(uuid)) ?? null;
  } catch {
    return null;
  }
}

function usageAlreadyHasDamage(usageId: string, attackId: string): boolean {
  const keys = new Set([usageId, attackId].filter(Boolean));
  return findDamageCard(keys) !== null;
}

function findDamageCard(keys: Iterable<string>): any {
  const wanted = new Set([...keys].filter(Boolean));
  if (!wanted.size) return null;
  const collection = (globalThis as any).game?.messages;
  const list = Array.isArray(collection) ? collection : (collection?.contents ?? []);
  for (const msg of list) {
    const type = rollType(msg);
    if (type !== "damage" && type !== "healing") continue;
    const origin = originatingId(msg);
    if (origin && wanted.has(origin)) return msg;
    if (wanted.has(String(msg.id ?? ""))) return msg;
  }
  return null;
}

/**
 * Hold until auto-apply has had a chance. A bloody or a kill has to land before
 * the next turn or legendary action. Released once the card is flagged, or shortly
 * after it appears (apply declined / stood aside), or at the patience cap.
 */
async function waitForDamageLanded(keys: string[]): Promise<void> {
  const start = Date.now();
  let seenAt = 0;
  while (Date.now() - start < OWED_DAMAGE_APPLY_MS) {
    const card = findDamageCard(keys);
    if (card?.getFlag?.(MODULE_ID, "damageApplied")) return;
    if (card && !seenAt) seenAt = Date.now();
    if (card && Date.now() - seenAt >= OWED_GRACE_MS) return;
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function looksLikeDemandedRoll(message: any): boolean {
  if (!isUsageCard(message)) return false;
  const item = itemOf(message);
  const activity = activityOf(message, item);
  const type = String(activity?.type ?? "");
  return type === "save" || type === "check";
}
