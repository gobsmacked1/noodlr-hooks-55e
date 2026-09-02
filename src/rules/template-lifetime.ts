// Templates leave when the effect does.
//
// dnd5e places a MeasuredTemplate and then forgets it. Concentration *can* cascade a dependent,
// and plenty of templates are never registered as one, so a broken Wall of Fire or a spent
// Fireball stays painted. Instantaneous leftovers are why a creature fleeing yesterday's
// explosion looks broken (`dnd5e-hazards.ts`). This is bookkeeping, not tactics: the system
// already draws the shape; we own when it leaves.
//
// Two families, and they must not be conflated:
//
//   * Instant (Fireball, Lightning Bolt, a breath): settled, then gone — either the placing
//     turn is over, or INSTANT_VISIBLE_MS has elapsed on the same slot. A Lightning Bolt is a
//     flash; leaving the line up for a whole player turn looks like the cleanup never ran.
//     The combat clock still ends it the moment the turn advances (Hold Person already showed
//     worldTime can run minutes during one round). Out of combat, a short real-time TTL.
//   * Lasting (Wall of Fire, Darkness, Moonbeam): BOTH clocks, when the spell has both.
//     Concentration is required for the whole time it is up — a break ends the parent AE and
//     every child template. The printed duration is a ceiling: you cannot hold the same slot
//     forever by concentrating. Whichever happens first ends both. A successful Counterspell
//     never reaches this file — the veto is at `preUseActivity`, before `#placeTemplate` and
//     before the concentration AE is created, so there is nothing to expire.
//     `heldSeen` is only "we actually saw the AE"; an empty live set is not a break.
//
// Lasting clocks: the same combat, if it was already started when the spell was placed, uses
// rounds (1 minute = 10). Everywhere else — including a wall dropped to block a door before
// anyone rolls initiative — uses real time, plus worldTime so a calendar skip still ends it.
// Placing a template never starts a combat.
//
// A template that vanishes before the saves resolve is worse than one that lingered, so an
// instant is not due until SETTLE_MS. Lasting uses the duration, not that settle window.

import { MODULE_ID, log } from "../constants";
import { isTemplateLifetimeEnabled } from "../settings";
import { clocksFromDuration, durationOf, ROUND_MS, type LifeKind } from "../system/dnd5e-templates";
import { isDnd5e } from "../system/dnd5e-rewards";
import { isPrimaryGM } from "../util/gm";

export const SETTLE_MS = 4_000;
export const OOC_TTL_MS = 8_000;
/** Instant templates vanish after this even if the placing turn is still live. */
export const INSTANT_VISIBLE_MS = 6_000;
const POLL_MS = 6_000;

export interface LifetimeStamp {
  kind: LifeKind;
  at: number;
  combatId?: string;
  round?: number;
  turn?: number;
  combatant?: string;
  origin?: string;
  item?: string;
  actor?: string;
  concentrating?: boolean;
  effect?: string;
  /** We have seen the matching concentration AE. Without this, a miss is not an ending. */
  heldSeen?: boolean;
  durationMs?: number;
  durationRounds?: number;
  untilMs?: number;
  untilWorld?: number;
  untilRound?: number;
}

export interface LifetimeNow {
  now: number;
  combatId?: string;
  round?: number;
  turn?: number;
  combatant?: string;
  worldTime?: number;
  /** UUIDs still concentrating — effect uuid, item uuid, origin uuid. Never a bare actor id. */
  live: ReadonlySet<string>;
}

function enabled(): boolean {
  try {
    return isDnd5e() && isTemplateLifetimeEnabled();
  } catch {
    return false;
  }
}

function dndFlags(doc: any): any {
  return doc?.flags?.dnd5e ?? doc?._source?.flags?.dnd5e ?? {};
}

function ourStamp(doc: any): LifetimeStamp | null {
  const raw = doc?.flags?.[MODULE_ID]?.lifetime ?? doc?._source?.flags?.[MODULE_ID]?.lifetime;
  if (!raw || typeof raw !== "object") return null;
  if (raw.kind !== "instant" && raw.kind !== "lasting" && raw.kind !== "keep") return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at)) return null;
  return raw as LifetimeStamp;
}

export function combatClockOf(combat: any): Pick<LifetimeStamp, "combatId" | "round" | "turn" | "combatant"> {
  if (!combat?.id || combat.started === false) return {};
  return {
    combatId: String(combat.id),
    round: Number.isFinite(combat.round) ? Number(combat.round) : undefined,
    turn: Number.isFinite(combat.turn) ? Number(combat.turn) : undefined,
    combatant: combat.combatant?.id ? String(combat.combatant.id) : undefined,
  };
}

