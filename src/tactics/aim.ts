// Where an automated area lands, given one caster and one nominated target.
//
// dnd5e's `#placeTemplate` calls `AbilityTemplate.drawPreview()`, which waits for a mouse click.
// `configure: false` does not skip that. An automated Lightning Bolt therefore spends the slot and
// never fires — a Dex save the GM allows by hand still has no area, so nothing takes damage.
//
// This is the cheap half of Phase 5: aim AT the creature the planner already named. The scored
// search (max party / min allied hostiles, candidate origins) is still open. A 1v1 line or cone
// aimed at the barbarian is the case that was reported.

export interface Point {
  x: number;
  y: number;
}

export type FoundryShape = "ray" | "cone" | "circle" | "rect";

/** Map a dnd5e `target.template.type` onto Foundry's MeasuredTemplate `t`. */
export function foundryShape(areaType: string): FoundryShape | null {
  switch (String(areaType ?? "").trim()) {
    case "line":
    case "wall":
      return "ray";
    case "cone":
      return "cone";
    case "circle":
    case "cylinder":
    case "sphere":
    case "radius":
      return "circle";
    case "cube":
    case "square":
      return "rect";
    default:
      return null;
  }
}

/**
 * Foundry direction: degrees, 0 = east, increasing clockwise on a y-down canvas.
 * `atan2(dy, dx)` with canvas y is already clockwise from east.
 */
export function directionDeg(from: Point, to: Point): number {
  const deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** Origin of the template: caster for a line/cone, the nominated target for a blob. */
export function aimOrigin(shape: FoundryShape, from: Point, to: Point): Point {
  if (shape === "circle" || shape === "rect") return { x: to.x, y: to.y };
  return { x: from.x, y: from.y };
}

export function aimPlacement(
  shape: FoundryShape,
  from: Point,
  to: Point,
): { x: number; y: number; direction: number } {
  const origin = aimOrigin(shape, from, to);
  return {
    x: origin.x,
    y: origin.y,
    direction: directionDeg(from, to),
  };
}

/** The caster is in their own Lightning Bolt's first square; they are not a target of it. */
export function excludeCaster(shape: FoundryShape): boolean {
  return shape === "ray" || shape === "cone";
}
