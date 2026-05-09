import type { EndpointUri } from "../../protocol/src/index.ts";
import type { ContextCompaction, RenderForAgentRequest, SourceRef } from "../../collaboration-context/src/index.ts";
import type { SlockCancelAgentRunRequest, SlockMessage } from "../../slock-channel/src/index.ts";
import {
  type SessionManagerAnswerQuestionRequest,
  type SessionManagerAskQuestionRequest,
  type SessionManagerAttachSourceRequest,
  type SessionManagerCloseSessionRequest,
  type SessionManagerCreateSessionRequest,
  type SessionManagerDashboardSubscriptionRequest,
  type SessionManagerDashboardUnsubscribeRequest,
  type SessionManagerLinkTraceRequest,
  type SessionManagerListContextCompactionsRequest,
  type SessionManagerMoveSourceRequest,
  type SessionManagerRecordValidationRequest,
  type SessionManagerRecordContextCompactionRequest,
  type SessionManagerRecordDecisionRequest,
  type SessionManagerRenderContextRequest,
  type SessionManagerReportMessageRequest,
  type SessionManagerRequestApprovalRequest,
  type SessionManagerRequestSynthesisRequest,
  type SessionManagerRequestValidationRequest,
  type SessionManagerResolveApprovalRequest,
  type SessionManagerResolveRequest,
  type SessionManagerReviewArtifactRequest,
  type SessionManagerRouteMessageRequest,
  type SessionManagerRunValidationRequest,
  type SessionManagerSubmitArtifactRequest,
  type SessionManagerUpdateSessionGoalRequest,
} from "./types.ts";
import { uniqueEndpointUris } from "./helpers.ts";

export function readDashboardSubscriptionRequest(value: unknown): SessionManagerDashboardSubscriptionRequest {
  if (!isRecord(value)) {
    return {};
  }
  return {
    session_id: typeof value.session_id === "string" && value.session_id.trim().length > 0 ? value.session_id.trim() : undefined,
    include_snapshot: value.include_snapshot === false ? false : undefined,
    include_detail: value.include_detail === true ? true : undefined,
  };
}

export function readDashboardUnsubscribeRequest(value: unknown): SessionManagerDashboardUnsubscribeRequest {
  if (!isRecord(value)) {
    return {};
  }
  return {
    subscriber: typeof value.subscriber === "string" && value.subscriber.trim().length > 0 ? value.subscriber.trim() : undefined,
    reason: typeof value.reason === "string" && value.reason.trim().length > 0 ? value.reason.trim() : undefined,
  };
}

export function readRouteMessageRequest(value: unknown): SessionManagerRouteMessageRequest {
  if (!isRecord(value) || !isSlockMessage(value.message)) {
    throw new Error("create_or_attach_session requires a Slock message");
  }
  return {
    message: value.message,
    mentions: Array.isArray(value.mentions) ? value.mentions.filter((item): item is EndpointUri => typeof item === "string") : undefined,
    session_id: typeof value.session_id === "string" ? value.session_id : undefined,
    new_session: value.new_session === true ? true : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    objective: typeof value.objective === "string" ? value.objective : undefined,
    acceptance_criteria: readStringArray(value.acceptance_criteria),
    delegation_plan: readDelegationPlan(value.delegation_plan),
  };
}

export function readCreateSessionRequest(value: unknown): SessionManagerCreateSessionRequest {
  if (!isRecord(value)) {
    return {};
  }
  return {
    session_id: typeof value.session_id === "string" && value.session_id.trim().length > 0 ? value.session_id.trim() : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    objective: typeof value.objective === "string" ? value.objective : undefined,
    acceptance_criteria: readStringArray(value.acceptance_criteria),
    owner: typeof value.owner === "string" ? value.owner : undefined,
    message: isSlockMessage(value.message) ? value.message : undefined,
    source_ref: isSourceRef(value.source_ref) ? value.source_ref : undefined,
  };
}

export function readUpdateSessionGoalRequest(value: unknown): SessionManagerUpdateSessionGoalRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || value.session_id.trim().length === 0) {
    throw new Error("update_session_goal requires session_id");
  }
  return {
    session_id: value.session_id,
    title: typeof value.title === "string" ? value.title : undefined,
    objective: typeof value.objective === "string" ? value.objective : undefined,
    acceptance_criteria: readStringArray(value.acceptance_criteria),
    constraints: Array.isArray(value.constraints) ? value.constraints : undefined,
    source_refs: Array.isArray(value.source_refs) ? value.source_refs.filter(isSourceRef) : undefined,
  };
}

