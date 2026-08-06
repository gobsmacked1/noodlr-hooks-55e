// What is standing in the way: fog, darkness, and illusory hedges placed between two creatures.
//
// The party does not usually cast Fog Cloud on themselves. They drop it, or a sphere of Darkness, or an
// illusory brick wall, in the gap between themselves and the guard, and the guard has to get past that
// before it has any chance at the people behind it (user, 2026-08-04). Modelling those as effects on the
// hider — which is what the first pass did — gets the common case exactly backwards, because nothing is
// ever applied to the hider at all. They are placed objects, and the question is geometric.
//
// WHERE A SCREEN CAN COME FROM, in descending order of how often it actually happens:
//   * a MeasuredTemplate, which is how dnd5e places nearly every area spell;
//   * a Region, which is how a GM marks a standing hazard or a permanently foggy room;
//   * an AmbientLight configured as a darkness source, which is how several modules and some GMs build
//     the Darkness spell instead of using a template.
//
// NAMING IS THE HARD PART, not the intersection test. Foundry stores a template with no record of what
// spell created it beyond a link back to the originating item, and that link has moved around across
// dnd5e versions, so several paths are tried and a failure to resolve a name simply means the screen is
// ignored. That is the right failure: an unrecognised template must not start blocking sight.
//
// The test itself is a walk along the line between the two tokens, sampling at half a grid square. A
// screen only has to be found once. Sampling rather than solving analytically is deliberate — templates,
// regions and darkness sources each expose a different containment API and none of them expose a
// segment-intersection one, so the shared primitive is "is this point inside you".

import { log } from "../../constants";
import { screenFor, type Concealment } from "../systems/dnd5e-concealment";

/** How finely the line between two creatures is walked, as a fraction of a grid square. */
const STEP = 0.5;

/** Never sample more than this many points, however long the line is. */
const MAX_SAMPLES = 80;

/** Every concealing screen standing between two tokens, without duplicates. */
export function screensBetween(spotter: any, target: any): Concealment[] {
  const found = new Map<string, Concealment>();
  try {
    const points = walk(spotter?.center, target?.center);
    if (points.length === 0) return [];
    for (const candidate of candidates()) {
      if (found.has(candidate.screen.label)) continue;
      if (points.some((point) => candidate.contains(point))) {
        found.set(candidate.screen.label, candidate.screen);
      }
    }
  } catch (err) {
    log("could not check what stands between two creatures:", err);
  }
  return [...found.values()];
}

/** Points along the line from one centre to the other, endpoints included. */
function walk(from: any, to: any): Array<{ x: number; y: number }> {
  if (!from || !to) return [];
  const size = Number((canvas as any)?.grid?.size) || 100;
  const span = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(span / (size * STEP))));
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return points;
}

interface Candidate {
  screen: Concealment;
  contains: (point: { x: number; y: number }) => boolean;
}

/** Everything on the scene that might be a screen, paired with a way to test a point against it. */
function candidates(): Candidate[] {
  const out: Candidate[] = [];

  for (const template of (canvas as any)?.templates?.placeables ?? []) {
    const screen = screenFor(templateName(template?.document));
    if (!screen) continue;
    out.push({ screen, contains: (point) => inTemplate(template, point) });
  }

  for (const region of (canvas as any)?.regions?.placeables ?? []) {
    const screen = screenFor(String(region?.document?.name ?? ""));
    if (!screen) continue;
    out.push({ screen, contains: (point) => inRegion(region, point) });
  }

  // A negative light is magical darkness by construction; there is nothing else it can be.
  for (const light of (canvas as any)?.lighting?.placeables ?? []) {
    if (!light?.document?.config?.negative || light.document.hidden) continue;
    const screen = screenFor("darkness");
    if (!screen) continue;
    const doc = light.document;
    out.push({ screen, contains: (point) => inDarkness(point, doc, doc.config) });
  }

  // Darkness that walks. The warlock with Devil's Sight casts it on themselves and strolls through the
  // fight seeing perfectly well, which is a real build and not an edge case (user, 2026-08-05). It
  // renders as light emitted BY the token, which the ambient-light layer above never sees. The line we
  // walk includes both endpoints, so a creature standing in its own darkness is caught the same way as
  // one standing behind somebody else's.
  for (const token of (canvas as any)?.tokens?.placeables ?? []) {
    const config: any = token?.document?.light;
    if (!config?.negative) continue;
    const screen = screenFor("darkness");
    if (!screen) continue;
    out.push({ screen, contains: (point) => inDarkness(point, token.center, config) });
  }

  return out;
}

/**
 * The name of whatever spell placed this template.
 *
 * dnd5e has moved the origin link more than once, and in current versions it can point at an Activity
 * rather than the Item, so the resolved document is asked for its own name and then its item's.
 */
export function templateName(doc: any): string {
  const direct = String(doc?.name ?? "");
  if (direct) return direct;

  const flags: any = doc?.flags?.dnd5e ?? {};
  const uuid = String(flags.origin ?? flags.item?.uuid ?? flags.spellUuid ?? "");
  if (!uuid) return "";
  try {
    const found: any = (globalThis as any).fromUuidSync?.(uuid);
    return String(found?.name ?? found?.item?.name ?? found?.parent?.name ?? "");
  } catch {
    return "";
  }
}

export function inTemplate(template: any, point: { x: number; y: number }): boolean {
  try {
    const doc = template?.document;
    const shape = template?.shape;
    if (shape?.contains) return Boolean(shape.contains(point.x - doc.x, point.y - doc.y));
    // No shape built yet (a template off-screen may not have been drawn): bounds are a fair stand-in.
    return Boolean(template?.bounds?.contains?.(point.x, point.y));
  } catch {
    return false;
  }
}

export function inRegion(region: any, point: { x: number; y: number }): boolean {
  try {
    const test = { x: point.x, y: point.y, elevation: 0 };
    if (typeof region?.document?.testPoint === "function") return region.document.testPoint(test);
    if (typeof region?.testPoint === "function") return region.testPoint(test);
    return Boolean(region?.bounds?.contains?.(point.x, point.y));
  } catch {
    return false;
  }
}

/** Is a point inside a darkness source centred on `origin` with the given light config? */
function inDarkness(
  point: { x: number; y: number },
  origin: { x: number; y: number },
  config: any,
): boolean {
  try {
    const grid: any = (canvas as any)?.grid;
    const perUnit = Number(grid?.size) / Number(grid?.distance || 5);
    const radius = Math.max(Number(config?.dim) || 0, Number(config?.bright) || 0) * perUnit;
    if (!(radius > 0)) return false;
    return Math.hypot(point.x - origin.x, point.y - origin.y) <= radius;
  } catch {
    return false;
  }
}
