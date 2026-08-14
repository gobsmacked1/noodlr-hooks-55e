// Applying damage the way dnd5e applies it, and knowing when to let midi do it instead.
//
// Everything that knows a dnd5e path or method name lives here rather than in `rules/damage.ts`, which
// is the same fence `dnd5e-dying.ts` and `dnd5e-concentration.ts` sit behind: a second game system
// replaces this file and nothing else.
//
// The one rule that matters here: WE DO NOT COMPUTE DAMAGE. `Actor5e#applyDamage` already resolves
// resistance, vulnerability, immunity, physical-damage properties, temporary hit points and the
// hit-point floor, and it fires `dnd5e.preApplyDamage` / `dnd5e.applyDamage` so anything else at the
// table gets its say. Halving a value ourselves would be a second, worse implementation of arithmetic
// the system already owns — and it would be invisible, because a wrong number looks exactly like a
// right one. Our job is to decide WHO takes the roll and to press the button.

import { isDnd5e } from "./dnd5e-rewards";
import { midiConfig, midiOn } from "../util/modules";

/** Hit points as they stood before we touched them, and enough to put them back. */
export interface HpSnapshot {
  actorUuid: string;
  value: number;
  temp: number;
}

/**
 * Is midi applying damage itself?
 *
 * `autoApplyDamage` is the switch, and it defaults to `"none"` — so on a stock midi install this is
 * false and we still do the work, which is correct: a table that installed midi and left it alone is a
 * table where nothing applies damage. Its non-`none` values distinguish whether saves and the tray are
 * shown, and all of them mean midi writes the hit points.
 *
 * Read through `midiConfig()` (the live object, not the stored setting) for the reason that helper
 * exists: a GM who changed the switch without reloading has a stale stored value.
 */
export function midiOwnsDamage(): boolean {
  if (!isDnd5e()) return false;
  const settings = midiConfig();
  if (!settings) return false;
  return midiOn(settings.autoApplyDamage);
}

/**
 * Is midi deciding what saving throws were worth?
 *
 * `autoCheckSaves` is the switch and it also defaults to `"none"`, so a stock install decides nothing and
 * we do the work. When it is on, midi rolls the saves, compares them and writes `failedSaveUuids` to its
 * card — a real verdict rather than a reconstruction of one — and our own save layer stands down whole,
 * because two answers to "did that creature save" is a race whichever of them is right.
 *
 * Separate from `midiOwnsDamage` on purpose: they are separate settings and either can be on alone. A
 * table with saves checked and damage on manual wants midi's verdict and our button-free application, and
 * conflating the two would give it neither.
 */
export function midiOwnsSaves(): boolean {
  if (!isDnd5e()) return false;
  const settings = midiConfig();
  if (!settings) return false;
  return midiOn(settings.autoCheckSaves);
}

/** The hit-point object dnd5e keeps, or null when the sheet has none (a vehicle, a group). */
function hpOf(actor: any): any {
  return actor?.system?.attributes?.hp ?? null;
}

export function snapshotHp(actor: any): HpSnapshot | null {
  const hp = hpOf(actor);
  const uuid = String(actor?.uuid ?? "");
  if (!hp || !uuid || typeof hp.value !== "number") return null;
  return { actorUuid: uuid, value: Number(hp.value), temp: Number(hp.temp ?? 0) };
}

/**
 * Put a creature's hit points back exactly as they were.
 *
 * Deliberately a plain `update` of the two fields rather than an inverse `applyDamage`: applying the
 * negative of what we applied would run the resistance arithmetic a second time and land somewhere else
 * entirely for anything resistant, and it would fire the damage hooks again on the way. Restoring the
 * recorded numbers cannot drift.
 *
 * It CAN overwrite something that happened afterwards — a heal between the hit and the undo — which is
 * why undo is offered on the card that reported the damage and not as a general "reverse the last
 * thing" command. It reads as "put this back", and that is what it does.
 */
export async function restoreHp(snapshot: HpSnapshot): Promise<boolean> {
  try {
    const actor: any = await (globalThis as any).fromUuid?.(snapshot.actorUuid);
    if (!actor) return false;
    await actor.update({
      "system.attributes.hp.value": snapshot.value,
      "system.attributes.hp.temp": snapshot.temp,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand the rolled damage to the system.
 *
 * `isDelta: true` matches what the damage tray passes, and `originatingMessage` is what lets dnd5e tell
 * healing from damage and lets anything listening find the roll. `multiplier` is how the system expresses
 * a halved save and a critical's double — never by us re-rolling or re-adding anything.
 */
export async function applyDamageTo(
  actor: any,
  parts: unknown[],
  message: any,
  multiplier = 1,
): Promise<void> {
  await actor.applyDamage(parts, { multiplier, isDelta: true, originatingMessage: message });
}

/** Does this sheet have hit points we can move at all? */
export function hasHitPoints(actor: any): boolean {
  return typeof hpOf(actor)?.value === "number";
}
