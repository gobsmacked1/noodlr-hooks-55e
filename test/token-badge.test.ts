import { strict as assert } from "node:assert";
import { test } from "node:test";

import { badgeHit, matchesImg } from "../src/util/token-badge";

test("matchesImg accepts a Foundry route that only shares the filename", () => {
  const img = "icons/magic/control/encase-creature-monster-hold.webp";
  assert.equal(matchesImg(img, img), true);
  assert.equal(matchesImg(`/vtt/${img}`, img), true);
  assert.equal(matchesImg(`https://host/vtt/${img}?t=1`, img), true);
  assert.equal(matchesImg("icons/other/sword.webp", img), false);
  assert.equal(matchesImg("", img), false);
});

test("badgeHit is true only for the matching effect sprite under the pointer", () => {
  const img = "icons/magic/control/encase-creature-monster-hold.webp";
  const sprite = {
    texture: { baseTexture: { resource: { src: `/vtt/${img}` } } },
    getBounds: () => ({
      x: 10,
      y: 10,
      width: 16,
      height: 16,
      contains: (x: number, y: number) => x >= 10 && x <= 26 && y >= 10 && y <= 26,
    }),
  };
  const other = {
    texture: { baseTexture: { resource: { src: "icons/svg/aura.svg" } } },
    getBounds: () => ({ x: 0, y: 0, width: 16, height: 16, contains: () => true }),
  };
  const token = { effects: { children: [other, sprite] } };
  assert.equal(badgeHit(token, img, { global: { x: 12, y: 12 } }), true);
  assert.equal(badgeHit(token, img, { global: { x: 0, y: 0 } }), false);
  assert.equal(badgeHit(token, img, { target: sprite }), true);
});

test("badgeHit uses Foundry layer-space origin, not screen-space global", () => {
  const img = "icons/magic/control/encase-creature-monster-hold.webp";
  const sprite = {
    texture: { baseTexture: { resource: { src: img } } },
    getBounds: () => ({
      x: 200,
      y: 80,
      width: 16,
      height: 16,
      contains: (x: number, y: number) => x >= 200 && x <= 216 && y >= 80 && y <= 96,
    }),
  };
  const token = {
    layer: {
      toGlobal: (p: { x: number; y: number }) => ({ x: p.x + 100, y: p.y + 40 }),
    },
    effects: { children: [sprite] },
  };
  assert.equal(
    badgeHit(token, img, {
      global: { x: 12, y: 12 },
      interactionData: { origin: { x: 108, y: 48 } },
    }),
    true,
  );
  assert.equal(
    badgeHit(token, img, {
      global: { x: 208, y: 88 },
      interactionData: { origin: { x: 0, y: 0 } },
    }),
    false,
  );
});

test("badgeHit matches the AE img when the texture fell back to hazard.svg", () => {
  const img = "icons/creatures/mammals/bull-horns-eyes-glowin-orange.webp";
  const sprite = {
    texture: { baseTexture: { resource: { src: "icons/svg/hazard.svg" } } },
    getBounds: () => ({
      x: 0,
      y: 0,
      width: 16,
      height: 16,
      contains: (x: number, y: number) => x >= 0 && x <= 16 && y >= 0 && y <= 16,
    }),
  };
  const token = {
    actor: { temporaryEffects: [{ img }] },
    effects: { children: [sprite] },
  };
  assert.equal(badgeHit(token, img, { global: { x: 8, y: 8 } }), true);
});
