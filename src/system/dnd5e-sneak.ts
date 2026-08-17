// Sneak Attack: reading the rule off the sheet. D&D 5e ONLY.
//
// "Once per turn, you can deal an extra 1d6 damage to one creature you hit with an attack roll if you
// have Advantage on the roll and the attack uses a Finesse or a Ranged weapon. The extra damage's type
// is the same as the weapon's type. You don't need Advantage on the attack roll if at least one of your
// allies is within 5 feet of the target, the ally doesn't have the Incapacitated condition, and you
// don't have Disadvantage on the attack roll." (PHB 2024, Rogue.)
//
// WHY THIS NEEDS US AT ALL, given that dnd5e ships the feature with a working damage activity. The
// button exists and nobody presses it. That is the same finding as the damage tray, the concentration
// save and the legendary resistance: the system models the mechanic and waits for a human, and the
// human is mid-conversation. What is different here is that the CONDITIONS are the interesting part —
// Advantage, or an ally beside the target, and a Finesse or Ranged weapon — and none of them is checked
// by anything, so the button is equally pressable on a turn where the rogue has not earned it.
//
// THE 2024 ALLY CLAUSE IS NOT THE 2014 ONE. 2014 said "another ENEMY OF THE TARGET is within 5 feet of
// it"; 2024 says "at least one of YOUR ALLIES". A goblin flanking with another goblin against a
// character no longer qualifies its neighbour, and neither does a charmed creature the party is not
// allied with. Disposition is the reading available, so an ally is a token sharing the attacker's
// disposition — see `alliesBeside` for what that costs.
//
// WHAT IS DELIBERATELY NOT MODELLED. Cunning Strike (2024 spends Sneak Attack dice on riders), the
// Assassin's automatic critical, and any subclass that changes the damage type. All of them are
// decisions made after "yes, Sneak Attack" and belong to whoever pressed the button.

import { isDnd5e } from "./dnd5e-rewards";
import { isIncapacitated } from "./dnd5e-conditions";
import { weaponDamageType } from "./dnd5e-damage";
import { partFormula } from "../capability/duplicate";
import { separation } from "../rules/unseen";
import { moduleActive } from "../util/modules";

/** How far an ally may stand from the target and still qualify, in scene units. */
export const ALLY_REACH = 5;

/** The rule as it applies to one swing. */
export interface SneakReading {
  /** May this attack carry Sneak Attack damage? */
  eligible: boolean;
  /** Why not, in one clause, for the survey and the debug line. Empty when eligible. */
  reason: string;
  /** The formula to roll. Present only when eligible. */
  formula: string;
  /** The weapon's damage type, or "" when unreadable (which `applyDamage` treats as untyped). */
  damageType: string;
  /** Which clause qualified it, for the prompt body. */
  because: "advantage" | "ally" | "";
}

/** Is this the Sneak Attack feature? Identifier first, name only on a feat — the usual asymmetry. */
export function isSneakFeature(item: any): boolean {
  if (!item) return false;
  const id = String(item.system?.identifier ?? "");
  if (id) return id === "sneak-attack";
  if (String(item.type) !== "feat") return false;
  return /sneak\s*attack/i.test(String(item.name ?? ""));
}

/** The creature's Sneak Attack feature, or null. */
export function sneakFeature(actor: any): any {
  if (!isDnd5e() || !actor) return null;
  for (const item of actor.items ?? []) {
    if (isSneakFeature(item)) return item;
  }
  return null;
}

/**
 * Could Chris's Premades be automating Sneak Attack anywhere in this world?
 *
 * The module-wide half, for the settings badge, which has no creature in hand. Deliberately weaker than
 * `cprAutomatesSneak` and the note beside it says so: the real answer is per rogue.
 */
export function cprMaySneak(): boolean {
  return moduleActive("chris-premades") && moduleActive("midi-qol");
}

