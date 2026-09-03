// Weapon masteries that are not Push, Graze, or Nick. D&D 5e 2024 ONLY.
//
// `CONFIG.DND5E.weaponMasteries` is eight `{label, reference}` pairs. Nothing in the system
// executes any of them. Push lives in `dnd5e-forced-movement.ts`, Graze in `dnd5e-graze.ts`,
// Nick in `dnd5e-two-weapon.ts`. This file is the arithmetic and the closed list for the
// remaining five: Sap, Slow, Topple, Vex, Cleave.
//
// Authority on which mastery fired is `flags.dnd5e.roll.mastery` (see `masteryOf` in
// `rules/cards.ts`). A weapon can be mastered and the mastery declined on the dialog.
//
// THE TAG ON THE WEAPON IS NOT THE FEATURE. RAW: "This weapon has the following mastery
// property. To use this property, you must have a feature that lets you use it." Proficiency
// is not that feature. dnd5e's own `masteryOptions` getter (`data/item/weapon.mjs`) only
// offers the dialog when `traits.weaponProf.mastery.value` contains the weapon's
// `type.baseItem`. Nick already made that test; the other seven were reading the tag
// (or a leftover `flags.dnd5e.roll.mastery`) and applying it to anyone holding the item.
// `canUseWeaponMastery` is the one gate. Characters always need the list. NPCs whose
// sheet has no list at all are the 2024 MM encoding — mastery is printed on that attack
// and stored only on the item — so the native tag is their grant. An empty list is a
// stated "none", not a missing field.
//
// 2024 PHB Appendix D, read from the journal pages rather than from memory:
//   Sap    — hit → Disadvantage on its next attack before the start of YOUR next turn.
//   Slow   — hit AND deal damage → you CAN reduce Speed by 10 (does not stack past −10)
//            until the start of YOUR next turn.
//   Topple — hit → you CAN force a Con save, DC 8 + attack ability modifier + PB. Fail →
//            Prone. No size limit (Push has Large-or-smaller; Topple does not).
//   Vex    — hit AND deal damage → YOU have Advantage on your next attack against THAT
//            creature before the end of YOUR next turn.
//   Cleave — hit with a MELEE attack → you CAN make one melee attack vs a second creature
//            within 5 ft of the first that is also within your reach. On a hit, weapon
//            damage without the ability modifier unless that modifier is negative.
//            Once per turn.

export const HIT_MASTERIES = ["sap", "topple", "cleave"] as const;
export const DAMAGE_MASTERIES = ["slow", "vex"] as const;
export const AUTOMATED_MASTERIES = [...HIT_MASTERIES, ...DAMAGE_MASTERIES] as const;

export type HitMastery = (typeof HIT_MASTERIES)[number];
export type DamageMastery = (typeof DAMAGE_MASTERIES)[number];
export type AutomatedMastery = (typeof AUTOMATED_MASTERIES)[number];

const MOVEMENT_KEYS = ["walk", "fly", "swim", "climb", "burrow"] as const;

export function isAutomatedMastery(value: string): value is AutomatedMastery {
  return (AUTOMATED_MASTERIES as readonly string[]).includes(value);
}

export function isHitMastery(value: string): value is HitMastery {
  return (HIT_MASTERIES as readonly string[]).includes(value);
}

export function isDamageMastery(value: string): value is DamageMastery {
  return (DAMAGE_MASTERIES as readonly string[]).includes(value);
}

/**
 * Empty `attack.type` is melee — dnd5e fills it during prep and its weapon-type map omits
 * `natural`, so every claw and bite lands there. Only an explicit `"ranged"` is ranged.
 */
export function isMeleeAttack(activity: any, item?: any): boolean {
  const type = String(activity?.attack?.type?.value ?? activity?.attack?.type ?? "").toLowerCase();
  if (type === "ranged") return false;
  const itemType = String(item?.system?.actionType ?? "").toLowerCase();
  if (itemType === "rwak" || itemType === "rsak") return false;
  return true;
}

export function abilityKeyOf(activity: any, item?: any): string {
  const fromActivity = String(activity?.ability ?? "").trim().toLowerCase();
  if (fromActivity) return fromActivity;
  const fromItem = String(item?.system?.ability ?? "").trim().toLowerCase();
  return fromItem || "str";
}

