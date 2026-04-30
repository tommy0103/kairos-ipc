import assert from "node:assert/strict";
import test from "node:test";
import { inferMentions } from "../packages/slock-ui-bridge/src/index.ts";

test("UI bridge infers mentions from configured aliases", () => {
  assert.deepEqual(
    inferMentions("@mock please calculate", undefined, { mock: "agent://local/mock" }),
    ["agent://local/mock"],
  );
});

test("UI bridge keeps explicit mentions and deduplicates inferred aliases", () => {
  assert.deepEqual(
    inferMentions("@mock and @unknown", ["agent://local/mock", "agent://local/other"], {
      mock: "agent://local/mock",
    }),
    ["agent://local/mock", "agent://local/other"],
  );
});
