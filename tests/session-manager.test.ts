import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createAgentAdapter, type AgentRuntime } from "../packages/agent-adapter/src/index.ts";
import { AllowAllCapabilityGate } from "../packages/kernel/src/capability.ts";
import type { Connection } from "../packages/kernel/src/registry.ts";
import { EndpointRegistry } from "../packages/kernel/src/registry.ts";
import { Router } from "../packages/kernel/src/router.ts";
import { TraceWriter } from "../packages/kernel/src/trace.ts";
import type { ClientFrame, KernelFrame } from "../packages/protocol/src/index.ts";
import { createNode, type IpcTransport } from "../packages/sdk/src/index.ts";
import { createSessionManager, KAIROS_DASHBOARD_EVENT_MIME } from "../packages/session-manager/src/index.ts";
import {
  createSlockChannel,
  SLOCK_CHANNEL_EVENT_MIME,
  SLOCK_MESSAGE_MIME,
  type SlockAgentRun,
  type SlockChannelEvent,
} from "../packages/slock-channel/src/index.ts";

test("session manager owns multi-agent Slock routing and projects artifacts back to the channel", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager", coordinator_uri: "agent://local/coordinator" });
  const channel = createSlockChannel({
    uri: "app://slock/channel/general",
    session_manager_uri: "app://kairos/session-manager",
    mention_aliases: {
      alice: "agent://local/alice",
      cindy: "agent://local/cindy",
      agent: ["agent://local/alice", "agent://local/cindy"],
      coordinator: "agent://local/coordinator",
    },
  });
  const capturedRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: recordingRuntime("alice", capturedRuns) });
  const cindy = createAgentAdapter({ uri: "agent://local/cindy", runtime: recordingRuntime("cindy", capturedRuns) });
  const coordinator = createAgentAdapter({ uri: "agent://local/coordinator", runtime: coordinatorRuntime(capturedRuns) });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  try {
    await human.connect(ipc.createTransport("human"));
    await sessionManager.node.connect(ipc.createTransport("session-manager"));
    await channel.node.connect(ipc.createTransport("channel"));
    await alice.node.connect(ipc.createTransport("alice"));
    await cindy.node.connect(ipc.createTransport("cindy"));
    await coordinator.node.connect(ipc.createTransport("coordinator"));

    await human.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    const posted = await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@agent compare architecture options and synthesize a final report", thread_id: null },
    });
    const rootId = (posted.data as { id: string }).id;

    await waitFor(() => events.filter((event) => event.type === "message_created" && event.message).length === 4);

    assert.equal(sessionManager.sessions.size, 1);
    const record = [...sessionManager.sessions.values()][0];
    assert.ok(record);
    assert.equal(Object.keys(record.state.delegations).length, 3);
    assert.equal(Object.keys(record.state.artifacts).length, 3);
    assert.equal(Object.values(record.state.barriers)[0]?.status, "satisfied");
    assert.deepEqual(Object.keys(record.state.active_runs), []);
    assert.equal(Object.values(record.state.tasks)[0]?.status, "completed");

    assert.equal(channel.messages.length, 4);
    assert.equal(events.filter((event) => event.type === "agent_run_started").length, 3);
    assert.equal(events.filter((event) => event.type === "agent_run_finished" && event.run?.state === "completed").length, 3);
    assert.ok(capturedRuns.every((run) => run.session_id === record.id));
    assert.ok(capturedRuns.every((run) => run.context_text?.includes("Kairos collaboration session")));
    assert.ok(capturedRuns.every((run) => run.context_text?.includes("compare architecture options")));

    const projected = events.filter((event) => event.type === "message_created" && event.message && event.message.thread_id === rootId);
    const agentProjected = projected.filter((event) => event.message?.kind === "agent");
    const artifactProjections = projected.filter((event) => event.message?.projection?.presentation === "artifact");
    const finalReports = projected.filter((event) => event.message?.projection?.presentation === "final_report");
    assert.deepEqual(agentProjected.map((event) => event.message?.sender).sort(), ["agent://local/alice", "agent://local/cindy"]);
    assert.equal(artifactProjections.length, 2);
    assert.ok(artifactProjections.every((event) => !event.message?.text.startsWith("Artifact ready.")));
    assert.ok(artifactProjections.some((event) => event.message?.text.includes("alice completed")));
    assert.ok(artifactProjections.some((event) => event.message?.text.includes("cindy completed")));
    assert.ok(artifactProjections.every((event) => event.message?.projection?.session_id === record.id));
    assert.ok(artifactProjections.every((event) => event.message?.projection?.artifact_id));
    assert.equal(finalReports.length, 1);
    assert.equal(finalReports[0]?.message?.kind, "system");
    assert.equal(finalReports[0]?.message?.sender, record.uri);
    assert.equal(finalReports[0]?.message?.projection?.author, "agent://local/coordinator");
    assert.equal(finalReports[0]?.message?.projection?.session_id, record.id);
    assert.ok(finalReports[0]?.message?.projection?.artifact_id);
    assert.ok(projected.every((event) => event.message?.thread_id === rootId));
    assert.ok(projected.some((event) => event.message?.text.includes("coordinator saw workers")));
    assert.ok(projected.filter((event) => event.message?.text.includes("alice completed")).every((event) => event.message?.projection?.presentation === "artifact"));
    assert.ok(projected.filter((event) => event.message?.text.includes("cindy completed")).every((event) => event.message?.projection?.presentation === "artifact"));
    assert.ok(projected.filter((event) => event.message?.text.includes("coordinator saw workers")).every((event) => event.message?.projection?.presentation === "final_report"));
    assert.ok(!projected.some((event) => event.message?.text === "Drafting final synthesis."));

    const coordinatorRun = capturedRuns.find((run) => run.purpose === "synthesis");
    assert.equal(coordinatorRun?.message_id, rootId);
    assert.ok(coordinatorRun?.context_text?.includes("alice completed"));
    assert.ok(coordinatorRun?.context_text?.includes("cindy completed"));
    assert.ok(coordinatorRun?.context_text?.includes("Purpose: synthesis"));

    await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@alice also account for RevenueCat", thread_id: null },
    });

    await waitFor(() => events.filter((event) => event.type === "message_created" && event.message?.projection?.presentation === "final_report").length === 2);

    assert.equal(sessionManager.sessions.size, 1);
    assert.equal(Object.values(record.state.tasks)[0]?.status, "completed");
    const aliceArtifacts = Object.values(record.state.artifacts).filter((artifact) => artifact.author === "agent://local/alice");
    const coordinatorArtifacts = Object.values(record.state.artifacts).filter((artifact) => artifact.author === "agent://local/coordinator");
    assert.equal(aliceArtifacts.filter((artifact) => artifact.status === "superseded").length, 1);
    assert.equal(aliceArtifacts.filter((artifact) => artifact.status === "submitted").length, 1);
    assert.equal(coordinatorArtifacts.filter((artifact) => artifact.status === "superseded").length, 1);
    assert.equal(coordinatorArtifacts.filter((artifact) => artifact.status === "submitted").length, 1);

    const amendedAliceRun = capturedRuns.find((run) => run.context_text?.includes("Audience: agent://local/alice") && run.context_text.includes("RevenueCat"));
    assert.ok(amendedAliceRun?.context_text?.includes("Amendment"));
    assert.ok(amendedAliceRun?.context_text?.includes("RevenueCat"));
    const finalCoordinatorRun = capturedRuns.filter((run) => run.purpose === "synthesis").at(-1);
    assert.ok(finalCoordinatorRun?.context_text?.includes("RevenueCat"));

    await human.call("app://kairos/session-manager", "record_decision", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        decision: { selected_billing_vendor: "RevenueCat" },
      },
    });
    assert.equal(record.state.decisions.length, 1);
    assert.deepEqual(record.state.decisions[0]?.decision, { selected_billing_vendor: "RevenueCat" });
    assert.equal(record.state.decisions[0]?.session_id, record.id);
    assert.equal(record.state.decisions[0]?.decider, "human://user/local");

    const currentAliceArtifact = aliceArtifacts.find((artifact) => artifact.status === "submitted");
    assert.ok(currentAliceArtifact);
    const eventsBeforeCompaction = record.events.length;
    const compactionResult = await human.call("app://kairos/session-manager", "record_context_compaction", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        audience: "agent://local/cindy",
        purpose: "review",
        covers_refs: [{ kind: "artifact", artifact_id: currentAliceArtifact.id }],
        cursor: { before_event_id: record.events.at(-1)?.id },
        summary_text: "RevenueCat decision digest: Alice amended the Expo/RN path to account for RevenueCat.",
        structured_digest: {
          decisions: [{ selected_billing_vendor: "RevenueCat" }],
          artifact_refs: aliceArtifacts.map((artifact) => artifact.id),
          barrier_refs: Object.keys(record.state.barriers),
        },
      },
    });
    assert.equal(record.events.length, eventsBeforeCompaction);
    assert.equal(record.compactions.length, 1);
    const compaction = compactionResult.data as { id: string };

    const snapshot = await human.call("app://kairos/session-manager", "get_session_state", {
      mime_type: "application/json",
      data: { session_id: record.id },
    });
    assert.equal((snapshot.data as { compactions: unknown[] }).compactions.length, 1);

    const listed = await human.call("app://kairos/session-manager", "list_context_compactions", {
      mime_type: "application/json",
      data: { session_id: record.id, audience: "agent://local/cindy", purpose: "review" },
    });
    assert.deepEqual((listed.data as { compactions: Array<{ id: string }> }).compactions.map((item) => item.id), [compaction.id]);

    const rendered = await human.call("app://kairos/session-manager", "render_context", {
      mime_type: "application/json",
      data: { session_id: record.id, audience: "agent://local/cindy", purpose: "review" },
    });
    assert.ok((rendered.data as { text: string }).text.includes("RevenueCat decision digest"));

    await human.call("app://kairos/session-manager", "ask_question", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        from: "agent://local/alice",
        to: "agent://local/cindy",
        question: "Which implementation risk remains after choosing RevenueCat?",
      },
    });

    await waitFor(() => events.filter((event) => event.type === "message_created" && event.message?.kind === "agent").length === 4);
    const question = Object.values(record.state.questions)[0];
    assert.equal(question?.status, "answered");
    assert.ok(question?.answer_artifact_id);
    const questionRun = capturedRuns.find((run) => run.purpose === "review" && run.context_text?.includes("Which implementation risk remains"));
    assert.ok(questionRun?.context_text?.includes("Audience: agent://local/cindy"));
    assert.ok(questionRun?.context_text?.includes("RevenueCat decision digest"));
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await channel.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
    await cindy.node.close().catch(() => undefined);
    await coordinator.node.close().catch(() => undefined);
  }
});