/** A hand-drawn ruler has no activity. Leave it. */
export function isAbilityTemplate(doc: any): boolean {
  const flags = dndFlags(doc);
  return Boolean(flags.origin || flags.item);
}

export function stampFor(
  doc: any,
  source: any,
  clock: Pick<LifetimeStamp, "combatId" | "round" | "turn" | "combatant">,
  at: number,
  worldTime?: number,
): LifetimeStamp | null {
  const flags = dndFlags(doc);
  const origin = String(flags.origin ?? source?.uuid ?? "");
  const item = String(flags.item ?? source?.item?.uuid ?? source?.uuid ?? "");
  const actor = String(source?.actor?.uuid ?? source?.item?.actor?.uuid ?? "");
  if (!source) {
    if (!origin && !item) return null;
    return {
      kind: "keep",
      at,
      ...clock,
      origin: origin || undefined,
      item: item || undefined,
      actor: actor || undefined,
    };
  }
  const read = durationOf(source);
  const clocks = clocksFromDuration(read.units, read.value, at, clock, worldTime);
  return {
    kind: read.kind,
    at,
    ...clock,
    ...clocks,
    origin: origin || undefined,
    item: item || undefined,
    actor: actor || undefined,
    concentrating: read.concentrating || undefined,
  };
}

/** Same combat that was already started when the template was placed. */
export function inPlacingCombat(stamp: LifetimeStamp, now: LifetimeNow): boolean {
  return Boolean(stamp.combatId && now.combatId === stamp.combatId && Number.isFinite(now.round));
}

/**
 * The spell's own duration has run out.
 *
 * Same started combat → rounds (a calendar skip mid-round must not end a wall).
 * Everywhere else — including a door blocked before initiative — real time, plus
 * worldTime so a GM who advances the clock still ends it. Never starts a combat.
 */
export function durationExpired(stamp: LifetimeStamp, now: LifetimeNow): boolean {
  if (inPlacingCombat(stamp, now) && stamp.untilRound != null && now.round != null) {
    return now.round >= stamp.untilRound;
  }
  if (stamp.untilMs != null && now.now >= stamp.untilMs) return true;
  if (stamp.untilWorld != null && now.worldTime != null && now.worldTime >= stamp.untilWorld) {
    return true;
  }
  return false;
}

/**
 * Combat ended: remaining rounds become leftover real time so a wall dropped in
 * round 1 of a 3-round skirmish still has ~42 s left at the door, not the
 * original full minute and not nothing.
 */
export function leftoverAfterCombat(stamp: LifetimeStamp, endedRound: number, nowMs: number): number | null {
  if (stamp.untilRound == null || !Number.isFinite(endedRound)) return null;
  const remaining = stamp.untilRound - endedRound;
  return nowMs + Math.max(0, remaining) * ROUND_MS;
}

/**
 * Whether this stamp should be deleted *now*.
 *
 * Instant: settled, and either the placing turn is over, the visible TTL elapsed, or
 * there was never a combat (OOC TTL).
 * Lasting / keep: duration clock, or concentration we have actually seen and then lost.
 * An empty live set is not "concentration ended" — that is how a one-minute wall
 * vanished after SETTLE_MS.
 */
export function isDue(stamp: LifetimeStamp, now: LifetimeNow): boolean {
  if (!(now.now >= stamp.at)) return false;
  if (stamp.kind === "instant") {
    if (stamp.combatId) {
      if (now.now < stamp.at + SETTLE_MS) return false;
      const sameCombat = now.combatId === stamp.combatId;
      const sameSlot = sameCombat && now.round === stamp.round && now.turn === stamp.turn;
      if (!sameSlot) return true;
      return now.now >= stamp.at + INSTANT_VISIBLE_MS;
    }
    return now.now >= stamp.at + OOC_TTL_MS;
  }

  if (durationExpired(stamp, now)) return true;
  if (stamp.kind === "keep" && !stamp.concentrating && !stamp.effect) return false;
  return concentrationEnded(stamp, now);
}

export function concentrationEnded(stamp: LifetimeStamp, now: LifetimeNow): boolean {
  if (!stamp.concentrating && !stamp.effect) return false;
  if (!stamp.heldSeen) return false;
  if (now.now < stamp.at + SETTLE_MS) return false;
  if (stamp.effect && now.live.has(stamp.effect)) return false;
  return !stillHeld(stamp, now.live);
}

