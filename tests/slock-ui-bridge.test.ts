import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inferMentions } from "../packages/slock-channel/src/index.ts";

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

test("UI bridge frontend is implemented as a Vue app", () => {
  const main = readFileSync(new URL("../packages/slock-ui-bridge/web/src/main.ts", import.meta.url), "utf8");
  const app = readFileSync(new URL("../packages/slock-ui-bridge/web/src/App.vue", import.meta.url), "utf8");

  assert.match(main, /createApp\(App\)\.mount\("#app"\)/);
  assert.match(app, /<script setup lang="ts">/);
});