test("session manager skips coordinator synthesis for independent parallel delegations", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager", coordinator_uri: "agent://local/coordinator" });
  const channel = createSlockChannel({
    uri: "app://slock/channel/general",
    session_manager_uri: "app://kairos/session-manager",
    mention_aliases: {
      agent: ["agent://local/alice", "agent://local/cindy"],
    },
  });
  const capturedRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: recordingRuntime("alice", capturedRuns) });
  const cindy = createAgentAdapter({ uri: "agent://local/cindy", runtime: recordingRuntime("cindy", capturedRuns) });
  const coordinator = createAgentAdapter({ uri: "agent://local/coordinator", runtime: coordinatorRuntime(capturedRuns) });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  try {
    await human.connect(ipc.createTransport("human"));
    await sessionManager.node.connect(ipc.createTransport("session-manager"));
    await channel.node.connect(ipc.createTransport("channel"));
    await alice.node.connect(ipc.createTransport("alice"));
    await cindy.node.connect(ipc.createTransport("cindy"));
    await coordinator.node.connect(ipc.createTransport("coordinator"));

    await human.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    const posted = await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@agent compare architecture options", thread_id: null },
    });
    const rootId = (posted.data as { id: string }).id;

    await waitFor(() => events.filter((event) => event.type === "message_created" && event.message).length === 3);

    assert.equal(sessionManager.sessions.size, 1);
    const record = [...sessionManager.sessions.values()][0];
    assert.ok(record);
    await waitFor(() => Object.values(record.state.tasks)[0]?.status === "completed");

    assert.equal(Object.keys(record.state.delegations).length, 2);
    assert.equal(Object.keys(record.state.artifacts).length, 2);
    assert.equal(Object.values(record.state.barriers)[0]?.status, "satisfied");
    assert.equal(channel.messages.length, 3);
    assert.equal(events.filter((event) => event.type === "agent_run_started").length, 2);
    assert.equal(events.filter((event) => event.type === "agent_run_finished" && event.run?.state === "completed").length, 2);
    assert.equal(capturedRuns.filter((run) => run.purpose === "synthesis").length, 0);

    const workSessions = await human.call("app://kairos/session-manager", "list_work_sessions", {
      mime_type: "application/json",
      data: {},
    });
    const workSession = (workSessions.data as { sessions: Array<{ session_id: string; phase: string; agents: unknown[]; blockers: unknown[]; latest_report?: string }> }).sessions[0];
    assert.equal(workSession?.session_id, record.id);
    assert.equal(workSession?.phase, "done");
    assert.equal(workSession?.agents.length, 2);
    assert.equal(workSession?.blockers.length, 0);
    assert.ok(workSession?.latest_report?.includes("cindy completed") || workSession?.latest_report?.includes("alice completed"));

    const projected = events.filter((event) => event.type === "message_created" && event.message?.thread_id === rootId);
    assert.deepEqual(projected.map((event) => event.message?.sender).sort(), ["agent://local/alice", "agent://local/cindy"]);
    assert.equal(projected.filter((event) => event.message?.projection?.presentation === "artifact").length, 2);
    assert.equal(projected.filter((event) => event.message?.projection?.presentation === "final_report").length, 0);
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await channel.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
    await cindy.node.close().catch(() => undefined);
    await coordinator.node.close().catch(() => undefined);
  }
});

test("session manager projects final result summaries while storing artifact bodies", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const channel = createSlockChannel({
    uri: "app://slock/channel/general",
    session_manager_uri: "app://kairos/session-manager",
    mention_aliases: { alice: "agent://local/alice" },
  });
  const capturedRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: reportingRuntime(capturedRuns) });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  try {
    await human.connect(ipc.createTransport("human"));
    await sessionManager.node.connect(ipc.createTransport("session-manager"));
    await channel.node.connect(ipc.createTransport("channel"));
    await alice.node.connect(ipc.createTransport("alice"));

    await human.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@alice inspect the implementation path", thread_id: null },
    });

    await waitFor(() => events.some((event) => event.type === "agent_run_finished" && event.run?.state === "completed"));

    const record = [...sessionManager.sessions.values()][0];
    assert.ok(record);
    assert.equal(Object.keys(record.state.artifacts).length, 1);
    assert.equal(Object.keys(record.state.notes).length, 2);
    assert.equal(channel.messages.length, 3);
    assert.ok(channel.messages.some((message) => message.text === "Checking implementation path."));
    assert.ok(channel.messages.some((message) => message.text.includes("Finding: Implementation path is ready enough to review.")));
    assert.ok(channel.messages.some((message) => message.text.includes("Risk: File boundary still needs validation before the session can be treated as low-risk.")));
    assert.ok(!channel.messages.some((message) => message.text.includes("Detailed artifact for review")));
    assert.equal(events.filter((event) => event.type === "message_created" && event.message?.kind === "agent").length, 2);

    const runFinished = events.find((event) => event.type === "agent_run_finished" && event.run?.state === "completed");
    assert.ok(runFinished?.run?.final_message_id);

    const artifact = Object.values(record.state.artifacts)[0];
    assert.deepEqual(artifact?.content, {
      summary: "Finding: Implementation path is ready enough to review. The first pass found a coherent route through the session manager and channel projection code.\n\nRisk: File boundary still needs validation before the session can be treated as low-risk. The artifact calls out which ownership lines Cindy should verify next.\n\nNext: Review the artifact for the detailed checklist, then decide whether the boundary needs another focused pass.",
      final_text: "Detailed artifact for review.",
    });

    const rendered = await human.call("app://kairos/session-manager", "render_context", {
      mime_type: "application/json",
      data: { session_id: record.id, audience: "agent://local/cindy", purpose: "review" },
    });
    assert.ok((rendered.data as { text: string }).text.includes("Cindy should validate the file boundary."));
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await channel.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
  }
});

