// What a creature can actually DO, normalized across two very different data shapes.
//
// Why this file exists (bug found in play, 2026-08-03): every automated creature fell through to
// "calls out for help", because the planner asked each item for `system.actionType` and dnd5e v4+
// no longer has one. The 2024 system moved every doable thing into `item.system.activities` — a
// collection of typed activities, each with its own attack type, range, and uses. An archmage read as
// having no attacks whatsoever, so the only option left standing was the one that needs no equipment.
//
// The lesson worth keeping: a capability read that silently returns nothing looks exactly like a
// creature with nothing, and the planner faithfully played it that way. Reads that come back empty
// for EVERY item on EVERY creature are treated as suspicious now — see `readActions`, which logs it.
//
// Shapes handled:
//   - activities (dnd5e 4.x/5.x, 2024 rules): item.system.activities → per-activity type/attack/range
//   - legacy actionType (dnd5e 3.x and the many systems built in its image)
// Duck-typed rather than keyed on `game.system.id`, so anything that adopts either shape works.

import { log } from "../constants";
import { pick, pickNumber, pickString, systemPaths, type SystemPaths } from "./system-profiles";

/** What the planner needs to know about one thing a creature can do. */
export type ActionKind = "attack" | "control" | "heal" | "utility";

export interface CreatureAction {
  item: any;
  name: string;
  kind: ActionKind;
  melee: boolean;
  ranged: boolean;
  /** Effective reach or range in scene units. */
  range: number;
  /** False when charges, ammunition, spell slots, or quantity say it is spent. */
  available: boolean;
}

function gridDistance(): number {
  return Number((canvas as any)?.scene?.grid?.distance ?? 5) || 5;
}

/** Range in scene units from a `{ value, units }` pair, honouring the special non-numeric units. */
function rangeFrom(source: any, melee: boolean): number | null {
  if (!source) return null;
  const units = String(source.units ?? "").toLowerCase();
  if (units === "touch") return gridDistance();
  if (units === "self") return 0;
  const value = Number(source.value);
  if (!Number.isFinite(value)) return null;
  if (units === "mi") return value * 5280;
  return melee && value === 0 ? gridDistance() : value;
}

/** Item-level availability: quantity, an uncharged recharge feature, and item-wide uses. */
function itemAvailable(item: any, actor: any, P: SystemPaths): boolean {
  const quantity = pickNumber(item, P.itemQuantity);
  if (quantity !== null && quantity <= 0) return false;

  if (pickString(item, P.itemRechargeValue) && pick(item, P.itemRecharged) === false) return false;

  const max = pickNumber(item, P.itemUsesMax);
  if (max !== null && max > 0) {
    const spent = pickNumber(item, P.itemUsesSpent);
    const remaining = pickNumber(item, P.itemUses) ?? (spent !== null ? max - spent : null);
    if (remaining !== null && remaining <= 0) return false;
  }

  // A spell with no slot left is not castable, unless the creature casts it innately or at will.
  if (item?.type === "spell") {
    const level = Number(item?.system?.level ?? 0);
    const mode = String(
      item?.system?.preparation?.mode ?? item?.system?.method ?? "",
    ).toLowerCase();
    const alwaysOn = mode.includes("atwill") || mode.includes("innate") || mode.includes("pact");
    if (level > 0 && !alwaysOn) {
      const slot = actor?.system?.spells?.[`spell${level}`]?.value;
      if (typeof slot === "number" && slot <= 0) return false;
    }
  }
  return true;
}

/** Activity-level uses, which are tracked separately from the item's own. */
function activityAvailable(activity: any, actor: any): boolean {
  const max = Number(activity?.uses?.max);
  if (Number.isFinite(max) && max > 0) {
    const spent = Number(activity?.uses?.spent ?? 0);
    if (max - spent <= 0) return false;
  }

  // Ammunition: the empty-quiver case, which is the whole point of tracking any of this.
  for (const target of activity?.consumption?.targets ?? []) {
    if (String(target?.type ?? "") !== "ammunition") continue;
    const ammo = target?.target ? actor?.items?.get?.(target.target) : null;
    const quantity = Number(ammo?.system?.quantity);
    if (Number.isFinite(quantity) && quantity <= 0) return false;
  }
  return true;
}

