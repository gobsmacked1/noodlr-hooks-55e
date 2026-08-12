// Finding the token an actor is standing on, and what a player has targeted.
//
// Every rule that starts from a button press has the same problem: `dnd5e.preUseActivity` hands over an
// actor, and geometry — cover, reach, distance, who is dying over there — needs a token. Three files had
// grown their own answer to that, which is how they eventually give different ones.

/**
 * The token this actor is on the current scene, preferring the synthetic one an unlinked token carries.
 *
 * `actor.token` is set on the synthetic actor an unlinked token owns, and it is the only answer that is
 * unambiguous: `getActiveTokens` on a linked actor can return several, and the first is a guess. Null
 * when the actor has nothing placed, which callers must treat as "no geometry to reason about" rather
 * than as an error.
 */
export function tokenFor(actor: any): any {
  try {
    const own = actor?.token?.object ?? actor?.token;
    if (own) return own;
    const active = actor?.getActiveTokens?.(true, false) ?? actor?.getActiveTokens?.() ?? [];
    return active[0] ?? null;
  } catch {
    return null;
  }
}

/** Everything this client currently has targeted. */
export function targetedTokens(): any[] {
  return Array.from((game.user?.targets ?? []) as Set<any>);
}
