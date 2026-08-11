// Four starting points, so a table does not have to read eighteen hints to get going.
//
// A preset writes settings and nothing else — no hidden mode, no state of its own. After applying one
// every switch is still individually editable, and the window simply stops naming a preset once the
// values stop matching one. That is deliberate: a preset that remembered it had been chosen would
// eventually disagree with the settings it supposedly describes.
//
// "Alongside Midi QoL" is the one worth explaining. Two of these rules already stand aside from midi
// at runtime, so that profile could have been left empty and would have behaved identically. It sets
// them off explicitly anyway, because the entire complaint this window exists to answer is that a
// silent stand-aside leaves a switch reading ON while nothing happens. A GM running midi should be
// able to SEE that concentration is midi's.

import { COMBAT_SETTINGS, GENERAL_SETTINGS, MODULE_ID } from "../constants";

const C = COMBAT_SETTINGS;
const G = GENERAL_SETTINGS;

export interface Preset {
  id: string;
  label: string;
  blurb: string;
  /** Setting key to value. Keys absent from a preset are left exactly as the GM had them. */
  values: Record<string, unknown>;
}

/** Every rule switch, so a preset can state a complete position rather than a partial one. */
const ALL_RULES = {
  [C.conditions]: true,
  [C.dying]: true,
  [C.importantNpcSaves]: true,
  [C.concentration]: true,
  [C.forced]: true,
  [C.movement]: true,
  [C.stealth]: true,
  [C.surprise]: true,
  [C.invisBreak]: true,
  [C.autoEnd]: true,
  [G.jump]: true,
  [G.influence]: true,
};

const OFF = Object.fromEntries(Object.keys(ALL_RULES).map((k) => [k, false]));

export const PRESETS: Preset[] = [
  {
    id: "narrate",
    label: "Narrate only",
    blurb:
      "Enforce nothing. Every rule in this module is off and the monsters are yours to play. Use this " +
      "when another package already runs your combat and you want this one purely for the voice the " +
      "companion module gives it.",
    values: { ...OFF, [C.automation]: "off", [C.economy]: "off", [C.autoEngage]: false },
  },
  {
    id: "assistant",
    label: "Rules assistant",
    blurb:
      "Enforce what nothing else does, and ask rather than refuse. Players are warned when they " +
      "overspend a turn and can carry on; monsters are only played when you opt them in with the Act " +
      "as NPC tool. The recommended starting point.",
    values: {
      ...ALL_RULES,
      [C.automation]: "partial",
      [C.economy]: "warn",
      [C.autoEngage]: true,
    },
  },
  {
    id: "full",
    label: "Full enforcement",
    blurb:
      "Everything on and the action economy refuses rather than asks. Monsters play themselves, start " +
      "their own fights and end their own turns. The GM is still only ever asked, never refused.",
    values: {
      ...ALL_RULES,
      [C.automation]: "full",
      [C.economy]: "block",
      [C.autoEngage]: true,
    },
  },
  {
    id: "midi",
    label: "Alongside Midi QoL",
    blurb:
      "Keep the rules midi genuinely leaves alone — forced movement, the Speed budget and Dash, hiding " +
      "and surprise, jumping and Influence — and hand it the two it owns. Dying and concentration are " +
      "switched off here rather than left to stand aside quietly, so the split is visible.",
    values: {
      ...ALL_RULES,
      [C.dying]: false,
      [C.concentration]: false,
      [C.automation]: "off",
      [C.economy]: "warn",
    },
  },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

function read(key: string): unknown {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch {
    return undefined;
  }
}

/** The preset whose every value the world currently matches, if any. */
export function currentPreset(): string | null {
  for (const preset of PRESETS) {
    const same = Object.entries(preset.values).every(([key, value]) => read(key) === value);
    if (same) return preset.id;
  }
  return null;
}

/** Apply a preset. Returns how many settings actually changed, for the confirmation message. */
export async function applyPreset(id: string): Promise<number> {
  const preset = presetById(id);
  if (!preset) return 0;
  let changed = 0;
  for (const [key, value] of Object.entries(preset.values)) {
    if (read(key) === value) continue;
    await game.settings.set(MODULE_ID, key, value as never);
    changed += 1;
  }
  return changed;
}
