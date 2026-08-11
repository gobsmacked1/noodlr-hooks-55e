// What hurt whom, when, and with what.
//
// This is the primitive the most capabilities turn out to need: Regeneration ("unless it took Acid or
// Fire damage"), retaliation ("when a creature hits it with a melee attack"), damage riders, Loathsome
// Limbs ("took 15 or more Slashing damage during that turn"). dnd5e records none of it — damage is
// applied and forgotten, and the only trace is a chat card.
//
// TWO SOURCES, ONE LEDGER, AND THE REASON IS WHICH CLIENT SEES WHAT:
//
//   * `updateActor` fires on EVERY client, and dnd5e's `_preUpdate` puts the old hit points in
//     `options.dnd5e.hp`, so the amount is computable everywhere. This is the only recording path, so
//     there is no cross-client deduplication to get wrong.
//   * `dnd5e.applyDamage` and `dnd5e.preCalculateDamage` fire ONLY on the client that applied the
//     damage. They carry the damage TYPES, which the actor update does not. So they do not record
//     anything; they deposit types into a short-lived buffer that the update path reads.
//   * `createChatMessage` also fires everywhere, so a damage card is the fallback source of types when
//     the applying client was somebody else's. Same parsing dnd5e and midi already make available.
//
// Where no type can be established the entry is recorded as untyped rather than guessed. A predicate
// naming damage types then does not match it, which for Regeneration means the monster keeps
// regenerating — the direction that is visible at the table and arguable, rather than a monster that
// silently stops for a reason nobody can find.

import { debug, log } from "../constants";

export type DamageWindow = "this_turn" | "since_last_turn" | "this_round" | "ever";

export interface DamageEntry {
  /** Monotonic within a session, so windows are comparisons rather than timestamp arithmetic. */
  seq: number;
  actorUuid: string;
  /** What actually landed, after resistance and immunity. */
  amount: number;
  types: string[];
  round: number;
  at: number;
}

export interface DamageTakenEvent extends DamageEntry {
  actor: any;
}

type Listener = (event: DamageTakenEvent) => void;

/** Kept per encounter, not forever: an unbounded log of every hit in a session is a leak. */
const entries: DamageEntry[] = [];
const ENTRY_CAP = 2000;

/** Sequence numbers at which each actor's turns began, newest last. */
const turnStarts = new Map<string, number[]>();

/** Types deposited by whichever client applied the damage, valid for a moment only. */
const typeBuffer = new Map<string, { types: string[]; at: number }>();
const TYPE_TTL_MS = 1500;

const listeners: Listener[] = [];

let seq = 0;
let registered = false;

function uuidOf(actor: any): string {
  return String(actor?.uuid ?? actor?.id ?? "");
}

function currentRound(): number {
  return Number((game as any)?.combat?.round ?? 0);
}

function depositTypes(actorUuid: string, types: string[]): void {
  if (!actorUuid || types.length === 0) return;
  const existing = typeBuffer.get(actorUuid);
  const fresh = existing && Date.now() - existing.at < TYPE_TTL_MS ? existing.types : [];
  typeBuffer.set(actorUuid, {
    types: [...new Set([...fresh, ...types.map((t) => String(t).toLowerCase())])],
    at: Date.now(),
  });
}

function takeTypes(actorUuid: string): string[] {
  const found = typeBuffer.get(actorUuid);
  if (!found) return [];
  typeBuffer.delete(actorUuid);
  return Date.now() - found.at < TYPE_TTL_MS ? found.types : [];
}

/** Damage types on a chat message, one per roll — a DamageRoll carries exactly one. */
function messageDamageTypes(message: any): string[] {
  const out: string[] = [];
  for (const roll of message?.rolls ?? []) {
    const type = String((roll as any)?.options?.type ?? "");
    if (type) out.push(type.toLowerCase());
  }
  for (const entry of message?.flags?.["midi-qol"]?.damageDetail ?? []) {
    const type = String(entry?.type ?? "");
    if (type) out.push(type.toLowerCase());
  }
  return out;
}