export function readCloseSessionRequest(value: unknown): SessionManagerCloseSessionRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || value.session_id.trim().length === 0) {
    throw new Error("close_session requires session_id");
  }
  return {
    session_id: value.session_id,
    status: value.status === "cancelled" || value.status === "archived" || value.status === "completed" ? value.status : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

export function readReopenSessionRequest(value: unknown): { session_id: string; reason?: string } {
  if (!isRecord(value) || typeof value.session_id !== "string" || value.session_id.trim().length === 0) {
    throw new Error("reopen_session requires session_id");
  }
  return {
    session_id: value.session_id,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

export function readMoveSourceRequest(value: unknown): SessionManagerMoveSourceRequest {
  if (!isRecord(value) || typeof value.to_session_id !== "string" || value.to_session_id.trim().length === 0) {
    throw new Error("move_source requires to_session_id");
  }
  return {
    to_session_id: value.to_session_id,
    from_session_id: typeof value.from_session_id === "string" ? value.from_session_id : undefined,
    message: isSlockMessage(value.message) ? value.message : undefined,
    source_ref: isSourceRef(value.source_ref) ? value.source_ref : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

export function readResolveRequest(value: unknown): SessionManagerResolveRequest {
  if (!isRecord(value)) {
    return {};
  }
  return {
    source_ref: isSourceRef(value.source_ref) ? value.source_ref : undefined,
    channel: typeof value.channel === "string" ? value.channel : undefined,
    message_id: typeof value.message_id === "string" ? value.message_id : undefined,
    thread_id: typeof value.thread_id === "string" ? value.thread_id : value.thread_id === null ? null : undefined,
  };
}

export function readAttachSourceRequest(value: unknown): SessionManagerAttachSourceRequest {
  if (!isRecord(value)) {
    throw new Error("attach_source requires an object payload");
  }
  return {
    session_id: typeof value.session_id === "string" ? value.session_id : undefined,
    message: isSlockMessage(value.message) ? value.message : undefined,
    source_ref: isSourceRef(value.source_ref) ? value.source_ref : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

export function readRenderContextRequest(value: unknown): SessionManagerRenderContextRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || typeof value.audience !== "string") {
    throw new Error("render_context requires session_id and audience");
  }
  return {
    session_id: value.session_id,
    audience: value.audience,
    purpose: readRenderPurpose(value.purpose),
    delegation_id: typeof value.delegation_id === "string" ? value.delegation_id : undefined,
  };
}

export function readSubmitArtifactRequest(value: unknown): SessionManagerSubmitArtifactRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || !isRecord(value.artifact)) {
    throw new Error("submit_artifact requires session_id and artifact");
  }
  if (typeof value.artifact.author !== "string" || typeof value.artifact.kind !== "string" || !("content" in value.artifact)) {
    throw new Error("submit_artifact artifact requires author, kind, and content");
  }
  return {
    session_id: value.session_id,
    delegation_id: typeof value.delegation_id === "string" ? value.delegation_id : undefined,
    artifact: value.artifact as SessionManagerSubmitArtifactRequest["artifact"],
    project: value.project === false ? false : undefined,
  };
}

export function readReviewArtifactRequest(value: unknown, defaultStatus?: SessionManagerReviewArtifactRequest["status"]): SessionManagerReviewArtifactRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || typeof value.artifact_id !== "string") {
    throw new Error("review_artifact requires session_id and artifact_id");
  }
  const status = defaultStatus ?? readArtifactReviewStatus(value.status);
  if (!status) {
    throw new Error("review_artifact requires status accepted, rejected, or revision_requested");
  }
  return {
    session_id: value.session_id,
    artifact_id: value.artifact_id,
    status,
    note: typeof value.note === "string" ? value.note : undefined,
    reviewer: typeof value.reviewer === "string" ? value.reviewer : undefined,
    source_refs: Array.isArray(value.source_refs) ? value.source_refs.filter(isSourceRef) : undefined,
    trace_refs: Array.isArray(value.trace_refs) ? value.trace_refs.filter(isTraceRef) : undefined,
    revision_instruction: typeof value.revision_instruction === "string" ? value.revision_instruction : undefined,
    rerun: value.rerun === true ? true : undefined,
  };
}

export function readRequestApprovalRequest(value: unknown): SessionManagerRequestApprovalRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || typeof value.tool_endpoint !== "string" || typeof value.action !== "string" || typeof value.payload_summary !== "string") {
    throw new Error("request_approval requires session_id, tool_endpoint, action, and payload_summary");
  }
  return {
    session_id: value.session_id,
    requester: typeof value.requester === "string" ? value.requester : undefined,
    tool_endpoint: value.tool_endpoint,
    action: value.action,
    risk: readApprovalRisk(value.risk),
    payload_summary: value.payload_summary,
    source_refs: Array.isArray(value.source_refs) ? value.source_refs.filter(isSourceRef) : undefined,
    trace_refs: Array.isArray(value.trace_refs) ? value.trace_refs.filter(isTraceRef) : undefined,
  };
}

