// Ammunition recovery: the printed 2024 rule, with no Foundry.
//
// Each attack expends one piece. After a fight the party may spend a minute
// searching and recover half of what they spent, rounded down; the rest is
// lost. dnd5e spends the stack on the attack roll and never gives any back.
// Thrown weapons (`ammoUpdate.id === weapon.id`) are a different rule — they
// pin a Tile — and must not be counted here.
//
// Victory and "still able to search" are decided by the caller from live
// combat state. This file is the arithmetic and the two predicates.

export function ammoRecovered(spent: number): number {
  const n = Math.floor(Number(spent));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n / 2);
}

/** Party won the field: hostiles were present, none still fighting, not mercy. */
export function partyHeldTheField(input: {
  hostiles: number;
  standing: number;
  mercy: boolean;
}): boolean {
  return input.hostiles > 0 && input.standing === 0 && !input.mercy;
}

/**
 * Alive enough to search. Knockout is 1 HP + Unconscious — they cannot.
 * Do not use `defeated` alone: knockout is often defeated at 1 HP.
 */
export function canSearchBattlefield(input: {
  hp: number | null;
  dead: boolean;
  unconscious: boolean;
}): boolean {
  if (input.dead || input.unconscious) return false;
  if (input.hp === null) return false;
  return input.hp > 0;
}

/** Party-side only. Dead goblin archers do not pick their arrows back up. */
export function isPartySearcher(input: {
  character: boolean;
  playerOwned: boolean;
  friendly: boolean;
}): boolean {
  return input.character || input.playerOwned || input.friendly;
}