/** Who a damage card was aimed at, in whichever of the three shapes is present. */
function messageTargets(message: any): string[] {
  const out: string[] = [];
  // Midi writes token uuids unconditionally, which is the better identity for unlinked tokens.
  for (const uuid of message?.flags?.["midi-qol"]?.hitTargetUuids ?? []) out.push(String(uuid));
  // dnd5e keys by ACTOR uuid, which collapses two linked tokens of one actor into a single entry.
  for (const target of message?.flags?.dnd5e?.targets ?? []) {
    if (target?.uuid) out.push(String(target.uuid));
  }
  return out;
}

// ---- Recording ------------------------------------------------------------------------------

function record(actor: any, amount: number, types: string[]): void {
  const actorUuid = uuidOf(actor);
  if (!actorUuid || !(amount > 0)) return;

  const entry: DamageEntry = {
    seq: ++seq,
    actorUuid,
    amount,
    types,
    round: currentRound(),
    at: Date.now(),
  };
  entries.push(entry);
  if (entries.length > ENTRY_CAP) entries.splice(0, entries.length - ENTRY_CAP);

  debug("damage taken", { actor: actor?.name, amount, types });
  for (const listener of listeners) {
    try {
      listener({ ...entry, actor });
    } catch (err) {
      // One bad listener must not stop the others, and must never break damage application.
      log("a damageTaken listener threw:", err);
    }
  }
}

/** Subscribe to damage. Returns an unsubscribe, so a test or a reload does not stack handlers. */
export function onDamageTaken(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
}

/** Note that a creature's turn has begun, which is what the turn-scoped windows are measured from. */
export function noteTurnStart(actorUuid: string): void {
  if (!actorUuid) return;
  const stamps = turnStarts.get(actorUuid) ?? [];
  stamps.push(seq);
  // Two is all any window needs; keeping more would grow without bound over a long fight.
  turnStarts.set(actorUuid, stamps.slice(-2));
}

/** Forget the encounter. Called on `deleteCombat`, for the same reason the tactics registry is. */
export function clearDamageLog(): void {
  entries.length = 0;
  turnStarts.clear();
  typeBuffer.clear();
}

// ---- Querying -------------------------------------------------------------------------------

/**
 * The last sequence number BEFORE the window opens, or null when the window cannot be evaluated.
 *
 * "Before" rather than "first inside" because a turn boundary is recorded between two damage entries:
 * the hit that landed at the same sequence number as the stamp happened on somebody else's turn, and
 * counting it as part of the new turn is exactly the off-by-one that would let Loathsome Limbs fire on
 * damage spread across two turns.
 *
 * Null out of combat for the turn-scoped windows, deliberately: with no initiative there are no turns,
 * so "during that turn" has no referent. A predicate that cannot be evaluated must fail closed rather
 * than quietly widen to "ever".
 */
function windowStart(actorUuid: string, window: DamageWindow): number | null {
  if (window === "ever") return 0;
  if (window === "this_round") {
    return currentRound() > 0 ? -1 : null; // -1 = every seq; the round is filtered separately.
  }
  const stamps = turnStarts.get(actorUuid) ?? [];
  if (stamps.length === 0) return null;
  if (window === "this_turn") return stamps[stamps.length - 1];
  // `since_last_turn` opens at the PREVIOUS turn start, so it spans the gap in which everyone else
  // acted. That is the reading the Troll needs: acid or fire at any point between its turns.
  return stamps.length >= 2 ? stamps[stamps.length - 2] : stamps[0];
}

export interface DamageQuery {
  window: DamageWindow;
  damageTypes?: string[];
  minimum?: number;
}

export interface DamageAnswer {
  /** False when the window itself could not be evaluated — not the same as "took nothing". */
  evaluable: boolean;
  total: number;
  matched: DamageEntry[];
}

