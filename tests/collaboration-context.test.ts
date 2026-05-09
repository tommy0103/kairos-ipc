import assert from "node:assert/strict";
import test from "node:test";
import {
  barrierIsSatisfied,
  reduceCollaborationEvents,
  renderForAgent,
  renderForHuman,
  renderAgentWorkload,
  renderReviewQueue,
  renderSessionDetailProjection,
  renderSessionWorkProjection,
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
  assert.equal(Object.keys(state.notes).length, 1);
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
  assert.match(context.text, /Collaboration notes:/);
  assert.match(context.text, /Please compare native-module risk against Expo config plugins/);
  assert.match(context.text, /Before ending the run or returning final output/);
  assert.match(context.text, /IM status pulse, not a report/);
  assert.match(context.text, /under 80 characters/);
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

test("work projection renders an agile session dashboard summary", () => {
  const state = reduceCollaborationEvents(fixtureEvents());
  const projection = renderSessionWorkProjection(state);

  assert.equal(projection?.session_id, "session_mobile_eval");
  assert.equal(projection?.title, "Mobile app technical evaluation");
  assert.equal(projection?.phase, "review");
  assert.equal(projection?.owner, "human://user/local");
  assert.deepEqual(projection?.agents.map((agent) => agent.agent).sort(), ["agent://alice", "agent://cindy"]);
  assert.equal(projection?.blockers.length, 0);
  assert.ok(projection?.latest_report?.includes("Expo is fastest"));
  assert.ok(projection?.actions.some((action) => action.kind === "open_thread"));
});

test("collaboration reducer and projections preserve production workflow gates", () => {
  const traceRef = { correlation_id: "run_expo", endpoint: "plugin://local/workspace" as const, action: "search", label: "workspace search", object_ref: "delegation:delegation_expo" };
  const events: CollaborationEvent[] = [
    ...fixtureEvents(),
    {
      id: "event_14",
      type: "scope_updated",
      at: "2026-05-09T00:00:06.000Z",
      session_id: "session_mobile_eval",
      title: "Pick mobile stack",
      objective: "Choose a shippable mobile stack with risk called out.",
      source_refs: [{ kind: "channel_message", channel: "app://slock/channel/general", message_id: "channel_msg_1" }],
    },
    {
      id: "event_15",
      type: "acceptance_criteria_recorded",
      at: "2026-05-09T00:00:07.000Z",
      session_id: "session_mobile_eval",
      criteria: ["Compare native and Expo paths", "Call out IAP risk"],
    },
    {
      id: "event_16",
      type: "constraint_recorded",
      at: "2026-05-09T00:00:08.000Z",
      session_id: "session_mobile_eval",
      constraint: { timeline: "two weeks" },
    },
    {
      id: "event_17",
      type: "approval_requested",
      at: "2026-05-09T00:00:09.000Z",
      approval: {
        id: "approval_shell",
        session_id: "session_mobile_eval",
        requester: "agent://alice",
        tool_endpoint: "plugin://local/shell",
        action: "exec",
        risk: "high",
        payload_summary: "run mobile tests",
        source_refs: [{ kind: "artifact", artifact_id: "artifact_expo" }],
        status: "pending",
        created_at: "2026-05-09T00:00:09.000Z",
      },
    },
    {
      id: "event_18",
      type: "validation_requested",
      at: "2026-05-09T00:00:10.000Z",
      validation: {
        id: "validation_mobile",
        session_id: "session_mobile_eval",
        artifact_id: "artifact_expo",
        requester: "human://user/local",
        status: "requested",
        summary: "Validate Expo native-module risk",
        source_refs: [{ kind: "artifact", artifact_id: "artifact_expo" }],
        created_at: "2026-05-09T00:00:10.000Z",
      },
    },
    {
      id: "event_19",
      type: "validation_failed",
      at: "2026-05-09T00:00:11.000Z",
      session_id: "session_mobile_eval",
      validation_id: "validation_mobile",
      summary: "Expo config plugin check failed",
      trace_refs: [{ ...traceRef, severity: "error", label: "config plugin failure" }],
    },
    {
      id: "event_20",
      type: "artifact_reviewed",
      at: "2026-05-09T00:00:12.000Z",
      session_id: "session_mobile_eval",
      artifact_id: "artifact_expo",
      review: {
        reviewer: "human://user/local",
        status: "revision_requested",
        note: "Address config plugin failure.",
        reviewed_at: "2026-05-09T00:00:12.000Z",
        trace_refs: [traceRef],
      },
    },
    {
      id: "event_21",
      type: "trace_linked",
      at: "2026-05-09T00:00:13.000Z",
      session_id: "session_mobile_eval",
      object_ref: "delegation:delegation_expo",
      trace_ref: traceRef,
    },
    {
      id: "event_22",
      type: "trace_linked",
      at: "2026-05-09T00:00:14.000Z",
      session_id: "session_mobile_eval",
      object_ref: "task:task_eval",
      trace_ref: { ...traceRef, label: "task evidence", object_ref: "task:task_eval" },
    },
    {
      id: "event_23",
      type: "trace_linked",
      at: "2026-05-09T00:00:15.000Z",
      session_id: "session_mobile_eval",
      object_ref: "barrier:barrier_evaluations",
      trace_ref: { ...traceRef, label: "barrier evidence", object_ref: "barrier:barrier_evaluations" },
    },
  ];

  const state = reduceCollaborationEvents(events);
  assert.deepEqual(reduceCollaborationEvents(events), state);
  assert.equal(state.session?.title, "Pick mobile stack");
  assert.deepEqual(state.session?.acceptance_criteria, ["Compare native and Expo paths", "Call out IAP risk"]);
  assert.equal(state.constraints.length, 1);
  assert.equal(state.artifacts.artifact_expo.status, "revision_requested");
  assert.equal(state.approvals.approval_shell.status, "pending");
  assert.equal(state.validations.validation_mobile.status, "failed");
  assert.ok(state.trace_refs.some((ref) => ref.action === "search"));
  assert.ok(state.delegations.delegation_expo.trace_refs?.some((ref) => ref.label === "workspace search"));
  assert.ok(state.tasks.task_eval.trace_refs?.some((ref) => ref.label === "task evidence"));
  assert.ok(state.barriers.barrier_evaluations.trace_refs?.some((ref) => ref.label === "barrier evidence"));

  const projection = renderSessionWorkProjection(state);
  assert.equal(projection?.phase, "validate");
  assert.match(projection?.phase_reason ?? "", /failed/i);
  assert.ok(projection?.blockers.some((blocker) => blocker.kind === "pending_approval"));
  assert.ok(projection?.blockers.some((blocker) => blocker.kind === "revision_requested"));

  const queue = renderReviewQueue([state]);
  assert.ok(queue.some((item) => item.id === "artifact:artifact_expo"));
  assert.ok(queue.some((item) => item.id === "approval:approval_shell"));
  assert.ok(queue.some((item) => item.id === "validation:validation_mobile"));

  const workload = renderAgentWorkload([state]);
  const alice = workload.find((item) => item.agent === "agent://alice");
  assert.equal(alice?.latest_tool_call?.endpoint, "plugin://local/workspace");
  assert.equal(alice?.sessions[0]?.session_id, "session_mobile_eval");

  const detail = renderSessionDetailProjection(state);
  assert.equal(detail?.constraints.length, 1);
  assert.equal(detail?.approvals.length, 1);
  assert.equal(detail?.validations.length, 1);
});

test("work projection phase precedence is deterministic across mixed workflow signals", () => {
  const reviewState = reduceCollaborationEvents(fixtureEvents());
  assert.equal(renderSessionWorkProjection(reviewState)?.phase, "review");

  const activeState = reduceCollaborationEvents([
    ...fixtureEvents(),
    {
      id: "event_active",
      type: "delegation_created",
      at: "2026-05-09T00:00:06.000Z",
      delegation: {
        id: "delegation_security",
        session_id: "session_mobile_eval",
        task_id: "task_eval",
        assignee: "agent://security",
        instruction: "Check security risk.",
        status: "pending",
        source_refs: [{ kind: "channel_message", channel: "app://slock/channel/general", message_id: "channel_msg_1" }],
      },
    },
  ]);
  assert.equal(renderSessionWorkProjection(activeState)?.phase, "execute");

  const decisionState = reduceCollaborationEvents([
    ...fixtureEvents(),
    {
      id: "event_approval",
      type: "approval_requested",
      at: "2026-05-09T00:00:06.000Z",
      approval: {
        id: "approval_1",
        session_id: "session_mobile_eval",
        requester: "agent://alice",
        tool_endpoint: "plugin://local/workspace",
        action: "edit",
        risk: "medium",
        payload_summary: "edit config",
        source_refs: [],
        status: "pending",
        created_at: "2026-05-09T00:00:06.000Z",
      },
    },
  ]);
  assert.equal(renderSessionWorkProjection(decisionState)?.phase, "decision");

  const failedValidationState = reduceCollaborationEvents([
    ...fixtureEvents(),
    {
      id: "event_validation",
      type: "validation_requested",
      at: "2026-05-09T00:00:06.000Z",
      validation: {
        id: "validation_1",
        session_id: "session_mobile_eval",
        requester: "human://user/local",
        status: "requested",
        source_refs: [],
        created_at: "2026-05-09T00:00:06.000Z",
      },
    },
    {
      id: "event_validation_failed",
      type: "validation_failed",
      at: "2026-05-09T00:00:07.000Z",
      session_id: "session_mobile_eval",
      validation_id: "validation_1",
      summary: "tests failed",
    },
  ]);
  assert.equal(renderSessionWorkProjection(failedValidationState)?.phase, "validate");
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
    {
      id: "event_13",
      type: "note_posted",
      at: "2026-05-09T00:00:05.000Z",
      note: {
        id: "note_native_to_expo",
        session_id: "session_mobile_eval",
        from: "agent://cindy",
        to: ["agent://alice"],
        visibility: "agents",
        text: "Please compare native-module risk against Expo config plugins.",
        delegation_id: "delegation_native",
        source_refs: [{ kind: "artifact", artifact_id: "artifact_native" }],
        created_at: "2026-05-09T00:00:05.000Z",
      },
    },
  ];
}
