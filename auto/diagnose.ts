// Console tools for the movement problem, and for the scene it is being tested in.
//
// `testMove()` exists because three releases of reasoning about movement produced three wrong answers.
// It does not reason: it moves the selected token one square, in front of you, and reports exactly what
// core said at each stage — then puts the token back. One command, one paste, no combat required.
//
// `flattenElevation()` removes elevation as a variable while that is being diagnosed, and is reversible.

import { log, MODULE_ID } from "../../constants";
import { blocked, centerOf, insideScene, occupied, type Point } from "./positioning";

/** Modules known to hook, veto, or silently rewrite token movement. Worth naming if present. */
const SUSPECTS = [
  "notyourturn",
  "not-your-turn",
  "token-warp",
  "rideable",
  "monks-active-tiles",
  "terrainmapper",
  "terrain-mapper",
  "levels",
  "wall-height",
  "routinglib",
  "patrol",
  "about-face",
  "item-piles",
];

function activeSuspects(): string[] {
  const found: string[] = [];
  for (const [id, mod] of (game.modules as any)?.entries?.() ?? []) {
    if (!mod?.active) continue;
    const key = String(id).toLowerCase();
    if (SUSPECTS.some((s) => key === s || key.includes(s)))
      found.push(`${id}@${mod.version ?? "?"}`);
  }
  return found;
}

function snapshot(doc: any): { x: number; y: number; elevation: number } {
  const src = doc?._source ?? doc;
  return {
    x: Number(src?.x) || 0,
    y: Number(src?.y) || 0,
    elevation: Number(src?.elevation) || 0,
  };
}

interface AttemptReport {
  attempt: string;
  moved: boolean;
  returned: unknown;
  constrained: unknown;
  state: unknown;
  from: string;
  to: string;
}

/** One move attempt, reported in full. Returns whether the token's stored position actually changed. */
async function attempt(
  doc: any,
  label: string,
  waypoint: Record<string, unknown>,
  options: Record<string, unknown>,
): Promise<AttemptReport> {
  const before = snapshot(doc);
  let completed: unknown;
  let threw: unknown;
  try {
    completed = await Promise.race([
      doc.move(waypoint, options),
      new Promise((resolve) => setTimeout(() => resolve("TIMED OUT (paused?)"), 8000)),
    ]);
  } catch (err) {
    threw = err;
  }
  const after = snapshot(doc);
  return {
    attempt: label,
    moved: Math.hypot(after.x - before.x, after.y - before.y) > 1,
    returned: threw ? `THREW: ${String((threw as any)?.message ?? threw)}` : completed,
    constrained: doc?.movement?.constrained,
    state: doc?.movement?.state,
    from: `${before.x},${before.y}@${before.elevation}`,
    to: `${after.x},${after.y}@${after.elevation}`,
  };
}

/**
 * Move the selected token one square east and report what happened, then put it back.
 *
 * Escalates deliberately: normal walk, then walls ignored, then `displace` (which skips wall testing
 * entirely by design). Whichever step first succeeds names the cause — and if even `displace` fails,
 * the refusal is coming from a module hook rather than from geometry, which the `noHook` attempt then
 * confirms.
 */
