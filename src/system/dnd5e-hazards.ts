// Areas that hurt whatever stands in them, by name. D&D 5e ONLY.
//
// SYSTEM-SPECIFIC BY NECESSITY, and quarantined here for the same reason as `dnd5e-concealment.ts`:
// there is no system-agnostic way to ask "will this square hurt me". Foundry knows a template is a
// twenty-foot sphere; it does not know the sphere is on fire. The damage lives in a spell description,
// or in an Active Effect a premades package applies on entry, or in a Region behaviour a GM wrote by
// hand — and none of those are readable in general. So this is a list of names, checked with regular
// expressions, exactly like the concealment table. It is a heuristic, and it is meant to be.
//
// WHAT GOES ON THE LIST: persistent areas that damage or trap a creature that stays in them. What stays
// off: instantaneous bursts, which are over before anyone could walk out (a Fireball's template lingers
// on the canvas long after the fire has gone, and a creature fleeing yesterday's explosion looks
// broken); areas that only matter on entry; and anything purely beneficial.
//
// `severity` is how urgently a creature wants out, not how much damage it deals — several of these do
// no damage at all and are still somewhere to leave. It is a plain multiplier on the escape option's
// score, and nothing else reads it.

export interface Hazard {
  label: string;
  pattern: RegExp;
  severity: number;
  /** Trapped creatures cannot simply walk out; the option is worth less because it may fail. */
  restrains?: boolean;
}

export const HAZARDS: Hazard[] = [
  // Fire and its relatives. Incendiary Cloud is the one that prompted this: a hostile stood in it for
  // three rounds and burned to death without ever trying to leave (user, 2026-08-05).
  { label: "Incendiary Cloud", pattern: /incendiary\s*cloud/i, severity: 1.6 },
  { label: "Wall of Fire", pattern: /wall\s*of\s*fire/i, severity: 1.5 },
  { label: "Flaming Sphere", pattern: /flaming\s*sphere/i, severity: 1.2 },
  { label: "Fire Storm", pattern: /fire\s*storm/i, severity: 1.4 },
  { label: "Immolation", pattern: /immolation/i, severity: 1.2 },

  // Poison and necrosis.
  { label: "Cloudkill", pattern: /cloudkill/i, severity: 1.6 },
  { label: "Stinking Cloud", pattern: /stinking\s*cloud/i, severity: 1.1 },
  { label: "Hunger of Hadar", pattern: /hunger\s*of\s*hadar/i, severity: 1.5 },
  { label: "Sickening Radiance", pattern: /sickening\s*radiance/i, severity: 1.4 },
  { label: "Cloud of Daggers", pattern: /cloud\s*of\s*daggers/i, severity: 1.3 },

  // Radiant and divine.
  { label: "Spirit Guardians", pattern: /spirit\s*guardians/i, severity: 1.4 },
  { label: "Moonbeam", pattern: /moonbeam/i, severity: 1.3 },
  { label: "Blade Barrier", pattern: /blade\s*barrier/i, severity: 1.5 },
  { label: "Sunbeam", pattern: /sunbeam/i, severity: 1.2 },

  // Storms and the elements.
  { label: "Ice Storm", pattern: /ice\s*storm/i, severity: 1.1 },
  { label: "Sleet Storm", pattern: /sleet\s*storm/i, severity: 1.0 },
  { label: "Storm Sphere", pattern: /storm\s*sphere/i, severity: 1.2 },
  { label: "Maelstrom", pattern: /maelstrom/i, severity: 1.2 },
  { label: "Whirlwind", pattern: /whirlwind/i, severity: 1.2 },

  // Ground that bites. Worth leaving even when it deals nothing, because standing in it is what makes
  // everything else land.
  { label: "Spike Growth", pattern: /spike\s*growth/i, severity: 1.3 },
  { label: "Grease", pattern: /grease/i, severity: 0.8 },
  { label: "Caltrops", pattern: /caltrops/i, severity: 0.8 },
  { label: "Web", pattern: /\bweb\b/i, severity: 0.9, restrains: true },
  {
    label: "Evard's Black Tentacles",
    pattern: /black\s*tentacles/i,
    severity: 1.4,
    restrains: true,
  },
  { label: "Entangle", pattern: /entangle/i, severity: 0.9, restrains: true },

  // Regions and GM-drawn ground. Named plainly because a GM naming a region "Lava" has said everything
  // that needs saying.
  { label: "Lava", pattern: /\blava\b|\bmagma\b/i, severity: 1.8 },
  { label: "Acid", pattern: /\bacid\b/i, severity: 1.4 },
  { label: "Fire", pattern: /\b(?:bonfire|brazier|flames?|burning)\b/i, severity: 1.3 },
  { label: "Poison", pattern: /\b(?:poison|toxic|miasma)\b/i, severity: 1.3 },
  { label: "Hazard", pattern: /\bhazard(?:ous)?\b|\bdamaging\b/i, severity: 1.2 },
];

/** The hazard this name describes, if any. */
export function hazardFor(name: string): Hazard | null {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return null;
  return HAZARDS.find((h) => h.pattern.test(trimmed)) ?? null;
}