function kindOfActivity(activity: any): ActionKind {
  switch (String(activity?.type ?? "")) {
    case "attack":
    case "damage":
      return "attack";
    case "save":
      // A fireball is a save that hurts; a hold person is a save that does not. The presence of
      // damage is the only distinction available without knowing what any spell means.
      return (activity?.damage?.parts?.length ?? 0) > 0 ? "attack" : "control";
    case "heal":
      return "heal";
    default:
      return "utility";
  }
}

function fromActivities(item: any, actor: any, P: SystemPaths): CreatureAction[] | null {
  const collection: any = item?.system?.activities;
  // No such field means this system (or this item type) predates activities — fall back. An EMPTY
  // collection still means activities-world, so we return [] rather than null: dropping through to
  // `system.actionType` there would hit dnd5e's deprecation shim and log a warning per item.
  if (collection === undefined || collection === null) return null;
  const list: any[] = collection.contents ?? (Array.isArray(collection) ? collection : []);

  const baseAvailable = itemAvailable(item, actor, P);
  const out: CreatureAction[] = [];
  for (const activity of list) {
    const kind = kindOfActivity(activity);
    if (kind === "utility") continue;

    const attackType = String(activity?.attack?.type?.value ?? "").toLowerCase();
    const melee = attackType === "melee";
    const ranged = attackType === "ranged";
    // The activity may override the item's range, or defer to it.
    const range =
      rangeFrom(activity?.range, melee) ??
      rangeFrom(item?.system?.range, melee) ??
      (melee ? gridDistance() : 30);

    out.push({
      item,
      name: String(activity?.name || item?.name || "?"),
      kind,
      melee,
      // A spell that is neither a melee nor a ranged *attack* still reaches across the room.
      ranged: ranged || (!melee && range > gridDistance()),
      range,
      available: baseAvailable && activityAvailable(activity, actor),
    });
  }
  return out;
}

const MELEE_TYPES = new Set(["mwak", "msak", "melee"]);
const RANGED_TYPES = new Set(["rwak", "rsak", "ranged"]);

function fromActionType(item: any, actor: any, P: SystemPaths): CreatureAction | null {
  const actionType = pickString(item, P.itemActionType).toLowerCase();
  if (!actionType) return null;

  const melee = MELEE_TYPES.has(actionType);
  const ranged = RANGED_TYPES.has(actionType);
  const kind: ActionKind =
    melee || ranged
      ? "attack"
      : actionType === "heal"
        ? "heal"
        : actionType === "save"
          ? "control"
          : "utility";
  if (kind === "utility") return null;

  const stated = pickNumber(item, P.itemRange);
  const range = stated ?? (melee ? gridDistance() : 30);

  let available = itemAvailable(item, actor, P);
  const ammoId = pickString(item, P.itemConsumeTarget);
  if (available && ammoId) {
    const ammo = actor?.items?.get?.(ammoId);
    const quantity = ammo ? pickNumber(ammo, P.itemQuantity) : null;
    if (quantity !== null && quantity <= 0) available = false;
  }

  return { item, name: String(item?.name ?? "?"), kind, melee, ranged, range, available };
}

/**
 * Everything this creature could do, from whichever data shape its system uses.
 *
 * A creature that genuinely has no actions is possible (a swarm of rats with only a lair effect), but
 * it is rare enough that finding none is worth a log line — that silence is exactly what hid the
 * activities migration for a whole release.
 */
export function readActions(actor: any): CreatureAction[] {
  const P = systemPaths();
  const out: CreatureAction[] = [];
  for (const item of actor?.items ?? []) {
    const viaActivities = fromActivities(item, actor, P);
    if (viaActivities) {
      out.push(...viaActivities);
      continue;
    }
    const legacy = fromActionType(item, actor, P);
    if (legacy) out.push(legacy);
  }
  if (out.length === 0 && (actor?.items?.size ?? 0) > 0) {
    log(
      `no readable actions on ${actor?.name} despite ${actor.items.size} items — check system paths`,
    );
  }
  return out;
}
