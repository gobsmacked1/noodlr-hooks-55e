// Reading other modules' state, in one place.
//
// Every stand-aside in this module has to answer the same two questions — is that module active, and
// what is it configured to do — and each one used to answer them itself. Three copies of the midi
// config lookup was the point at which that stopped being acceptable, because the lookup is not
// obvious: midi exposes a live object through its global that is NOT always the same as the stored
// setting, and reading only the stored setting misses a runtime change.
//
// Nothing here throws. A module we do not own may be absent, half-initialised, or storing a shape we
// have never seen, and the correct answer in all three cases is "I could not tell" — which every
// caller reads as "nobody else owns this", i.e. keep enforcing. Failing the other way would silently
// switch our own rules off because another module's settings object had an unexpected key.

/** Is a module installed AND enabled in this world? */
export function moduleActive(id: string): boolean {
  try {
    return Boolean((game as any)?.modules?.get?.(id)?.active);
  } catch {
    return false;
  }
}

/**
 * midi-qol's live configuration, or null when midi is absent or unreadable.
 *
 * Prefers `MidiQOL.configSettings()` over the stored world setting: midi mutates that object at
 * runtime, so a GM who changed a switch without reloading has a stored value that is already stale.
 * Falls back to the setting because the global does not exist until midi's own ready hook has run,
 * and our stand-asides are consulted from paths that can run earlier.
 */
export function midiConfig(): any | null {
  if (!moduleActive("midi-qol")) return null;
  try {
    const MidiQOL = (globalThis as any).MidiQOL;
    const live = typeof MidiQOL?.configSettings === "function" ? MidiQOL.configSettings() : null;
    return live ?? game.settings.get("midi-qol", "ConfigSettings") ?? null;
  } catch {
    return null;
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

/**
 * midi's own "is this switch on" idiom.
 *
 * Almost every mechanical setting midi has is a string enum whose off position is the literal
 * `"none"`, so a plain truthiness test reports `"none"` as enabled.
 */
export function midiOn(value: unknown): boolean {
  return Boolean(value && value !== "none");
}