/** How much damage of the given types an actor has taken inside a window. */
export function damageTakenBy(actorUuid: string, query: DamageQuery): DamageAnswer {
  const start = windowStart(actorUuid, query.window);
  if (start === null) return { evaluable: false, total: 0, matched: [] };

  const round = currentRound();
  const wanted = (query.damageTypes ?? []).map((t) => String(t).toLowerCase());

  const matched = entries.filter((entry) => {
    if (entry.actorUuid !== actorUuid) return false;
    if (query.window === "this_round") {
      if (entry.round !== round) return false;
    } else if (entry.seq <= start) return false;
    if (wanted.length === 0) return true;
    return entry.types.some((type) => wanted.includes(type));
  });

  const total = matched.reduce((sum, entry) => sum + entry.amount, 0);
  return { evaluable: true, total, matched };
}

/** The predicate form: did enough of the right damage land? Unevaluable windows answer false. */
export function damageTakenMatches(actorUuid: string, query: DamageQuery): boolean {
  const answer = damageTakenBy(actorUuid, query);
  if (!answer.evaluable) return false;
  const minimum = Number(query.minimum ?? 1);
  return answer.matched.length > 0 && answer.total >= minimum;
}

// ---- Hooks ----------------------------------------------------------------------------------

export function registerDamageLog(): void {
  if (registered) return;
  registered = true;

  // Types, from whichever client applied the damage. Pre-resistance values, which is why they are
  // only used as labels — the amount always comes from the actor update.
  Hooks.on("dnd5e.preCalculateDamage", (actor: any, damages: any[]) => {
    const types = (damages ?? []).map((d) => String(d?.type ?? "")).filter(Boolean);
    depositTypes(uuidOf(actor), types);
  });

  // Types, from a damage card. Fires on every client, so this is what covers damage a player applied.
  Hooks.on("createChatMessage", (message: any) => {
    const types = messageDamageTypes(message);
    if (types.length === 0) return;
    for (const uuid of messageTargets(message)) {
      depositTypes(uuid, types);
      // dnd5e's targets are ACTOR uuids while a token on the scene reports its own; deposit under
      // both readings rather than trying to resolve, since the buffer is keyed lookup and cheap.
      const actor = (foundry as any)?.utils?.fromUuidSync?.(uuid);
      if (actor?.actor?.uuid) depositTypes(String(actor.actor.uuid), types);
    }
  });

  // The one recording path. Fires everywhere; `options.dnd5e.hp` carries the previous values because
  // dnd5e writes them in `_preUpdate`, so the delta is available without a pre-hook of our own.
  Hooks.on("updateActor", (actor: any, _changes: any, options: any) => {
    try {
      const before = options?.dnd5e?.hp;
      if (!before) return;
      const oldTotal = Number(before.value ?? 0) + Number(before.temp ?? 0);
      const now = actor?.system?.attributes?.hp;
      if (!now) return;
      const newTotal = Number(now.value ?? 0) + Number(now.temp ?? 0);
      const lost = oldTotal - newTotal;
      // Healing and direct edits both come through here; only a decrease is damage.
      if (!(lost > 0)) return;
      record(actor, lost, takeTypes(uuidOf(actor)));
    } catch (err) {
      log("damage log: could not read an actor update:", err);
    }
  });

  Hooks.on("deleteCombat", () => clearDamageLog());

  Hooks.on("updateCombat", () => {
    const combatant = (game as any)?.combat?.combatant;
    const actorUuid = uuidOf(combatant?.actor);
    if (actorUuid) noteTurnStart(actorUuid);
  });
}

/** Test seam. */
export function __damageLogInternals() {
  return {
    record,
    entries,
    turnStarts,
    reset: () => {
      clearDamageLog();
      seq = 0;
      listeners.length = 0;
    },
  };
}
