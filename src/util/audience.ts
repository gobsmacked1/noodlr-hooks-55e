// Is this creature one of the players' or one of the GM's?
//
// Three rules are configured separately for each side — dying, concentration and the action economy —
// because an operator very rarely wants the same answer for both. Death saves for the party and
// instant death for the mooks is the obvious pairing; so is refusing a monster's third action outright
// while merely asking a player about theirs.
//
// THE ANSWER IS THE SHEET TYPE, NOT WHO OWNS IT. `actor.hasPlayerOwner` is the tempting test and it is
// wrong here for a measured reason: Foundry resolves ownership through the default row, so a world set
// to "All Players: Owner" — which is a legitimate and common configuration, and the one already
// documented in AGENTS.md as breaking midi's `playerForActor` — reports every goblin on the map as
// player-owned. A settings split that silently inverts itself on that world is worse than no split.
// The sheet type cannot do that, and it is also what a GM means when they say "the player settings":
// they are thinking about the party's character sheets.
//
// Ownership is still the right question elsewhere and is deliberately left where it is. `enforce.ts`
// asks `hasPlayerOwner` to decide whether there is anybody who could answer a dialog, which is about
// who is at the keyboard rather than about which rules apply.

export type Audience = "npc" | "pc";

/** Both, in the order the settings window draws them. */
export const AUDIENCES: readonly Audience[] = ["npc", "pc"] as const;

/**
 * The audience a creature belongs to. Anything unreadable is an NPC.
 *
 * Accepts whatever the caller happens to be holding — an Actor, a Token, a TokenDocument or a
 * Combatant — because the alternative is every call site remembering to unwrap, and one that forgets
 * would resolve to NPC while looking correct.
 */
export function audienceOf(subject: unknown): Audience {
  const actor = actorOf(subject);
  return String((actor as any)?.type ?? "") === "character" ? "pc" : "npc";
}

/** Unwrap to an Actor, or null. */
function actorOf(subject: unknown): unknown {
  const s = subject as any;
  if (!s) return null;
  // A Combatant and a Token both expose `.actor`; a TokenDocument does too. An Actor does not.
  return s.actor ?? s.document?.actor ?? s;
}
