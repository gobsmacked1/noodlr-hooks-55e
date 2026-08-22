// Clickable token-corner status icons.
//
// Core draws `temporaryEffects` as inert PIXI sprites (`Token#_drawEffect`). Paladin aura badges
// stay inert on purpose. Wild Shape and a saddle need a click that is *not* a HUD toggle — Token
// HUD skips `hud: false`, so the sprite itself is the affordance.
//
// PIXI `pointerdown` on those sprites is not enough. Foundry's MouseInteractionManager binds
// `clickLeft` to the Token as a whole, and that path never asks the effect children. Hit-test
// inside Token#_onClickLeft using `interactionData.origin` (layer space), not `event.global`
// (screen space). The wrap must return false so MIM does not also select/drag.

type BadgeHandler = (token: any) => void | Promise<void>;

interface BadgeBinding {
  img: string;
  handle: BadgeHandler;
}

const bindings: BadgeBinding[] = [];
const recent = new Map<string, number>();
const RECENT_MS = 400;

export function registerBadgeClick(img: string, handle: BadgeHandler): void {
  if (!img || bindings.some((b) => b.img === img && b.handle === handle)) return;
  bindings.push({ img, handle });
  patchTokenClicks();
}

export function wireEffectClicks(token: any, img: string, onClick: BadgeHandler): void {
  const effects = token?.effects;
  if (!effects?.children || !img) return;
  try {
    effects.eventMode = effects.eventMode === "none" ? "passive" : effects.eventMode;
    effects.interactiveChildren = true;
  } catch {
    /* PIXI version without those fields */
  }
  for (const child of badgeSprites(token, img)) {
    child.noodlrBadge = img;
    makeClickable(child, () => fireBadge(token, img, onClick));
  }
}

export function matchesImg(src: string, img: string): boolean {
  if (!src || !img) return false;
  const a = src.replace(/\\/g, "/");
  const b = img.replace(/\\/g, "/");
  if (a === b || a.endsWith(b) || a.includes(b)) return true;
  const file = b.slice(b.lastIndexOf("/") + 1);
  return file.length > 0 && a.endsWith(`/${file}`);
}

function spriteSrc(child: any): string {
  const tex = child?.texture;
  const src =
    tex?.baseTexture?.resource?.src ?? tex?.baseTexture?.resource?.url ?? child?.textureSrc;
  return src ? String(src) : "";
}

function asPoint(value: any): { x: number; y: number } | null {
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  return null;
}

/**
 * Foundry's click is `interactionData.origin` in **layer** space (`getLocalPosition(layer)`).
 * PIXI `event.global` is screen space (`screenOrigin` is copied from it). Sprite `getBounds()`
 * is world space. Comparing global to bounds is why the restore icon looked clickable and
 * never fired.
 */
export function pointerForHit(token: any, event: any): { x: number; y: number } | null {
  const data = event?.interactionData;
  const layerPt = asPoint(data?.origin) ?? asPoint(data?.destination);
  const layer = token?.layer ?? (globalThis as any).canvas?.tokens;
  if (layerPt) {
    if (typeof layer?.toGlobal === "function") {
      try {
        const world = asPoint(layer.toGlobal(layerPt));
        if (world) return world;
      } catch {
        /* canvas not up */
      }
    }
    return layerPt;
  }
  return (
    asPoint(event?.global) ?? asPoint(event?.data?.global) ?? asPoint(event?.interactionData?.destination)
  );
}

const HIT_PAD = 6;

function boundsContain(child: any, pt: { x: number; y: number }): boolean {
  try {
    if (typeof child.containsPoint === "function" && child.containsPoint(pt)) return true;
  } catch {
    /* some sprites throw if they have no texture yet */
  }
  const b = child.getBounds?.();
  if (!b) return false;
  const x = Number(b.x);
  const y = Number(b.y);
  const w = Number(b.width);
  const h = Number(b.height);
  if (![x, y, w, h].every(Number.isFinite)) return false;
  if (typeof b.contains === "function" && b.contains(pt.x, pt.y)) return true;
  return (
    pt.x >= x - HIT_PAD && pt.x <= x + w + HIT_PAD && pt.y >= y - HIT_PAD && pt.y <= y + h + HIT_PAD
  );
}

function effectSprites(token: any): any[] {
  const children = token?.effects?.children;
  if (!children?.length) return [];
  const bg = token.effects.bg;
  const overlay = token.effects.overlay;
  return [...children].filter((c) => c && c !== bg && c !== overlay);
}

