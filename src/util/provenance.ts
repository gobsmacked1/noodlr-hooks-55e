// What this world is, as two strings worth recording next to something we computed from it.
//
// A leaf on purpose. `capability/cache.ts` stamps it onto every reading it stores and
// `capability/age.ts` compares it back; if either of them owned this function the other would have to
// import it across, and a cycle between two files that both run at load is the kind of thing that
// works under ESM until somebody moves an initialiser to module scope.

/** A version pair, compared as strings: any difference at all is worth reporting to a human. */
export interface WorldStamp {
  foundry: string;
  system: string;
}

/**
 * This world, right now.
 *
 * `game.version` is the plain Foundry version (`14.365`) and has been there longest;
 * `game.release.version` is the same value on builds that expose the release object. The system is
 * `id + version` TOGETHER, because a world that switched system entirely is the largest drift there
 * is and an id on its own cannot express a patch release.
 *
 * Empty strings rather than a throw or a guess when either is unreadable: a stamp that cannot be read
 * must compare as "nothing to say", and {@link import("../capability/age").driftOf} reads it that way.
 */
export function worldStamp(): WorldStamp {
  const g = game as any;
  const id = String(g?.system?.id ?? "");
  const version = String(g?.system?.version ?? "");
  return {
    foundry: String(g?.version ?? g?.release?.version ?? ""),
    system: id && version ? `${id} ${version}` : id || version,
  };
}