test("progress reports do not suppress final artifact projections", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const channel = createSlockChannel({
    uri: "app://slock/channel/general",
    session_manager_uri: "app://kairos/session-manager",
    mention_aliases: { alice: "agent://local/alice" },
  });
  const capturedRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: progressOnlyRuntime(capturedRuns) });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  try {
    await human.connect(ipc.createTransport("human"));
    await sessionManager.node.connect(ipc.createTransport("session-manager"));
    await channel.node.connect(ipc.createTransport("channel"));
    await alice.node.connect(ipc.createTransport("alice"));

    await human.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@alice inspect the implementation path", thread_id: null },
    });

    await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.projection?.presentation === "artifact"));

    const record = [...sessionManager.sessions.values()][0];
    assert.ok(record);
    assert.equal(capturedRuns.length, 1);
    assert.ok(Object.values(record.state.notes).some((note) => note.purpose === "progress"));
    assert.ok(!Object.values(record.state.notes).some((note) => note.purpose === "final_summary"));
    assert.ok(channel.messages.some((message) => message.text === "Checking implementation path."));
    assert.ok(channel.messages.some((message) => message.text === "Detailed artifact for review."));
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await channel.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
  }
});

test("session manager mode suppresses legacy stream text and thread auto-mentions", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const channel = createSlockChannel({
    uri: "app://slock/channel/general",
    session_manager_uri: "app://kairos/session-manager",
    mention_aliases: { alice: "agent://local/alice" },
  });
  const capturedRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: legacyStreamingRuntime(capturedRuns) });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  try {
    await human.connect(ipc.createTransport("human"));
    await sessionManager.node.connect(ipc.createTransport("session-manager"));
    await channel.node.connect(ipc.createTransport("channel"));
    await alice.node.connect(ipc.createTransport("alice"));

    await human.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    const posted = await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@alice inspect the architecture", thread_id: null },
    });
    const rootId = (posted.data as { id: string }).id;

    await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.projection?.presentation === "artifact"));
    assert.equal(capturedRuns.length, 1);
    assert.equal(events.some((event) => event.type === "message_delta" && event.delta?.kind !== "status"), false);
    assert.equal(channel.messages.some((message) => message.text.includes("Legacy streamed body")), false);

    const followup = await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "noted, keep this attached to the same session", thread_id: rootId },
    });
    const followupMessage = followup.data as { id: string; mentions: string[] };
    assert.deepEqual(followupMessage.mentions, []);

    const record = [...sessionManager.sessions.values()][0];
    assert.ok(record);
    await waitFor(() => record.state.source_refs.some((ref) => ref.kind === "channel_message" && ref.message_id === followupMessage.id));
    assert.equal(Object.keys(record.state.delegations).length, 1);
    assert.equal(capturedRuns.length, 1);
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await channel.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
  }
});

test("session manager supports explicit session lifecycle and source moves", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const sourceRef = { kind: "external" as const, uri: "external://ticket/123", label: "ticket 123" };

  try {
    await human.connect(ipc.createTransport("human"));
    await sessionManager.node.connect(ipc.createTransport("session-manager"));

    const manifest = await human.call("app://kairos/session-manager", "manifest", {
      mime_type: "application/json",
      data: {},
    });
    const manifestText = String(manifest.data);
    assert.match(manifestText, /export interface SessionManagerSubmitArtifactRequest/);
    assert.match(manifestText, /submit_artifact\(payload: SessionManagerSubmitArtifactRequest\): SessionManagerSessionSnapshot/);
    assert.match(manifestText, /ask_question\(payload: SessionManagerAskQuestionRequest\): SessionManagerQuestionResult/);
    assert.match(manifestText, /answer_question\(payload: SessionManagerAnswerQuestionRequest\): SessionManagerSessionSnapshot/);
    assert.match(manifestText, /report_message\(payload: SessionManagerReportMessageRequest\): SessionManagerReportMessageResult/);
    assert.match(manifestText, /record_decision\(payload: SessionManagerRecordDecisionRequest\): SessionManagerSessionSnapshot/);

    await human.call("app://kairos/session-manager", "create_session", {
      mime_type: "application/json",
      data: {
        session_id: "session_ticket_a",
        title: "Investigate ticket 123",
        source_ref: sourceRef,
      },
    });
    await human.call("app://kairos/session-manager", "create_session", {
      mime_type: "application/json",
      data: {
        session_id: "session_ticket_b",
        title: "Implement ticket 123",
      },
    });

    const firstResolve = await human.call("app://kairos/session-manager", "resolve_session", {
      mime_type: "application/json",
      data: { source_ref: sourceRef },
    });
    assert.equal((firstResolve.data as { session_id?: string }).session_id, "session_ticket_a");

    const moved = await human.call("app://kairos/session-manager", "move_source", {
      mime_type: "application/json",
      data: {
        to_session_id: "session_ticket_b",
        source_ref: sourceRef,
        reason: "implementation owns this source now",
      },
    });
    assert.equal((moved.data as { session_id: string }).session_id, "session_ticket_b");

    const secondResolve = await human.call("app://kairos/session-manager", "resolve_session", {
      mime_type: "application/json",
      data: { source_ref: sourceRef },
    });
    assert.equal((secondResolve.data as { session_id?: string }).session_id, "session_ticket_b");

    const recordA = sessionManager.getSession("session_ticket_a");
    const recordB = sessionManager.getSession("session_ticket_b");
    assert.ok(recordA);
    assert.ok(recordB);
    assert.ok(!recordA.state.source_refs.some((ref) => ref.kind === "external" && ref.uri === sourceRef.uri));
    assert.ok(recordB.state.source_refs.some((ref) => ref.kind === "external" && ref.uri === sourceRef.uri));

    await human.call("app://kairos/session-manager", "close_session", {
      mime_type: "application/json",
      data: { session_id: "session_ticket_b", status: "archived" },
    });
    assert.equal(recordB.state.session?.status, "archived");

    await human.call("app://kairos/session-manager", "reopen_session", {
      mime_type: "application/json",
      data: { session_id: "session_ticket_b" },
    });
    assert.equal(recordB.state.session?.status, "open");
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
  }
});