export function stillHeld(stamp: LifetimeStamp, live: ReadonlySet<string>): boolean {
  for (const key of [stamp.effect, stamp.origin, stamp.item]) {
    if (key && live.has(key)) return true;
  }
  return false;
}

export function dueReason(stamp: LifetimeStamp, now: LifetimeNow): string | null {
  if (!isDue(stamp, now)) return null;
  if (stamp.kind === "instant") {
    if (!stamp.combatId) return "ooc ttl";
    const sameSlot =
      now.combatId === stamp.combatId && now.round === stamp.round && now.turn === stamp.turn;
    return sameSlot ? "visible ttl" : "turn over";
  }
  if (durationExpired(stamp, now)) return "duration";
  return "concentration ended";
}

function resolveSource(doc: any): any {
  const flags = dndFlags(doc);
  const fromUuid = (globalThis as any).fromUuidSync;
  if (typeof fromUuid !== "function") return null;
  for (const uuid of [flags.origin, flags.item]) {
    if (!uuid) continue;
    try {
      const got = fromUuid(String(uuid), { strict: false });
      if (got) return got;
    } catch {
      /* an unloaded pack is not a reason to delete */
    }
  }
  return null;
}

/**
 * Placement time for an unstamped template. Synthesizing `at = Date.now()` every
 * poll made a player Lightning Bolt look zero seconds old forever, so it could
 * never become due. `_stats.createdTime` is the document's own clock.
 */
export function createdAtOf(doc: any, fallback: number): number {
  const t = Number(doc?._stats?.createdTime ?? doc?._source?._stats?.createdTime);
  return Number.isFinite(t) && t > 0 ? t : fallback;
}

export function lifetimeOf(doc: any, clock: ReturnType<typeof combatClockOf>, at: number): LifetimeStamp | null {
  const stamped = ourStamp(doc);
  if (stamped) return stamped;
  const placed = createdAtOf(doc, at);
  const source = resolveSource(doc);
  if (source) return stampFor(doc, source, clock, placed, worldTimeOf());
  return stampFor(doc, null, clock, placed);
}

function liveConcentration(): Set<string> {
  const live = new Set<string>();
  const actors = (globalThis as any).game?.actors ?? [];
  for (const actor of actors) addLiveFrom(actor, live);
  const tokens = (globalThis as any).canvas?.scene?.tokens ?? [];
  for (const token of tokens) {
    const actor = token?.actor;
    if (actor && !actors.find?.((a: any) => a === actor)) addLiveFrom(actor, live);
  }
  return live;
}

function addLiveFrom(actor: any, live: Set<string>): void {
  const effects = actor?.concentration?.effects ?? actor?.effects ?? [];
  const list = effects instanceof Set ? [...effects] : [...effects];
  for (const effect of list) {
    if (!isConcentratingEffect(effect)) continue;
    if (effect.uuid) live.add(String(effect.uuid));
    if (effect.origin) live.add(String(effect.origin));
    const item = effect.flags?.dnd5e?.item?.uuid ?? effect.flags?.dnd5e?.item?.id;
    if (item) live.add(String(item));
    const activity = effect.flags?.dnd5e?.activity?.uuid;
    if (activity) live.add(String(activity));
  }
}

export function isConcentratingEffect(effect: any): boolean {
  const statuses = effect?.statuses;
  const id =
    (globalThis as any).CONFIG?.specialStatusEffects?.CONCENTRATING ?? "concentrating";
  if (statuses && typeof statuses.has === "function") return statuses.has(id);
  return Array.from(statuses ?? []).includes(id);
}

function worldTimeOf(): number | undefined {
  const t = (globalThis as any).game?.time?.worldTime;
  return Number.isFinite(t) ? Number(t) : undefined;
}

function nowOf(): LifetimeNow {
  const combat = (globalThis as any).game?.combat;
  return {
    now: Date.now(),
    ...combatClockOf(combat),
    worldTime: worldTimeOf(),
    live: liveConcentration(),
  };
}

function templatesOnView(): any[] {
  const scene = (globalThis as any).canvas?.scene;
  const col = scene?.templates;
  if (!col) return [];
  if (typeof col.contents !== "undefined") return [...col.contents];
  return [...col];
}

