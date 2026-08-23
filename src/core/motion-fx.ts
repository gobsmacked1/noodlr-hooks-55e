// Visual polish on the Token subclass that already owns sheet pace.
//
// These helpers know nothing about Foundry documents. The Token methods paint a mesh and must
// restore it: a hung animation that left a burrower invisible is worse than no vanish at all.
// Do not write `hidden` on the document — that is a rules flag, not a costume.

/** Alpha while a burrow animation is in flight. 0 is vanish; restore is the caller's job. */
export function burrowAlpha(done: boolean, resting = 1): number {
  return done ? resting : 0;
}

/**
 * A few pixels of hover, one sine cycle per segment.
 *
 * Foundry has no per-token wind effect. Scene weather is global. The `wind` token transition
 * is a texture-swap easing (Wild Shape), not a flight trail. This is the stock-only polish.
 */
export function flyBobPx(progress01: number, amplitude = 4): number {
  const t = Number(progress01);
  if (!Number.isFinite(t)) return 0;
  return Math.sin(Math.min(1, Math.max(0, t)) * Math.PI * 2) * amplitude;
}

export function movementActionOf(options: { action?: string } | null | undefined, fallback = ""): string {
  return String(options?.action || fallback || "").toLowerCase();
}

type MeshState = { alpha: number; pivotY: number };

const saved = new WeakMap<object, MeshState>();

function meshOf(token: any): any {
  return token?.mesh ?? null;
}

function remember(token: object, mesh: any): MeshState {
  let state = saved.get(token);
  if (!state) {
    state = {
      alpha: Number(mesh.alpha ?? 1),
      pivotY: Number(mesh.pivot?.y ?? 0),
    };
    saved.set(token, state);
  }
  return state;
}

function lastFrame(context: any): boolean {
  const duration = Number(context?.duration);
  const time = Number(context?.time);
  if (!(duration >= 0) || !Number.isFinite(time)) return false;
  const chained = Number(context?.chain?.length ?? 0) > 0;
  return time >= duration && !chained;
}

/** Paint vanish / hover for this frame. Safe to call when there is no mesh. */
export function paintMotionFx(token: any, context: any): void {
  const mesh = meshOf(token);
  if (!mesh) return;
  const action = movementActionOf(context?.options, token?.document?.movementAction);
  const done = lastFrame(context);
  const base = remember(token, mesh);

  if (action === "burrow") {
    mesh.alpha = burrowAlpha(done, base.alpha);
    if (done) saved.delete(token);
    return;
  }
  if (action === "fly") {
    const duration = Math.max(Number(context?.duration) || 1, 1);
    const t = Number(context?.time) / duration;
    if (mesh.pivot) mesh.pivot.y = done ? base.pivotY : base.pivotY + flyBobPx(t);
    if (done) saved.delete(token);
  }
}

/** Fail-open: always put the mesh back. Called when no animation context remains. */
export function restoreMotionFx(token: any): void {
  const mesh = meshOf(token);
  const base = token ? saved.get(token) : undefined;
  if (mesh && base) {
    mesh.alpha = base.alpha;
    if (mesh.pivot) mesh.pivot.y = base.pivotY;
  }
  if (token) saved.delete(token);
}