export function abilityModOf(actor: any, activity: any, item?: any): number | null {
  const key = abilityKeyOf(activity, item);
  const mod = Number(actor?.system?.abilities?.[key]?.mod);
  return Number.isFinite(mod) ? Math.trunc(mod) : null;
}

export function proficiencyBonus(actor: any): number | null {
  const pb = Number(actor?.system?.attributes?.prof);
  return Number.isFinite(pb) ? Math.trunc(pb) : null;
}

/** DC 8 + attack ability modifier + PB. Unreadable either side is a refusal, not DC 8. */
export function toppleDc(abilityMod: number, pb: number): number | null {
  if (!Number.isFinite(abilityMod) || !Number.isFinite(pb)) return null;
  return 8 + Math.trunc(abilityMod) + Math.trunc(pb);
}

/**
 * How much to subtract from a Cleave extra-attack's rolled total.
 *
 * The rule drops the ability modifier unless it is negative, so a +4 Strength Greatsword
 * loses 4 and a −1 Strength Greatsword keeps the −1. Crits double dice, not the modifier,
 * so this is the undoubled number either way.
 */
export function cleaveDamageAdjustment(abilityMod: number): number {
  if (!Number.isFinite(abilityMod)) return 0;
  return Math.max(0, Math.trunc(abilityMod));
}

export function cleaveReach(activity: any, item: any, fallback = 5): number {
  const fromActivity = Number(activity?.range?.reach);
  if (Number.isFinite(fromActivity) && fromActivity > 0) return fromActivity;
  const fromItem = Number(item?.system?.range?.reach);
  if (Number.isFinite(fromItem) && fromItem > 0) return fromItem;
  return fallback;
}

/**
 * Movement keys Slow writes −10 onto.
 *
 * 2024 says "reduce its Speed by 10", which is every listed speed, not walk alone. The
 * compiler's `modify_speed` with an unset type only writes walk — do not copy that gap.
 * A creature with no readable positive speed still gets walk, so the AE is findable.
 */
export function movementKeysOf(actor: any): string[] {
  const movement = actor?.system?.attributes?.movement ?? {};
  const present = MOVEMENT_KEYS.filter((k) => Number(movement[k]) > 0);
  return present.length ? [...present] : ["walk"];
}

export function slowAmount(): number {
  return -10;
}

function hasKey(collection: unknown, key: string): boolean {
  if (!key) return false;
  if (collection instanceof Set) return collection.has(key);
  if (Array.isArray(collection)) return collection.map(String).includes(key);
  return false;
}

function isPlayerCharacter(actor: any): boolean {
  return String(actor?.type ?? "") === "character";
}

/**
 * May this creature use this mastery on this weapon?
 *
 * `claimed` is the property on the card or the item (`topple`, `vex`, …). The weapon's
 * own `system.mastery` is what they get from mastering the base item; `mastery.bonus`
 * is the Weapon Master extras, and those only apply on a weapon they already master —
 * the same pairing dnd5e's dialog uses. Fail closed: no actor, no base item, or an
 * unreadable list is a no.
 */
export function canUseWeaponMastery(actor: any, item: any, claimed: string): boolean {
  const key = String(claimed ?? "")
    .trim()
    .toLowerCase();
  if (!key || !actor) return false;
  const native = String(item?.system?.mastery ?? "")
    .trim()
    .toLowerCase();
  const base = String(item?.system?.type?.baseItem ?? "").trim();
  if (!base) return false;

  const pack = actor.system?.traits?.weaponProf?.mastery;
  const listed = pack?.value;
  if (isPlayerCharacter(actor) || listed != null) {
    if (!hasKey(listed, base)) return false;
    if (key === native) return true;
    return hasKey(pack?.bonus, key);
  }
  return key === native && Boolean(native);
}

/** The weapon's printed mastery, or "" if this wielder is not entitled to it. */
export function usableMastery(actor: any, item: any): string {
  const native = String(item?.system?.mastery ?? "")
    .trim()
    .toLowerCase();
  return canUseWeaponMastery(actor, item, native) ? native : "";
}