test("session manager exposes production workflow actions and dashboard projections", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });

  try {
    await human.connect(ipc.createTransport("human"));
    await sessionManager.node.connect(ipc.createTransport("session-manager"));

    await human.call("app://kairos/session-manager", "create_session", {
      mime_type: "application/json",
      data: {
        session_id: "session_dashboard_actions",
        title: "Build dashboard actions",
        objective: "Make review and validation visible.",
        acceptance_criteria: ["Artifact review is typed", "Validation can fail visibly"],
      },
    });
    const record = sessionManager.getSession("session_dashboard_actions");
    assert.ok(record);
    assert.equal(record.state.session?.objective, "Make review and validation visible.");
    assert.deepEqual(record.state.session?.acceptance_criteria, ["Artifact review is typed", "Validation can fail visibly"]);

    await human.call("app://kairos/session-manager", "update_session_goal", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        constraints: [{ boundary: "do not touch kernel/sdk" }],
      },
    });

    await human.call("app://kairos/session-manager", "submit_artifact", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        artifact: {
          id: "artifact_dashboard_plan",
          author: "agent://local/alice",
          kind: "evaluation",
          title: "Dashboard plan",
          content: { text: "Actions are app-layer session events." },
        },
      },
    });
    await human.call("app://kairos/session-manager", "review_artifact", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        artifact_id: "artifact_dashboard_plan",
        status: "accepted",
        note: "Good enough for projection.",
      },
    });
    assert.equal(record.state.artifacts.artifact_dashboard_plan?.status, "accepted");
    assert.equal(record.state.artifacts.artifact_dashboard_plan?.review?.reviewer, "human://user/local");

    const approvalResult = await human.call("app://kairos/session-manager", "request_approval", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        tool_endpoint: "plugin://local/workspace",
        action: "edit",
        risk: "high",
        payload_summary: "update dashboard files",
      },
    });
    const approvalId = (approvalResult.data as { approval: { id: string } }).approval.id;
    assert.equal(record.state.approvals[approvalId]?.status, "pending");

    const queueWithApproval = await human.call("app://kairos/session-manager", "list_review_queue", {
      mime_type: "application/json",
      data: {},
    });
    assert.ok((queueWithApproval.data as { items: Array<{ id: string }> }).items.some((item) => item.id === `approval:${approvalId}`));

    await human.call("app://kairos/session-manager", "resolve_approval", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        approval_id: approvalId,
        approved: false,
        resolution_note: "Use a read-only pass first.",
      },
    });
    assert.equal(record.state.approvals[approvalId]?.status, "rejected");

    const validationResult = await human.call("app://kairos/session-manager", "request_validation", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        artifact_id: "artifact_dashboard_plan",
        summary: "Run projection checks",
      },
    });
    const validationId = (validationResult.data as { validation: { id: string } }).validation.id;
    await human.call("app://kairos/session-manager", "record_validation", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        validation_id: validationId,
        status: "failed",
        summary: "Projection check failed",
        trace_refs: [{ endpoint: "plugin://local/workspace", action: "search", label: "projection check" }],
      },
    });
    assert.equal(record.state.validations[validationId]?.status, "failed");

    await human.call("app://kairos/session-manager", "link_trace", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        object_ref: "artifact:artifact_dashboard_plan",
        trace_ref: { endpoint: "plugin://local/workspace", action: "read", label: "artifact evidence" },
      },
    });
    assert.ok(record.state.artifacts.artifact_dashboard_plan?.trace_refs?.some((ref) => ref.action === "read"));

    const detail = await human.call("app://kairos/session-manager", "get_session_detail", {
      mime_type: "application/json",
      data: { session_id: record.id },
    });
    const detailData = detail.data as { session: { session: { build_board?: { columns: unknown[]; write_operations: unknown[] } }; constraints: unknown[]; approvals: unknown[]; validations: unknown[] } };
    assert.equal(detailData.session.constraints.length, 1);
    assert.equal(detailData.session.approvals.length, 1);
    assert.equal(detailData.session.validations.length, 1);
    assert.equal(detailData.session.session.build_board?.columns.length, 5);
    assert.equal(detailData.session.session.build_board?.write_operations.length, 1);

    const queueWithValidation = await human.call("app://kairos/session-manager", "list_review_queue", {
      mime_type: "application/json",
      data: {},
    });
    assert.ok((queueWithValidation.data as { items: Array<{ id: string }> }).items.some((item) => item.id === `validation:${validationId}`));

    await assert.rejects(
      human.call("app://kairos/session-manager", "report_message", {
        mime_type: "application/json",
        data: {
          session_id: record.id,
          visibility: "human",
          text: "# Detailed report\n- This belongs in an artifact.",
        },
      }),
      /plain text/,
    );

    await assert.rejects(
      human.call("app://kairos/session-manager", "report_message", {
        mime_type: "application/json",
        data: {
          session_id: record.id,
          visibility: "human",
          text: "x".repeat(81),
        },
      }),
      /under 80 characters/,
    );

    await assert.rejects(
      human.call("app://kairos/session-manager", "report_message", {
        mime_type: "application/json",
        data: {
          session_id: record.id,
          visibility: "human",
          text: "Done.\nNext.",
        },
      }),
      /one brief IM status line/,
    );

    const legacySummary = await human.call("app://kairos/session-manager", "report_message", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        visibility: "human",
        purpose: "final_summary",
        text: "Finding: Legacy callers can still record this.\nNext: Final result summaries own IM projection.",
      },
    });
    assert.equal((legacySummary.data as { note: { purpose: string }; projected_message_id?: string }).note.purpose, "final_summary");
    assert.equal((legacySummary.data as { projected_message_id?: string }).projected_message_id, undefined);
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
  }
});

test("session manager emits realtime dashboard subscription events from real sessions", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const emitted: Array<Record<string, unknown>> = [];
  const ended: Array<Record<string, unknown>> = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === KAIROS_DASHBOARD_EVENT_MIME) {
      emitted.push(payload.data as Record<string, unknown>);
    }
  });
  human.onEnd("*", (payload) => {
    if (payload.mime_type === KAIROS_DASHBOARD_EVENT_MIME) {
      ended.push(payload.data as Record<string, unknown>);
    }
  });

  try {
    await human.connect(ipc.createTransport("human"));
    await sessionManager.node.connect(ipc.createTransport("session-manager"));

    await human.call("app://kairos/session-manager", "subscribe_dashboard", {
      mime_type: "application/json",
      data: { include_snapshot: true },
    });
    await waitFor(() => emitted.some((event) => event.type === "dashboard_snapshot"));
    const snapshot = emitted.find((event) => event.type === "dashboard_snapshot") as { sessions?: unknown[]; review_queue?: unknown[]; agent_workload?: unknown[]; sequence?: number };
    assert.deepEqual(snapshot.sessions, []);
    assert.deepEqual(snapshot.review_queue, []);
    assert.deepEqual(snapshot.agent_workload, []);
    assert.equal(typeof snapshot.sequence, "number");

    await human.call("app://kairos/session-manager", "create_session", {
      mime_type: "application/json",
      data: {
        session_id: "session_dashboard_realtime",
        title: "Realtime dashboard",
        objective: "Stream real session projections into the work dashboard.",
      },
    });
    await waitFor(() => emitted.some((event) => event.type === "session_updated" && event.session_id === "session_dashboard_realtime"));
    const created = emitted.findLast((event) => event.type === "session_updated" && event.session_id === "session_dashboard_realtime") as { sessions?: Array<{ title?: string }>; session?: { title?: string }; source_event?: { id?: string; type?: string } };
    assert.equal(created.session?.title, "Realtime dashboard");
    assert.equal(created.sessions?.[0]?.title, "Realtime dashboard");
    assert.ok(created.source_event?.id);
    assert.ok(created.source_event?.type);

    await human.call("app://kairos/session-manager", "request_approval", {
      mime_type: "application/json",
      data: {
        session_id: "session_dashboard_realtime",
        tool_endpoint: "plugin://local/workspace",
        action: "edit",
        risk: "medium",
        payload_summary: "update dashboard implementation",
      },
    });
    await waitFor(() => emitted.some((event) => Array.isArray(event.review_queue) && event.review_queue.some((item: { kind?: string }) => item.kind === "approval")));
    const approvalUpdate = emitted.findLast((event) => Array.isArray(event.review_queue) && event.review_queue.length > 0) as { review_queue?: Array<{ kind?: string; session_id?: string }> };
    assert.equal(approvalUpdate.review_queue?.[0]?.kind, "approval");
    assert.equal(approvalUpdate.review_queue?.[0]?.session_id, "session_dashboard_realtime");

    await human.call("app://kairos/session-manager", "unsubscribe_dashboard", {
      mime_type: "application/json",
      data: { reason: "test complete" },
    });
    await waitFor(() => ended.some((event) => event.type === "dashboard_subscription_closed"));
    assert.equal(ended.at(-1)?.reason, "test complete");
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
  }
});

test("session manager can run validation through a validator agent", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const capturedRuns: SlockAgentRun[] = [];
  const validator = createAgentAdapter({ uri: "agent://local/validator", runtime: recordingRuntime("validator", capturedRuns) });

  try {
    await human.connect(ipc.createTransport("human"));
    await sessionManager.node.connect(ipc.createTransport("session-manager"));
    await validator.node.connect(ipc.createTransport("validator"));

    await human.call("app://kairos/session-manager", "create_session", {
      mime_type: "application/json",
      data: {
        session_id: "session_validation_runner",
        title: "Validate dashboard projection",
      },
    });
    const record = sessionManager.getSession("session_validation_runner");
    assert.ok(record);

    await human.call("app://kairos/session-manager", "submit_artifact", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        artifact: {
          id: "artifact_projection",
          author: "agent://local/alice",
          kind: "summary",
          title: "Projection implementation",
          content: { text: "Projection implementation is ready for validation." },
        },
      },
    });

    const validationResult = await human.call("app://kairos/session-manager", "request_validation", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        artifact_id: "artifact_projection",
        validator: "agent://local/validator",
        summary: "Validate projection implementation",
        run: true,
      },
    });
    const validationId = (validationResult.data as { validation: { id: string }; delegation_id?: string }).validation.id;
    const validationDelegationId = (validationResult.data as { delegation_id?: string }).delegation_id;
    assert.ok(validationDelegationId);

    await waitFor(() => record.state.validations[validationId]?.status === "passed");
    assert.equal(capturedRuns.length, 1);
    assert.equal(capturedRuns[0]?.purpose, "validation");
    assert.ok(capturedRuns[0]?.context_text?.includes("Purpose: validation"));
    assert.equal(record.state.delegations[validationDelegationId!]?.role, "validation");
    const validationArtifact = Object.values(record.state.artifacts).find((artifact) => artifact.kind === "validation_result");
    assert.ok(validationArtifact);
    assert.equal(record.state.validations[validationId]?.artifact_id, validationArtifact.id);
    assert.ok(record.state.delegations[validationDelegationId!]?.trace_refs?.some((ref) => ref.action === "run"));
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await validator.node.close().catch(() => undefined);
  }
});

