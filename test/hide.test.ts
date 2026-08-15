import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { canHide, hideLine } from "../src/rules/hide";

const HOSTILE = -1;
const FRIENDLY = 1;
const GRID = 100;

/**
 * A token good enough for the prerequisite check: a position, a footprint, a disposition and a sheet.
 *
 * `senses` is the only interesting field. With no `CONFIG.Canvas.visionSourceClass` in a test process the
 * perception layer cannot build a vision source, so it falls back to the stat block — which is exactly the
 * path a dnd5e NPC takes in a real world too, since NPC prototype tokens ship with sight disabled.
 */
function token(overrides: Record<string, any> = {}) {
  const doc: any = {
    id: overrides.id ?? "t1",
    name: overrides.name ?? "Someone",
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    width: 1,
    height: 1,
    disposition: overrides.disposition ?? FRIENDLY,
    hidden: false,
    sight: { range: 0 },
    hasStatusEffect: () => false,
    getFlag: () => undefined,
  };
  return {
    id: doc.id,
    name: doc.name,
    document: doc,
    center: { x: doc.x + GRID / 2, y: doc.y + GRID / 2 },
    actor: {
      name: doc.name,
      system: {
        attributes: { senses: { ranges: { darkvision: overrides.darkvision ?? 0 } } },
        skills: { ste: { passive: 14 } },
      },
    },
  };
}

/** Feet between two tokens, as the grid would measure it: the scene is 100px = 5ft. */
function feetApart(a: any, b: any): number {
  return (Math.hypot(b.center.x - a.center.x, b.center.y - a.center.y) / GRID) * 5;
}

beforeEach(() => {
  (globalThis as any).CONST = { TOKEN_DISPOSITIONS: { HOSTILE, FRIENDLY } };
  (globalThis as any).game = {
    system: { id: "dnd5e" },
    // Everything asked of settings here is a rules switch; `rulesVersion` is the one that matters and
    // anything other than "legacy" means the 2024 prerequisites apply.
    settings: { get: () => true },
    users: { filter: () => [] },
    i18n: { format: (key: string, data: Record<string, string>) => `${key} ${Object.values(data).join(" ")}` },
  };
  (globalThis as any).foundry = { utils: { escapeHTML: (s: string) => s } };
  (globalThis as any).CONFIG = { specialStatusEffects: { DEFEATED: "dead" } };
  (globalThis as any).canvas = {
    grid: {
      size: GRID,
      measurePath: (points: any[]) => ({
        distance: feetApart({ center: points[0] }, { center: points[1] }),
      }),
    },
    tokens: { placeables: [], controlled: [] },
    // A clear view everywhere: no wall blocks anything, so cover is always zero and the only thing that
    // can keep a creature hidden is an enemy not being able to see it.
    walls: { checkCollision: () => false },
  };
});

/** Put the rogue and its would-be watchers on the canvas. */
function scene(rogue: any, enemies: any[]): void {
  (globalThis as any).canvas.tokens.placeables = [rogue, ...enemies];
}

test("an enemy that cannot see the creature is not a watcher", () => {
  // 100 feet away with 60 feet of darkvision and no light: this is the whole of the bug reported from
  // play. There is no wall in the way, so the old corner-ray test called it "plain view" and refused the
  // hide, while the perception sweep — correctly — had never let this creature notice anybody.
  const rogue = token({ id: "rogue", name: "Rogwiz" });
  const wolf = token({
    id: "wolf",
    name: "Dire Wolf",
    disposition: HOSTILE,
    x: GRID * 20,
    darkvision: 60,
  });
  scene(rogue, [wolf]);

  const check = canHide(rogue);
  assert.equal(check.allowed, true);
  assert.match(check.reason, /line of sight/);
});

test("an enemy close enough to see the creature in the open refuses the hide", () => {
  const rogue = token({ id: "rogue", name: "Rogwiz" });
  const wolf = token({
    id: "wolf",
    name: "Dire Wolf",
    disposition: HOSTILE,
    x: GRID * 4,
    darkvision: 60,
  });
  scene(rogue, [wolf]);

  assert.equal(canHide(rogue).allowed, false);
});

test("the refusal shown to the table names nobody, and the GM's copy names everybody", () => {
  // The card is public, so the reason is read by every player at the table. Naming the watchers there
  // handed a player the scene's whole hostile roster in exchange for pressing a button.
  const rogue = token({ id: "rogue", name: "Rogwiz" });
  const enemies = [
    token({ id: "a", name: "Beholder Zombie", disposition: HOSTILE, x: GRID * 3, darkvision: 60 }),
    token({ id: "b", name: "Archmage", disposition: HOSTILE, x: GRID * 4, darkvision: 60 }),
  ];
  scene(rogue, enemies);

  const check = canHide(rogue);
  assert.equal(check.allowed, false);
  for (const enemy of enemies) {
    assert.equal(
      check.reason.includes(enemy.name),
      false,
      `${enemy.name} leaked into the public line`,
    );
    assert.equal(
      check.detail.includes(enemy.name),
      true,
      `${enemy.name} missing from the GM's copy`,
    );
  }
});

test("nobody watching at all is a different answer from cover, and both allow the hide", () => {
  const alone = token({ id: "rogue", name: "Rogwiz" });
  scene(alone, []);
  assert.equal(canHide(alone).allowed, true);
});

test("a friendly creature is not an enemy, however close it stands", () => {
  const rogue = token({ id: "rogue", name: "Rogwiz" });
  const ally = token({ id: "ally", name: "Cleric", x: GRID, darkvision: 60 });
  scene(rogue, [ally]);
  assert.equal(canHide(rogue).allowed, true);
});

test("the watchers are reported by id, because that is what the hide is banked against", () => {
  // The house rule does not refuse the action; it hides the creature from everyone EXCEPT the enemies
  // this list names. So the ids have to be right and complete — a watcher missing from here is one the
  // rogue is wrongly hidden from, which is the failure mode the whole per-observer design exists to fix.
  const rogue = token({ id: "rogue", name: "Rogwiz" });
  const near = token({ id: "near", name: "Bandit", disposition: HOSTILE, x: GRID * 3, darkvision: 60 });
  const far = token({ id: "far", name: "Archer", disposition: HOSTILE, x: GRID * 40, darkvision: 60 });
  scene(rogue, [near, far]);

  const check = canHide(rogue);
  assert.deepEqual(check.exposed, ["near"]);
});

test("nobody in view means nobody is exposed, so the hide is whole", () => {
  const rogue = token({ id: "rogue", name: "Rogwiz" });
  scene(rogue, []);
  assert.deepEqual(canHide(rogue).exposed, []);
});

test("a watched hide and a clean one read identically at the table", () => {
  // The player does not know those watchers exist. Saying "hidden, but two of them can see you" hands them
  // a fact they had no way to have and cannot un-have, and it spoils an ambush as completely as naming the
  // creatures would. The count is the leak, not just the names.
  const clean = hideLine(token({ name: "Rogwiz" }), {
    hidden: true,
    total: 19,
    dc: 15,
    reason: "nobody is watching",
    detail: "nobody is watching",
  });
  const watched = hideLine(token({ name: "Rogwiz" }), {
    hidden: true,
    total: 19,
    dc: 15,
    reason: "there is nowhere to hide from here",
    detail: "hid at DC 19 but is in plain view of Bandit Captain, Archmage",
  });

  assert.equal(watched, clean);
  for (const leak of ["Bandit", "Archmage", "plain view", "2", "two"]) {
    assert.equal(watched.includes(leak), false, `"${leak}" reached the public card`);
  }
});