export function readRunValidationRequest(value: unknown): SessionManagerRunValidationRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || typeof value.validation_id !== "string") {
    throw new Error("run_validation requires session_id and validation_id");
  }
  return {
    session_id: value.session_id,
    validation_id: value.validation_id,
    validator: typeof value.validator === "string" ? value.validator : undefined,
  };
}

export function readResolveApprovalRequest(value: unknown): SessionManagerResolveApprovalRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || typeof value.approval_id !== "string") {
    throw new Error("resolve_approval requires session_id and approval_id");
  }
  return {
    session_id: value.session_id,
    approval_id: value.approval_id,
    status: readResolvedApprovalStatus(value.status),
    approved: typeof value.approved === "boolean" ? value.approved : undefined,
    resolved_by: typeof value.resolved_by === "string" ? value.resolved_by : undefined,
    resolution_note: typeof value.resolution_note === "string" ? value.resolution_note : undefined,
    trace_refs: Array.isArray(value.trace_refs) ? value.trace_refs.filter(isTraceRef) : undefined,
  };
}

export function readRequestValidationRequest(value: unknown): SessionManagerRequestValidationRequest {
  if (!isRecord(value) || typeof value.session_id !== "string") {
    throw new Error("request_validation requires session_id");
  }
  return {
    session_id: value.session_id,
    task_id: typeof value.task_id === "string" ? value.task_id : undefined,
    artifact_id: typeof value.artifact_id === "string" ? value.artifact_id : undefined,
    requester: typeof value.requester === "string" ? value.requester : undefined,
    validator: typeof value.validator === "string" ? value.validator : undefined,
    summary: typeof value.summary === "string" ? value.summary : undefined,
    source_refs: Array.isArray(value.source_refs) ? value.source_refs.filter(isSourceRef) : undefined,
    trace_refs: Array.isArray(value.trace_refs) ? value.trace_refs.filter(isTraceRef) : undefined,
    run: value.run === true ? true : undefined,
  };
}

export function readRecordValidationRequest(value: unknown): SessionManagerRecordValidationRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || typeof value.validation_id !== "string") {
    throw new Error("record_validation requires session_id and validation_id");
  }
  const status = readRecordValidationStatus(value.status);
  if (!status) {
    throw new Error("record_validation requires status running, passed, failed, or cancelled");
  }
  const artifact = isRecord(value.artifact) && typeof value.artifact.author === "string" && "content" in value.artifact
    ? value.artifact as SessionManagerRecordValidationRequest["artifact"]
    : undefined;
  return {
    session_id: value.session_id,
    validation_id: value.validation_id,
    status,
    summary: typeof value.summary === "string" ? value.summary : undefined,
    validator: typeof value.validator === "string" ? value.validator : undefined,
    artifact,
    source_refs: Array.isArray(value.source_refs) ? value.source_refs.filter(isSourceRef) : undefined,
    trace_refs: Array.isArray(value.trace_refs) ? value.trace_refs.filter(isTraceRef) : undefined,
  };
}