test("session manager records structured and inferred delegation roles", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const capturedRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: recordingRuntime("alice", capturedRuns) });
  const cindy = createAgentAdapter({ uri: "agent://local/cindy", runtime: recordingRuntime("cindy", capturedRuns) });

  try {
    await human.connect(ipc.createTransport("human"));
    await sessionManager.node.connect(ipc.createTransport("session-manager"));
    await alice.node.connect(ipc.createTransport("alice"));
    await cindy.node.connect(ipc.createTransport("cindy"));

    await human.call("app://kairos/session-manager", "create_or_attach_session", {
      mime_type: "application/json",
      data: {
        message: {
          id: "channel_msg_roles",
          channel: "app://slock/channel/general",
          sender: "human://user/local",
          text: "@cindy 负责看代码质量，@alice 负责看架构设计，研究这个仓库",
          mentions: ["agent://local/cindy", "agent://local/alice"],
          thread_id: null,
          reply_to_id: null,
          kind: "human",
          created_at: "2026-05-09T00:00:00.000Z",
        },
        objective: "Research the repository with separate quality and architecture roles.",
        acceptance_criteria: ["Quality risks are named", "Architecture risks are named"],
        delegation_plan: [
          {
            assignee: "agent://local/alice",
            role: "architecture",
            role_label: "Architecture design",
            expected_output: "Architecture review artifact",
          },
        ],
      },
    });

    await waitFor(() => capturedRuns.length === 2);
    const record = [...sessionManager.sessions.values()][0];
    assert.ok(record);
    const aliceDelegation = Object.values(record.state.delegations).find((delegation) => delegation.assignee === "agent://local/alice");
    const cindyDelegation = Object.values(record.state.delegations).find((delegation) => delegation.assignee === "agent://local/cindy");
    assert.equal(aliceDelegation?.role, "architecture");
    assert.equal(aliceDelegation?.role_label, "Architecture design");
    assert.equal(cindyDelegation?.role_label, "代码质量");
    assert.deepEqual(record.state.session?.acceptance_criteria, ["Quality risks are named", "Architecture risks are named"]);
    assert.ok(capturedRuns.find((run) => run.delegation_id === aliceDelegation?.id)?.context_text?.includes("role: Architecture design"));
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
    await cindy.node.close().catch(() => undefined);
  }
});

test("explicit routing can start or target sessions without channel heuristics", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const channel = createSlockChannel({
    uri: "app://slock/channel/general",
    session_manager_uri: "app://kairos/session-manager",
    mention_aliases: { alice: "agent://local/alice" },
  });
  const capturedRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: recordingRuntime("alice", capturedRuns) });

  try {
    await human.connect(ipc.createTransport("human"));
    await sessionManager.node.connect(ipc.createTransport("session-manager"));
    await channel.node.connect(ipc.createTransport("channel"));
    await alice.node.connect(ipc.createTransport("alice"));

    await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@alice first task", thread_id: null },
    });
    await waitFor(() => capturedRuns.length === 1);
    const first = [...sessionManager.sessions.values()][0];
    assert.ok(first);

    await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@alice second task", thread_id: null, new_session: true },
    });
    await waitFor(() => capturedRuns.length === 2 && sessionManager.sessions.size === 2);
    const second = [...sessionManager.sessions.values()].find((record) => record.id !== first.id);
    assert.ok(second);

    const amendment = await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@alice amend first task", thread_id: null, session_id: first.id },
    });
    const amendmentId = (amendment.data as { id: string }).id;
    await waitFor(() => capturedRuns.length === 3);
    assert.equal(sessionManager.sessions.size, 2);
    assert.ok(first.state.source_refs.some((ref) => ref.kind === "channel_message" && ref.message_id === amendmentId));

    await human.call("app://kairos/session-manager", "close_session", {
      mime_type: "application/json",
      data: { session_id: first.id },
    });
    await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "@alice third task after close", thread_id: null },
    });
    await waitFor(() => capturedRuns.length === 4 && sessionManager.sessions.size === 3);
    assert.equal(first.state.session?.status, "completed");
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await channel.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
  }
});

test("direct delegation request creates an explicit Dify-sourced session and public run shape", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });

  try {
    await human.connect(ipc.createTransport("human-direct-contract"));
    await sessionManager.node.connect(ipc.createTransport("session-direct-contract"));

    const created = await human.call("app://kairos/session-manager", "create_session", {
      mime_type: "application/json",
      data: {
        title: "Review repository architecture",
        objective: "Find architecture and code-quality risks.",
        acceptance_criteria: ["Alice submits architecture artifact", "Cindy submits code-quality artifact"],
        source_ref: {
          kind: "external",
          uri: "dify://app/kairos/conversation/conv_1/message/msg_1",
          label: "Dify user message",
        },
      },
    });

    const sessionId = (created.data as { session_id: string }).session_id;
    const record = sessionManager.getSession(sessionId);
    assert.ok(record);
    assert.equal(record.state.session?.origin.kind, "external");
    assert.equal(record.state.session?.origin.uri, "dify://app/kairos/conversation/conv_1/message/msg_1");

    const result = await human.call("app://kairos/session-manager", "start_delegations", {
      mime_type: "application/json",
      data: {
        session_id: sessionId,
        task_title: "Review repository architecture",
        owner: "human://user/local",
        instruction: "Review the repository and submit a concise artifact.",
        expected_output: "Markdown artifact with findings and risks.",
        mode: "parallel",
        synthesis_requested: false,
        delegations: [
          { assignee: "agent://local/alice", role: "architecture", role_label: "Architecture", instruction: "Review architecture boundaries." },
          { assignee: "agent://local/cindy", role: "code_quality", role_label: "Code quality", instruction: "Review maintainability and tests." },
        ],
        source_refs: [{ kind: "external", uri: "dify://app/kairos/conversation/conv_1/message/msg_1", label: "Dify user message" }],
      },
    });

    const data = result.data as { session_id: string; task_id: string; delegation_ids: string[]; barrier_id?: string; mode: string };
    assert.equal(data.session_id, sessionId);
    assert.equal(data.mode, "parallel");
    assert.equal(data.delegation_ids.length, 2);
    assert.ok(data.task_id);
    assert.ok(data.barrier_id);
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
  }
});

