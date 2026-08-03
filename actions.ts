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
//
// Rewritten 2026-08-03 against the system's real behaviour rather than inference, after a second play
// test. Three findings drove it, and each had produced a visible symptom:
//
//  1. "Midi Attack" was NOT a bogus duplicate. midi-qol replaces the system's activity document
//     classes and, with its Activity Prefix setting on, an activity's name shows midi's localized TYPE
//     TITLE. So it was the creature's real attack all along, wearing a confusing label. Nothing to
//     skip — but names are now reported as "Mace (Midi Attack)" so this is never mistaken again.
//     What DOES need skipping is different and specific: `canUse === false`, riders, and midi's
//     `midiProperties.automationOnly` (activities that exist only for automation internals).
//  2. `activity.range.units` defaults to the string "self", and `range.override: false` means "this
//     activity states no range, use the item's". Reading that literally gave the Dire Wolf's Bite a
//     range of ZERO, so nothing was ever in reach and it could only bellow for help. Fixed at source.
//  3. An empty `attack.type.value` means "melee, weapon" — the system fills it in during preparation,
//     and natural weapons are deliberately absent from its weapon-type map so they always land there.
//     Treating empty as "not melee" mislabelled every natural attack a creature has.

import { log } from "../constants";
import { pick, pickNumber, pickString, systemPaths, type SystemPaths } from "./system-profiles";

/** What the planner needs to know about one thing a creature can do. */
export type ActionKind = "attack" | "control" | "heal" | "utility";

/**
 * Which slot of the action economy something costs.
 *
 * This is why the first play test had creatures able to spend a turn on a Parry: everything on the
 * sheet was treated as interchangeable, so reactions and legendary actions competed for the creature's
 * action like any other option.
 *
 * - `action` / `bonus` — the creature's own turn
 * - `free` — costs nothing worth modelling ("special" activations, passive-but-usable things)
 * - `reaction` / `legendary` — real, but OFF-turn; the layer that spends them does not exist yet
 * - `trigger` — fires on an event (turn start/end, entering an encounter), never chosen
 */
export type Economy = "action" | "bonus" | "free" | "reaction" | "legendary" | "trigger";

/** Activations measured in minutes or longer, or tied to a rest: not combat options at all. */
const OUT_OF_COMBAT = new Set([
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "year",
  "permanent",
  "shortrest",
  "longrest",
  "crew",
]);
/** midi-qol adds its own reaction flavours alongside the system's one. */
const REACTIONS = new Set(["reaction", "reactiondamage", "reactionmanual"]);
const OFF_TURN = new Set(["legendary", "mythic", "lair"]);
const TRIGGERS = new Set(["turnstart", "turnend", "encounter"]);

/**
 * Classify an activation type. Returns null for "not usable in a fight at all".
 *
 * Consults the system's own activation table where it exists, so an unrecognized key inherits the
 * system's `passive` metadata instead of a guess of ours. Everything unknown is assumed to cost an
 * action, which is the conservative reading: it competes fairly rather than being silently discarded.
 */
function economyOf(raw: unknown): Economy | null {
  const type = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (OUT_OF_COMBAT.has(type)) return null;
  if (type === "action") return "action";
  if (type === "bonus") return "bonus";
  if (REACTIONS.has(type)) return "reaction";
  if (OFF_TURN.has(type)) return "legendary";
  if (TRIGGERS.has(type)) return "trigger";
  if (type === "special") return "free";

  const table: any = (globalThis as any).CONFIG?.DND5E?.activityActivationTypes;
  // Match case-insensitively: the table is keyed in camelCase ("longRest") and we lowercased above.
  const entry = table
    ? Object.entries(table).find(([key]) => key.toLowerCase() === type)?.[1]
    : undefined;
  if ((entry as any)?.passive) return "free";
  return "action";
}

