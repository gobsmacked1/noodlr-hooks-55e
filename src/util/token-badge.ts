// Clickable token-corner status icons.
//
// Core draws `temporaryEffects` as inert PIXI sprites (`Token#_drawEffect`). Paladin aura badges
// stay inert on purpose. Wild Shape and a saddle need a click that is *not* a HUD toggle — Token
// HUD skips `hud: false`, so the sprite itself is the affordance.
//
// PIXI `pointerdown` on those sprites is not enough. Foundry's MouseInteractionManager binds
// `clickLeft` to the Token as a whole, and that path never asks the effect children. The live
// restore icon did nothing for that reason: the sprite looked clickable and the handler never
// ran. Clicks are therefore also hit-tested inside Token#_onClickLeft.

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
  for (const child of effects.children) {
    if (!matchesImg(spriteSrc(child), img)) continue;
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

function pointerGlobal(event: any): { x: number; y: number } | null {
  const g = event?.global ?? event?.data?.global ?? event?.interactionData?.destination;
  const x = Number(g?.x);
  const y = Number(g?.y);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  return null;
}

function boundsContain(child: any, pt: { x: number; y: number }): boolean {
  try {
    if (typeof child.containsPoint === "function" && child.containsPoint(pt)) return true;
  } catch {
    /* some sprites throw if they have no texture yet */
  }
  const b = child.getBounds?.();
  if (!b) return false;
  if (typeof b.contains === "function") return Boolean(b.contains(pt.x, pt.y));
  const w = Number(b.width);
  const h = Number(b.height);
  return pt.x >= b.x && pt.x <= b.x + w && pt.y >= b.y && pt.y <= b.y + h;
}

export function badgeHit(token: any, img: string, event: any): boolean {
  if (!token || !img) return false;
  const children = token.effects?.children;
  if (!children?.length) return false;
  const pt = pointerGlobal(event);
  for (const child of children) {
    if (!matchesImg(spriteSrc(child), img)) continue;
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
      return;
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
