import { readFile } from "node:fs/promises";
import type { EndpointUri } from "../../protocol/src/index.ts";
import type { Artifact, ApprovalRequest, CollaborationState, Delegation } from "../../collaboration-context/src/index.ts";
import type {
  SessionManagerCancelDelegationRunResult,
  SessionManagerSessionSnapshot,
  SessionManagerStartDelegationsResult,
  SessionManagerWorkSessionResult,
} from "../../session-manager/src/index.ts";
import { buildTraceView, parseTraceJsonl, type TraceViewFilters } from "../../slock-ui-bridge/src/trace-viewer.ts";
import { sourceRefFromDifyMetadata } from "./source-refs.ts";
import type {
  DifyApprovalListResponse,
  DifyApprovalSummary,
  DifyArtifactDetail,
  DifyArtifactListResponse,
  DifyArtifactMetadata,
  DifyBridgeOptions,
  DifyCancelRunRequest,
  DifyCancelRunResponse,
  DifyChatRequest,
  DifyChatResponse,
  DifyCreateSessionRequest,
  DifyCreateSessionResponse,
  DifyPostMessageRequest,
  DifyResolveApprovalRequest,
  DifyResolveApprovalResponse,
  DifyReviewArtifactRequest,
  DifyReviewArtifactResponse,
  DifyRunSummary,
  DifySessionSummary,
  DifyStartRunRequest,
  DifyStartRunResponse,
  DifyTraceResult,
} from "./types.ts";

export interface DifyBridgeService {
  chat(request: DifyChatRequest): Promise<DifyChatResponse>;
  createSession(request: DifyCreateSessionRequest): Promise<DifyCreateSessionResponse>;
  getSession(sessionId: string): Promise<DifySessionSummary>;
  postMessage(sessionId: string, request: DifyPostMessageRequest): Promise<DifySessionSummary>;
  startRun(sessionId: string, request: DifyStartRunRequest): Promise<DifyStartRunResponse>;
  cancelRun(runId: string, request?: DifyCancelRunRequest): Promise<DifyCancelRunResponse>;
  listArtifacts(sessionId: string): Promise<DifyArtifactListResponse>;
  readArtifact(artifactId: string, sessionId?: string): Promise<DifyArtifactDetail>;
  reviewArtifact(artifactId: string, request: DifyReviewArtifactRequest): Promise<DifyReviewArtifactResponse>;
  listApprovals(sessionId: string): Promise<DifyApprovalListResponse>;
  resolveApproval(approvalId: string, request: DifyResolveApprovalRequest): Promise<DifyResolveApprovalResponse>;
  getSessionTrace(sessionId: string): Promise<DifyTraceResult>;
  getRunTrace(runId: string): Promise<DifyTraceResult>;
}

