import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  collectScene,
  featuresOf,
  registerCapabilityCollector,
  surveyScene,
} from "../src/capability/collect";
import { plainText } from "../src/capability/prose";
import { bindingsFor, clearBindings } from "../src/capability/bindings";
import * as cache from "../src/capability/cache";
import type { Capability } from "../src/integration/capability";

// ---- Fakes ---------------------------------------------------------------------------------------

let compileCalls: any[];
let answer: (items: any[]) => Record<string, unknown>;
let compileEnabled: boolean;
let listening: boolean;
let uploads: any[];

function item(name: string, description: string, over: any = {}) {
  return {
    name,
    type: "feat",
    system: { description: { value: description }, ...(over.system ?? {}) },
    flags: over.flags ?? {},
    ...over,
  };
}

function creature(uuid: string, name: string, items: any[]) {
  return {
    uuid,
    name,
    type: "npc",
    items,
    system: {
      attributes: { hp: { max: 84 }, movement: { walk: 30 } },
      details: { type: { value: "giant" }, cr: 5 },
      traits: { size: "lg" },
    },
  };
}

/** A compiled Regeneration, the shape the compiler is expected to hand back. */
function regeneration(id: string): Capability {
  return {
    id,
    label: "Regeneration",
    status: "compiled",
    rules: [
      {
        trigger: { event: "on_turn_start" },
        condition: [{ kind: "hp_at_least", amount: { value: 1 } }],
        effect: { kind: "heal", amount: { value: 15, units: "hp" } },
        adjudication: "engine",
      },
    ],
  };
}

function scene(actors: any[]) {
  return { tokens: { contents: actors.map((actor) => ({ actor })) } };
}

beforeEach(() => {
  cache.__reset();
  clearBindings();
  compileCalls = [];
  compileEnabled = true;
  listening = true;
  uploads = [];
  answer = (items) =>
    Object.fromEntries(
      items.map((i) => [i.id, { label: i.label, rules: regeneration(i.id).rules }]),
    );

  (globalThis as any).game = {
    system: { id: "dnd5e" },
    user: { isGM: true, id: "gm-1" },
    users: { activeGM: { id: "gm-1" } },
    i18n: { format: (_k: string, d: any) => `read ${d.count}` },
    settings: { get: () => compileEnabled },
  };
  (globalThis as any).ui = { notifications: { info: () => {} } };
  (globalThis as any).canvas = { scene: { id: "scene-1", tokens: { contents: [] } } };
  (globalThis as any).foundry = {
    applications: {
      apps: {
        FilePicker: {
          createDirectory: async () => {},
          upload: async (_src: string, _path: string, file: any) => uploads.push(file),
        },
      },
    },
    utils: { getRoute: (p: string) => `/${p}` },
  };
  (globalThis as any).File = class {
    constructor(
      public parts: any[],
      public name: string,
    ) {}
  };
  // Nothing has ever been written, so every shard read is a miss.
  (globalThis as any).fetch = async () => ({ ok: false, text: async () => "" });
  (globalThis as any).Hooks = {
    on: () => {},
    callAll: (_name: string, payload: any) => {
      if (!listening) return;
      compileCalls.push(payload);
      payload.waitFor(
        (async () => {
          payload.compiled = answer(payload.items);
          payload.handled = true;
        })(),
      );
    },
  };
});

// ---- Reading a sheet -------------------------------------------------------------------------------

test("prose keeps its paragraphs, because a stat block's rules are separate sentences", () => {
  const html = "<p>The troll makes three attacks.</p><p>It can use its Bite in place of one.</p>";
  assert.equal(
    plainText(html),
    "The troll makes three attacks.\nIt can use its Bite in place of one.",
  );
});

test("a flavour line is not compiled, and the system's own spell clones are skipped", () => {
  const actor = creature("Actor.a", "Troll", [
    item("Big", "A rock."),
    item("Regeneration", "The troll regains 15 Hit Points at the start of each of its turns."),
    item("Fireball", "A bright streak flashes from your pointing finger to a point you choose.", {
      type: "spell",
      // The clone dnd5e makes to service a feat's cast activity. Reading it as well as the feat
      // compiles the same ability twice, with the wrong resource attached to one of them.
      flags: { dnd5e: { cachedFor: "Item.something" } },
    }),
    {
      name: "Rations",
      type: "loot",
      system: { description: { value: "A week of dried meat and hard bread." } },
    },
  ]);

  const features = featuresOf(actor);
  assert.deepEqual(
    features.map((f) => f.label),
    ["Regeneration"],
  );
});