test("direct delegation runtime starts agents, records artifacts, and cancels by delegation id", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const capturedRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: recordingRuntime("alice", capturedRuns) });
  const cindy = createAgentAdapter({ uri: "agent://local/cindy", runtime: recordingRuntime("cindy", capturedRuns) });
  const slowRuns: SlockAgentRun[] = [];
  const slow = createAgentAdapter({ uri: "agent://local/slow", runtime: cancellableRuntime(slowRuns) });

  try {
    await human.connect(ipc.createTransport("human-direct-runtime"));
    await sessionManager.node.connect(ipc.createTransport("session-direct-runtime"));
    await alice.node.connect(ipc.createTransport("alice-direct-runtime"));
    await cindy.node.connect(ipc.createTransport("cindy-direct-runtime"));
    await slow.node.connect(ipc.createTransport("slow-direct-runtime"));

    const created = await human.call("app://kairos/session-manager", "create_session", {
      mime_type: "application/json",
      data: {
        session_id: "session_dify_direct_runtime",
        title: "Direct Dify bridge run",
        source_ref: { kind: "external", uri: "dify://app/kairos/conversation/conv_2/message/msg_2", label: "Dify user message" },
      },
    });
    const sessionId = (created.data as { session_id: string }).session_id;
    const record = sessionManager.getSession(sessionId);
    assert.ok(record);

    const started = await human.call("app://kairos/session-manager", "start_delegations", {
      mime_type: "application/json",
      data: {
        session_id: sessionId,
        task_title: "Review direct bridge behavior",
        instruction: "Inspect the direct delegation context and submit findings.",
        expected_output: "A concise summary artifact.",
        mode: "parallel",
        synthesis_requested: false,
        source_refs: [{ kind: "external", uri: "dify://app/kairos/conversation/conv_2/message/msg_2", label: "Dify user message" }],
        delegations: [
          { assignee: "agent://local/alice", role: "architecture", instruction: "Check architecture handoff." },
          { assignee: "agent://local/cindy", role: "quality", instruction: "Check quality risks." },
        ],
      },
    });
    const directRun = started.data as { delegation_ids: string[]; barrier_id: string };

    await waitFor(() => capturedRuns.length === 2);
    await waitFor(() => record.state.barriers[directRun.barrier_id]?.status === "satisfied");
    assert.equal(Object.keys(record.state.artifacts).length, 2);
    assert.deepEqual(capturedRuns.map((run) => run.session_id), [sessionId, sessionId]);
    assert.deepEqual(capturedRuns.map((run) => run.delegation_id).sort(), [...directRun.delegation_ids].sort());
    assert.ok(capturedRuns.every((run) => run.context_text?.includes("Inspect the direct delegation context")));
    assert.ok(capturedRuns.every((run) => run.source_refs?.some((ref) => ref.kind === "external" && ref.uri === "dify://app/kairos/conversation/conv_2/message/msg_2")));

    const cancelStarted = await human.call("app://kairos/session-manager", "start_delegations", {
      mime_type: "application/json",
      data: {
        session_id: sessionId,
        task_title: "Cancellable direct run",
        instruction: "Stay active until cancelled.",
        mode: "parallel",
        delegations: [{ assignee: "agent://local/slow", instruction: "Wait for cancellation." }],
      },
    });
    const cancelRun = cancelStarted.data as { task_id: string; delegation_ids: string[]; barrier_id: string };
    const cancelDelegationId = cancelRun.delegation_ids[0];
    assert.ok(cancelDelegationId);
    await waitFor(() => slowRuns.length === 1 && record.state.delegations[cancelDelegationId]?.status === "running");

    const cancelled = await human.call("app://kairos/session-manager", "cancel_delegation_run", {
      mime_type: "application/json",
      data: {
        session_id: sessionId,
        delegation_id: cancelDelegationId,
        reason: "Dify user stopped the run",
      },
    });
    assert.deepEqual(cancelled.data, {
      cancelled: true,
      session_id: sessionId,
      delegation_id: cancelDelegationId,
      agent: "agent://local/slow",
      reason: "Dify user stopped the run",
    });
    await waitFor(() => record.state.delegations[cancelDelegationId]?.status === "cancelled" && Object.keys(record.state.active_runs).length === 0);
    assert.equal(record.state.barriers[cancelRun.barrier_id]?.status, "cancelled");
    assert.equal(record.state.tasks[cancelRun.task_id]?.status, "cancelled");
    assert.ok(record.events.some((event) => event.type === "agent_run_cancelled" && event.reason === "Dify user stopped the run"));
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
    await cindy.node.close().catch(() => undefined);
    await slow.node.close().catch(() => undefined);
  }
});

test("direct delegation rejects duplicate assignees before creating work", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });

  try {
    await human.connect(ipc.createTransport("human-direct-duplicates"));
    await sessionManager.node.connect(ipc.createTransport("session-direct-duplicates"));

    await human.call("app://kairos/session-manager", "create_session", {
      mime_type: "application/json",
      data: { session_id: "session_direct_duplicates", title: "Reject duplicate direct agents" },
    });
    const record = sessionManager.getSession("session_direct_duplicates");
    assert.ok(record);
    const tasksBefore = Object.keys(record.state.tasks).length;

    await assert.rejects(
      human.call("app://kairos/session-manager", "start_delegations", {
        mime_type: "application/json",
        data: {
          session_id: record.id,
          instruction: "Review the same request once per assignee.",
          delegations: [
            { assignee: "agent://local/alice" },
            { assignee: "agent://local/alice", role: "duplicate" },
          ],
        },
      }),
      /duplicate delegation assignee/,
    );

    assert.equal(Object.keys(record.state.tasks).length, tasksBefore);
    assert.equal(Object.keys(record.state.delegations).length, 0);
    assert.equal(Object.keys(record.state.barriers).length, 0);
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
  }
});

test("direct delegation in a Slock-backed session projects artifacts to the origin thread", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const channel = createSlockChannel({
    uri: "app://slock/channel/general",
    session_manager_uri: "app://kairos/session-manager",
  });
  const capturedRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: recordingRuntime("alice", capturedRuns) });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  try {
    await human.connect(ipc.createTransport("human-direct-slock-origin"));
    await sessionManager.node.connect(ipc.createTransport("session-direct-slock-origin"));
    await channel.node.connect(ipc.createTransport("channel-direct-slock-origin"));
    await alice.node.connect(ipc.createTransport("alice-direct-slock-origin"));

    await human.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    const posted = await human.call("app://slock/channel/general", "post_message", {
      mime_type: SLOCK_MESSAGE_MIME,
      data: { text: "Create a Slock-backed session for direct delegation", thread_id: null },
    });
    const rootId = (posted.data as { id: string }).id;
    await waitFor(() => sessionManager.sessions.size === 1);
    const record = [...sessionManager.sessions.values()][0];
    assert.ok(record);

    await human.call("app://kairos/session-manager", "start_delegations", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        instruction: "Run directly inside the Slock-backed session.",
        delegations: [{ assignee: "agent://local/alice" }],
      },
    });

    await waitFor(() => events.some((event) => event.type === "message_created" && event.message?.projection?.presentation === "artifact"));
    const projected = events.find((event) => event.type === "message_created" && event.message?.projection?.presentation === "artifact")?.message;
    assert.equal(projected?.thread_id, rootId);
    assert.equal(projected?.reply_to_id, rootId);
    assert.equal(projected?.sender, "agent://local/alice");
    assert.equal(projected?.projection?.session_id, record.id);
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await channel.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
  }
});

test("direct delegation in an external session uses the configured agent event channel", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({
    uri: "app://kairos/session-manager",
    agent_event_channel_uri: "app://slock/channel/general",
  });
  const channel = createSlockChannel({
    uri: "app://slock/channel/general",
    session_manager_uri: "app://kairos/session-manager",
  });
  const capturedRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: recordingRuntime("alice", capturedRuns) });
  const events: SlockChannelEvent[] = [];

  human.onEmit("*", (payload) => {
    if (payload.mime_type === SLOCK_CHANNEL_EVENT_MIME) {
      events.push(payload.data as SlockChannelEvent);
    }
  });

  try {
    await human.connect(ipc.createTransport("human-external-agent-events"));
    await sessionManager.node.connect(ipc.createTransport("session-external-agent-events"));
    await channel.node.connect(ipc.createTransport("channel-external-agent-events"));
    await alice.node.connect(ipc.createTransport("alice-external-agent-events"));

    await human.call("app://slock/channel/general", "subscribe", { mime_type: "application/json", data: {} });
    const created = await human.call("app://kairos/session-manager", "create_session", {
      mime_type: "application/json",
      data: {
        session_id: "session_external_agent_events",
        title: "External Dify run",
        source_ref: { kind: "external", uri: "dify://app/kairos/conversation/conv_event/message/msg_event", label: "Dify user message" },
      },
    });
    const sessionId = (created.data as { session_id: string }).session_id;
    const record = sessionManager.getSession(sessionId);
    assert.ok(record);

    await human.call("app://kairos/session-manager", "start_delegations", {
      mime_type: "application/json",
      data: {
        session_id: sessionId,
        task_title: "External event routing",
        instruction: "Run without a Slock origin message.",
        mode: "parallel",
        delegations: [{ assignee: "agent://local/alice", instruction: "Report progress and finish." }],
      },
    });

    await waitFor(() => capturedRuns.length === 1);
    await waitFor(() => Object.keys(record.state.artifacts).length === 1);

    assert.equal(capturedRuns[0]?.channel, "app://slock/channel/general");
    assert.ok(events.some((event) => event.type === "message_delta" && event.delta?.kind === "status" && event.delta.source === "agent://local/alice"));
    assert.doesNotMatch(readFileSync(ipc.tracePath, "utf8"), /target is not registered: app:\/\/kairos\/session\/session_external_agent_events/);
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await channel.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
  }
});

