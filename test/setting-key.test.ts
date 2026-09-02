import { strict as assert } from "node:assert";
import { test } from "node:test";

import { settingKeyOf } from "../src/util/setting-key";

test("updateSetting key is the Setting document's .key, never the options object", () => {
  assert.equal(settingKeyOf({ key: "noodlr-hooks-55e.general.riding" }), "noodlr-hooks-55e.general.riding");
  assert.equal(settingKeyOf(undefined), "");
  assert.equal(settingKeyOf(null), "");
  assert.equal(settingKeyOf({}), "");
  assert.equal(settingKeyOf({ key: 12 }), "");
  const options = { diff: true, render: true };
  assert.equal(typeof (options as { endsWith?: unknown }).endsWith, "undefined");
  assert.equal(settingKeyOf(options as { key?: unknown }), "");
});
