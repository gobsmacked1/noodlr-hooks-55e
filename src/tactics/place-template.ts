// Place a MeasuredTemplate for an automated area without waiting on a mouse click.
//
// Uses dnd5e's `AbilityTemplate.fromActivity` for the document shape (flags, size, type)
// when it is available, then writes origin and facing from `aim.ts` and creates the
// document. Who is inside is read off the live placeable — the same containment
// `core/screens.ts` already uses.

import { log } from "../constants";
import { inTemplate } from "../core/screens";
import { placesTemplate, templateActivityOf, templateSpecOf } from "../rules/template-targets";
import { adoptTemplateCatch } from "../rules/saves";
import {
  aimPlacement,
  excludeCaster,
  foundryShape,
  type FoundryShape,
  type Point,
} from "./aim";

export interface AimedArea {
  shape: FoundryShape;
  templates: any[];
  caught: any[];
}

function centerOf(token: any): Point | null {
  const c = token?.center;
  if (Number.isFinite(c?.x) && Number.isFinite(c?.y)) return { x: c.x, y: c.y };
  const doc = token?.document ?? token;
  const x = Number(doc?.x);
  const y = Number(doc?.y);
  const w = Number(doc?.width ?? 1);
  const h = Number(doc?.height ?? 1);
  const size = Number((canvas as any)?.grid?.size) || 100;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: x + (w * size) / 2, y: y + (h * size) / 2 };
}

function abilityTemplateClass(): { fromActivity: (activity: any, options?: object) => any[] | null } | null {
  const cls = (globalThis as any).dnd5e?.canvas?.AbilityTemplate;
  return typeof cls?.fromActivity === "function" ? cls : null;
}

function tokenIdOfPlaceable(token: any): string {
  return String(token?.document?.id ?? token?.id ?? "");
}

/** Tokens whose centre sits inside any of the placed templates. */
export function tokensInside(templates: any[], caster: any, shape: FoundryShape): any[] {
  const skip = excludeCaster(shape) ? tokenIdOfPlaceable(caster) : "";
  const out: any[] = [];
  const seen = new Set<string>();
  for (const token of (canvas as any)?.tokens?.placeables ?? []) {
    const doc = token?.document;
    const id = String(doc?.id ?? "");
    if (!id || seen.has(id)) continue;
    if (doc?.hidden || doc?.isSecret) continue;
    if (skip && id === skip) continue;
    if (!templates.some((t) => inTemplate(t, token.center ?? centerOf(token)))) continue;
    seen.add(id);
    out.push(doc);
  }
  return out;
}

/**
 * Always keep the nominated target on the catch list.
 *
 * A snapped line can miss a centre by a pixel and then auto-saves have nobody to roll.
 * The planner named this creature; leaving them off is the failure that was reported.
 */
function withNominated(caught: any[], target: any): any[] {
  const doc = target?.document ?? target;
  const id = String(doc?.id ?? "");
  if (!id) return caught;
  if (caught.some((d) => String(d?.id ?? "") === id)) return caught;
  return [...caught, doc];
}

async function createFromActivity(
  activity: any,
  placement: { x: number; y: number; direction: number },
): Promise<any[]> {
  const AbilityTemplate = abilityTemplateClass();
  const built = AbilityTemplate?.fromActivity(activity, placement);
  if (!built?.length) return [];

  const scene = (canvas as any)?.scene;
  if (!scene?.createEmbeddedDocuments) return [];

  const data = built.map((object: any) => {
    const doc = object?.document ?? object;
    doc.updateSource?.(placement);
    return typeof doc.toObject === "function" ? doc.toObject() : { ...doc, ...placement };
  });
  return scene.createEmbeddedDocuments("MeasuredTemplate", data);
}

async function createFromSpec(
  activity: any,
  shape: FoundryShape,
  spec: { size: number; width?: number },
  placement: { x: number; y: number; direction: number },
): Promise<any[]> {
  const scene = (canvas as any)?.scene;
  if (!scene?.createEmbeddedDocuments) return [];
  const user = (globalThis as any).game?.user;
  const item = activity?.item;
  const payload: Record<string, unknown> = {
    t: shape,
    user: user?.id,
    distance: spec.size,
    direction: placement.direction,
    x: placement.x,
    y: placement.y,
    fillColor: user?.color,
    flags: {
      dnd5e: {
        dimensions: { size: spec.size, width: spec.width },
        item: item?.uuid,
        origin: activity?.uuid,
      },
    },
  };
  if (shape === "cone") {
    payload.angle = (CONFIG as any)?.MeasuredTemplate?.defaults?.angle ?? 53;
  }
  if (shape === "ray") {
    payload.width = spec.width ?? (canvas as any)?.dimensions?.distance ?? 5;
  }
  if (shape === "rect") {
    payload.width = spec.size;
  }
  return scene.createEmbeddedDocuments("MeasuredTemplate", [payload]);
}

export async function placeAimedTemplate(
  activity: any,
  caster: any,
  target: any,
): Promise<AimedArea | null> {
  if (!placesTemplate(activity)) return null;
  const placer = templateActivityOf(activity);
  const spec = templateSpecOf(placer);
  const shape = foundryShape(spec.type);
  if (!shape || !(spec.size > 0)) {
    log(`aim: ${String(activity?.name ?? activity?.item?.name ?? "activity")} has no placeable area`);
    return null;
  }

  const from = centerOf(caster);
  const to = centerOf(target);
  if (!from || !to) {
    log("aim: caster or target has no position");
    return null;
  }

  const placement = aimPlacement(shape, from, to);
  let created: any[] = [];
  try {
    created = await createFromActivity(placer, placement);
  } catch (err) {
    log("aim: AbilityTemplate.fromActivity failed, writing the document ourselves:", err);
  }
  if (!created.length) {
    try {
      created = await createFromSpec(placer, shape, spec, placement);
    } catch (err) {
      log("aim: could not create the MeasuredTemplate:", err);
      return null;
    }
  }
  if (!created.length) return null;

  const placeables = created.map((doc) => doc?.object ?? (canvas as any)?.templates?.get?.(doc.id) ?? doc);
  const caught = withNominated(tokensInside(placeables, caster, shape), target);
  log(
    `aim: placed ${shape} (${spec.size}) — ${caught.map((d) => d?.name).filter(Boolean).join(", ") || "nobody"}`,
  );
  return { shape, templates: created, caught };
}

export async function stampCatch(message: any, docs: any[]): Promise<void> {
  if (!message) return;
  const targets = docs
    .map((doc) => {
      const actor = doc?.actor;
      if (!actor?.uuid) return null;
      const ac = Number(actor.system?.attributes?.ac?.value);
      return {
        name: String(doc?.name ?? actor.name ?? ""),
        img: actor.img,
        uuid: actor.uuid,
        ac: Number.isFinite(ac) ? ac : null,
      };
    })
    .filter(Boolean);
  try {
    if (typeof message.setFlag === "function") await message.setFlag("dnd5e", "targets", targets);
    else if (typeof message.update === "function") await message.update({ "flags.dnd5e.targets": targets });
  } catch (err) {
    log("aim: could not stamp who the area caught:", err);
  }
  adoptTemplateCatch(message);
}