export function readRequestSynthesisRequest(value: unknown): SessionManagerRequestSynthesisRequest {
  if (!isRecord(value) || typeof value.session_id !== "string") {
    throw new Error("request_synthesis requires session_id");
  }
  return {
    session_id: value.session_id,
    task_id: typeof value.task_id === "string" ? value.task_id : undefined,
    barrier_id: typeof value.barrier_id === "string" ? value.barrier_id : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    source_refs: Array.isArray(value.source_refs) ? value.source_refs.filter(isSourceRef) : undefined,
  };
}

export function readAskQuestionRequest(value: unknown): SessionManagerAskQuestionRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || typeof value.to !== "string" || typeof value.question !== "string") {
    throw new Error("ask_question requires session_id, to, and question");
  }
  return {
    session_id: value.session_id,
    to: value.to,
    from: typeof value.from === "string" ? value.from : undefined,
    question: value.question,
    about_refs: Array.isArray(value.about_refs) ? value.about_refs.filter(isSourceRef) : undefined,
  };
}

export function readAnswerQuestionRequest(value: unknown): SessionManagerAnswerQuestionRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || typeof value.question_id !== "string") {
    throw new Error("answer_question requires session_id and question_id");
  }
  const artifact = isRecord(value.artifact) && typeof value.artifact.author === "string" && "content" in value.artifact
    ? value.artifact as SessionManagerAnswerQuestionRequest["artifact"]
    : undefined;
  return {
    session_id: value.session_id,
    question_id: value.question_id,
    artifact,
    answer: typeof value.answer === "string" ? value.answer : undefined,
    project: value.project === false ? false : undefined,
  };
}

export function readReportMessageRequest(value: unknown): SessionManagerReportMessageRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || typeof value.text !== "string" || value.text.trim().length === 0) {
    throw new Error("report_message requires session_id and non-empty text");
  }

  return {
    session_id: value.session_id,
    text: value.text.trim(),
    delegation_id: typeof value.delegation_id === "string" ? value.delegation_id : undefined,
    to: Array.isArray(value.to) ? uniqueEndpointUris(value.to) : undefined,
    visibility: readNoteVisibility(value.visibility),
    source_refs: Array.isArray(value.source_refs) ? value.source_refs.filter(isSourceRef) : undefined,
    project: value.project === false ? false : undefined,
  };
}

export function readRecordDecisionRequest(value: unknown): SessionManagerRecordDecisionRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || !("decision" in value)) {
    throw new Error("record_decision requires session_id and decision");
  }
  return {
    session_id: value.session_id,
    decision: value.decision,
    source_refs: Array.isArray(value.source_refs) ? value.source_refs.filter(isSourceRef) : undefined,
    trace_refs: Array.isArray(value.trace_refs) ? value.trace_refs.filter(isTraceRef) : undefined,
    decider: typeof value.decider === "string" ? value.decider : undefined,
    relates_to: readStringArray(value.relates_to),
    supersedes: typeof value.supersedes === "string" ? value.supersedes : undefined,
  };
}

export function readLinkTraceRequest(value: unknown): SessionManagerLinkTraceRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || !isTraceRef(value.trace_ref)) {
    throw new Error("link_trace requires session_id and trace_ref");
  }
  return {
    session_id: value.session_id,
    object_ref: typeof value.object_ref === "string" ? value.object_ref : undefined,
    trace_ref: value.trace_ref,
  };
}

export function readRecordContextCompactionRequest(value: unknown): SessionManagerRecordContextCompactionRequest {
  if (!isRecord(value) || typeof value.session_id !== "string" || typeof value.summary_text !== "string") {
    throw new Error("record_context_compaction requires session_id and summary_text");
  }

  return {
    id: typeof value.id === "string" ? value.id : undefined,
    session_id: value.session_id,
    audience: typeof value.audience === "string" ? value.audience : undefined,
    purpose: readRenderPurpose(value.purpose),
    covers_refs: Array.isArray(value.covers_refs) ? value.covers_refs.filter(isSourceRef) : [],
    cursor: readCompactionCursor(value.cursor),
    summary_text: value.summary_text,
    structured_digest: readStructuredDigest(value.structured_digest),
    created_at: typeof value.created_at === "string" ? value.created_at : undefined,
    created_by: typeof value.created_by === "string" ? value.created_by : undefined,
    created_from_model: typeof value.created_from_model === "string" ? value.created_from_model : undefined,
  };
}

