// Which client acts, when several could.
//
// Anything triggered by a relayed socket message runs on EVERY connected GM, because
// `game.user.isGM` is true for each of them (Foundry counts Assistant GMs as GMs). Work that must
// happen exactly once for the table — writing the session journal, ingesting into RAG, deleting a
// message — has to be narrowed to one client, or it happens once per GM logged in.
//
// The same problem appears one step out for anything driven by a document hook that fires
// everywhere: a roll made on a creature's behalf needs exactly one client to make it, and for a
// player character that client should be the player's, not the GM's.

/**
 * True when this client is the GM Foundry has designated to act for the table.
 *
 * Foundry elects the designated GM itself (`Users#activeGM` = the highest-role user among the
 * active GMs, so a full Gamemaster is preferred over an Assistant), and every client evaluates the
 * same replicated user list, so all clients agree on the answer. We do not run our own election.
 *
 * Compares by id, not object identity: `activeGM` and `game.user` are normally the same User
 * instance, but that is an implementation detail to lean on for something that silently disables a
 * whole feature when it does not hold.
 *
 * Falls back to "any GM" when Foundry reports no active GM, so a feature degrades to running
 * everywhere rather than nowhere.
 */
export function isPrimaryGM(): boolean {
  if (!game.user?.isGM) return false;
  const active = (game.users as any)?.activeGM ?? null;
  return !active || active.id === game.user.id;
}

/**
 * The one user who should roll on this actor's behalf: its player if one is connected, else the GM.
 *
 * Three passes over the connected players, most specific first, because each of the looser tests has
 * a world configuration that makes it answer wrongly on its own:
 *
 *   1. Whoever has this actor assigned in User Configuration. This is checked first for the same
 *      reason midi checks it first — it is the only signal that names ONE person.
 *   2. An explicit Owner row on the actor. A world with several owners per character is rare; a
 *      world with several owners per *actor collection* is not.
 *   3. `testUserPermission`, which also honours the "All Players" default row. Left until last
 *      precisely because it is the broad one: in a world whose default permission is Owner it would
 *      otherwise hand every character's save to whichever player happens to sort first.
 *
 * The last of those is still the test midi's `playerForActor` is missing, which is why a world set to
 * "All Players: Owner" prompts the GM for everything: Foundry resolves ownership as
 * `ownership[user.id] ?? ownership.default ?? NONE`, and its ownership dialog *deletes* the per-user
 * row for anyone left on Default rather than writing one, so a raw `ownership[id] === 3` lookup finds
 * nothing to match.
 *
 * Sorted by id within each pass so that every client — each evaluating the same replicated user list
 * — picks the same person. Two owners online must not both roll.
 */
export function rollerForActor(actor: any): string | null {
  try {
    if (actor?.hasPlayerOwner) {
      const players = (game.users as any)?.filter?.((u: any) => u?.active && !u?.isGM) ?? [];
      const pick = (test: (u: any) => boolean): string | null => {
        const ids = players
          .filter(test)
          .map((u: any) => String(u.id))
          .sort();
        return ids.length ? ids[0] : null;
      };
      const assigned = pick(
        (u: any) =>
          Boolean(u?.character) &&
          (String(u.character.id) === String(actor.id) ||
            String(u.character.uuid ?? "") === String(actor.uuid ?? "")),
      );
      if (assigned) return assigned;

      const ownership = actor?.ownership ?? actor?._source?.ownership ?? {};
      const explicit = pick((u: any) => ownership[u.id] === 3);
      if (explicit) return explicit;

      const any = pick((u: any) => Boolean(actor?.testUserPermission?.(u, "OWNER")));
      if (any) return any;
    }
  } catch {
    // fall through to the GM
  }
  const gm = (game.users as any)?.activeGM ?? null;
  return gm ? String(gm.id) : null;
}

/**
 * True when THIS client should press the roll for that actor.
 *
 * `rollerForActor` ALWAYS names someone when a GM is online — the player if one
 * owns the creature, otherwise the GM. A truthy roller is therefore not "leave
 * the button". Treating it that way left every NPC save unpressed in a running
 * world (Hold Person vs Assassin, 2026-08-18): the Assassin's roller was the
 * GM, the skip saw a name, and the Wisdom save never happened.
 *
 * Auto-roll when we are the designated roller. Leave the button when a
 * connected player owns the dice.
 */
export function isRollerFor(actor: any): boolean {
  return autoRollsWhen(rollerForActor(actor), game.user?.id);
}

/**
 * The save-automation gate, extracted so a test can pin the Hold Person miss
 * without a Foundry world. `rollerId` is `rollerForActor`; `thisUserId` is
 * the client considering whether to press.
 */
export function autoRollsWhen(rollerId: string | null, thisUserId: string | null | undefined): boolean {
  return Boolean(rollerId) && rollerId === String(thisUserId ?? "");
}