function dueIds(now: LifetimeNow): { id: string; label: string; why: string }[] {
  const clock = {
    combatId: now.combatId,
    round: now.round,
    turn: now.turn,
    combatant: now.combatant,
  };
  const out: { id: string; label: string; why: string }[] = [];
  for (const doc of templatesOnView()) {
    if (!isAbilityTemplate(doc) && !ourStamp(doc)) continue;
    const stamp = lifetimeOf(doc, clock, now.now);
    if (!stamp || !isDue(stamp, now)) continue;
    const id = String(doc.id ?? "");
    if (!id) continue;
    out.push({
      id,
      label: String(doc.flags?.dnd5e?.item ?? doc.id ?? "?"),
      why: dueReason(stamp, now) ?? stamp.kind,
    });
  }
  return out;
}

async function noteHeldSeen(now: LifetimeNow): Promise<void> {
  if (!isPrimaryGM()) return;
  for (const doc of templatesOnView()) {
    const stamp = ourStamp(doc);
    if (!stamp?.concentrating || stamp.heldSeen) continue;
    if (!stillHeld(stamp, now.live)) continue;
    try {
      await doc.update?.({ [`flags.${MODULE_ID}.lifetime`]: { ...stamp, heldSeen: true } });
    } catch {
      /* a locked template is not a reason to drop the sweep */
    }
  }
}

function stampsForDue(due: { id: string; why: string }[]): LifetimeStamp[] {
  const out: LifetimeStamp[] = [];
  for (const row of due) {
    if (row.why !== "duration") continue;
    const doc = templatesOnView().find((t) => String(t.id) === row.id);
    const stamp = doc ? ourStamp(doc) : null;
    if (stamp) out.push(stamp);
  }
  return out;
}

async function endParents(stamps: LifetimeStamp[], now: LifetimeNow): Promise<void> {
  const seen = new Set<string>();
  for (const stamp of stamps) {
    if (!stamp.concentrating || !stamp.actor || seen.has(stamp.actor)) continue;
    seen.add(stamp.actor);
    try {
      await endMatchingConcentration(stamp, now);
    } catch (err) {
      log("templates: could not end the parent concentration:", err);
    }
  }
}

async function endMatchingConcentration(stamp: LifetimeStamp, _now: LifetimeNow): Promise<void> {
  const fromUuid = (globalThis as any).fromUuidSync;
  if (typeof fromUuid !== "function") return;
  const actor = fromUuid(String(stamp.actor), { strict: false });
  if (!actor?.endConcentration) return;
  const effects = actor.concentration?.effects;
  const list = effects instanceof Set ? [...effects] : [...(effects ?? [])];
  for (const effect of list) {
    if (!isConcentratingEffect(effect)) continue;
    const item = effect.flags?.dnd5e?.item?.uuid ?? effect.flags?.dnd5e?.item?.id;
    const origin = effect.origin ? String(effect.origin) : "";
    const match =
      (stamp.effect && effect.uuid === stamp.effect) ||
      (stamp.origin && origin === stamp.origin) ||
      (stamp.item && (item === stamp.item || origin === stamp.item));
    if (!match) continue;
    await actor.endConcentration(effect);
    return;
  }
}

async function sweep(): Promise<number> {
  if (!enabled() || !isPrimaryGM()) return 0;
  const now = nowOf();
  await noteHeldSeen(now);
  const due = dueIds(nowOf());
  if (!due.length) return 0;
  const parents = stampsForDue(due);
  const scene = (globalThis as any).canvas?.scene;
  try {
    await scene?.deleteEmbeddedDocuments?.("MeasuredTemplate", due.map((d) => d.id));
    await endParents(parents, now);
    log(`templates: removed ${due.length} leftover (${due.map((d) => d.why).join(", ")})`);
    return due.length;
  } catch (err) {
    log("templates: could not remove leftovers:", err);
    return 0;
  }
}

let poll: ReturnType<typeof setInterval> | undefined;
let sweepTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSweep(): void {
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => {
    sweepTimer = undefined;
    void sweep();
  }, 400);
}

function onPreCreate(doc: any): void {
  try {
    if (!enabled()) return;
    const stamp = stampFor(
      doc,
      resolveSource(doc),
      combatClockOf((globalThis as any).game?.combat),
      Date.now(),
      worldTimeOf(),
    );
    if (!stamp) return;
    doc.updateSource?.({ [`flags.${MODULE_ID}.lifetime`]: stamp });
  } catch (err) {
    log("templates: could not stamp a new template:", err);
  }
}

/**
 * Player-placed bolts often get `flags.dnd5e.origin` on a later update, so
 * preCreate sees a hand-drawn ruler and writes nothing. The GM then synthesizes
 * a stamp every poll with `at = now` and the line never expires.
 *
 * Stamp once, using the document's createdTime, so a leftover from last turn is
 * already due.
 */