test("the resolved numbers travel with the prose, and outrank it", () => {
  // The whole advantage of compiling from a sheet over mining a book: the Monster Manual states this
  // amount as `[[lookup @healing.formula activity=…]]`, which the corpus miner could only record as a
  // literal string. Here the activity is resolved and 15 is sent alongside.
  const actor = creature("Actor.a", "Troll", [
    item("Regeneration", "The troll regains Hit Points at the start of each of its turns.", {
      system: {
        description: { value: "The troll regains Hit Points at the start of each of its turns." },
        uses: { max: 3, spent: 1, recovery: [{ period: "lr", type: "recoverAll" }] },
        activities: {
          contents: [
            {
              type: "heal",
              activation: { type: "special" },
              healing: { formula: "15", number: 15, types: new Set(["healing"]) },
            },
          ],
        },
      },
    }),
  ]);

  const [feature] = featuresOf(actor);
  const structured = feature.structured as any;
  assert.equal(structured.activities[0].healing.formula, "15");
  assert.deepEqual(structured.activities[0].healing.types, ["healing"]);
  assert.deepEqual(structured.uses, {
    max: 3,
    spent: 1,
    recovery: [{ period: "lr", type: "recoverAll", formula: undefined }],
  });
});

test("a note addressed to the GM never reaches the compiler, and does not key the cache", async () => {
  // The Troll's, and the reason `prose.ts` exists: the note is a plain-English instruction NOT to
  // emit the effect the sentence above it states, and a well-behaved model obliges.
  const rule = "The troll has 1 Exhaustion level for each missing limb.";
  const withNote =
    `<p>${rule}</p>` +
    '<section class="secret"><p><strong>Foundry Note</strong></p>' +
    "<p>The Exhaustion levels from missing limbs must be applied manually.</p></section>";

  const [feature] = featuresOf(creature("Actor.a", "Troll", [item("Loathsome Limbs", withNote)]));
  assert.equal(feature.prose, rule);
  assert.deepEqual(
    feature.removed,
    [],
    "a note inside a hidden section is expected, so it is quiet",
  );
  assert.equal(
    feature.id,
    cache.proseHash(rule),
    "the note is gone before the wording is hashed, so editing one invalidates the entry",
  );

  await collectScene(scene([creature("Actor.a", "Troll", [item("Loathsome Limbs", withNote)])]));
  assert.equal(compileCalls[0].items[0].prose, rule);
  assert.doesNotMatch(compileCalls[0].items[0].prose, /manually/);
});

test("tooling written into open rule text is reported to the GM", async () => {
  // Nothing dnd5e ships does this — measured at zero over 31,905 descriptions — so it means an
  // importer or a homebrew author, and the GM is the only person who can judge whether it mattered.
  const actor = creature("Actor.a", "Homebrew", [
    item(
      "Draconic Resistance",
      "<p>The creature has resistance to one damage type. " +
        "The resistances will need to be manually enabled/disabled.</p>",
    ),
  ]);
  const [feature] = featuresOf(actor);
  assert.match(feature.prose, /resistance to one damage type/);
  assert.equal(feature.removed.length, 1);

  const report = await collectScene(scene([actor]));
  assert.deepEqual(Object.keys(report.scrubbed), ["Draconic Resistance"]);
});

// ---- Running a scene ---------------------------------------------------------------------------------

test("twenty goblins with one wording cost one compile", async () => {
  const text = "While within 5 feet of an ally, the goblin has Advantage on attack rolls.";
  const actors = Array.from({ length: 20 }, (_, i) =>
    creature(`Actor.goblin${i}`, "Goblin", [item("Pack Tactics", text)]),
  );

  const report = await collectScene(scene(actors));
  assert.equal(report.actors, 20);
  assert.equal(report.features, 20);
  assert.equal(report.distinct, 1, "one wording, however many creatures carry it");
  assert.equal(report.requested, 1);
  assert.equal(report.compiled, 1);
  assert.equal(compileCalls.length, 1, "one batch, not one call per creature");

  // Every goblin is bound to the one compiled capability.
  for (const actor of actors) assert.equal(bindingsFor(actor).length, 1);
});

test("a second pass asks about nothing, because the cache answers", async () => {
  const actors = [
    creature("Actor.a", "Troll", [
      item("Regeneration", "The troll regains 15 Hit Points each turn."),
    ]),
  ];
  await collectScene(scene(actors));
  compileCalls.length = 0;

  const report = await collectScene(scene(actors));
  assert.equal(report.hits, 1);
  assert.equal(report.requested, 0);
  assert.equal(compileCalls.length, 0);
});

test("with nobody listening the scene still binds, and says so rather than failing", async () => {
  listening = false;
  const actors = [
    creature("Actor.a", "Troll", [
      item("Regeneration", "The troll regains 15 Hit Points each turn."),
    ]),
  ];

  const report = await collectScene(scene(actors));
  assert.equal(report.noCompiler, true);
  assert.equal(report.compiled, 0);
  assert.equal(bindingsFor(actors[0]).length, 0, "no descriptors is the baseline, not an error");
});

