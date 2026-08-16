// Which sheets a diagnostic can read, and the one caveat that matters about the answer.
//
// Extracted from `hygiene.ts` when a second caller appeared. A private copy in each place is how two
// diagnostics come to disagree about what the world contains, and here the disagreement would be
// invisible: both would report a plausible number.

/**
 * Every actor whose sheet could produce a cache key.
 *
 * World actors AND every scene's tokens, because an unlinked token carries its own sheet: a monster
 * customised on the canvas has prose that exists nowhere in `game.actors`. Deliberately NOT compendia —
 * walking every pack means loading every pack, which is minutes on a world with the full SRD plus
 * third-party content, for a diagnostic. **So every count derived from this is a lower bound, and a
 * caller reporting one has to say so** — that is why `absent` is never pruned in `hygiene.ts`.
 */
export function readableActors(): any[] {
  const seen = new Map<string, any>();
  const add = (actor: any): void => {
    const uuid = String(actor?.uuid ?? "");
    if (actor && uuid && !seen.has(uuid)) seen.set(uuid, actor);
  };
  for (const actor of (game as any)?.actors?.contents ?? []) add(actor);
  for (const scene of (game as any)?.scenes?.contents ?? []) {
    for (const token of scene?.tokens?.contents ?? []) add(token?.actor);
  }
  return [...seen.values()];
}
