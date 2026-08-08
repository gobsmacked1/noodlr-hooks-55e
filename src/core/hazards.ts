// Noticing that the ground you are standing on is killing you, and finding somewhere else to stand.
//
// A hostile stood inside an Incendiary Cloud for the whole fight and burned to death without ever
// attempting to step out of it (user, 2026-08-05). Nothing in the planner had any concept of the square
// a creature occupies being worse than the square next to it, so a cloud of fire was, to the decision
// tree, simply weather.
//
// The check is geometric and cheap: the creature's own centre against every placed template and region
// on the scene, using the same containment primitives as the sight-screen test. Escaping is a search
// outward through the surrounding rings for the nearest point that is clear, walkable, unoccupied, and
// inside the scene — nearest, not safest, because leaving costs movement and a creature that walks
// forty feet to avoid two fire damage has made the fight worse for itself.
//
// WHICH AREAS HURT is not a geometric question, and Foundry cannot answer it: a template knows its own
// radius and nothing whatever about what is inside it. That judgement lives in `system/dnd5e-hazards.ts`
// as a name table, and this file is agnostic about how the answer was reached.

import { log } from "../constants";
import { hazardFor, type Hazard } from "../system/dnd5e-hazards";
import { inRegion, inTemplate, templateName } from "./screens";
import { blocked, centerOf, insideScene, occupied, type Point, type Spot } from "./positioning";

/** Directions tried when looking for a way out, as an eight-point compass. */
const BEARINGS: Array<{ dx: number; dy: number; name: string }> = [
  { dx: 0, dy: -1, name: "north" },
  { dx: 1, dy: -1, name: "northeast" },
  { dx: 1, dy: 0, name: "east" },
  { dx: 1, dy: 1, name: "southeast" },
  { dx: 0, dy: 1, name: "south" },
  { dx: -1, dy: 1, name: "southwest" },
  { dx: -1, dy: 0, name: "west" },
  { dx: -1, dy: -1, name: "northwest" },
];

interface Area {
  hazard: Hazard;
  contains: (point: Point) => boolean;
}

/** Every harmful area currently placed on the scene, paired with a containment test. */
function areas(): Area[] {
  const out: Area[] = [];

  for (const template of (canvas as any)?.templates?.placeables ?? []) {
    if (template?.document?.hidden) continue;
    const hazard = hazardFor(templateName(template?.document));
    if (!hazard) continue;
    out.push({ hazard, contains: (point) => inTemplate(template, point) });
  }

  for (const region of (canvas as any)?.regions?.placeables ?? []) {
    const hazard = hazardFor(String(region?.document?.name ?? ""));
    if (!hazard) continue;
    out.push({ hazard, contains: (point) => inRegion(region, point) });
  }

  return out;
}

/** What is hurting this creature where it stands. Empty is the overwhelmingly common answer. */
export function hazardsUnder(token: any): Hazard[] {
  try {
    const here = centerOf(token);
    if (!here) return [];
    return areas()
      .filter((area) => area.contains(here))
      .map((area) => area.hazard);
  } catch (err) {
    log("could not check the ground a creature is standing on:", err);
    return [];
  }
}

/**
 * The nearest spot outside every harmful area, within the creature's movement.
 *
 * Rings outward at half-square steps and takes the first clear point, so the creature leaves by the
 * shortest route rather than the safest-looking one. A wall between here and there disqualifies a spot:
 * this is a step out of a fire, not a plan.
 */
export function findWayOut(token: any, budget: number): Spot | null {
  try {
    const origin = centerOf(token);
    if (!origin || !(budget > 0)) return null;

    const harmful = areas();
    if (harmful.length === 0) return null;

    const size = Number((canvas as any)?.grid?.size) || 100;
    const perUnit = Number((canvas as any)?.grid?.distance) || 5;
    const pixelBudget = (budget / perUnit) * size;

    for (let radius = size; radius <= pixelBudget; radius += size / 2) {
      for (const bearing of BEARINGS) {
        // Diagonals are normalized so that "one ring out" means the same distance in all eight
        // directions; without it the corners reach 1.41 times as far and get tried too early.
        const length = Math.hypot(bearing.dx, bearing.dy) || 1;
        const candidate: Point = {
          x: origin.x + (bearing.dx / length) * radius,
          y: origin.y + (bearing.dy / length) * radius,
        };
        if (!insideScene(candidate)) continue;
        if (harmful.some((area) => area.contains(candidate))) continue;
        if (blocked(origin, candidate, "move")) continue;
        if (occupied(candidate, token)) continue;

        return {
          x: candidate.x,
          y: candidate.y,
          travel: Math.round((radius / size) * perUnit),
          bearing: bearing.name,
        };
      }
    }
  } catch (err) {
    log("could not find a way out of a hazard:", err);
  }
  return null;
}