/**
 * Does Chris's Premades already automate THIS creature's Sneak Attack?
 *
 * Per-item rather than per-module, the same shape as `alreadyAutomated()` in `rules/forced.ts`, because
 * that is how CPR works: `sneakAttack.mjs` is a `roll` macro on the `actorDamageRollBonuses` pass, bound
 * to the feature by CPR's own flags, so a world may run CPR with a dozen automated items and a rogue
 * whose Sneak Attack it never touched. Standing aside module-wide would leave that rogue with nothing.
 *
 * Midi is required as well because every step of theirs goes through a Midi workflow —
 * `workflow.hitTargets`, `workflowUtils.bonusDamage` — so with midi absent their macro cannot fire at
 * all, and deferring to an inert automation would be the failure the ownership resolver exists to
 * prevent. Same conjunction, same reasoning, as `gambitsOwnsBarbs`.
 *
 * Note that this is NOT covered by the midi damage stand-aside. CPR's macro adds bonus damage to midi's
 * own damage roll, which happens whether or not `autoApplyDamage` is on — so a table running midi at
 * stock settings has our damage layer live AND theirs claiming Sneak Attack, which is precisely the
 * double-ask this guard exists for.
 */
export function cprAutomatesSneak(feature: any): boolean {
  if (!feature || !cprMaySneak()) return false;
  if (feature.flags?.["chris-premades"]?.info?.identifier) return true;
  for (const activity of feature.system?.activities ?? []) {
    if (activity?.flags?.cat?.macros) return true;
  }
  return false;
}

/**
 * The dice, as a formula ready to hand to `Roll`.
 *
 * The FEATURE'S OWN damage part is read first and the class scale is the fallback, and that order is the
 * whole reason this reads a sheet rather than a rulebook. The stock 2024 item carries
 * `@scale.rogue.sneak-attack`, which is the right answer for a rogue of any level and for a multiclass;
 * a homebrew or imported copy carries whatever its author wrote, and that is equally the right answer
 * because it is what the table decided. Fourteen NPCs in the reference world carry literal dice.
 *
 * The scale fallback exists for the case that produced this work: an item whose damage activity has been
 * hollowed out to a Utility, leaving the description and no dice. `@scale.<class>.sneak-attack` resolves
 * through the actor's own roll data, so it is still the sheet answering.
 */
export function sneakFormula(actor: any, item: any): string {
  for (const activity of item?.system?.activities ?? []) {
    for (const part of activity?.damage?.parts ?? []) {
      const formula = partFormula(part);
      if (formula) return formula;
    }
  }

  // No dice on the feature. Ask the class scale directly, by whichever class identifier holds one —
  // never assume "rogue", because a homebrew class or a translated identifier would silently roll
  // nothing and the failure would look like the offer being broken.
  const scale = actor?.getRollData?.()?.scale ?? {};
  for (const key of Object.keys(scale)) {
    const value = scale[key]?.["sneak-attack"];
    const text = value === undefined || value === null ? "" : String(value);
    if (text && text !== "[object Object]") return `@scale.${key}.sneak-attack`;
  }
  return "";
}

/**
 * Does the attack use a Finesse or a Ranged weapon?
 *
 * A POSITIVE reading is required, and that is the one place this errs strict rather than generous. The
 * generous direction would offer Sneak Attack on a maul whenever the properties could not be read, and a
 * prompt that appears on every swing is a prompt that gets clicked through — at which point the rogue is
 * dealing damage they did not earn and nothing says so. A refusal is quiet and is reported by
 * `api.surveySneak()`, which is the honest place for it.
 */
export function qualifyingWeapon(item: any, activity: any): boolean {
  if (String(item?.type) !== "weapon") return false;

  const properties = item?.system?.properties;
  const has = (p: string) =>
    properties instanceof Set
      ? properties.has(p)
      : Array.isArray(properties)
        ? properties.includes(p)
        : Boolean(properties?.has?.(p));
  if (has("fin")) return true;

  // Ranged by the weapon's own classification, or by the activity's attack type where a weapon can be
  // thrown or fired either way.
  if (/R$/.test(String(item?.system?.type?.value ?? ""))) return true;
  return String(activity?.attack?.type?.value ?? "") === "ranged";
}

/**
 * Advantage, Disadvantage or neither, read off the roll that was actually made.
 *
 * `options.advantageMode` is set during evaluation (`d20-roll.mjs:216-220`) and travels with the roll's
 * serialized options, so it survives arriving on another client — which matters, because the creature
 * being asked about is often not the one whose browser rolled. `hasAdvantage` is preferred where the
 * roll deserialized as a `D20Roll`; the raw mode is the fallback for anything that did not.
 */
