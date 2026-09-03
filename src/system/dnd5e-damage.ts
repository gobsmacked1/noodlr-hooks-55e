// Applying damage the way dnd5e applies it.
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


/** Hit points as they stood before we touched them, and enough to put them back. */
export interface HpSnapshot {
  actorUuid: string;
  value: number;
  temp: number;
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

/**
 * "The same type dealt by the weapon."
 *
 * Here rather than beside either of its callers because two rules now need it — Graze deals the ability
 * modifier "of the same type dealt by the weapon", and Sneak Attack's extra dice are the weapon's type
 * too — and a second copy of this reading is the divergence this repo keeps finding.
 *
 * The activity's first damage part is the answer, and `types` is a Set because a weapon may offer a choice
 * (a trident dealing piercing, a versatile club, a magic weapon offering its own type). Where there is a
 * choice we take the first rather than asking: a prompt for the damage type of a 3-point graze is worse
 * than being occasionally wrong about which of two physical types it was.
 *
 * An unreadable type is "" rather than a guess. `Actor5e#applyDamage` treats an unknown type as untyped,
 * which is the correct failure — it skips resistance rather than inventing an immunity.
 */
export function weaponDamageType(activity: any, item: any): string {
  const parts = activity?.damage?.parts ?? [];
  for (const part of parts) {
    const types = part?.types;
    const first = types?.first?.() ?? (types instanceof Set ? [...types][0] : undefined);
    if (first) return String(first);
  }
  const fallback = item?.system?.damage?.base?.types;
  const one = fallback?.first?.() ?? (fallback instanceof Set ? [...fallback][0] : undefined);
  return one ? String(one) : "";
}
