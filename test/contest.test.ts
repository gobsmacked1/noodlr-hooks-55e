import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  activityResolvesByContest,
  contestRefusal,
  isFailContingentFlag,
  itemSaveBranches,
  primaryContestActivity,
} from "../src/capability/contest";
import { staticRefusal } from "../src/capability/describe";
import { deleteOurTimedEffects } from "../src/capability/timed";
import type { CapabilityRule } from "../src/integration/capability";

const grantOnUse: CapabilityRule = {
  trigger: { event: "on_activity_use" },
  condition: [],
  effect: { kind: "grant_advantage", rollType: "attack", target: "self" },
  adjudication: "engine",
};

const grantOnSuccess: CapabilityRule = {
  trigger: { event: "on_save_succeeded" },
  condition: [],
  effect: { kind: "grant_advantage", rollType: "attack", target: "self" },
  adjudication: "engine",
};

const stunOnFail: CapabilityRule = {
  trigger: { event: "on_save_failed" },
  condition: [],
  effect: { kind: "apply_status", status: "stunned", target: "target" },
  adjudication: "engine",
};

const spendOnUse: CapabilityRule = {
  trigger: { event: "on_activity_use" },
  condition: [],
  effect: { kind: "spend_resource", resource: "focus" },
  adjudication: "engine",
};

const ddbStunningStrike = {
  type: "save",
  save: { ability: "con", dc: { value: 15 } },
  effects: [{ _id: "stun", onSave: false }],
};

const stock2024 = {
  type: "save",
  save: { ability: "con" },
  effects: [
    { _id: "stun", onSave: false },
    { _id: "slow", onSave: true },
  ],
};

test("a save or attack activity is a contest; a Utility is not", () => {
  assert.equal(activityResolvesByContest({ type: "save" }), true);
  assert.equal(activityResolvesByContest({ type: "attack" }), true);
  assert.equal(activityResolvesByContest({ type: "utility" }), false);
  assert.equal(activityResolvesByContest({ save: { ability: "con" } }), true);
  assert.equal(activityResolvesByContest({ attack: { type: { value: "melee" } } }), true);
});

test("a Cast wrapper follows a cached spell that has the save", () => {
  const wrapper = {
    type: "cast",
    cachedSpell: {
      system: { activities: [{ type: "save", save: { ability: "wis" } }] },
    },
  };
  assert.equal(activityResolvesByContest(wrapper), true);
});

test("Stunning Strike's Advantage must not write when the button is pressed", () => {
  const reason = contestRefusal(grantOnUse, ddbStunningStrike);
  assert.match(reason, /waits for a hit or a save/);
});

test("Reckless Attack is a Utility, so a use-time grant still writes", () => {
  assert.equal(contestRefusal(grantOnUse, { type: "utility" }), "");
});

test("spending Focus is not contingent on the save", () => {
  assert.equal(contestRefusal(spendOnUse, ddbStunningStrike), "");
});

test("DDB Stunning Strike declares fail-only, so a compiled success rider is refused", () => {
  assert.deepEqual(itemSaveBranches(ddbStunningStrike), {
    fail: true,
    succeed: false,
    unspecified: false,
  });
  assert.match(contestRefusal(grantOnSuccess, ddbStunningStrike), /onSave:true/);
  assert.equal(contestRefusal(stunOnFail, ddbStunningStrike), "");
});

test("an item that marks a success branch still allows compiled consolation", () => {
  assert.deepEqual(itemSaveBranches(stock2024), {
    fail: true,
    succeed: true,
    unspecified: false,
  });
  assert.equal(contestRefusal(grantOnSuccess, stock2024), "");
  assert.equal(contestRefusal(stunOnFail, stock2024), "");
});

test("no effect links leaves both save events to the compiler", () => {
  const hold = { type: "save", save: { ability: "wis" }, effects: [] };
  assert.equal(itemSaveBranches(hold).unspecified, true);
  assert.equal(contestRefusal(stunOnFail, hold), "");
  assert.equal(contestRefusal(grantOnSuccess, hold), "");
});

test("primaryContestActivity prefers the save on a mixed item", () => {
  const item = {
    system: {
      activities: {
        a: { type: "utility", name: "Flavor" },
        b: { type: "save", save: { ability: "con" }, effects: [{ onSave: false }] },
      },
    },
  };
  const picked = primaryContestActivity(item) as { type: string };
  assert.equal(picked.type, "save");
  assert.match(contestRefusal(grantOnUse, picked), /waits for a hit or a save/);
});

test("a bought save strips use-time and fail-gated timed AEs, not a stamped success", () => {
  const ids = new Set(["hash-ss"]);
  assert.equal(
    isFailContingentFlag({ capability: "hash-ss", event: "on_activity_use", kind: "grant_advantage" }, ids),
    true,
  );
  assert.equal(
    isFailContingentFlag({ capability: "hash-ss", event: "on_save_failed", kind: "apply_status" }, ids),
    true,
  );
  assert.equal(
    isFailContingentFlag({ capability: "hash-ss", event: "on_save_succeeded", kind: "modify_speed" }, ids),
    false,
  );
  assert.equal(
    isFailContingentFlag({ capability: "hash-ss", kind: "grant_advantage" }, ids),
    true,
    "unstamped leftovers from before the stamp are the Stunning Strike bug",
  );
  assert.equal(isFailContingentFlag({ capability: "other", kind: "grant_advantage" }, ids), false);
});

test("the sheet badges a use-time grant on a save activity", () => {
  const item = { system: { activities: { a: ddbStunningStrike } } };
  assert.match(staticRefusal(grantOnUse, item), /waits for a hit or a save/);
});

test("deleteOurTimedEffects removes only the leftovers a bought save names", async () => {
  const actor: any = {
    name: "Monk",
    effects: [
      {
        id: "keep",
        flags: {
          "noodlr-hooks-55e": {
            timed: { capability: "hash-ss", event: "on_save_succeeded", kind: "modify_speed" },
          },
        },
      },
      {
        id: "drop",
        flags: {
          "noodlr-hooks-55e": {
            timed: { capability: "hash-ss", event: "on_activity_use", kind: "grant_advantage" },
          },
        },
      },
    ],
    async deleteEmbeddedDocuments(_type: string, ids: string[]) {
      actor.effects = actor.effects.filter((e: any) => !ids.includes(e.id));
    },
  };
  const n = await deleteOurTimedEffects(actor, (flag) =>
    isFailContingentFlag(flag as { capability?: unknown; event?: unknown; kind?: unknown }, new Set(["hash-ss"])),
  );
  assert.equal(n, 1);
  assert.equal(actor.effects.length, 1);
  assert.equal(actor.effects[0].id, "keep");
});
