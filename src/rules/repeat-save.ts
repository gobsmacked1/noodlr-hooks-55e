// "It can repeat the saving throw at the end of each of its turns, ending the effect on itself on a
// success." Nobody rolls it.
//
// WHY THIS EXISTS. The clause is on hundreds of effects — every Hold Person, every paralysing bite,
// every fear aura — and dnd5e cannot express it. An Active Effect carries a duration, a set of statuses
// and a list of changes; there is no field anywhere on it for a save that ends it early, and no code in
// the system looks for one. So the effect runs its full stated length unless a human remembers, at the
// end of every turn, for every afflicted creature, which DC and which ability. In practice the save
// gets rolled for the first round of a fight and forgotten by the third, which quietly makes every
// save-ends effect stronger than the rules make it.
//
// WHERE THE CLAUSES COME FROM. Two sources, and the second is the interesting one:
//
//   1. The capability compiler. A descriptor that applies a status with a `dc` and an `ability` is
//      stating exactly this rule, and `capability/executor.ts` registers the clause as it applies the
//      status. Nothing there has to know how the save is rolled.
//   2. `api.repeatSave()`, for the GM applying something by hand off a stat block.
//
// Deliberately NOT a third source: parsing every incoming Active Effect's prose for the sentence. The
// effect's own description is usually the whole spell, so the DC found in it may belong to a different
// clause entirely, and a save rolled against the wrong DC is worse than one nobody rolled — it looks
// authoritative. When the compiler is off, this layer simply has nothing pending, which is honest.
//
// WHERE THE STATE LIVES. On the AFFLICTED creature, as a flag, exactly like the action ledger and for
// the same reason: the rule belongs to the victim's turn, not to whoever applied it, and the applier
// may well be dead by the time the save comes round.
//
// THE STAND-ASIDE. midi-qol's `OverTime` flag encodes this same rule and DDB Importer stamps it on
// everything it can (`turn=end,saveDC=13,saveAbility=con,saveRemove=true`). An effect carrying one is
// already being handled, so ours declines rather than rolling a second save against the same DC.