export interface CreatureAction {
  item: any;
  /** The specific activity on that item, where the system models them. Undefined on legacy shapes. */
  activity?: any;
  name: string;
  kind: ActionKind;
  economy: Economy;
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

/**
 * Range in scene units from a `{ value, units }` pair, honouring the special non-numeric units.
 *
 * Returns null for "this pair says nothing", which the caller must distinguish from zero. `Number(null)`
 * is 0 and passes `isFinite`, so an unset range read as a legitimate reach of zero — and every activity
 * with a blank range became unusable at any distance. (Fixed 2026-08-03.)
 */
function rangeFrom(source: any, melee: boolean): number | null {
  if (!source) return null;
  const units = String(source.units ?? "").toLowerCase();
  if (units === "touch") return gridDistance();
  // "self" is the schema's INITIAL value for units, not an assertion — an activity nobody configured a
  // range on reads as self. Treating that as a reach of zero is what left the Dire Wolf unable to bite
  // anything. "spec" ("see the description") is equally uninformative; "any" is unlimited.
  if (units === "self" || units === "spec") return null;
  if (units === "any") return Number.POSITIVE_INFINITY;
  const raw = source.value;
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  // The distance units the system recognizes. Scenes are almost always in feet, so metric ranges are
  // converted rather than taken at face value.
  const multiplier = units === "mi" ? 5280 : units === "m" ? 3.281 : units === "km" ? 3281 : 1;
  const scaled = value * multiplier;
  return melee && scaled === 0 ? gridDistance() : scaled;
}

/**
 * Reach of a melee attack when nothing states one.
 *
 * The system's own fallback: a weapon's `system.range.reach` when set, otherwise 5 feet expressed in
 * the scene's units. A published Dire Wolf states neither, and its bite is a 5 ft bite.
 */
function meleeReachOf(item: any): number {
  const reach = Number(item?.system?.range?.reach);
  if (Number.isFinite(reach) && reach > 0) return reach;
  return gridDistance();
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

  if (item?.type === "spell" && !spellSlotAvailable(item, actor)) return false;
  return true;
}

/**
 * Can this spell still be cast?
 *
 * Only some casting methods spend a slot. Rather than hardcode which ("atwill and innate are free,
 * pact and spell are not"), ask the system: each entry in its spellcasting table declares whether it
 * draws on slots, so a module that adds a method is handled for free.
 *
 * Note `system.prepared` is deliberately NOT consulted. It is a number now (0/1/2), and the system
 * never prepared-filters NPCs — every spell on a monster's sheet is one it can cast.
 */
function spellSlotAvailable(item: any, actor: any): boolean {
  const level = Number(item?.system?.level ?? 0);
  if (!(level > 0)) return true;

  // dnd5e 5.1 renamed `preparation.mode` to `method`, keeping the old name as a deprecation shim that
  // logs on every read — which our own console output caught us doing three times per turn. Read the
  // new field, then the raw source (which bypasses the shim), never the shim itself.
  const method = String(
    item?.system?.method ?? item?._source?.system?.preparation?.mode ?? "",
  ).toLowerCase();

  const table: any = (globalThis as any).CONFIG?.DND5E?.spellcasting;
  const model = table
    ? Object.entries(table).find(([key]) => key.toLowerCase() === method)?.[1]
    : undefined;
  const spendsSlot = model
    ? Boolean((model as any).slots)
    : // No table to consult: fall back to naming the two methods that are free.
      !(method.includes("atwill") || method.includes("innate"));
  if (!spendsSlot) return true;

  const pool =
    method === "pact"
      ? actor?.system?.spells?.pact?.value
      : actor?.system?.spells?.[`spell${level}`]?.value;
  return !(typeof pool === "number" && pool <= 0);
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

/**
 * Is this activity something a creature can be told to do?
 *
 * These are the system's and midi's own tests, not heuristics of ours:
 *   - `canUse === false` covers unmet attunement, unidentified items, and level windows.
 *   - a "rider" is a dependent piece of another activity, never used on its own.
 *   - `midiProperties.automationOnly` is midi's explicit "for automation internals, not for humans".
 *
 * Worth noting: Argon's dnd5e implementation checks none of these, so its buttons can surface
 * automation-only activities. We check them because an automated creature has no human to notice.
 */
function usableActivity(activity: any): boolean {
  if (activity?.canUse === false) return false;
  if (activity?.isRider === true) return false;
  if (activity?.midiProperties?.automationOnly === true) return false;
  return true;
}

/**
 * Classify by what the activity CARRIES rather than what it is called.
 *
 * Duck-typing matters here: with midi-qol configured to add its own activity types instead of replacing
 * the system's classes, the same capability arrives as `midiAttack` rather than `attack`. Matching the
 * type string alone would silently drop every attack on every sheet in that configuration — the exact
 * class of failure that cost the first two releases.
 */
function kindOfActivity(activity: any): ActionKind {
  const type = String(activity?.type ?? "").toLowerCase();
  const damaging = (activity?.damage?.parts?.length ?? 0) > 0;

  if (type.includes("attack") || activity?.attack?.type) return "attack";
  if (type.includes("heal") || activity?.healing) return "heal";
  if (type.includes("save") || activity?.save?.ability) {
    // A fireball is a save that hurts; a hold person is a save that does not. The presence of damage is
    // the only distinction available without knowing what any particular spell means.
    return damaging ? "attack" : "control";
  }
  if (type.includes("damage") || damaging) return "attack";
  return "utility";
}

/**
 * The spell behind a feat's "cast" activity.
 *
 * The dominant shape for limited casting on 2024 monster sheets: the Archmage's Misty Step is a FEAT
 * whose activity is `type: "cast"` with the uses on the feat and a pointer to the real spell. Reading
 * only the feat tells us nothing about what the spell does, so we resolve it — preferring the cached
 * clone the system creates on first use, then a synchronous UUID lookup.
 *
 * Returns null when the spell cannot be resolved without awaiting, in which case the activity is left
 * out rather than guessed at.
 */
function castSpellOf(activity: any): any {
  if (String(activity?.type ?? "").toLowerCase() !== "cast") return null;
  const cached = activity?.cachedSpell;
  if (cached) return cached;
  const uuid = activity?.spell?.uuid;
  if (!uuid) return null;
  try {
    const sync = (foundry as any)?.utils?.fromUuidSync ?? (globalThis as any).fromUuidSync;
    // A pack that isn't loaded yields an index stub with no `system`, which is no use to us.
    const doc = typeof sync === "function" ? sync(uuid) : null;
    return doc?.system?.activities ? doc : null;
  } catch {
    return null;
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
    if (!usableActivity(activity)) continue;

    // A feat that casts a spell describes nothing itself: what it does lives on the spell. Read the
    // spell for the SHAPE (attack or control, and how far), but keep the cast activity as the thing to
    // invoke, because that is where the feat's limited uses are enforced.
    const spell = castSpellOf(activity);
    const shapeSource = spell
      ? ((spell.system.activities?.contents ?? []) as any[]).find(
          (a) => kindOfActivity(a) !== "utility",
        )
      : activity;
    if (!shapeSource) continue;

    const kind = kindOfActivity(shapeSource);
    if (kind === "utility") continue;

    const economy = economyOf(activity?.activation?.type ?? pick(item, P.itemActivation));
    // A ten-minute ritual is not something to do while being bitten; a trigger is not a choice.
    if (economy === null || economy === "trigger") continue;

    // An empty attack type is not "unknown" — the system resolves it to melee/weapon during data
    // preparation, and its weapon-type map deliberately omits natural weapons so that every claw and
    // bite lands there. Only an explicit "ranged" makes something ranged.
    const attackType = String(shapeSource?.attack?.type?.value ?? "").toLowerCase();
    const declaredRanged = attackType === "ranged";

    // Precedence: the activity's own range only when it overrides, then the item's, then the system's
    // own melee fallback. `override === false` means "this activity states no range" — reading its
    // placeholder `units: "self"` as a real value is what gave the Dire Wolf a reach of zero.
    const stated =
      activity?.range?.override === false ? null : rangeFrom(shapeSource?.range, !declaredRanged);
    const range =
      stated ??
      rangeFrom(item?.system?.range, !declaredRanged) ??
      (declaredRanged ? 30 : meleeReachOf(item));

    // Anything that reaches further than this creature's own arm is used at range, whatever it is
    // called: that is the distinction the planner cares about when deciding where to stand.
    const armsLength = Math.max(gridDistance(), meleeReachOf(item));
    const ranged = declaredRanged || range > armsLength;

    // Both names when they differ. "attacks with Midi Attack" told us nothing about which item it came
    // from — and that name is midi's localized TYPE TITLE, not a real activity name.
    const activityName = String(activity?.name ?? "").trim();
    const itemName = String(item?.name ?? "?").trim();
    out.push({
      item,
      activity,
      name: activityName && activityName !== itemName ? `${itemName} (${activityName})` : itemName,
      kind,
      economy,
      melee: !ranged,
      ranged,
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

  const economy = economyOf(pick(item, P.itemActivation));
  if (economy === null) return null;

  const stated = pickNumber(item, P.itemRange);
  // Ranged types keep a nominal 30 ft when the sheet is silent, because on this older shape the
  // action type itself is the assertion that it shoots. Melee falls back to arm's length.
  const range = stated ?? (ranged ? 30 : gridDistance());

  let available = itemAvailable(item, actor, P);
  const ammoId = pickString(item, P.itemConsumeTarget);
  if (available && ammoId) {
    const ammo = actor?.items?.get?.(ammoId);
    const quantity = ammo ? pickNumber(ammo, P.itemQuantity) : null;
    if (quantity !== null && quantity <= 0) available = false;
  }

  return { item, name: String(item?.name ?? "?"), kind, economy, melee, ranged, range, available };
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
    // A spell the system cloned onto the actor to service a feat's "cast" activity. We enumerate the
    // cast activity itself (which is where the feat's limited uses live), so counting the clone as well
    // would offer the same ability twice — once with the wrong resource attached.
    if (item?.flags?.dnd5e?.cachedFor) continue;

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