/** Prefer a tagged / textured match; fall back to the AE's own img (texture src can be the 404 fallback). */
export function badgeSprites(token: any, img: string): any[] {
  if (!token || !img) return [];
  const icons = effectSprites(token);
  const tagged = icons.filter(
    (c) => c.noodlrBadge === img || matchesImg(spriteSrc(c), img),
  );
  if (tagged.length) return tagged;
  const aes = token.actor?.temporaryEffects ?? [];
  const out: any[] = [];
  let i = 0;
  for (const ae of aes) {
    if (!ae?.img) continue;
    try {
      if (typeof ae.getFlag === "function" && ae.getFlag("core", "overlay")) continue;
    } catch {
      /* ignore */
    }
    const sprite = icons[i++];
    if (sprite && matchesImg(String(ae.img), img)) out.push(sprite);
  }
  return out;
}

export function badgeHit(token: any, img: string, event: any): boolean {
  if (!token || !img) return false;
  const sprites = badgeSprites(token, img);
  if (!sprites.length) return false;
  const pt = pointerForHit(token, event);
  for (const child of sprites) {
    if (pt && boundsContain(child, pt)) return true;
    const target = event?.target;
    if (target && (target === child || child.contains?.(target))) return true;
  }
  return false;
}

function fireBadge(token: any, img: string, handle: BadgeHandler): boolean {
  const key = `${String(token?.id ?? token?.document?.id ?? "")}:${img}`;
  const now = Date.now();
  const prev = recent.get(key) ?? 0;
  if (now - prev < RECENT_MS) return true;
  recent.set(key, now);
  void handle(token);
  return true;
}

function consumeBadgeClick(token: any, event: any): boolean {
  for (const { img, handle } of bindings) {
    if (badgeHit(token, img, event)) return fireBadge(token, img, handle);
  }
  return false;
}

function patchTokenClicks(): void {
  const proto = (globalThis as any).CONFIG?.Token?.objectClass?.prototype;
  if (!proto || proto.noodlrBadgeClick) return;
  proto.noodlrBadgeClick = true;
  const orig = proto._onClickLeft;
  proto._onClickLeft = function noodlrBadgeClickLeft(event: any) {
    if (consumeBadgeClick(this, event)) {
      event?.stopPropagation?.();
      event?.preventDefault?.();
      return false;
    }
    return typeof orig === "function" ? orig.call(this, event) : undefined;
  };
}

/**
 * Wrap Token#_onClickLeft at `setup`, after the Speed subclass is installed. MouseInteractionManager
 * copies `this._onClickLeft` when the token is drawn, and canvas init finishes before `ready`, so a
 * wrap from `ready` never reaches the tokens already on the scene.
 */
export function installTokenBadgeClicks(): void {
  const HooksRef = (globalThis as any).Hooks;
  if (HooksRef?.once) {
    HooksRef.once("setup", () => patchTokenClicks());
  }
}

export function rebindTokenBadgeClicks(): void {
  patchTokenClicks();
  try {
    for (const token of (globalThis as any).canvas?.tokens?.placeables ?? []) {
      const mgr = token.mouseInteractionManager;
      if (!mgr?.callbacks) continue;
      mgr.callbacks.clickLeft = token._onClickLeft.bind(token);
    }
  } catch {
    /* canvas not up */
  }
}

/**
 * Whether the sprite half of a badge is alive for this token, in words.
 *
 * "The icon does nothing" has two possible homes — the token sprite and an on-screen effect strip —
 * and neither is visible from the source. Reports the wrap, the sprite count and whether the sprite
 * took a pointer listener, so a report names which half to look at instead of both.
 */
export function describeBadgeWiring(token: any, img: string): string {
  const proto = (globalThis as any).CONFIG?.Token?.objectClass?.prototype;
  const wrapped = Boolean(proto?.noodlrBadgeClick);
  const sprites = badgeSprites(token, img);
  if (sprites.length === 0) {
    const drawn = effectSprites(token).length;
    return `sprite: none matched (${drawn} icon(s) drawn), wrap ${wrapped ? "on" : "MISSING"}`;
  }
  const listening = sprites.filter((s) => s.noodlrBadgeWired).length;
  return (
    `sprite: ${sprites.length} matched, ${listening} listening, ` +
    `wrap ${wrapped ? "on" : "MISSING"}`
  );
}

function makeClickable(sprite: any, onClick: () => void): void {
  if (!sprite || sprite.noodlrBadgeWired) return;
  sprite.noodlrBadgeWired = true;
  sprite.eventMode = "static";
  sprite.interactive = true;
  sprite.cursor = "pointer";
  sprite.on?.("pointerdown", (event: any) => {
    event?.stopPropagation?.();
    onClick();
  });
}
