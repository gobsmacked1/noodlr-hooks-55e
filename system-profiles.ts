// Where each game system keeps the numbers we need, expressed as data rather than branches.
//
// Reading a creature's sheet inevitably touches system-specific shapes: dnd5e keeps ability scores at
// `system.abilities.int.value`, pf2e at `system.abilities.int.mod`, and a homebrew system may keep
// them somewhere else entirely. That is not the same as encoding rules — we never learn what an
// ability score MEANS, only where the number lives — but it does need a place to live that isn't a
// pile of `if (game.system.id === ...)`.
//
// Every field is a list of candidate paths tried in order, so an unknown system usually still works:
// most Foundry systems borrow dnd5e's layout closely enough for the generic candidates to hit. A
// system with a real profile just gets its own candidates tried first. Anything that misses is
// omitted from the dossier rather than guessed at — a wrong number is worse than a missing one.

/** Read a dotted path off an object, tolerating missing links. */
export function readPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** First candidate path that yields something usable. */
export function pick(obj: unknown, paths: string[]): unknown {
  for (const p of paths) {
    const v = readPath(obj, p);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

export function pickNumber(obj: unknown, paths: string[]): number | null {
  const v = pick(obj, paths);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function pickString(obj: unknown, paths: string[]): string {
  const v = pick(obj, paths);
  return typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
}

export interface SystemPaths {
  /** Ability scores, keyed by the system's own short keys (int/wis here). */
  intelligence: string[];
  wisdom: string[];
  hpValue: string[];
  hpMax: string[];
  armor: string[];
  /** Primary land speed, plus any alternate movement modes worth naming. */
  speed: string[];
  speedUnits: string[];
  altSpeeds: string[];
  senses: string[];
  challenge: string[];
  /** Free-text alignment, read only to decide whether a creature is the merciful sort. */
  alignment: string[];
  /** Legendary action / resistance pools, when the system models them. */
  legendaryActions: string[];
  legendaryResistances: string[];
  /** Per-item fields. */
  itemActivation: string[];
  itemActivationLabel: string[];
  /** Coarse kind of thing an item does (dnd5e: mwak/rwak/msak/rsak/save/heal/util). */
  itemActionType: string[];
  itemUses: string[];
  /** Some systems (dnd5e 4.x) store uses as a SPENT count; remaining = max - spent. */
  itemUsesSpent: string[];
  itemUsesMax: string[];
  itemQuantity: string[];
  itemRangeLabel: string[];
  itemRange: string[];
  itemRangeUnits: string[];
  itemDamageLabel: string[];
  itemSpellLevel: string[];
  itemPrepared: string[];
  /** Ammunition consumption: which item id is spent, if any. */
  itemConsumeTarget: string[];
  itemConsumeType: string[];
  /** Recharge state: whether a "recharge 5-6" style feature is currently available. */
  itemRechargeValue: string[];
  itemRecharged: string[];
  /** Whether an item is a reaction, a legendary action, and so on. */
  itemActivationCost: string[];
}

// Candidates that work across the many systems built in dnd5e's image. Tried after a matching
// profile's own candidates, so a profile only has to list its exceptions.
const GENERIC: SystemPaths = {
  intelligence: ["system.abilities.int.value", "system.abilities.int.mod", "system.abilities.int"],
  wisdom: ["system.abilities.wis.value", "system.abilities.wis.mod", "system.abilities.wis"],
  hpValue: ["system.attributes.hp.value", "system.hp.value", "system.health.value"],
  hpMax: ["system.attributes.hp.max", "system.hp.max", "system.health.max"],
  armor: ["system.attributes.ac.value", "system.armorClass.value", "system.ac.value"],
  speed: ["system.attributes.movement.walk", "system.attributes.speed.value", "system.speed.value"],
  speedUnits: ["system.attributes.movement.units"],
  altSpeeds: ["system.attributes.movement", "system.attributes.speed.otherSpeeds"],
  senses: ["system.attributes.senses", "system.traits.senses", "system.perception.senses"],
  challenge: ["system.details.cr", "system.details.level.value", "system.details.level"],
  alignment: ["system.details.alignment", "system.details.alignment.value", "system.alignment"],
  legendaryActions: ["system.resources.legact.value"],
  legendaryResistances: ["system.resources.legres.value"],
  itemActivation: ["system.activation.type", "system.actionType", "system.actions.0.type"],
  itemActivationLabel: ["labels.activation"],
  itemActionType: ["system.actionType", "system.action.type"],
  itemUses: ["system.uses.value", "system.charges.value"],
  itemUsesSpent: ["system.uses.spent"],
  itemUsesMax: ["system.uses.max", "system.charges.max"],
  itemQuantity: ["system.quantity", "system.quantity.value"],
  itemRangeLabel: ["labels.range"],
  itemRange: ["system.range.value", "system.range.increment"],
  itemRangeUnits: ["system.range.units"],
  itemDamageLabel: ["labels.damage", "labels.derivedDamage.0.label"],
  itemSpellLevel: ["system.level", "system.level.value"],
  itemPrepared: ["system.preparation.prepared", "system.prepared.value"],
  itemConsumeTarget: ["system.consume.target"],
  itemConsumeType: ["system.consume.type"],
  itemRechargeValue: ["system.recharge.value", "system.uses.recovery.0.formula"],
  itemRecharged: ["system.recharge.charged"],
  itemActivationCost: ["system.activation.cost", "system.activation.value"],
};

// Only the exceptions. dnd5e matches GENERIC and is listed for documentation value; pf2e differs
// enough in item shape to be worth its own entries.
const PROFILES: Record<string, Partial<SystemPaths>> = {
  dnd5e: {},
  pf2e: {
    intelligence: ["system.abilities.int.mod"],
    wisdom: ["system.abilities.wis.mod"],
    hpValue: ["system.attributes.hp.value"],
    hpMax: ["system.attributes.hp.max"],
    armor: ["system.attributes.ac.value"],
    speed: ["system.attributes.speed.value"],
    altSpeeds: ["system.attributes.speed.otherSpeeds"],
    challenge: ["system.details.level.value"],
    itemActivation: ["system.actionType.value", "system.time.value"],
    itemQuantity: ["system.quantity"],
    itemSpellLevel: ["system.level.value"],
  },
};

export function systemPaths(): SystemPaths {
  const profile = PROFILES[String((game as any).system?.id ?? "")] ?? {};
  const merged = {} as SystemPaths;
  for (const key of Object.keys(GENERIC) as (keyof SystemPaths)[]) {
    // Profile candidates first, generic ones as fallback — an unknown field still gets a chance.
    merged[key] = [...(profile[key] ?? []), ...GENERIC[key]];
  }
  return merged;
}