test("the switch being off costs nothing and asks nothing", async () => {
  compileEnabled = false;
  const actors = [
    creature("Actor.a", "Troll", [
      item("Regeneration", "The troll regains 15 Hit Points each turn."),
    ]),
  ];

  const report = await collectScene(scene(actors));
  assert.equal(report.requested, 0);
  assert.equal(compileCalls.length, 0);
  assert.equal(report.distinct, 1, "it still knows what it would have asked about");
});

test("a descriptor that does not validate is thrown away, not cached", async () => {
  answer = (items) =>
    Object.fromEntries(
      items.map((i) => [
        i.id,
        {
          label: i.label,
          rules: [
            {
              trigger: { event: "whenever_i_feel_like_it" },
              condition: [],
              effect: { kind: "heal", amount: { value: 15 } },
              adjudication: "engine",
            },
          ],
        },
      ]),
    );
  const actors = [
    creature("Actor.a", "Troll", [
      item("Regeneration", "The troll regains 15 Hit Points each turn."),
    ]),
  ];

  const report = await collectScene(scene(actors));
  assert.equal(report.compiled, 0);
  assert.equal(report.rejected, 1);
  assert.equal(cache.size(), 0);
});

test("an answer about something nobody asked about is refused", async () => {
  // A key the compiler invented would poison a wording it never read.
  answer = () => ({ "0000000000000000": { label: "Nonsense", rules: [] } });
  const actors = [
    creature("Actor.a", "Troll", [
      item("Regeneration", "The troll regains 15 Hit Points each turn."),
    ]),
  ];

  const report = await collectScene(scene(actors));
  assert.equal(report.compiled, 0);
  assert.equal(report.rejected, 1);
  assert.equal(cache.size(), 0);
});

test("a locked descriptor survives a recompile", async () => {
  const text = "The troll regains 15 Hit Points at the start of each of its turns.";
  const actors = [creature("Actor.a", "Troll", [item("Regeneration", text)])];
  const id = cache.proseHash(text);

  cache.putOverride({
    ...regeneration(id),
    label: "Regeneration (fixed by hand)",
    status: "locked",
  });
  await collectScene(scene(actors));

  assert.equal(cache.get(id)?.label, "Regeneration (fixed by hand)");
  assert.equal(cache.get(id)?.status, "locked");
});

test("the survey reports what a scene would cost without spending it", async () => {
  (globalThis as any).canvas.scene.tokens.contents = [
    {
      actor: creature("Actor.a", "Troll", [
        item("Regeneration", "The troll regains 15 Hit Points each turn."),
      ]),
    },
    {
      actor: creature("Actor.b", "Troll", [
        item("Regeneration", "The troll regains 15 Hit Points each turn."),
      ]),
    },
  ];
  const report = (await surveyScene()) as any;
  assert.equal(report.actors, 2);
  assert.equal(report.features, 2);
  assert.equal(report.distinct, 1);
  assert.equal(report.wouldAsk, 1);
  assert.equal(compileCalls.length, 0);
});

test("the survey warms the cache, or it reports a full one as empty", async () => {
  // Shards on disk and nothing warmed: the state of every page load before the collector runs. An
  // unwarmed read reported 1,099 stored descriptors as zero and was diagnosed as a data loss.
  const text = "The troll regains 15 Hit Points at the start of each of its turns.";
  const id = cache.proseHash(text);
  const shard = JSON.stringify({ capabilities: [regeneration(id)] });
  (globalThis as any).fetch = async () => ({ ok: true, text: async () => shard });
  (globalThis as any).canvas.scene.tokens.contents = [
    { actor: creature("Actor.a", "Troll", [item("Regeneration", text)]) },
  ];

  const report = (await surveyScene()) as any;
  assert.equal(report.cached, 1);
  assert.equal(report.wouldAsk, 0);
  assert.equal(compileCalls.length, 0);
});

test("registering onto a canvas that is already drawn still collects", async () => {
  // `canvasReady` fires before `ready`, and this module registers from `ready`, so the hook has
  // already been missed by the time the listener exists. Without the catch-up nothing is ever bound
  // on a fresh load — silently, and only on scenes the GM does not re-enter.
  const text = "The troll regains 15 Hit Points at the start of each of its turns.";
  const actor = creature("Actor.a", "Troll", [item("Regeneration", text)]);
  (globalThis as any).canvas = {
    ready: true,
    scene: { id: "scene-1", tokens: { contents: [{ actor }] } },
  };

  registerCapabilityCollector();
  await new Promise((resolve) => setTimeout(resolve, 900));

  assert.equal(compileCalls.length, 1);
  assert.equal(bindingsFor(actor).length, 1);
});