export async function testMove(): Promise<Record<string, unknown> | undefined> {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  if (!token) {
    ui.notifications?.warn("Select a token first, then run testMove() again.");
    return undefined;
  }
  const doc = token.document ?? token;
  const grid = Number((canvas as any)?.grid?.size) || 100;
  const origin = centerOf(token);
  if (!origin) {
    console.warn("Noodlr | that token has no readable position");
    return undefined;
  }
  const start = snapshot(doc);

  // Everything is collected into one object and printed as text at the end. The first version wrote
  // straight to a console group, and the report that came back from play was the returned Promise
  // expanded in the inspector — the findings themselves were not copyable (2026-08-04).
  const report: Record<string, unknown> = {
    token: {
      name: doc?.name,
      ...start,
      width: doc?.width,
      height: doc?.height,
      hidden: doc?.hidden,
      speeds: doc?.actor?.system?.attributes?.movement,
    },
    world: {
      foundry: game.version,
      system: `${game.system?.id}@${(game.system as any)?.version}`,
      scene: (canvas as any)?.scene?.name,
      gridSize: grid,
      gridDistance: (canvas as any)?.grid?.distance,
      // The setting that does NOT apply to programmatic moves in core, which Noodlr now mirrors itself.
      unconstrainedMovementSetting: (() => {
        try {
          return game.settings.get("core", "unconstrainedMovement");
        } catch {
          return "(unreadable)";
        }
      })(),
    },
    modulesThatTouchMovement: activeSuspects(),
  };

  // What our own pre-flight thinks of the eight neighbouring squares.
  const compass: Array<[string, number, number]> = [
    ["E", 1, 0],
    ["SE", 1, 1],
    ["S", 0, 1],
    ["SW", -1, 1],
    ["W", -1, 0],
    ["NW", -1, -1],
    ["N", 0, -1],
    ["NE", 1, -1],
  ];
  const neighbours: Record<string, string> = {};
  let firstFree: Point | null = null;
  for (const [name, dx, dy] of compass) {
    const point = { x: origin.x + dx * grid, y: origin.y + dy * grid };
    const reasons: string[] = [];
    if (!insideScene(point)) reasons.push("outside scene");
    if (occupied(point, token)) reasons.push("occupied");
    const wall = blocked(origin, point, "move");
    if (wall === true) reasons.push("wall (our 2-D test)");
    if (wall === null) reasons.push("collision API unreadable");
    neighbours[name] = reasons.length ? reasons.join(", ") : "clear";
    if (!reasons.length && !firstFree) firstFree = point;
  }
  console.log("neighbouring squares:", neighbours);

  const target = firstFree ?? { x: origin.x + grid, y: origin.y };
  const corner = {
    x: Math.round(target.x - (grid * (Number(doc?.width) || 1)) / 2),
    y: Math.round(target.y - (grid * (Number(doc?.height) || 1)) / 2),
  };
  const waypoint = { ...corner, elevation: start.elevation, explicit: true, checkpoint: true };

  // Stop at the first attempt that works: the point is to find the LEAST permissive call that moves
  // this token, because that is what names the cause.
  const attempts: AttemptReport[] = [];
  const escalation: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["walk, walls enforced", waypoint, { constrainOptions: { ignoreCost: true } }],
    [
      "walk, walls ignored",
      waypoint,
      { constrainOptions: { ignoreCost: true, ignoreWalls: true } },
    ],
    ["displace (skips wall testing)", { ...waypoint, action: "displace" }, {}],
    ["displace, hooks disabled", { ...waypoint, action: "displace" }, { noHook: true }],
  ];
  for (const [label, point, options] of escalation) {
    const result = await attempt(doc, label, point, {
      method: "api",
      showRuler: false,
      ...options,
    });
    attempts.push(result);
    if (result.moved) break;
  }
  report.attempts = attempts;

  const winner = attempts.find((a) => a.moved);
  if (winner) {
    // Instant on purpose: this is a diagnostic putting things back, not a creature walking.
    try {
      await doc.move(
        { ...start, action: "displace", explicit: true, checkpoint: true },
        { method: "api", showRuler: false },
      );
    } catch (err) {
      console.warn("Noodlr | could not return the token to its starting square:", err);
    }
  }
  report.result = winner
    ? `MOVED on "${winner.attempt}" - the least permissive call that works, so that names the cause.`
    : "NOTHING moved it, not even displace with hooks disabled. That points at permissions or a wrapped update, not geometry.";

  console.log("Noodlr | movement test - copy everything below this line:");
  console.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * Set every token in the current scene to elevation 0, remembering what they were.
 *
 * Requested while diagnosing movement on an elevated barbican: one less variable. Reversible through
 * `restoreElevation()`, which reads the backup stored on the scene itself, so it survives a reload.
 */
export async function flattenElevation(): Promise<number> {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Only a GM can change token elevations.");
    return 0;
  }
  const scene: any = (canvas as any)?.scene;
  if (!scene) return 0;

  const backup: Record<string, number> = {};
  const updates: Array<Record<string, unknown>> = [];
  for (const tokenDoc of scene.tokens ?? []) {
    const elevation = Number(tokenDoc?.elevation) || 0;
    if (elevation === 0) continue;
    backup[tokenDoc.id] = elevation;
    updates.push({ _id: tokenDoc.id, elevation: 0 });
  }
  if (updates.length === 0) {
    log("elevation: every token in this scene is already at 0");
    return 0;
  }

  // Store the backup BEFORE moving anything, so an interrupted run is still reversible.
  await scene.setFlag(MODULE_ID, "elevationBackup", backup);
  await scene.updateEmbeddedDocuments("Token", updates);
  log(
    `elevation: flattened ${updates.length} token(s) to 0 — api.restoreElevation() puts them back`,
  );
  ui.notifications?.info(`Noodlr: ${updates.length} token(s) set to elevation 0.`);
  return updates.length;
}

/** Undo `flattenElevation()` for the current scene. */
export async function restoreElevation(): Promise<number> {
  if (!game.user?.isGM) return 0;
  const scene: any = (canvas as any)?.scene;
  const backup: Record<string, number> = scene?.getFlag(MODULE_ID, "elevationBackup") ?? {};
  const updates = Object.entries(backup)
    .filter(([id]) => scene.tokens.get(id))
    .map(([id, elevation]) => ({ _id: id, elevation }));

  if (updates.length === 0) {
    log("elevation: nothing to restore in this scene");
    return 0;
  }
  await scene.updateEmbeddedDocuments("Token", updates);
  await scene.unsetFlag(MODULE_ID, "elevationBackup");
  log(`elevation: restored ${updates.length} token(s)`);
  return updates.length;
}