export function createDifyBridgeService(options: DifyBridgeOptions): DifyBridgeService {
  const human = options.human_node;
  const sessionManagerUri = options.session_manager_uri;

  return {
    chat,
    createSession,
    getSession,
    postMessage,
    startRun,
    cancelRun,
    listArtifacts,
    readArtifact,
    reviewArtifact,
    listApprovals,
    resolveApproval,
    getSessionTrace,
    getRunTrace,
  };

  async function chat(request: DifyChatRequest): Promise<DifyChatResponse> {
    const agents = request.agents?.length ? request.agents : DEFAULT_CHAT_AGENTS;
    const created = await createSession({
      title: request.title ?? titleFromMessage(request.message),
      objective: request.message,
      acceptance_criteria: request.acceptance_criteria ?? DEFAULT_CHAT_ACCEPTANCE_CRITERIA,
      source: request.source,
    });
    const run = await startRun(created.session_id, {
      instruction: chatInstruction(request.message),
      agents,
      mode: "parallel",
      expected_output: request.expected_output ?? DEFAULT_CHAT_EXPECTED_OUTPUT,
      synthesis_requested: false,
      source: request.source,
    });
    return {
      session_id: created.session_id,
      runs: run.runs,
      status_url: run.status_url,
      text: chatText(created.session_id, run.runs),
    };
  }

  async function createSession(request: DifyCreateSessionRequest): Promise<DifyCreateSessionResponse> {
    const sourceRef = sourceRefFromDifyMetadata(request.source, "Dify session");
    const result = await human.call<typeof request & { source_ref: typeof sourceRef }, SessionManagerSessionSnapshot>(sessionManagerUri, "create_session", {
      mime_type: "application/json",
      data: {
        title: request.title,
        objective: request.objective,
        acceptance_criteria: request.acceptance_criteria,
        source_ref: sourceRef,
      },
    });
    return {
      session_id: result.data.session_id,
      session_uri: result.data.session_uri,
      status: result.data.state.session?.status,
    };
  }

  async function getSession(sessionId: string): Promise<DifySessionSummary> {
    await human.call<{ session_id: string }, SessionManagerWorkSessionResult>(sessionManagerUri, "get_work_session", {
      mime_type: "application/json",
      data: { session_id: sessionId },
    }).catch(() => undefined);
    const snapshot = await getState(sessionId);
    return summarizeSession(snapshot.data);
  }

  async function postMessage(sessionId: string, request: DifyPostMessageRequest): Promise<DifySessionSummary> {
    const sourceRef = sourceRefFromDifyMetadata(request.source, "Dify message");
    await human.call(sessionManagerUri, "attach_source", {
      mime_type: "application/json",
      data: {
        session_id: sessionId,
        source_ref: sourceRef,
        reason: request.text?.trim() ? `Dify message: ${request.text.trim()}` : "Dify message attached",
      },
    });
    return getSession(sessionId);
  }

  async function startRun(sessionId: string, request: DifyStartRunRequest): Promise<DifyStartRunResponse> {
    const sourceRef = sourceRefFromDifyMetadata(request.source, "Dify run");
    const delegations = request.delegation_plan?.length
      ? request.delegation_plan
      : request.agents.map((assignee) => ({ assignee }));

    const result = await human.call(sessionManagerUri, "start_delegations", {
      mime_type: "application/json",
      data: {
        session_id: sessionId,
        instruction: request.instruction,
        expected_output: request.expected_output,
        mode: request.mode ?? "parallel",
        synthesis_requested: request.synthesis_requested,
        source_refs: [sourceRef],
        delegations,
      },
    });
    const data = result.data as SessionManagerStartDelegationsResult;
    const state = await getState(sessionId).then((snapshot) => snapshot.data.state).catch(() => undefined);
    return {
      session_id: data.session_id,
      task_id: data.task_id,
      barrier_id: data.barrier_id,
      mode: data.mode,
      runs: data.delegation_ids.map((delegationId): DifyRunSummary => {
        const delegation = state?.delegations[delegationId];
        return {
          agent: delegation?.assignee ?? assigneeForDelegationRequest(delegations, delegationId) ?? "agent://unknown",
          delegation_id: delegationId,
          status: delegation?.status ?? "pending",
        };
      }),
      status_url: `/sessions/${encodeURIComponent(sessionId)}`,
    };
  }

  async function cancelRun(runId: string, request: DifyCancelRunRequest = {}): Promise<DifyCancelRunResponse> {
    const sessionId = request.session_id ?? await resolveSessionIdForDelegation(runId);
    const result = await human.call(sessionManagerUri, "cancel_delegation_run", {
      mime_type: "application/json",
      data: {
        session_id: sessionId,
        delegation_id: runId,
        reason: request.reason,
      },
    });
    return result.data as SessionManagerCancelDelegationRunResult;
  }

  async function listArtifacts(sessionId: string): Promise<DifyArtifactListResponse> {
    const snapshot = await getState(sessionId);
    return {
      session_id: sessionId,
      artifacts: Object.values(snapshot.data.state.artifacts).map(artifactMetadata),
    };
  }

  async function readArtifact(artifactId: string, sessionId?: string): Promise<DifyArtifactDetail> {
    const resolved = await resolveArtifact(artifactId, sessionId);
    return artifactDetail(resolved.artifact);
  }

  async function reviewArtifact(artifactId: string, request: DifyReviewArtifactRequest): Promise<DifyReviewArtifactResponse> {
    const sessionId = request.session_id ?? (await resolveArtifact(artifactId)).sessionId;
    const sourceRefs = request.source ? [sourceRefFromDifyMetadata(request.source, "Dify artifact review")] : undefined;
    const result = await human.call(sessionManagerUri, "review_artifact", {
      mime_type: "application/json",
      data: {
        session_id: sessionId,
        artifact_id: artifactId,
        status: request.status,
        note: request.note,
        reviewer: request.reviewer,
        revision_instruction: request.revision_instruction,
        rerun: request.rerun,
        source_refs: sourceRefs,
      },
    });
    const artifact = (result.data as SessionManagerSessionSnapshot).state.artifacts[artifactId];
    return {
      session_id: sessionId,
      artifact_id: artifactId,
      status: artifact?.review?.status ?? request.status,
      note: artifact?.review?.note ?? request.note,
    };
  }

  async function listApprovals(sessionId: string): Promise<DifyApprovalListResponse> {
    const snapshot = await getState(sessionId);
    return {
      session_id: sessionId,
      approvals: Object.values(snapshot.data.state.approvals)
        .filter((approval) => approval.status === "pending")
        .map(approvalSummary),
    };
  }

  async function resolveApproval(approvalId: string, request: DifyResolveApprovalRequest): Promise<DifyResolveApprovalResponse> {
    const sessionId = request.session_id ?? await resolveSessionIdForApproval(approvalId);
    const result = await human.call(sessionManagerUri, "resolve_approval", {
      mime_type: "application/json",
      data: {
        session_id: sessionId,
        approval_id: approvalId,
        status: request.status,
        approved: request.approved,
        resolved_by: request.resolved_by,
        resolution_note: request.resolution_note,
      },
    });
    const approval = (result.data as SessionManagerSessionSnapshot).state.approvals[approvalId];
    return { session_id: sessionId, approval_id: approvalId, status: approval?.status ?? request.status ?? (request.approved === false ? "rejected" : "approved") };
  }

  async function getSessionTrace(sessionId: string): Promise<DifyTraceResult> {
    await getState(sessionId);
    return traceResult({ q: sessionId });
  }

  async function getRunTrace(runId: string): Promise<DifyTraceResult> {
    await resolveSessionIdForDelegation(runId);
    const correlationId = await resolveCorrelationIdForDelegation(runId);
    return traceResult(correlationId ? { correlation_id: correlationId } : { q: runId });
  }

  async function getState(sessionId: string) {
    return human.call<{ session_id: string }, SessionManagerSessionSnapshot>(sessionManagerUri, "get_session_state", {
      mime_type: "application/json",
      data: { session_id: sessionId },
    });
  }

  async function listSessionIds(): Promise<string[]> {
    const result = await human.call(sessionManagerUri, "list_sessions", { mime_type: "application/json", data: {} });
    return ((result.data as { sessions?: Array<{ session_id: string }> }).sessions ?? []).map((session) => session.session_id);
  }

  async function resolveArtifact(artifactId: string, sessionId?: string): Promise<{ sessionId: string; artifact: Artifact }> {
    const sessionIds = sessionId ? [sessionId] : await listSessionIds();
    for (const id of sessionIds) {
      const snapshot = await getState(id);
      const artifact = snapshot.data.state.artifacts[artifactId];
      if (artifact) return { sessionId: id, artifact };
    }
    throw new Error(`artifact not found: ${artifactId}`);
  }

  async function resolveSessionIdForDelegation(delegationId: string): Promise<string> {
    for (const sessionId of await listSessionIds()) {
      const snapshot = await getState(sessionId);
      if (snapshot.data.state.delegations[delegationId]) return sessionId;
    }
    throw new Error(`delegation not found: ${delegationId}`);
  }

  async function resolveSessionIdForApproval(approvalId: string): Promise<string> {
    for (const sessionId of await listSessionIds()) {
      const snapshot = await getState(sessionId);
      if (snapshot.data.state.approvals[approvalId]) return sessionId;
    }
    throw new Error(`approval not found: ${approvalId}`);
  }

  async function resolveCorrelationIdForDelegation(delegationId: string): Promise<string | undefined> {
    for (const sessionId of await listSessionIds()) {
      const snapshot = await getState(sessionId);
      const delegation = snapshot.data.state.delegations[delegationId];
      if (delegation?.correlation_id) return delegation.correlation_id;
    }
    return undefined;
  }

  async function traceResult(filters: TraceViewFilters): Promise<DifyTraceResult> {
    if (!options.trace_path) {
      return { available: false, view: buildTraceView([]) };
    }
    try {
      const text = await readFile(options.trace_path, "utf8");
      const events = parseTraceJsonl(text);
      return { available: true, trace_path: options.trace_path, view: buildTraceView(events, { filters }) };
    } catch {
      return { available: false, trace_path: options.trace_path, view: buildTraceView([]) };
    }
  }
}

