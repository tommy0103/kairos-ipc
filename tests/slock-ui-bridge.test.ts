import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { inferMentions } from "../packages/slock-channel/src/index.ts";
import { renderJs } from "../packages/slock-ui-bridge/src/assets.ts";

test("Slock channel infers mentions from configured aliases", () => {
  assert.deepEqual(
    inferMentions("@mock please calculate", undefined, { mock: "agent://local/mock" }),
    ["agent://local/mock"],
  );
});

test("Slock channel keeps explicit mentions and deduplicates inferred aliases", () => {
  assert.deepEqual(
    inferMentions("@mock and @unknown", ["agent://local/mock", "agent://local/other"], {
      mock: "agent://local/mock",
    }),
    ["agent://local/mock", "agent://local/other"],
  );
});

test("Slock channel mention aliases can target multiple agents", () => {
  assert.deepEqual(
    inferMentions("@agent compare answers", undefined, {
      agent: ["agent://local/pi-assistant", "agent://local/mock"],
    }),
    ["agent://local/pi-assistant", "agent://local/mock"],
  );
});

test("UI bridge renders syntactically valid browser JavaScript", () => {
  assert.doesNotThrow(() => new vm.Script(renderJs(), { filename: "app.js" }));
});
