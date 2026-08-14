// Spell facts that belong to no single spell.
//
// Both of these started life inside `dnd5e-spells`' first caller, `dnd5e-counterspell.ts`, and moved here
// the moment a second reaction spell needed them. The alternative was Silvery Barbs importing from
// Counterspell, which reads as a dependency between two unrelated rules and is the shape that eventually
// makes one of them impossible to delete.

/**
 * Does casting this spell spend a slot at all?
 *
 * ASKED OF THE SYSTEM, never hardcoded: `CONFIG.DND5E.spellcasting[method].slots` is the field that says so,
 * and the methods are `spell`, `pact`, `ritual`, `innate` and `atwill`. A statblock's "at will: counterspell"
 * has no pool to check, and refusing it for want of a resource it does not use would make exactly the
 * creatures most likely to react unable to.
 */
export function spendsSlot(item: any): boolean {
  const method = String(item?.system?.method ?? "spell");
  const config: any = (globalThis as any).CONFIG?.DND5E?.spellcasting?.[method];
  if (config && "slots" in config) return Boolean(config.slots);
  // Unreadable config: assume it spends one, which errs towards checking a pool rather than towards
  // offering a spell the creature cannot pay for.
  return method !== "innate" && method !== "atwill";
}

/**
 * Is a slot of at least this level available?
 *
 * Pact magic counts: a warlock's slots are third level or better from level five, and they are the class
 * most likely to be holding Counterspell. Its pool carries its own `level`, which is why that is read in
 * preference to the `spellN` key.
 */
export function slotAvailable(actor: any, level: number): boolean {
  const spells: any = actor?.system?.spells;
  if (!spells) return false;

  for (const [key, pool] of Object.entries(spells) as [string, any][]) {
    const poolLevel = Number(pool?.level ?? key.match(/^spell(\d+)$/)?.[1]);
    if (!Number.isFinite(poolLevel) || poolLevel < level) continue;
    const max = Number(pool?.max ?? 0);
    const value = Number(pool?.value ?? 0);
    if (max > 0 && value > 0) return true;
  }
  return false;
}