const DEFAULT_CHAT_AGENTS: EndpointUri[] = ["agent://local/alice", "agent://local/cindy"];

const DEFAULT_CHAT_ACCEPTANCE_CRITERIA = [
  "Create a Kairos collaboration session from the Dify chat message.",
  "Run the selected Kairos agents through the local IPC runtime.",
  "Return durable artifacts, summaries, approvals, and trace through Kairos bridge APIs.",
];

const DEFAULT_CHAT_EXPECTED_OUTPUT = "Concise agent summaries plus durable markdown artifacts with findings, evidence, risks, and next steps.";

function titleFromMessage(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  if (!trimmed) return "Kairos chat request";
  const chars = Array.from(trimmed);
  return chars.length <= 64 ? trimmed : `${chars.slice(0, 61).join("")}...`;
}

function chatInstruction(message: string): string {
  return `${message.trim()}\n\nWork in the configured Kairos workspace. Keep IM progress brief. Submit a concise summary plus a durable markdown artifact with findings, evidence, risks, and recommended next steps.`;
}

function chatText(sessionId: string, runs: DifyRunSummary[]): string {
  const agents = runs.map((run) => run.agent).join(", ");
  const runIds = runs.map((run) => run.delegation_id).join(", ");
  return [
    `Kairos session started: ${sessionId}`,
    `Agents: ${agents}`,
    `Runs: ${runIds}`,
    "I will keep this chat lightweight. Use the session artifacts for the full markdown results and trace evidence.",
  ].join("\n");
}