test("direct delegation reopens a completed task when task_id is reused", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const capturedRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: recordingRuntime("alice", capturedRuns) });
  const slowRuns: SlockAgentRun[] = [];
  const slow = createAgentAdapter({ uri: "agent://local/slow", runtime: cancellableRuntime(slowRuns) });

  try {
    await human.connect(ipc.createTransport("human-direct-task-reopen"));
    await sessionManager.node.connect(ipc.createTransport("session-direct-task-reopen"));
    await alice.node.connect(ipc.createTransport("alice-direct-task-reopen"));
    await slow.node.connect(ipc.createTransport("slow-direct-task-reopen"));

    await human.call("app://kairos/session-manager", "create_session", {
      mime_type: "application/json",
      data: { session_id: "session_direct_task_reopen", title: "Direct task reuse" },
    });
    const record = sessionManager.getSession("session_direct_task_reopen");
    assert.ok(record);

    const first = await human.call("app://kairos/session-manager", "start_delegations", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        instruction: "Complete the initial direct task.",
        delegations: [{ assignee: "agent://local/alice" }],
      },
    });
    const taskId = (first.data as { task_id: string }).task_id;
    await waitFor(() => record.state.tasks[taskId]?.status === "completed");

    await human.call("app://kairos/session-manager", "start_delegations", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        task_id: taskId,
        instruction: "Reopen this task for another direct pass.",
        delegations: [{ assignee: "agent://local/slow" }],
      },
    });

    await waitFor(() => slowRuns.length === 1);
    assert.equal(record.state.tasks[taskId]?.status, "open");
    assert.ok(record.events.some((event) => event.type === "task_updated" && event.task_id === taskId && event.patch.status === "open"));
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
    await slow.node.close().catch(() => undefined);
  }
});

test("direct delegation cancellation lets remaining agents satisfy the barrier", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const slowRuns: SlockAgentRun[] = [];
  const slow = createAgentAdapter({ uri: "agent://local/slow", runtime: cancellableRuntime(slowRuns) });
  const cindyRuns: SlockAgentRun[] = [];
  const cindyDeferred = deferredFinalRuntime("cindy", cindyRuns);
  const cindy = createAgentAdapter({ uri: "agent://local/cindy", runtime: cindyDeferred.runtime });

  try {
    await human.connect(ipc.createTransport("human-direct-cancel-before-peer"));
    await sessionManager.node.connect(ipc.createTransport("session-direct-cancel-before-peer"));
    await slow.node.connect(ipc.createTransport("slow-direct-cancel-before-peer"));
    await cindy.node.connect(ipc.createTransport("cindy-direct-cancel-before-peer"));

    await human.call("app://kairos/session-manager", "create_session", {
      mime_type: "application/json",
      data: { session_id: "session_direct_cancel_before_peer", title: "Cancel one direct agent first" },
    });
    const record = sessionManager.getSession("session_direct_cancel_before_peer");
    assert.ok(record);

    const started = await human.call("app://kairos/session-manager", "start_delegations", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        instruction: "Let the remaining direct agent finish after cancellation.",
        delegations: [
          { assignee: "agent://local/slow" },
          { assignee: "agent://local/cindy" },
        ],
      },
    });
    const run = started.data as { task_id: string; barrier_id: string };
    await waitFor(() => slowRuns.length === 1 && cindyRuns.length === 1);
    const slowDelegationId = Object.values(record.state.delegations).find((delegation) => delegation.assignee === "agent://local/slow")?.id;
    assert.ok(slowDelegationId);

    await human.call("app://kairos/session-manager", "cancel_delegation_run", {
      mime_type: "application/json",
      data: { session_id: record.id, delegation_id: slowDelegationId, reason: "cancel slow only" },
    });
    await waitFor(() => record.state.delegations[slowDelegationId]?.status === "cancelled");
    assert.equal(record.state.barriers[run.barrier_id]?.status, "open");
    assert.deepEqual(record.state.barriers[run.barrier_id]?.expected_from, ["agent://local/cindy"]);

    cindyDeferred.resolve();
    await waitFor(() => record.state.barriers[run.barrier_id]?.status === "satisfied" && record.state.tasks[run.task_id]?.status === "completed");
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await slow.node.close().catch(() => undefined);
    await cindy.node.close().catch(() => undefined);
  }
});

test("direct delegation cancellation satisfies the barrier when another agent already replied", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const aliceRuns: SlockAgentRun[] = [];
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: recordingRuntime("alice", aliceRuns) });
  const slowRuns: SlockAgentRun[] = [];
  const slow = createAgentAdapter({ uri: "agent://local/slow", runtime: cancellableRuntime(slowRuns) });

  try {
    await human.connect(ipc.createTransport("human-direct-cancel-after-peer"));
    await sessionManager.node.connect(ipc.createTransport("session-direct-cancel-after-peer"));
    await alice.node.connect(ipc.createTransport("alice-direct-cancel-after-peer"));
    await slow.node.connect(ipc.createTransport("slow-direct-cancel-after-peer"));

    await human.call("app://kairos/session-manager", "create_session", {
      mime_type: "application/json",
      data: { session_id: "session_direct_cancel_after_peer", title: "Cancel after one reply" },
    });
    const record = sessionManager.getSession("session_direct_cancel_after_peer");
    assert.ok(record);

    const started = await human.call("app://kairos/session-manager", "start_delegations", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        instruction: "One direct agent replies before the other is cancelled.",
        delegations: [
          { assignee: "agent://local/alice" },
          { assignee: "agent://local/slow" },
        ],
      },
    });
    const run = started.data as { task_id: string; barrier_id: string };
    await waitFor(() => Object.values(record.state.artifacts).some((artifact) => artifact.author === "agent://local/alice") && slowRuns.length === 1);
    const slowDelegationId = Object.values(record.state.delegations).find((delegation) => delegation.assignee === "agent://local/slow")?.id;
    assert.ok(slowDelegationId);

    await human.call("app://kairos/session-manager", "cancel_delegation_run", {
      mime_type: "application/json",
      data: { session_id: record.id, delegation_id: slowDelegationId, reason: "alice already answered" },
    });

    await waitFor(() => record.state.barriers[run.barrier_id]?.status === "satisfied" && record.state.tasks[run.task_id]?.status === "completed");
    assert.deepEqual(record.state.barriers[run.barrier_id]?.expected_from, ["agent://local/alice"]);
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
    await slow.node.close().catch(() => undefined);
  }
});

test("direct delegation cancellation only updates the barrier for its batch", async () => {
  const ipc = createContext();
  const human = createNode("human://user/local");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const slowRuns: SlockAgentRun[] = [];
  const slow = createAgentAdapter({ uri: "agent://local/slow", runtime: cancellableRuntime(slowRuns) });
  const cindyRuns: SlockAgentRun[] = [];
  const cindyDeferred = deferredFinalRuntime("cindy", cindyRuns);
  const cindy = createAgentAdapter({ uri: "agent://local/cindy", runtime: cindyDeferred.runtime });
  const aliceRuns: SlockAgentRun[] = [];
  const aliceDeferred = deferredFinalRuntime("alice", aliceRuns);
  const alice = createAgentAdapter({ uri: "agent://local/alice", runtime: aliceDeferred.runtime });

  try {
    await human.connect(ipc.createTransport("human-direct-cancel-scoped"));
    await sessionManager.node.connect(ipc.createTransport("session-direct-cancel-scoped"));
    await slow.node.connect(ipc.createTransport("slow-direct-cancel-scoped"));
    await cindy.node.connect(ipc.createTransport("cindy-direct-cancel-scoped"));
    await alice.node.connect(ipc.createTransport("alice-direct-cancel-scoped"));

    await human.call("app://kairos/session-manager", "create_session", {
      mime_type: "application/json",
      data: { session_id: "session_direct_cancel_scoped", title: "Scoped direct cancellation" },
    });
    const record = sessionManager.getSession("session_direct_cancel_scoped");
    assert.ok(record);

    const first = await human.call("app://kairos/session-manager", "start_delegations", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        instruction: "Keep first direct batch open.",
        delegations: [
          { assignee: "agent://local/slow" },
          { assignee: "agent://local/cindy" },
        ],
      },
    });
    const firstRun = first.data as { task_id: string; delegation_ids: string[]; barrier_id: string };
    await waitFor(() => slowRuns.length === 1 && cindyRuns.length === 1);

    const second = await human.call("app://kairos/session-manager", "start_delegations", {
      mime_type: "application/json",
      data: {
        session_id: record.id,
        task_id: firstRun.task_id,
        instruction: "Keep second direct batch open too.",
        delegations: [
          { assignee: "agent://local/slow" },
          { assignee: "agent://local/alice" },
        ],
      },
    });
    const secondRun = second.data as { delegation_ids: string[]; barrier_id: string };
    await waitFor(() => slowRuns.length === 2 && aliceRuns.length === 1);
    const secondSlowDelegationId = secondRun.delegation_ids.find((id) => record.state.delegations[id]?.assignee === "agent://local/slow");
    assert.ok(secondSlowDelegationId);

    await human.call("app://kairos/session-manager", "cancel_delegation_run", {
      mime_type: "application/json",
      data: { session_id: record.id, delegation_id: secondSlowDelegationId, reason: "cancel second slow only" },
    });
    await waitFor(() => record.state.delegations[secondSlowDelegationId]?.status === "cancelled");

    assert.equal(record.state.barriers[firstRun.barrier_id]?.status, "open");
    assert.deepEqual(record.state.barriers[firstRun.barrier_id]?.expected_from, ["agent://local/slow", "agent://local/cindy"]);
    assert.equal(record.state.barriers[secondRun.barrier_id]?.status, "open");
    assert.deepEqual(record.state.barriers[secondRun.barrier_id]?.expected_from, ["agent://local/alice"]);
  } finally {
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
    await slow.node.close().catch(() => undefined);
    await cindy.node.close().catch(() => undefined);
    await alice.node.close().catch(() => undefined);
  }
});