export function advantageOf(message: any): -1 | 0 | 1 {
  const roll = message?.rolls?.[0];
  if (!roll) return 0;
  if (roll.hasAdvantage === true) return 1;
  if (roll.hasDisadvantage === true) return -1;
  const mode = Number(roll.options?.advantageMode);
  if (mode === 1) return 1;
  if (mode === -1) return -1;
  return 0;
}

/**
 * Is one of the attacker's allies standing beside the target, conscious?
 *
 * DISPOSITION IS THE READING, AND IT IS AN APPROXIMATION WITH A KNOWN SHAPE. Foundry has no concept of
 * an alliance; it has three dispositions and a secret one. So a party member is an ally of the rogue,
 * a second goblin is an ally of the first goblin, and a charmed ogre fighting beside the party is not
 * anyone's ally because its token is still Hostile. That last case is the one a GM will notice, and it
 * errs toward refusing the bonus, which is the recoverable direction — the GM can flip the disposition
 * or the player can take Advantage some other way.
 *
 * The attacker is excluded from its own ally list, and so is the target: a creature does not qualify
 * itself, and a Hostile target beside a Hostile attacker is not "your ally" in any reading of the
 * sentence. Neither exclusion is hypothetical on a table where a rogue's own summons share its
 * disposition.
 *
 * Chris's Premades reads this as `findNearby(target, 5, {disposition: 'enemy'})` — an enemy OF THE
 * TARGET, which is the 2014 wording their macro is nonetheless labelled `rules: '2024'` for. The two
 * agree on every ordinary fight and part company on a charmed creature: theirs qualifies it, ours does
 * not. We keep the printed 2024 sentence.
 */
export function alliesBeside(attackerToken: any, targetToken: any): any[] {
  if (!attackerToken || !targetToken) return [];
  const mine = Number((attackerToken.document ?? attackerToken)?.disposition ?? 0);
  const defeated = (globalThis as any).CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";

  const out: any[] = [];
  for (const other of (globalThis as any).canvas?.tokens?.placeables ?? []) {
    if (!other?.actor) continue;
    if (String(other.id) === String(attackerToken.id)) continue;
    if (String(other.id) === String(targetToken.id)) continue;
    if (Number(other.document?.disposition) !== mine) continue;
    try {
      if (other.document?.hasStatusEffect?.(defeated)) continue;
    } catch {
      /* an unreadable status is not a reason to discount an ally */
    }
    if (isIncapacitated(other.actor)) continue;
    if (separation(targetToken, other) > ALLY_REACH + 0.01) continue;
    out.push(other);
  }
  return out;
}

/** Everything the rule needs about one hit. */
export interface SneakInput {
  attackerToken: any;
  targetToken: any;
  item: any;
  activity: any;
  message: any;
}

/**
 * The whole rule, in the order the sentence states it.
 *
 * Weapon first because it is a property of the swing and cheap; the ally search is a canvas walk and is
 * only reached when Advantage did not already answer it.
 */
export function readSneak(input: SneakInput): SneakReading {
  const no = (reason: string): SneakReading => ({
    eligible: false,
    reason,
    formula: "",
    damageType: "",
    because: "",
  });

  const actor = input.attackerToken?.actor;
  const feature = sneakFeature(actor);
  if (!feature) return no("no Sneak Attack feature");
  if (!qualifyingWeapon(input.item, input.activity)) return no("not a Finesse or Ranged weapon");

  const advantage = advantageOf(input.message);
  let because: "advantage" | "ally" | "" = "";
  if (advantage === 1) because = "advantage";
  else if (advantage === -1) return no("the attack roll had Disadvantage");
  else if (alliesBeside(input.attackerToken, input.targetToken).length > 0) because = "ally";
  else return no("no Advantage and no ally within 5 feet of the target");

  const formula = sneakFormula(actor, feature);
  if (!formula) return no("the feature states no dice and the class scale has none");

  return {
    eligible: true,
    reason: "",
    formula,
    damageType: weaponDamageType(input.activity, input.item),
    because,
  };
}
