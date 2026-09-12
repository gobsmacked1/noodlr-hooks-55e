// Reading other modules' state, in one place.
//
// Advisories still have to answer "is that module active" and, for a few house-rule packages,
// "what is it configured to do". Nothing here throws. A module we do not own may be absent,
// half-initialised, or storing a shape we have never seen, and the correct answer in all three
// cases is "I could not tell". These helpers never switch our rules off — they only name a live
// conflict so the GM can see two referees.
//
// Do not add Midi QoL config readers. That package is incompatible; `moduleActive("midi-qol")`
// is enough to say so.

/** Is a module installed AND enabled in this world? */
export function moduleActive(id: string): boolean {
  try {
    return Boolean((game as any)?.modules?.get?.(id)?.active);
  } catch {
    return false;
  }
}

/**
 * A setting belonging to another module, or undefined when it cannot be read.
 *
 * `game.settings.get` throws on an unregistered key rather than returning undefined, which is exactly
 * the case we hit whenever a module is installed but has not registered its settings yet.
 */
export function moduleSetting(moduleId: string, key: string): unknown {
  try {
    return game.settings.get(moduleId, key);
  } catch {
    return undefined;
  }
}