function recordingRuntime(name: string, capturedRuns: SlockAgentRun[]): AgentRuntime {
  return {
    async *run(input) {
      capturedRuns.push(input);
      const amendment = input.context_text?.includes("RevenueCat") ? " with RevenueCat" : "";
      yield { type: "status", text: `${name} reading session context` };
      yield {
        type: "final",
        result: {
          summary: `${name} completed${amendment}`,
          final_text: `${name} completed${amendment} ${input.session_id} ${input.delegation_id}`,
        },
      };
    },
  };
}

function cancellableRuntime(capturedRuns: SlockAgentRun[]): AgentRuntime {
  return {
    async *run(input, context) {
      capturedRuns.push(input);
      await new Promise<void>((resolve) => {
        if (context.signal?.aborted) {
          resolve();
          return;
        }
        context.signal?.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 5000);
      });
      if (context.signal?.aborted) {
        return;
      }
      yield {
        type: "final",
        result: {
          summary: "slow completed",
          final_text: "slow completed",
        },
      };
    },
  };
}

function deferredFinalRuntime(name: string, capturedRuns: SlockAgentRun[]): { runtime: AgentRuntime; resolve: () => void } {
  let resolveRun: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });
  return {
    resolve: () => resolveRun?.(),
    runtime: {
      async *run(input) {
        capturedRuns.push(input);
        await ready;
        yield {
          type: "final",
          result: {
            summary: `${name} completed`,
            final_text: `${name} completed ${input.session_id} ${input.delegation_id}`,
          },
        };
      },
    },
  };
}

function legacyStreamingRuntime(capturedRuns: SlockAgentRun[]): AgentRuntime {
  return {
    async *run(input) {
      capturedRuns.push(input);
      yield { type: "message_delta", text: "Legacy streamed body that belongs in an artifact." };
      yield {
        type: "final",
        result: {
          summary: "Legacy final summary.",
          final_text: "Legacy final body that should only be stored as an artifact.",
        },
      };
    },
  };
}

function progressOnlyRuntime(capturedRuns: SlockAgentRun[]): AgentRuntime {
  return {
    async *run(input, context) {
      capturedRuns.push(input);
      await context.node.call("app://kairos/session-manager", "report_message", {
        mime_type: "application/json",
        data: {
          session_id: input.session_id,
          delegation_id: input.delegation_id,
          visibility: "human",
          purpose: "progress",
          text: "Checking implementation path.",
        },
      });
      yield {
        type: "final",
        result: {
          summary: "Detailed artifact for review.",
          final_text: "Detailed artifact for review.",
        },
      };
    },
  };
}

function reportingRuntime(capturedRuns: SlockAgentRun[]): AgentRuntime {
  return {
    async *run(input, context) {
      capturedRuns.push(input);
      await context.node.call("app://kairos/session-manager", "report_message", {
        mime_type: "application/json",
        data: {
          session_id: input.session_id,
          delegation_id: input.delegation_id,
          visibility: "human",
          purpose: "progress",
          text: "Checking implementation path.",
        },
      });
      await context.node.call("app://kairos/session-manager", "report_message", {
        mime_type: "application/json",
        data: {
          session_id: input.session_id,
          delegation_id: input.delegation_id,
          visibility: "agents",
          to: ["agent://local/cindy"],
          text: "Cindy should validate the file boundary.",
        },
      });
      yield {
        type: "final",
        result: {
          summary: "Finding: Implementation path is ready enough to review. The first pass found a coherent route through the session manager and channel projection code.\n\nRisk: File boundary still needs validation before the session can be treated as low-risk. The artifact calls out which ownership lines Cindy should verify next.\n\nNext: Review the artifact for the detailed checklist, then decide whether the boundary needs another focused pass.",
          final_text: "Detailed artifact for review.",
        },
      };
    },
  };
}

function coordinatorRuntime(capturedRuns: SlockAgentRun[]): AgentRuntime {
  return {
    async *run(input, context) {
      capturedRuns.push(input);
      const seesWorkers = Boolean(input.context_text?.includes("alice completed") && input.context_text.includes("cindy completed"));
      await context.node.call("app://kairos/session-manager", "report_message", {
        mime_type: "application/json",
        data: {
          session_id: input.session_id,
          delegation_id: input.delegation_id,
          visibility: "human",
          text: "Drafting final synthesis.",
        },
      });
      yield {
        type: "final",
        result: {
          summary: seesWorkers ? "coordinator saw workers" : "coordinator missed workers",
          final_text: seesWorkers ? "coordinator saw workers" : "coordinator missed workers",
        },
      };
    },
  };
}

function createContext() {
  const dir = mkdtempSync(join("/tmp", "kairos-ipc-session-manager-test-"));
  const tracePath = join(dir, "trace.jsonl");
  const registry = new EndpointRegistry();
  const trace = new TraceWriter(tracePath);
  const router = new Router({ registry, capabilityGate: new AllowAllCapabilityGate(), trace });

  return {
    tracePath,
    createTransport(id: string): IpcTransport {
      return new MemoryKernelTransport(id, registry, router, trace);
    },
  };
}

class MemoryKernelTransport implements IpcTransport {
  private readonly connection: Connection;
  private readonly registry: EndpointRegistry;
  private readonly router: Router;
  private readonly trace: TraceWriter;
  private readonly listeners = new Set<(frame: KernelFrame) => void>();
  private closed = false;

  constructor(id: string, registry: EndpointRegistry, router: Router, trace: TraceWriter) {
    this.registry = registry;
    this.router = router;
    this.trace = trace;
    this.connection = {
      id,
      send: (frame) => this.emit(frame),
    };
  }

  send(frame: ClientFrame): void {
    if (this.closed) {
      throw new Error(`transport is closed: ${this.connection.id}`);
    }

    if (frame.type === "register") {
      const result = this.registry.register(frame.uri, this.connection);
      if (!result.ok) {
        this.emit({ type: "error", error: { code: "REGISTER_FAILED", message: result.error ?? "register failed" } });
        return;
      }
      this.trace.recordEvent({ event: "endpoint_registered", uri: frame.uri, connection_id: this.connection.id });
      this.emit({ type: "registered", uri: frame.uri });
      return;
    }

    this.router.route(frame.envelope, this.connection);
  }

  onFrame(listener: (frame: KernelFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    const removed = this.registry.unregisterConnection(this.connection);
    for (const uri of removed) {
      this.trace.recordEvent({ event: "endpoint_unregistered", uri, connection_id: this.connection.id });
    }
  }

  private emit(frame: KernelFrame): void {
    for (const listener of this.listeners) {
      listener(frame);
    }
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
