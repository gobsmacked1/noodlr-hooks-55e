import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  awaitPendingReactions,
  pendingReactionCount,
  trackReaction,
} from "../src/rules/reaction-wait";

test("awaitPendingReactions returns once tracked work finishes plus the settle", async () => {
  let finished = false;
  trackReaction(
    new Promise<void>((resolve) => {
      setTimeout(() => {
        finished = true;
        resolve();
      }, 30);
    }),
  );
  assert.equal(pendingReactionCount(), 1);
  await awaitPendingReactions(20);
  assert.equal(finished, true);
  assert.equal(pendingReactionCount(), 0);
});

test("a rejected reaction still clears the waiter", async () => {
  trackReaction(Promise.reject(new Error("declined"))).catch(() => undefined);
  await awaitPendingReactions(10);
  assert.equal(pendingReactionCount(), 0);
});