async function adoptUnstamped(doc: any): Promise<void> {
  if (!enabled() || !isPrimaryGM()) return;
  if (ourStamp(doc)) return;
  if (!isAbilityTemplate(doc)) return;
  const at = createdAtOf(doc, Date.now());
  const stamp = stampFor(
    doc,
    resolveSource(doc),
    combatClockOf((globalThis as any).game?.combat),
    at,
    worldTimeOf(),
  );
  if (!stamp) return;
  try {
    await doc.update?.({ [`flags.${MODULE_ID}.lifetime`]: stamp });
  } catch {
    /* a locked template is not a reason to drop the sweep */
  }
}

async function convertAfterCombat(combat: any): Promise<void> {
  if (!enabled() || !isPrimaryGM() || !combat?.id) return;
  const endedRound = Number(combat.round);
  const nowMs = Date.now();
  const id = String(combat.id);
  for (const doc of templatesOnView()) {
    const stamp = ourStamp(doc);
    if (!stamp || stamp.combatId !== id) continue;
    const leftover = leftoverAfterCombat(stamp, endedRound, nowMs);
    if (leftover == null) continue;
    try {
      await doc.update?.({
        [`flags.${MODULE_ID}.lifetime`]: {
          ...stamp,
          untilMs: leftover,
          combatId: null,
          untilRound: null,
        },
      });
    } catch (err) {
      log("templates: could not convert leftover duration after combat:", err);
    }
  }
}

function onDeleteEffect(effect: any): void {
  try {
    if (!enabled() || !isPrimaryGM()) return;
    if (!isConcentratingEffect(effect)) return;
    scheduleSweep();
  } catch (err) {
    log("templates: concentration-end sweep failed:", err);
  }
}

/**
 * Stamp on the creating client so the flag travels with the document. Delete on the
 * primary GM — a MeasuredTemplate arrives on every client, and four deletes is three errors.
 */
export function registerTemplateLifetime(): void {
  Hooks.on("preCreateMeasuredTemplate", onPreCreate);
  Hooks.on("createMeasuredTemplate", (doc: any) => {
    void adoptUnstamped(doc);
    scheduleSweep();
  });
  Hooks.on("updateMeasuredTemplate", (doc: any) => {
    void adoptUnstamped(doc);
  });
  Hooks.on("updateCombat", (_combat: any, changed: any) => {
    if (!("turn" in (changed ?? {})) && !("round" in (changed ?? {}))) return;
    scheduleSweep();
  });
  Hooks.on("deleteCombat", (combat: any) => {
    void convertAfterCombat(combat);
    scheduleSweep();
  });
  Hooks.on("deleteActiveEffect", onDeleteEffect);
  Hooks.on("canvasReady", () => scheduleSweep());
  if ((globalThis as any).canvas?.ready) scheduleSweep();
  if (poll) clearInterval(poll);
  poll = setInterval(() => void sweep(), POLL_MS);
}

export function surveyTemplates(): { count: number; due: number; report: string } {
  const now = nowOf();
  const clock = {
    combatId: now.combatId,
    round: now.round,
    turn: now.turn,
    combatant: now.combatant,
  };
  const rows: string[] = [];
  let due = 0;
  for (const doc of templatesOnView()) {
    const stamp = lifetimeOf(doc, clock, now.now);
    const waiting = stamp ? isDue(stamp, now) : false;
    if (waiting) due += 1;
    const kind = stamp?.kind ?? (isAbilityTemplate(doc) ? "unstamped" : "hand-drawn");
    rows.push(
      `  ${waiting ? "DUE" : "keep"} ${kind}` +
        `${stamp?.concentrating ? " conc" : ""}` +
        `${stamp?.heldSeen ? " seen" : ""}` +
        ` ${String(doc.id ?? "?")}` +
        (stamp?.untilMs != null
          ? ` left ${Math.max(0, Math.round((stamp.untilMs - now.now) / 1000))}s`
          : stamp
            ? ` age ${Math.max(0, Math.round((now.now - stamp.at) / 1000))}s`
            : "") +
        (stamp?.untilRound != null ? ` until r${stamp.untilRound}` : ""),
    );
  }
  const lines = [
    `templates — ${enabled() ? "on" : "off"}  ${rows.length} on scene, ${due} due`,
    ...rows,
  ];
  const report = lines.join("\n");
  log(report);
  return { count: rows.length, due, report };
}