export function readListContextCompactionsRequest(value: unknown): SessionManagerListContextCompactionsRequest {
  if (!isRecord(value) || typeof value.session_id !== "string") {
    throw new Error("list_context_compactions requires session_id");
  }

  return {
    session_id: value.session_id,
    audience: typeof value.audience === "string" ? value.audience : undefined,
    purpose: typeof value.purpose === "string" ? readRenderPurpose(value.purpose) : undefined,
  };
}

export function readCancelAgentRunRequest(value: unknown): SlockCancelAgentRunRequest {
  if (!isRecord(value) || typeof value.message_id !== "string" || value.message_id.trim().length === 0) {
    throw new Error("cancel_agent_run requires message_id");
  }
  return {
    message_id: value.message_id,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

export function readSessionId(value: unknown): string {
  if (!isRecord(value) || typeof value.session_id !== "string" || value.session_id.trim().length === 0) {
    throw new Error("session_id is required");
  }
  return value.session_id;
}

function readNoteVisibility(value: unknown): SessionManagerReportMessageRequest["visibility"] {
  return value === "human" || value === "agents" || value === "all" ? value : undefined;
}

function readDelegationPlan(value: unknown): SessionManagerRouteMessageRequest["delegation_plan"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.assignee !== "string") {
      return [];
    }
    return [{
      assignee: item.assignee,
      role: typeof item.role === "string" ? item.role : undefined,
      role_label: typeof item.role_label === "string" ? item.role_label : undefined,
      instruction: typeof item.instruction === "string" ? item.instruction : undefined,
      expected_output: typeof item.expected_output === "string" ? item.expected_output : undefined,
    }];
  });
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function readArtifactReviewStatus(value: unknown): SessionManagerReviewArtifactRequest["status"] | undefined {
  return value === "accepted" || value === "rejected" || value === "revision_requested" ? value : undefined;
}

function readApprovalRisk(value: unknown): SessionManagerRequestApprovalRequest["risk"] {
  return value === "low" || value === "medium" || value === "high" || value === "destructive" ? value : undefined;
}

function readResolvedApprovalStatus(value: unknown): SessionManagerResolveApprovalRequest["status"] {
  return value === "approved" || value === "rejected" || value === "cancelled" || value === "expired" ? value : undefined;
}

function readRecordValidationStatus(value: unknown): SessionManagerRecordValidationRequest["status"] | undefined {
  return value === "running" || value === "passed" || value === "failed" || value === "cancelled" ? value : undefined;
}

function readRenderPurpose(value: unknown): RenderForAgentRequest["purpose"] {
  return value === "synthesis" || value === "review" || value === "validation" || value === "handoff" || value === "delegation"
    ? value
    : "delegation";
}

function readCompactionCursor(value: unknown): ContextCompaction["cursor"] {
  if (!isRecord(value)) {
    return {};
  }

  return {
    before_event_id: typeof value.before_event_id === "string" ? value.before_event_id : undefined,
    before_time_ms: typeof value.before_time_ms === "number" ? value.before_time_ms : undefined,
  };
}

function readStructuredDigest(value: unknown): ContextCompaction["structured_digest"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    claims: Array.isArray(value.claims) ? value.claims : undefined,
    decisions: Array.isArray(value.decisions) ? value.decisions : undefined,
    open_questions: Array.isArray(value.open_questions) ? value.open_questions : undefined,
    artifact_refs: Array.isArray(value.artifact_refs) ? value.artifact_refs.filter((item): item is string => typeof item === "string") : undefined,
    barrier_refs: Array.isArray(value.barrier_refs) ? value.barrier_refs.filter((item): item is string => typeof item === "string") : undefined,
  };
}

function isSlockMessage(value: unknown): value is SlockMessage {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.channel === "string"
    && typeof value.sender === "string"
    && typeof value.text === "string"
    && Array.isArray(value.mentions)
    && (value.kind === "human" || value.kind === "agent" || value.kind === "system");
}

function isSourceRef(value: unknown): value is SourceRef {
  return isRecord(value) && typeof value.kind === "string";
}

function isTraceRef(value: unknown): value is SessionManagerLinkTraceRequest["trace_ref"] {
  return isRecord(value) && typeof value.label === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
