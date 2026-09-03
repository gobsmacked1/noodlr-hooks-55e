import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  applyTrait,
  attackKind,
  attackMasterySuffixes,
  contestKind,
  damageMasterySuffixes,
  damagePartsFromRolls,
  faceColor,
  formatAttackLine,
  formatContestLine,
  formatDamageLine,
  formatSigned,
  readD20Breakdown,
  readDamageModifiers,
  traitMultiplier,
} from "../src/rules/card-line";

const L = {
  fumble: "Fumble!",
  crit: "Critical Hit!",
  hit: "Hit",
  miss: "Miss",
  success: "Success",
  failure: "Failure",
};

const title = (type: string) => type.charAt(0).toUpperCase() + type.slice(1);

test("a natural 20 is green and a natural 1 is red; nothing else is", () => {
  assert.equal(faceColor(20), "nat20");
  assert.equal(faceColor(1), "nat1");
  assert.equal(faceColor(19), "none");
  assert.equal(faceColor(2), "none");
  assert.equal(faceColor(null), "none");
});

test("attack cards: fumble, miss, hit, critical — face first, no mods on 1 or 20", () => {
  assert.equal(
    formatAttackLine({ face: 1, modifiers: 11, kind: attackKind(1, false), labels: L }),
    "1    (Fumble!)",
  );
  assert.equal(
    formatAttackLine({ face: 8, modifiers: 7, kind: attackKind(8, false), labels: L }),
    "8    +7    (Miss)",
  );
  assert.equal(
    formatAttackLine({ face: 15, modifiers: 7, kind: attackKind(15, true), labels: L }),
    "15    +7    (Hit)",
  );
  assert.equal(
    formatAttackLine({ face: 20, modifiers: 7, kind: attackKind(20, true), labels: L }),
    "20    (Critical Hit!)",
  );
});

test("a Champion 19 is a Hit, not a Critical Hit — labels follow the face", () => {
  assert.equal(attackKind(19, true), "hit");
  assert.equal(
    formatAttackLine({ face: 19, modifiers: 8, kind: "hit", labels: L }),
    "19    +8    (Hit)",
  );
});

test("saves and checks never auto-succeed or auto-fail on 20 or 1", () => {
  assert.equal(contestKind(false), "failure");
  assert.equal(contestKind(true), "success");
  assert.equal(
    formatContestLine({ face: 6, modifiers: 4, kind: "failure", labels: L }),
    "6    +4    (Failure)",
  );
  assert.equal(
    formatContestLine({ face: 14, modifiers: 4, kind: "success", labels: L }),
    "14    +4    (Success)",
  );
  assert.equal(
    formatContestLine({ face: 20, modifiers: 4, kind: "failure", labels: L }),
    "20    +4    (Failure)",
  );
  assert.equal(
    formatContestLine({ face: 1, modifiers: 4, kind: "success", labels: L }),
    "1    +4    (Success)",
  );
});

test("a zero modifier column is omitted; a negative one is signed", () => {
  assert.equal(formatSigned(0), "");
  assert.equal(formatSigned(-2), "-2");
  assert.equal(
    formatAttackLine({ face: 10, modifiers: 0, kind: "hit", labels: L }),
    "10    (Hit)",
  );
  assert.equal(
    formatAttackLine({ face: 10, modifiers: -2, kind: "miss", labels: L }),
    "10    -2    (Miss)",
  );
});

test("advantage keeps the active face, not the discarded one", () => {
  const roll = {
    total: 22,
    dice: [
      {
        faces: 20,
        results: [
          { result: 4, discarded: true, active: false },
          { result: 15, active: true },
        ],
      },
    ],
  };
  assert.deepEqual(readD20Breakdown(roll), { face: 15, modifiers: 7, total: 22 });
});