import { MODULE_ID, log } from "../constants";
import { isRepeatSaveEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import { isRollerFor } from "../util/gm";
import { speakerFor } from "../util/speaker";
import { readFlag } from "../util/flags";

const FLAG = "repeatSaves";

/** One pending escape clause, held on the creature it applies to. */
export interface RepeatSave {
  /** The status id whose removal ends it. Also the identity of the clause. */
  status: string;
  /** Ability abbreviation as dnd5e spells it: "con", "wis", ... */
  ability: string;
  dc: number;
  /** What imposed it, for the card. */
  source: string;
}

function pending(actor: any): RepeatSave[] {
  const raw = readFlag(actor, FLAG);
  return Array.isArray(raw) ? (raw as RepeatSave[]) : [];
}

async function store(actor: any, clauses: RepeatSave[]): Promise<void> {
  try {
    if (clauses.length === 0) await actor?.unsetFlag?.(MODULE_ID, FLAG);
    else await actor?.setFlag?.(MODULE_ID, FLAG, clauses);
  } catch {
    /* an actor we may not write is one we cannot track; the effect simply runs its full duration */
  }
}

/** Does this creature still carry the status a clause is about? */
function stillAfflicted(actor: any, status: string): boolean {
  for (const effect of actor?.appliedEffects ?? actor?.effects ?? []) {
    if (effect?.statuses?.has?.(status)) return true;
  }
  return Boolean(actor?.statuses?.has?.(status));
}

/**
 * Is something else already rolling this creature's escape save?
 *
 * midi's OverTime is the one real case. Checked per status rather than per actor: a creature can carry
 * a DDB-imported poison midi is counting down AND a paralysis from a stat block that nobody is.
 */
function alreadyHandled(actor: any, status: string): boolean {
  for (const effect of actor?.appliedEffects ?? actor?.effects ?? []) {
    if (!effect?.statuses?.has?.(status)) continue;
    const overtime = effect?.flags?.["midi-qol"]?.OverTime;
    if (!overtime) continue;
    const text = Array.isArray(overtime) ? overtime.join(",") : String(overtime);
    if (/saveRemove\s*=\s*true/i.test(text)) return true;
  }
  return false;
}

/**
 * Register the escape clause for a status just applied.
 *
 * Idempotent on `status`: re-applying Hold Person at a higher DC replaces the clause rather than
 * queueing a second save, which is what the rules describe and also what stops a stack of duplicates
 * accumulating across a long fight.
 */
export async function noteRepeatSave(actor: any, clause: RepeatSave): Promise<void> {
  if (!actor || !clause?.status || !clause?.ability || !Number.isFinite(clause.dc)) return;
  const status = String(clause.status).toLowerCase();
  const rest = pending(actor).filter((c) => String(c.status).toLowerCase() !== status);
  await store(actor, [...rest, { ...clause, status }]);
  log(
    `repeat save: ${String(actor.name)} may shake off ${status} with DC ${clause.dc} ${clause.ability}`,
  );
}

/** Forget a clause, for a status removed some other way. */
export async function clearRepeatSave(actor: any, status: string): Promise<void> {
  const wanted = String(status).toLowerCase();
  const rest = pending(actor).filter((c) => String(c.status).toLowerCase() !== wanted);
  if (rest.length !== pending(actor).length) await store(actor, rest);
}

/**
 * Roll every pending save for a creature whose turn has just ended.
 *
 * Sequential, because two of them can both end with a card and interleaving those makes the log
 * unreadable — and because a creature with two clauses is rare enough that the wait costs nothing.
 */
export async function rollPendingSaves(actor: any): Promise<void> {
  if (!isDnd5e() || !isRepeatSaveEnabled() || !actor) return;
  const clauses = pending(actor);
  if (clauses.length === 0) return;

  // A player's Wisdom save is the player's roll, on the same reasoning as the concentration layer:
  // Bless, Inspiration and a reroll are all decisions, and they belong to whoever owns the creature.
  if (!isRollerFor(actor)) return;

  const survivors: RepeatSave[] = [];
  for (const clause of clauses) {
    const status = String(clause.status).toLowerCase();

    // Gone already — the duration ran out, the caster dropped concentration, or someone clicked it off.
    if (!stillAfflicted(actor, status)) continue;
    if (alreadyHandled(actor, status)) {
      log(`repeat save: midi's OverTime already rolls ${status} for ${String(actor.name)}`);
      survivors.push(clause);
      continue;
    }

    const passed = await rollOne(actor, clause);
    if (passed === null) {
      // Cancelled, or the roll would not build. Keep the clause: a save nobody answered is not a
      // failed one, and the creature gets asked again at the end of its next turn.
      survivors.push(clause);
      continue;
    }
    if (!passed) {
      survivors.push(clause);
      continue;
    }
    await end(actor, clause);
  }

  if (survivors.length !== clauses.length) await store(actor, survivors);
}

/** True on a success, false on a failure, null when no verdict was produced. */
async function rollOne(actor: any, clause: RepeatSave): Promise<boolean | null> {
  try {
    const rolls = await actor.rollSavingThrow?.(
      { ability: clause.ability, target: clause.dc },
      { configure: Boolean(actor?.hasPlayerOwner) },
    );
    const total = Number(rolls?.[0]?.total);
    if (!Number.isFinite(total)) return null;
    // Meets the DC on equal, which is the general rule for every save in both editions.
    return total >= clause.dc;
  } catch (err) {
    log(`repeat save: could not roll for ${String(actor?.name)}:`, err);
    return null;
  }
}

/** Take the status off and say so, so the table sees the effect end rather than just stop mattering. */
async function end(actor: any, clause: RepeatSave): Promise<void> {
  const status = String(clause.status).toLowerCase();
  try {
    // By reading the effect off the actor rather than by `toggleStatusEffect`, for the reason the
    // Dodge layer records: core resolves the delete by the status's static id and walks past an
    // identically-statused effect another module created, which on a world with Convenient Effects
    // installed is often the only one there is.
    for (const effect of Array.from(actor?.effects ?? []) as any[]) {
      const statuses = effect?.statuses;
      if (statuses?.has?.(status) && statuses.size === 1) await effect.delete?.();
    }
    if (actor?.statuses?.has?.(status)) await actor.toggleStatusEffect?.(status, { active: false });
  } catch (err) {
    log(`repeat save: could not remove ${status} from ${String(actor?.name)}:`, err);
  }

  try {
    const ChatMessage = (globalThis as any).ChatMessage;
    const esc = foundry.utils.escapeHTML;
    await ChatMessage?.create({
      speaker: speakerFor(actor),
      content: `<p>${game.i18n.format("NOODLRHOOKS.Combat.RepeatSaves.Shook", {
        name: esc(String(actor?.name ?? "The creature")),
        status: esc(status),
        source: esc(String(clause.source ?? "")),
      })}</p>`,
    });
  } catch {
    /* losing the card is cosmetic; the effect has already ended */
  }
}

/**
 * Watch for turns ending.
 *
 * Registered on EVERY client, not just the GM's, which is why this cannot reuse the capability
 * executor's identical-looking tracker: that one is `isPrimaryGM()`-gated because it executes world
 * mutations, while a repeat save has to be rolled by whoever owns the creature. Two watchers reading
 * one hook, each keeping its own idea of the previous combatant, is the cheapest way to have both
 * gates — and each is a dozen lines with no shared state to drift.
 */
export function registerRepeatSaveWatch(): void {
  let previous: string | null = null;

  Hooks.on("updateCombat", (combat: any, changes: any) => {
    try {
      if (changes?.turn === undefined && changes?.round === undefined) return;
      const currentId = String(combat?.combatant?.id ?? "");
      if (currentId === previous) return;
      const ending = previous ? (combat?.combatants?.get?.(previous) ?? null) : null;
      previous = currentId || null;
      if (ending?.actor) void rollPendingSaves(ending.actor);
    } catch (err) {
      log("repeat save: updateCombat failed:", err);
    }
  });

  Hooks.on("deleteCombat", () => {
    previous = null;
  });

  // A status removed by any other route — the duration expiring, the caster losing concentration, the
  // GM clicking it off — takes its clause with it. Without this the clause outlives the effect and the
  // creature is asked, once, to save against something it no longer has.
  Hooks.on("deleteActiveEffect", (effect: any) => {
    try {
      const actor = effect?.parent;
      if (!actor?.isOwner) return;
      for (const status of effect?.statuses ?? []) void clearRepeatSave(actor, String(status));
    } catch (err) {
      log("repeat save: deleteActiveEffect failed:", err);
    }
  });
}

/** Diagnostics: what the selected creature is still waiting to shake off. */
export function surveyRepeatSaves(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  const report = {
    enabled: isRepeatSaveEnabled(),
    creature: String(actor?.name ?? "nothing selected"),
    clauses: pending(actor).map((c) => ({
      ...c,
      stillAfflicted: stillAfflicted(actor, c.status),
      midiOwnsIt: alreadyHandled(actor, c.status),
    })),
  };
  log("repeat saves:", report);
  return report;
}
