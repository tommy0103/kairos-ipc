import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inferMentions } from "../packages/slock-channel/src/index.ts";
import { buildTraceView, parseTraceJsonl } from "../packages/slock-ui-bridge/src/index.ts";

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
  assert.match(app, /activeView === 'trace'/);
  assert.match(app, /\/api\/trace/);
  assert.match(app, /class="trace-view"/);
  assert.match(app, /approval-card/);
  assert.match(app, /approvalDetailChips/);
  assert.match(app, /Raw payload/);
  assert.match(app, /tool-result-summary/);
});

test("trace viewer builds grouped content-safe timeline data", () => {
  const text = [
    JSON.stringify({
      timestamp: "2026-05-03T01:00:00.000Z",
      event: "envelope",
      msg_id: "msg_1",
      source: "app://slock/channel/general",
      target: "agent://local/pi",
      op_code: "CALL",
      action: "run",
      route_result: "delivered",
      payload_kind: "slock_agent_run",
      message_id: "message_1",
      payload: { secret: "do not show" },
    }),
    JSON.stringify({
      timestamp: "2026-05-03T01:00:01.000Z",
      event: "envelope",
      msg_id: "msg_2",
      correlation_id: "msg_1",
      source: "agent://local/pi",
      target: "plugin://system/shell",
      op_code: "CALL",
      action: "exec",
      route_result: "delivered",
      payload_kind: "slock_shell_exec",
      thread_id: "message_1",
      shell_command: "pwd",
    }),
    JSON.stringify({
      timestamp: "2026-05-03T01:00:02.000Z",
      event: "envelope",
      msg_id: "msg_3",
      source: "agent://local/pi",
      target: "app://slock/human",
      op_code: "RETURN",
      route_result: "delivered",
      payload_kind: "slock_approval_result",
      approval_id: "approval_1",
      approval_decision: false,
    }),
  ].join("\n");

  const view = buildTraceView(parseTraceJsonl(text), { limit: 20 });

  assert.equal(view.stats.total_events, 3);
  assert.equal(view.stats.shell_calls, 1);
  assert.equal(view.stats.rejected_approvals, 1);
  assert.equal(Object.hasOwn(view.events[0], "payload"), false);
  const shellEvent = view.events.find((event) => event.shell_command === "pwd");
  assert.equal(shellEvent?.direction, "request");
  assert.equal(shellEvent?.causal_parent_id, "message:msg_1");
  assert.equal(shellEvent?.causal_depth, 1);
  assert.ok(shellEvent?.relations.some((relation) => relation.kind === "correlation" && relation.value === "msg_1"));
  const threadGroup = view.groups.find((group) => group.id === "thread:message_1");
  assert.equal(threadGroup?.summary.requests, 2);
  assert.ok(threadGroup?.summary.relations.some((relation) => relation.kind === "thread" && relation.value === "message_1"));
  assert.ok(view.groups.some((group) => group.id === "approval:approval_1"));
});
