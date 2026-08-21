// Clickable token-corner status icons.
//
// Core draws `temporaryEffects` as inert PIXI sprites (`Token#_drawEffect`). Paladin aura badges
// stay inert on purpose. Wild Shape and a saddle need a click that is *not* a HUD toggle — Token
// HUD skips `hud: false`, so the sprite itself is the affordance.

type BadgeHandler = (token: any) => void | Promise<void>;

export function wireEffectClicks(token: any, img: string, onClick: BadgeHandler): void {
  const effects = token?.effects;
  if (!effects?.children || !img) return;
  for (const child of effects.children) {
    if (!matchesImg(spriteSrc(child), img)) continue;
    makeClickable(child, () => onClick(token));
  }
}

function matchesImg(src: string, img: string): boolean {
  if (!src) return false;
  const a = src.replace(/\\/g, "/");
  const b = img.replace(/\\/g, "/");
  if (a === b || a.endsWith(b) || a.includes(b)) return true;
  const file = b.slice(b.lastIndexOf("/") + 1);
  return file.length > 0 && a.endsWith(`/${file}`);
}

function spriteSrc(child: any): string {
  const tex = child?.texture;
  const src = tex?.baseTexture?.resource?.src ?? tex?.baseTexture?.resource?.url ?? child?.textureSrc;
  return src ? String(src) : "";
}

function makeClickable(sprite: any, onClick: () => void): void {
  if (!sprite || sprite.noodlrBadgeWired) return;
  sprite.noodlrBadgeWired = true;
  sprite.eventMode = "static";
  sprite.interactive = true;
  sprite.cursor = "pointer";
  sprite.on?.("pointerdown", (event: any) => {
    event?.stopPropagation?.();
    void onClick();
  });
}