test("damage cards: one type, two types, vulnerability, immunity, resistance", () => {
  const one = damagePartsFromRolls([{ total: 11, modifiers: 3, type: "piercing" }], null, title);
  assert.equal(formatDamageLine(one), "8    +3    (Piercing)");

  const two = damagePartsFromRolls(
    [
      { total: 11, modifiers: 3, type: "bludgeoning" },
      { total: 5, modifiers: 0, type: "fire" },
    ],
    null,
    title,
  );
  assert.equal(formatDamageLine(two), "8    +3    (Bludgeoning), 5    (Fire)");

  const vuln = { vuln: ["radiant"] };
  const radiant = damagePartsFromRolls(
    [
      { total: 11, modifiers: 3, type: "slashing" },
      { total: 6, modifiers: 0, type: "radiant" },
    ],
    vuln,
    title,
  );
  assert.equal(formatDamageLine(radiant), "8    +3    (Slashing), 12    (Radiant)");

  const immune = { immune: ["necrotic"] };
  const necrotic = damagePartsFromRolls(
    [
      { total: 11, modifiers: 3, type: "slashing" },
      { total: 6, modifiers: 0, type: "necrotic" },
    ],
    immune,
    title,
  );
  assert.equal(formatDamageLine(necrotic), "8    +3    (Slashing), 0    (Necrotic)");

  const resist = { resist: ["acid"] };
  const acid = damagePartsFromRolls(
    [
      { total: 11, modifiers: 3, type: "slashing" },
      { total: 7, modifiers: 0, type: "acid" },
    ],
    resist,
    title,
  );
  assert.equal(formatDamageLine(acid), "8    +3    (Slashing), 3    (Acid)");
});

test("resistance floors; immunity is zero; vulnerability doubles", () => {
  assert.equal(traitMultiplier({ resist: ["acid"] }, "acid"), 0.5);
  assert.equal(applyTrait(7, 0.5), 3);
  assert.equal(applyTrait(6, 0), 0);
  assert.equal(applyTrait(6, 2), 12);
});

test("damage modifiers are total minus kept dice faces", () => {
  const roll = {
    total: 11,
    dice: [{ results: [{ result: 5 }, { result: 3 }] }],
  };
  assert.equal(readDamageModifiers(roll), 3);
});

test("attack-card masteries: hit suffixes, Graze on a miss, Nick on either", () => {
  assert.deepEqual(attackMasterySuffixes("cleave", "hit", null, "Graze"), ["(Cleave)"]);
  assert.deepEqual(attackMasterySuffixes("push", "hit", null, "Graze"), ["(Push)"]);
  assert.deepEqual(attackMasterySuffixes("sap", "crit", null, "Graze"), ["(Sap)"]);
  assert.deepEqual(attackMasterySuffixes("topple", "hit", null, "Graze"), ["(Topple)"]);
  assert.deepEqual(attackMasterySuffixes("cleave", "miss", null, "Graze"), []);
  assert.deepEqual(attackMasterySuffixes("graze", "miss", 4, "Graze"), ["4    (Graze)"]);
  assert.deepEqual(attackMasterySuffixes("graze", "fumble", 4, "Graze"), ["4    (Graze)"]);
  assert.deepEqual(attackMasterySuffixes("graze", "miss", 0, "Graze"), []);
  assert.deepEqual(attackMasterySuffixes("graze", "hit", 4, "Graze"), []);
  assert.deepEqual(attackMasterySuffixes("nick", "hit", null, "Graze"), ["(Nick)"]);
  assert.deepEqual(attackMasterySuffixes("nick", "miss", null, "Graze"), ["(Nick)"]);
  assert.deepEqual(attackMasterySuffixes("nick", "fumble", null, "Graze"), ["(Nick)"]);
});

test("damage-card masteries: Slow and Vex only on a hit that dealt damage", () => {
  assert.deepEqual(damageMasterySuffixes("slow", true, 8), ["(Slow)"]);
  assert.deepEqual(damageMasterySuffixes("vex", true, 1), ["(Vex)"]);
  assert.deepEqual(damageMasterySuffixes("slow", true, 0), []);
  assert.deepEqual(damageMasterySuffixes("vex", false, 8), []);
  assert.deepEqual(damageMasterySuffixes("push", true, 8), []);
});

test("a miss with Graze appends the amount on the attack line", () => {
  const line = formatAttackLine({
    face: 9,
    modifiers: 6,
    kind: "miss",
    labels: L,
    suffixes: attackMasterySuffixes("graze", "miss", 5, "Graze"),
  });
  assert.equal(line, "9    +6    (Miss)    5    (Graze)");
});
