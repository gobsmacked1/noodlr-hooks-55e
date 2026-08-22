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
