import assert from "node:assert/strict";
import test from "node:test";
import {
  barrierIsSatisfied,
  reduceCollaborationEvents,
  renderForAgent,
  renderForHuman,
  type CollaborationEvent,
} from "../packages/collaboration-context/src/index.ts";

test("collaboration reducer tracks multi-agent delegations and barrier replies", () => {
  const events = fixtureEvents();
  const state = reduceCollaborationEvents(events);

  assert.equal(state.session?.id, "session_mobile_eval");
  assert.equal(Object.keys(state.tasks).length, 1);
  assert.equal(Object.keys(state.delegations).length, 2);
  assert.equal(state.delegations.delegation_native.status, "submitted");
  assert.equal(state.delegations.delegation_expo.status, "submitted");
  assert.equal(Object.keys(state.artifacts).length, 2);
  assert.equal(state.barriers.barrier_evaluations.status, "satisfied");
  assert.equal(barrierIsSatisfied(state.barriers.barrier_evaluations), true);
  assert.deepEqual(state.barriers.barrier_evaluations.replies, {
    "agent://cindy": "artifact_native",
    "agent://alice": "artifact_expo",
  });
  assert.deepEqual(Object.keys(state.active_runs), []);
});

test("agent renderer gives delegation-specific context without losing shared artifacts", () => {
  const state = reduceCollaborationEvents(fixtureEvents());
  const context = renderForAgent(state, {
    audience: "agent://alice",
    purpose: "delegation",
    delegation_id: "delegation_expo",
  });

  assert.equal(context.session_id, "session_mobile_eval");
  assert.equal(context.audience, "agent://alice");
  assert.match(context.text, /Your delegation:/);
  assert.match(context.text, /Expo and React Native/);
  assert.match(context.text, /Native camera and IAP are feasible/);
  assert.deepEqual(context.artifact_refs.sort(), ["artifact_expo", "artifact_native"]);
  assert.ok(context.source_refs.some((ref) => ref.kind === "channel_message" && ref.message_id === "channel_msg_1"));
});

test("human renderer projects current submitted artifacts", () => {
  const state = reduceCollaborationEvents(fixtureEvents());
  const projection = renderForHuman(state);

  assert.equal(projection.length, 2);
  assert.deepEqual(projection.map((item) => item.author).sort(), ["agent://alice", "agent://cindy"]);
  assert.ok(projection.some((item) => item.text.includes("Expo is fastest")));
});

function fixtureEvents(): CollaborationEvent[] {
  return [
    {
      id: "event_1",
      type: "session_created",
      at: "2026-05-09T00:00:00.000Z",
      session: {
        id: "session_mobile_eval",
        origin: { kind: "channel_message", channel: "app://slock/channel/general", message_id: "channel_msg_1" },
        source_refs: [{ kind: "channel_message", channel: "app://slock/channel/general", message_id: "channel_msg_1" }],
        status: "open",
        created_at: "2026-05-09T00:00:00.000Z",
      },
    },
    {
      id: "event_2",
      type: "task_created",
      at: "2026-05-09T00:00:00.000Z",
      task: {
        id: "task_eval",
        session_id: "session_mobile_eval",
        title: "Mobile app technical evaluation",
        owner: "human://user/local",
        status: "open",
        source_refs: [{ kind: "channel_message", channel: "app://slock/channel/general", message_id: "channel_msg_1" }],
      },
    },
    {
      id: "event_3",
      type: "delegation_created",
      at: "2026-05-09T00:00:00.000Z",
      delegation: {
        id: "delegation_native",
        session_id: "session_mobile_eval",
        task_id: "task_eval",
        assignee: "agent://cindy",
        instruction: "Evaluate native iOS and Android.",
        expected_output: "Native evaluation artifact",
        status: "pending",
        source_refs: [{ kind: "channel_message", channel: "app://slock/channel/general", message_id: "channel_msg_1" }],
      },
    },
    {
      id: "event_4",
      type: "delegation_created",
      at: "2026-05-09T00:00:00.000Z",
      delegation: {
        id: "delegation_expo",
        session_id: "session_mobile_eval",
        task_id: "task_eval",
        assignee: "agent://alice",
        instruction: "Evaluate Expo and React Native.",
        expected_output: "Expo/RN evaluation artifact",
        status: "pending",
        source_refs: [{ kind: "channel_message", channel: "app://slock/channel/general", message_id: "channel_msg_1" }],
      },
    },
    {
      id: "event_5",
      type: "barrier_created",
      at: "2026-05-09T00:00:00.000Z",
      barrier: {
        id: "barrier_evaluations",
        session_id: "session_mobile_eval",
        task_id: "task_eval",
        source_ref: { kind: "channel_message", channel: "app://slock/channel/general", message_id: "channel_msg_1" },
        owner: "human://user/local",
        expected_from: ["agent://cindy", "agent://alice"],
        notify: [],
        mode: "all",
        status: "open",
        replies: {},
        created_at: "2026-05-09T00:00:00.000Z",
      },
    },
    {
      id: "event_6",
      type: "delegation_started",
      at: "2026-05-09T00:00:01.000Z",
      session_id: "session_mobile_eval",
      delegation_id: "delegation_native",
      correlation_id: "run_native",
    },
    {
      id: "event_7",
      type: "artifact_submitted",
      at: "2026-05-09T00:00:02.000Z",
      delegation_id: "delegation_native",
      artifact: {
        id: "artifact_native",
        session_id: "session_mobile_eval",
        author: "agent://cindy",
        kind: "evaluation",
        title: "Native evaluation",
        content: { text: "Native camera and IAP are feasible." },
        status: "submitted",
        relates_to: ["delegation_native"],
        source_refs: [{ kind: "ipc_envelope", correlation_id: "run_native" }],
        created_at: "2026-05-09T00:00:02.000Z",
      },
    },
    {
      id: "event_8",
      type: "barrier_updated",
      at: "2026-05-09T00:00:02.000Z",
      session_id: "session_mobile_eval",
      barrier_id: "barrier_evaluations",
      patch: { replies: { "agent://cindy": "artifact_native" } },
    },
    {
      id: "event_9",
      type: "delegation_started",
      at: "2026-05-09T00:00:03.000Z",
      session_id: "session_mobile_eval",
      delegation_id: "delegation_expo",
      correlation_id: "run_expo",
    },
    {
      id: "event_10",
      type: "artifact_submitted",
      at: "2026-05-09T00:00:04.000Z",
      delegation_id: "delegation_expo",
      artifact: {
        id: "artifact_expo",
        session_id: "session_mobile_eval",
        author: "agent://alice",
        kind: "evaluation",
        title: "Expo evaluation",
        content: { text: "Expo is fastest, with native-module risk." },
        status: "submitted",
        relates_to: ["delegation_expo"],
        source_refs: [{ kind: "ipc_envelope", correlation_id: "run_expo" }],
        created_at: "2026-05-09T00:00:04.000Z",
      },
    },
    {
      id: "event_11",
      type: "barrier_updated",
      at: "2026-05-09T00:00:04.000Z",
      session_id: "session_mobile_eval",
      barrier_id: "barrier_evaluations",
      patch: { replies: { "agent://cindy": "artifact_native", "agent://alice": "artifact_expo" } },
    },
    {
      id: "event_12",
      type: "barrier_satisfied",
      at: "2026-05-09T00:00:04.000Z",
      session_id: "session_mobile_eval",
      barrier_id: "barrier_evaluations",
    },
  ];
}
