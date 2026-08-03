// The one place where Noodlr does game-system arithmetic, on purpose and in writing.
//
// Awarding experience and confiscating gear cannot be done "generically": XP values come from a 5e
// table, currency lives at a 5e path, and what counts as worn armour is a 5e item shape. The user
// accepted that on 2026-08-02 in exchange for the resolution addendum actually working. It is fenced
// off here — one file, gated on `game.system.id === "dnd5e"`, returning a report rather than throwing
// when it does not apply — so a second system means a sibling file, not edits scattered through the
// planner. Principle 0's line still holds everywhere else: nothing in `auto/` knows any of this.
//
// FORFEITURE IS DESTRUCTIVE AND THEREFORE RECORDED. Every item removed and every coin taken is stored
// verbatim on the actor under a module flag before anything is deleted, and `restoreForfeited()` puts
// it all back. A mercy ruling that lands wrong in the middle of a session must be undoable in one
// click, not reconstructed from memory.

import { MODULE_ID, log } from "../../constants";

const FLAG = "mercyForfeit";

export function isDnd5e(): boolean {
  return String((game as any).system?.id ?? "") === "dnd5e";
}

// Standard 5e experience by challenge rating. A table of published values, not a rule being derived.
const CR_XP: Record<string, number> = {
  "0": 10,
  "0.125": 25,
  "0.25": 50,
  "0.5": 100,
  "1": 200,
  "2": 450,
  "3": 700,
  "4": 1100,
  "5": 1800,
  "6": 2300,
  "7": 2900,
  "8": 3900,
  "9": 5000,
  "10": 5900,
  "11": 7200,
  "12": 8400,
  "13": 10000,
  "14": 11500,
  "15": 13000,
  "16": 15000,
  "17": 18000,
  "18": 20000,
  "19": 22000,
  "20": 25000,
  "21": 33000,
  "22": 41000,
  "23": 50000,
  "24": 62000,
  "25": 75000,
  "26": 90000,
  "27": 105000,
  "28": 120000,
  "29": 135000,
  "30": 155000,
};

/**
 * What this creature is worth. The sheet's own XP figure wins when it has one — homebrew and modules
 * routinely override it — and the CR table is the fallback.
 */
export function xpForActor(actor: any): number {
  const stated = Number(actor?.system?.details?.xp?.value);
  if (Number.isFinite(stated) && stated > 0) return stated;
  const cr = Number(actor?.system?.details?.cr);
  if (!Number.isFinite(cr)) return 0;
  return CR_XP[String(cr)] ?? 0;
}

/** Player-character actors in the fight, which is who an award is split between. */
function partyActors(): any[] {
  const out: any[] = [];
  for (const c of game.combat?.combatants ?? []) {
    const any = c as any;
    if (!(any?.hasPlayerOwner ?? any?.actor?.hasPlayerOwner)) continue;
    if (any.actor && !out.includes(any.actor)) out.push(any.actor);
  }
  return out;
}

/** Split `total` evenly and add it to each character's experience. Returns the per-head share. */
export async function awardExperience(total: number): Promise<{ each: number; heads: number }> {
  const party = partyActors();
  if (!isDnd5e() || party.length === 0 || total <= 0) return { each: 0, heads: party.length };

  // Rounded down: the party does not gain experience out of thin air on a remainder.
  const each = Math.floor(total / party.length);
  for (const actor of party) {
    const current = Number(actor?.system?.details?.xp?.value ?? 0);
    try {
      await actor.update({ "system.details.xp.value": current + each });
    } catch (err) {
      log(`could not award experience to ${actor?.name}:`, err);
    }
  }
  return { each, heads: party.length };
}

const ARMOUR_TYPES = new Set(["light", "medium", "heavy", "shield"]);

function isForfeitable(item: any): boolean {
  const equipped = Boolean(item?.system?.equipped);
  if (!equipped) return false;
  if (item.type === "weapon") return true;
  if (item.type === "equipment") {
    return ARMOUR_TYPES.has(String(item?.system?.type?.value ?? "").toLowerCase());
  }
  return false;
}

/**
 * Take the party's carried coin, held weapons, and worn armour, as the mercy ruling requires.
 * Everything removed is recorded on the actor first so `restoreForfeited()` can undo it exactly.
 */
export async function forfeitPartyGear(): Promise<{ actors: number; items: number }> {
  if (!isDnd5e()) return { actors: 0, items: 0 };
  let actorsTouched = 0;
  let itemsTaken = 0;

  for (const actor of partyActors()) {
    try {
      const items = (actor.items ?? []).filter(isForfeitable);
      const currency = foundry.utils.deepClone(actor.system?.currency ?? {});
      const hadCoin = Object.values(currency).some((v: any) => Number(v) > 0);
      if (items.length === 0 && !hadCoin) continue;

      // Record BEFORE deleting: the whole point is that this is reversible.
      await actor.setFlag(MODULE_ID, FLAG, {
        currency,
        items: items.map((i: any) => i.toObject()),
        at: Date.now(),
      });

      const emptied: Record<string, number> = {};
      for (const key of Object.keys(currency)) emptied[`system.currency.${key}`] = 0;
      await actor.update(emptied);
      if (items.length > 0) {
        await actor.deleteEmbeddedDocuments(
          "Item",
          items.map((i: any) => i.id),
        );
      }

      actorsTouched++;
      itemsTaken += items.length;
    } catch (err) {
      log(`could not take gear from ${actor?.name}:`, err);
    }
  }
  return { actors: actorsTouched, items: itemsTaken };
}

/** Put back everything the last mercy ruling took. Safe to call when nothing was taken. */
export async function restoreForfeited(): Promise<number> {
  let restored = 0;
  for (const actor of game.actors ?? []) {
    const record: any = (actor as any).getFlag?.(MODULE_ID, FLAG);
    if (!record) continue;
    try {
      const currency: Record<string, number> = {};
      for (const [key, value] of Object.entries(record.currency ?? {})) {
        currency[`system.currency.${key}`] = Number(value) || 0;
      }
      if (Object.keys(currency).length > 0) await (actor as any).update(currency);
      if (Array.isArray(record.items) && record.items.length > 0) {
        await (actor as any).createEmbeddedDocuments("Item", record.items);
      }
      await (actor as any).unsetFlag(MODULE_ID, FLAG);
      restored++;
    } catch (err) {
      log(`could not restore gear to ${actor?.name}:`, err);
    }
  }
  return restored;
}