function summarizeSession(snapshot: SessionManagerSessionSnapshot): DifySessionSummary {
  const state = snapshot.state;
  const artifacts = Object.values(state.artifacts).sort(compareByCreatedAt);
  const latestArtifact = artifacts.at(-1);
  const pendingApprovals = Object.values(state.approvals).filter((approval) => approval.status === "pending").map(approvalSummary);
  return {
    session_id: snapshot.session_id,
    session_uri: snapshot.session_uri,
    title: state.session?.title,
    objective: state.session?.objective,
    phase: sessionPhase(state),
    status: state.session?.status,
    agents: uniqueAgents(Object.values(state.delegations)),
    latest_summary: latestSummary(state, latestArtifact),
    latest_artifact: latestArtifact ? artifactMetadata(latestArtifact) : undefined,
    blockers: blockers(state),
    pending_approvals: pendingApprovals,
    trace_refs: state.trace_refs,
  };
}

function artifactMetadata(artifact: Artifact): DifyArtifactMetadata {
  return {
    id: artifact.id,
    session_id: artifact.session_id,
    author: artifact.author,
    kind: artifact.kind,
    title: artifact.title,
    status: artifact.status,
    summary: artifactSummary(artifact),
    created_at: artifact.created_at,
    updated_at: artifact.updated_at,
    source_refs: artifact.source_refs,
    trace_refs: artifact.trace_refs,
  };
}

function artifactDetail(artifact: Artifact): DifyArtifactDetail {
  return {
    ...artifactMetadata(artifact),
    content: artifact.content,
    review: artifact.review,
    relates_to: artifact.relates_to,
  };
}

function approvalSummary(approval: ApprovalRequest): DifyApprovalSummary {
  return {
    id: approval.id,
    session_id: approval.session_id,
    requester: approval.requester,
    tool_endpoint: approval.tool_endpoint,
    action: approval.action,
    risk: approval.risk,
    payload_summary: approval.payload_summary,
    status: approval.status,
    created_at: approval.created_at,
    resolved_at: approval.resolved_at,
    resolved_by: approval.resolved_by,
    resolution_note: approval.resolution_note,
  };
}

function uniqueAgents(delegations: Delegation[]): EndpointUri[] {
  return [...new Set(delegations.map((delegation) => delegation.assignee))];
}

function latestSummary(state: CollaborationState, latestArtifact: Artifact | undefined): string | undefined {
  const latestNote = Object.values(state.notes).sort(compareByCreatedAt).at(-1);
  return latestNote?.text ?? (latestArtifact ? artifactSummary(latestArtifact) : undefined);
}

function artifactSummary(artifact: Artifact): string | undefined {
  const content = artifact.content;
  if (isRecord(content)) {
    if (typeof content.summary === "string") return clipSummary(content.summary);
  }
  return undefined;
}

const METADATA_SUMMARY_MAX_CHARS = 320;

function clipSummary(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const chars = Array.from(trimmed);
  return chars.length <= METADATA_SUMMARY_MAX_CHARS
    ? trimmed
    : `${chars.slice(0, METADATA_SUMMARY_MAX_CHARS - 3).join("")}...`;
}

function blockers(state: CollaborationState): string[] {
  return [
    ...Object.values(state.approvals).filter((approval) => approval.status === "pending").map((approval) => `approval:${approval.id}`),
    ...Object.values(state.questions).filter((question) => question.status === "asked").map((question) => `question:${question.id}`),
    ...Object.values(state.barriers).filter((barrier) => barrier.status === "open").map((barrier) => `barrier:${barrier.id}`),
  ];
}

function sessionPhase(state: CollaborationState): string {
  if (Object.values(state.active_runs).length > 0) return "running";
  if (Object.values(state.approvals).some((approval) => approval.status === "pending")) return "approval_pending";
  if (Object.values(state.tasks).some((task) => task.status === "blocked")) return "blocked";
  if (Object.values(state.tasks).some((task) => task.status === "open")) return "open";
  if (Object.values(state.tasks).length > 0 && Object.values(state.tasks).every((task) => task.status === "completed")) return "completed";
  return state.session?.status ?? "unknown";
}

function assigneeForDelegationRequest(delegations: Array<{ assignee: EndpointUri }>, delegationId: string): EndpointUri | undefined {
  const indexMatch = delegationId.match(/_(\d+)$/);
  const index = indexMatch ? Number(indexMatch[1]) - 1 : -1;
  return index >= 0 ? delegations[index]?.assignee : undefined;
}

function compareByCreatedAt(left: { created_at?: string }, right: { created_at?: string }): number {
  return String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
