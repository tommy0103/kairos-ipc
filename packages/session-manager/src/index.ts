import { createCorrelationId, type EndpointUri } from "../../protocol/src/index.ts";
import { createNode, IpcCallError } from "../../sdk/src/index.ts";
import {
  barrierIsSatisfied,
  renderAgentWorkload,
  renderReviewQueue,
  renderSessionDetailProjection,
  renderSessionWorkProjection,
  renderSessionWorkProjections,
  type Artifact,
  type ArtifactReview,
  type CollaborationEvent,
  type ApprovalRequest,
  type CollaborationNote,
  type ContextCompaction,
  type Delegation,
  type RenderForAgentRequest,
  type ReplyBarrier,
  type SourceRef,
  type ValidationRecord,
} from "../../collaboration-context/src/index.ts";
import {
  SLOCK_AGENT_RUN_MIME,
  type SlockAgentResult,
  type SlockAgentRun,
  type SlockCancelAgentRunRequest,
  type SlockCancelAgentRunResult,
  type SlockMessage,
} from "../../slock-channel/src/index.ts";
import {
  explicitSessionSourceRef,
  labelFromUri,
  messageSourceRef,
  originMessageRef,
  questionMessageForQuestion,
  sessionUri,
  slug,
  sourceRefLabel,
  synthesisMessageForBarrier,
  uniqueAgentUris,
  uniqueSourceRefsForSession,
  uniqueStrings,
} from "./helpers.ts";
import {
  readAttachSourceRequest,
  readCancelAgentRunRequest,
  readCloseSessionRequest,
  readCreateSessionRequest,
  readDashboardSubscriptionRequest,
  readDashboardUnsubscribeRequest,
  readLinkTraceRequest,
  readListContextCompactionsRequest,
  readMoveSourceRequest,
  readRecordValidationRequest,
  readRecordContextCompactionRequest,
  readRenderContextRequest,
  readReopenSessionRequest,
  readRequestApprovalRequest,
  readRequestSynthesisRequest,
  readRequestValidationRequest,
  readResolveApprovalRequest,
  readResolveRequest,
  readReviewArtifactRequest,
  readRouteMessageRequest,
  readRunValidationRequest,
  readSessionId,
  readUpdateSessionGoalRequest,
} from "./readers.ts";
import {
  KAIROS_SESSION_MANAGER_URI,
  KAIROS_DASHBOARD_EVENT_MIME,
  KAIROS_SESSION_ROUTE_MIME,
  KAIROS_SESSION_STATE_MIME,
  type SessionManagerEndpoint,
  type SessionManagerOptions,
  type SessionManagerAttachSourceRequest,
  type SessionManagerAnswerQuestionRequest,
  type SessionManagerAgentWorkloadResult,
  type SessionManagerApprovalResult,
  type SessionManagerAskQuestionRequest,
  type SessionManagerCloseSessionRequest,
  type SessionManagerCreateSessionRequest,
  type SessionManagerDashboardEvent,
  type SessionManagerDashboardSnapshotResult,
  type SessionManagerDashboardSubscriptionRequest,
  type SessionManagerDashboardSubscriptionResult,
  type SessionManagerDashboardUnsubscribeRequest,
  type SessionManagerDashboardUnsubscribeResult,
  type SessionManagerListContextCompactionsRequest,
  type SessionManagerListContextCompactionsResult,
  type SessionManagerMoveSourceRequest,
  type SessionManagerQuestionResult,
  type SessionManagerReopenSessionRequest,
  type SessionManagerRecordContextCompactionRequest,
  type SessionManagerRenderContextRequest,
  type SessionManagerReportMessageRequest,
  type SessionManagerReportMessageResult,
  type SessionManagerRecordDecisionRequest,
  type SessionManagerRequestApprovalRequest,
  type SessionManagerRequestSynthesisRequest,
  type SessionManagerRequestValidationRequest,
  type SessionManagerResolveApprovalRequest,
  type SessionManagerResolveRequest,
  type SessionManagerResolveResult,
  type SessionManagerReviewArtifactRequest,
  type SessionManagerReviewQueueResult,
  type SessionManagerRouteMessageRequest,
  type SessionManagerRouteMessageResult,
  type SessionManagerRunValidationRequest,
  type SessionRecord,
  type SessionManagerSessionDetailResult,
  type SessionManagerSessionSnapshot,
  type SessionManagerSubmitArtifactRequest,
  type SessionManagerUpdateSessionGoalRequest,
  type SessionManagerValidationResult,
  type SessionManagerWorkSessionResult,
  type SessionManagerWorkSessionsResult,
} from "./types.ts";
import { createBarrierController } from "./barriers.ts";
import { createSessionPublisher } from "./publishing.ts";
import {
  HUMAN_REPORT_MESSAGE_MAX_CHARS,
  enforceReportMessageContract,
  hasHumanReportForDelegation,
  noteProjectsToHuman,
  reportSourceRefs,
  reportVisibility,
  resolveReportDelegationId,
} from "./reporting.ts";
import { createSessionContextRenderer, matchingCompactions } from "./rendering.ts";
import {
  sessionManagerAnswerQuestionRequestSchema,
  sessionManagerAskQuestionRequestSchema,
  sessionManagerAskQuestionResultSchema,
  sessionManagerRecordDecisionRequestSchema,
  sessionManagerReportMessageRequestSchema,
  sessionManagerReportMessageResultSchema,
  sessionManagerSessionSnapshotSchema,
  sessionManagerSubmitArtifactRequestSchema,
} from "./schemas.ts";
import { createSessionStore, type ActiveSessionRun } from "./store.ts";
import { createSessionWorkflow, latestDelegationForAssignee } from "./workflow.ts";

export * from "./types.ts";

const DEFAULT_AGENT_TTL_MS = 600000;

interface DashboardSubscription {
  subscriber: EndpointUri;
  correlation_id?: string;
  session_id?: string;
  include_detail: boolean;
}

export function createSessionManager(options: SessionManagerOptions = {}): SessionManagerEndpoint {
  const uri = options.uri ?? KAIROS_SESSION_MANAGER_URI;
  const node = createNode(uri);
  const dashboardSubscribers = new Map<EndpointUri, DashboardSubscription>();
  let dashboardSequence = 1;
  const {
    sessions,
    activeRunsByMessage,
    createSessionForMessage,
    createSession,
    createManualTask,
    appendEvent,
    attachSource,
    detachSource,
    resolveMessageSession,
    resolveSessionId,
    indexMessage,
    indexSourceRef,
    clearActiveSession,
    requiredSession,
    snapshot,
    rememberActiveRun,
    forgetActiveRun,
    nextArtifactId,
    nextQuestionId,
    nextNoteId,
    nextCompactionId,
    nextApprovalId,
    nextValidationId,
    nextExplicitSessionId,
    ensureSourceIsUnowned,
  } = createSessionStore({
    coordinator_uri: options.coordinator_uri,
    hasDelegationForAssignee: (record, assignee) => Boolean(latestDelegationForAssignee(record, assignee)),
    onEventAppended: (record, event) => publishDashboardUpdate(record, event),
  });
  const { routeHumanMentions, createQuestionDelegation } = createSessionWorkflow({
    appendEvent,
    coordinator_uri: options.coordinator_uri,
  });
  const { updateBarriersForArtifact } = createBarrierController({
    sessions,
    appendEvent,
    coordinator_uri: options.coordinator_uri,
    runSynthesis,
  });
  const {
    projectArtifact,
    projectNote,
    publishAgentRun,
    publishAgentCancelled,
    publishAgentError,
  } = createSessionPublisher(node, appendEvent);
  const { renderRunContext, renderSessionContext } = createSessionContextRenderer(node);
  const agentTtlMs = options.default_agent_ttl_ms ?? DEFAULT_AGENT_TTL_MS;

  node.action<SessionManagerCreateSessionRequest, SessionManagerSessionSnapshot>(
    "create_session",
    {
      description: "Create an explicit collaboration session boundary without relying on channel or thread heuristics.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
    },
    async (payload, context) => {
      const request = readCreateSessionRequest(payload.data);
      const sourceRef = request.message ? messageSourceRef(request.message) : request.source_ref ?? explicitSessionSourceRef(context.envelope.header.source, request.title);
      ensureSourceIsUnowned(sourceRef);
      const sessionId = request.session_id ?? nextExplicitSessionId(request.title ?? sourceRefLabel(sourceRef));
      const record = createSession(sessionId, sourceRef);
      if (request.title?.trim()) {
        createManualTask(record, request.title, request.owner ?? context.envelope.header.source, sourceRef);
      }
      applySessionGoal(record, {
        session_id: record.id,
        title: request.title,
        objective: request.objective,
        acceptance_criteria: request.acceptance_criteria,
        source_refs: [sourceRef],
      });
      if (request.message) {
        indexMessage(record.id, request.message, sourceRef);
      } else {
        indexSourceRef(record.id, sourceRef);
      }
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<SessionManagerCloseSessionRequest, SessionManagerSessionSnapshot>(
    "close_session",
    {
      description: "Close a collaboration session boundary so future heuristic routing will not attach to it.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
    },
    async (payload) => {
      const request = readCloseSessionRequest(payload.data);
      const record = requiredSession(request.session_id);
      appendEvent(record, {
        type: "session_updated",
        session_id: record.id,
        patch: { status: request.status ?? "completed" },
      });
      clearActiveSession(record.id);
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<SessionManagerReopenSessionRequest, SessionManagerSessionSnapshot>(
    "reopen_session",
    {
      description: "Reopen a collaboration session so explicit routing can continue against it.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
    },
    async (payload) => {
      const request = readReopenSessionRequest(payload.data);
      const record = requiredSession(request.session_id);
      appendEvent(record, {
        type: "session_updated",
        session_id: record.id,
        patch: { status: "open" },
      });
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<SessionManagerUpdateSessionGoalRequest, SessionManagerSessionSnapshot>(
    "update_session_goal",
    {
      description: "Update a collaboration session's title, objective, acceptance criteria, and constraints as first-class workflow state.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
    },
    async (payload) => {
      const request = readUpdateSessionGoalRequest(payload.data);
      const record = requiredSession(request.session_id);
      applySessionGoal(record, request);
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<SessionManagerMoveSourceRequest, SessionManagerSessionSnapshot>(
    "move_source",
    {
      description: "Move a source ref or Slock message from its current collaboration session to an explicit target session.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
    },
    async (payload) => {
      const request = readMoveSourceRequest(payload.data);
      const sourceRef = request.source_ref ?? (request.message ? messageSourceRef(request.message) : undefined);
      if (!sourceRef) {
        throw new Error("move_source requires source_ref or message");
      }
      const target = requiredSession(request.to_session_id);
      const fromSessionId = request.from_session_id ?? resolveSessionId({ source_ref: sourceRef });
      const from = fromSessionId ? sessions.get(fromSessionId) : undefined;
      if (from && from.id !== target.id) {
        detachSource(from, sourceRef, request.reason ?? `moved to ${target.id}`);
      }
      attachSource(target, sourceRef, request.reason ?? `moved${from ? ` from ${from.id}` : ""}`);
      if (request.message) {
        indexMessage(target.id, request.message, sourceRef);
      } else {
        indexSourceRef(target.id, sourceRef);
      }
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(target) };
    },
  );

  node.action<SessionManagerRouteMessageRequest, SessionManagerRouteMessageResult>(
    "create_or_attach_session",
    {
      description: "Create or attach a collaboration session for a human-facing Slock message, then route explicit agent delegations.",
      accepts: ["application/json", KAIROS_SESSION_ROUTE_MIME],
      returns: KAIROS_SESSION_ROUTE_MIME,
    },
    async (payload) => {
      const request = readRouteMessageRequest(payload.data);
      const message = request.message;
      const sourceRef = messageSourceRef(message);
      const agents = uniqueAgentUris(request.mentions ?? message.mentions);
      let record = request.session_id
        ? requiredSession(request.session_id)
        : request.new_session
          ? undefined
          : resolveMessageSession(message, agents);
      const created = !record;
      if (!record) {
        record = createSessionForMessage(message, sourceRef);
      } else {
        attachSource(record, sourceRef, "message attached to collaboration session");
      }
      indexMessage(record.id, message, sourceRef);
      applySessionGoal(record, {
        session_id: record.id,
        title: request.title,
        objective: request.objective,
        acceptance_criteria: request.acceptance_criteria,
        source_refs: [sourceRef],
      });

      const createdDelegations = message.kind === "human" && agents.length > 0
        ? routeHumanMentions(record, message, sourceRef, agents, created, request.delegation_plan)
        : { delegationIds: [], barrierId: undefined };

      for (const delegationId of createdDelegations.delegationIds) {
        void runDelegation(record.id, delegationId, message);
      }

      return {
        mime_type: KAIROS_SESSION_ROUTE_MIME,
        data: {
          session_id: record.id,
          session_uri: record.uri,
          created,
          attached: !created,
          source_ref: sourceRef,
          delegations_created: createdDelegations.delegationIds,
          barrier_id: createdDelegations.barrierId,
        },
      };
    },
  );

  node.action<SessionManagerResolveRequest, SessionManagerResolveResult>(
    "resolve_session",
    {
      description: "Resolve the collaboration session that owns a source ref, channel message, or Slock thread.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = readResolveRequest(payload.data);
      const sessionId = resolveSessionId(request);
      return {
        mime_type: "application/json",
        data: sessionId ? { session_id: sessionId, session_uri: sessionUri(sessionId) } : {},
      };
    },
  );

  node.action<SessionManagerAttachSourceRequest, SessionManagerSessionSnapshot>(
    "attach_source",
    {
      description: "Attach a source ref or Slock message to an existing collaboration session.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
    },
    async (payload) => {
      const request = readAttachSourceRequest(payload.data);
      const sourceRef = request.source_ref ?? (request.message ? messageSourceRef(request.message) : undefined);
      if (!sourceRef) {
        throw new Error("attach_source requires source_ref or message");
      }
      const sessionId = request.session_id ?? resolveSessionId({ source_ref: sourceRef }) ?? (request.message ? resolveMessageSession(request.message)?.id : undefined);
      const record = requiredSession(sessionId);
      attachSource(record, sourceRef, request.reason);
      if (request.message) {
        indexMessage(record.id, request.message, sourceRef);
      } else {
        indexSourceRef(record.id, sourceRef);
      }
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<SessionManagerRenderContextRequest>(
    "render_context",
    {
      description: "Render audience-specific collaboration context for an agent run.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = readRenderContextRequest(payload.data);
      const record = requiredSession(request.session_id);
      return {
        mime_type: "application/json",
        data: renderSessionContext(record, request),
      };
    },
  );

  node.action<SessionManagerSubmitArtifactRequest, SessionManagerSessionSnapshot>(
    "submit_artifact",
    {
      description: "Submit a structured artifact to a collaboration session and update waiting barriers.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
      input: sessionManagerSubmitArtifactRequestSchema,
      output: sessionManagerSessionSnapshotSchema,
      input_name: "SessionManagerSubmitArtifactRequest",
      output_name: "SessionManagerSessionSnapshot",
    },
    async ({ input: request, context }) => {
      const record = requiredSession(request.session_id);
      const artifact = normalizeSubmittedArtifact(record, request, context.envelope.header.source);
      const artifactEvent = appendEvent(record, {
        type: "artifact_submitted",
        artifact,
        delegation_id: request.delegation_id,
      });
      updateBarriersForArtifact(record, artifact, request.delegation_id, artifactEvent.at);
      if (request.project !== false) {
        void projectArtifact(record, artifact, artifactEvent.id, originMessageRef(record.state));
      }
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<SessionManagerReviewArtifactRequest, SessionManagerSessionSnapshot>(
    "review_artifact",
    {
      description: "Review an artifact as accepted, rejected, or revision_requested and update the owning delegation when revision is needed.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
    },
    async (payload, context) => {
      const request = readReviewArtifactRequest(payload.data);
      const record = requiredSession(request.session_id);
      const artifact = requiredArtifact(record, request.artifact_id);
      const review: ArtifactReview = {
        reviewer: request.reviewer ?? context.envelope.header.source,
        status: request.status,
        note: request.note,
        reviewed_at: new Date().toISOString(),
        source_refs: request.source_refs,
        trace_refs: request.trace_refs,
      };
      appendEvent(record, {
        type: "artifact_reviewed",
        session_id: record.id,
        artifact_id: artifact.id,
        review,
      }, review.reviewed_at);
      if (request.status === "revision_requested") {
        const reopened = reopenDelegationForRevision(record, artifact, review, request.revision_instruction);
        if (request.rerun && reopened) {
          void runDelegation(record.id, reopened.id, revisionMessageForArtifact(record, artifact, review, request.revision_instruction));
        }
      }
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<SessionManagerReviewArtifactRequest, SessionManagerSessionSnapshot>(
    "request_revision",
    {
      description: "Request a revision for an artifact and reopen the producing delegation.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
    },
    async (payload, context) => {
      const request = readReviewArtifactRequest(payload.data, "revision_requested");
      const record = requiredSession(request.session_id);
      const artifact = requiredArtifact(record, request.artifact_id);
      const review: ArtifactReview = {
        reviewer: request.reviewer ?? context.envelope.header.source,
        status: "revision_requested",
        note: request.note,
        reviewed_at: new Date().toISOString(),
        source_refs: request.source_refs,
        trace_refs: request.trace_refs,
      };
      appendEvent(record, { type: "artifact_reviewed", session_id: record.id, artifact_id: artifact.id, review }, review.reviewed_at);
      const reopened = reopenDelegationForRevision(record, artifact, review, request.revision_instruction);
      if (request.rerun && reopened) {
        void runDelegation(record.id, reopened.id, revisionMessageForArtifact(record, artifact, review, request.revision_instruction));
      }
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<SessionManagerRequestApprovalRequest, SessionManagerApprovalResult>(
    "request_approval",
    {
      description: "Record a first-class approval gate for a session object or tool call.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload, context) => {
      const request = readRequestApprovalRequest(payload.data);
      const record = requiredSession(request.session_id);
      const approval: ApprovalRequest = {
        id: nextApprovalId(record.id),
        session_id: record.id,
        requester: request.requester ?? context.envelope.header.source,
        tool_endpoint: request.tool_endpoint,
        action: request.action,
        risk: request.risk ?? "medium",
        payload_summary: request.payload_summary,
        source_refs: request.source_refs ?? [{ kind: "external", uri: context.envelope.header.source, label: "approval request" }],
        trace_refs: request.trace_refs,
        status: "pending",
        created_at: new Date().toISOString(),
      };
      appendEvent(record, { type: "approval_requested", approval }, approval.created_at);
      return { mime_type: "application/json", data: { approval } };
    },
  );

  node.action<SessionManagerResolveApprovalRequest, SessionManagerSessionSnapshot>(
    "resolve_approval",
    {
      description: "Resolve a pending session approval as approved, rejected, cancelled, or expired.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
    },
    async (payload, context) => {
      const request = readResolveApprovalRequest(payload.data);
      const record = requiredSession(request.session_id);
      if (!record.state.approvals[request.approval_id]) {
        throw new Error(`approval not found: ${request.approval_id}`);
      }
      appendEvent(record, {
        type: "approval_resolved",
        session_id: record.id,
        approval_id: request.approval_id,
        patch: {
          status: request.status ?? (request.approved === false ? "rejected" : "approved"),
          resolved_by: request.resolved_by ?? context.envelope.header.source,
          resolution_note: request.resolution_note,
          trace_refs: request.trace_refs,
        },
      });
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<SessionManagerRequestValidationRequest, SessionManagerValidationResult>(
    "request_validation",
    {
      description: "Record a first-class validation request for a task or artifact.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload, context) => {
      const request = readRequestValidationRequest(payload.data);
      const record = requiredSession(request.session_id);
      const validation: ValidationRecord = {
        id: nextValidationId(record.id),
        session_id: record.id,
        task_id: request.task_id,
        artifact_id: request.artifact_id,
        requester: request.requester ?? context.envelope.header.source,
        validator: request.validator,
        status: "requested",
        summary: request.summary,
        source_refs: request.source_refs ?? validationSourceRefs(record, request.task_id, request.artifact_id, context.envelope.header.source),
        trace_refs: request.trace_refs,
        created_at: new Date().toISOString(),
      };
      appendEvent(record, { type: "validation_requested", validation }, validation.created_at);
      const delegationId = request.run ? runValidation(record, validation.id, request.validator) : undefined;
      return { mime_type: "application/json", data: { validation: record.state.validations[validation.id], delegation_id: delegationId } };
    },
  );

  node.action<SessionManagerRunValidationRequest, SessionManagerValidationResult>(
    "run_validation",
    {
      description: "Start a validator agent for an existing validation request and store its output as a validation result artifact.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = readRunValidationRequest(payload.data);
      const record = requiredSession(request.session_id);
      const delegationId = runValidation(record, request.validation_id, request.validator);
      return {
        mime_type: "application/json",
        data: {
          validation: record.state.validations[request.validation_id],
          delegation_id: delegationId,
        },
      };
    },
  );

  node.action<SessionManagerRecordValidationRequest, SessionManagerValidationResult>(
    "record_validation",
    {
      description: "Record validation progress or result, optionally attaching a validation artifact.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload, context) => {
      const request = readRecordValidationRequest(payload.data);
      const record = requiredSession(request.session_id);
      const existing = record.state.validations[request.validation_id];
      if (!existing) {
        throw new Error(`validation not found: ${request.validation_id}`);
      }
      const at = new Date().toISOString();
      let artifactId: string | undefined;
      if (request.artifact) {
        const artifact: Artifact = {
          id: request.artifact.id ?? nextArtifactId(record.id),
          session_id: record.id,
          author: request.artifact.author ?? context.envelope.header.source,
          kind: "validation_result",
          title: request.artifact.title ?? `Validation result for ${request.validation_id}`,
          content: request.artifact.content,
          status: request.artifact.status ?? "submitted",
          relates_to: uniqueStrings([...(request.artifact.relates_to ?? []), request.validation_id, existing.artifact_id, existing.task_id]),
          source_refs: request.artifact.source_refs ?? request.source_refs ?? existing.source_refs,
          trace_refs: request.artifact.trace_refs ?? request.trace_refs,
          created_at: request.artifact.created_at ?? at,
        };
        appendEvent(record, { type: "artifact_submitted", artifact });
        artifactId = artifact.id;
      }
      if (request.status === "failed") {
        appendEvent(record, {
          type: "validation_failed",
          session_id: record.id,
          validation_id: request.validation_id,
          summary: request.summary,
          trace_refs: request.trace_refs,
        }, at);
      } else if (request.status === "running") {
        appendEvent(record, {
          type: "validation_started",
          session_id: record.id,
          validation_id: request.validation_id,
          validator: request.validator ?? existing.validator ?? context.envelope.header.source,
        }, at);
      } else {
        appendEvent(record, {
          type: "validation_recorded",
          session_id: record.id,
          validation_id: request.validation_id,
          patch: {
            status: request.status,
            validator: request.validator ?? existing.validator ?? context.envelope.header.source,
            summary: request.summary,
            source_refs: request.source_refs ?? existing.source_refs,
            trace_refs: request.trace_refs,
            artifact_id: artifactId ?? existing.artifact_id,
          },
        }, at);
      }
      const validation = record.state.validations[request.validation_id];
      return { mime_type: "application/json", data: { validation, artifact_id: artifactId } };
    },
  );

  node.action<SessionManagerRequestSynthesisRequest, SessionManagerSessionSnapshot>(
    "request_synthesis",
    {
      description: "Request final synthesis for a task or barrier and run the coordinator when the barrier is satisfied.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
    },
    async (payload) => {
      const request = readRequestSynthesisRequest(payload.data);
      const record = requiredSession(request.session_id);
      appendEvent(record, {
        type: "synthesis_requested",
        session_id: record.id,
        task_id: request.task_id,
        reason: request.reason,
        source_refs: request.source_refs,
      });
      const barrier = ensureSynthesisBarrier(record, request);
      if (barrier && options.coordinator_uri && barrierIsSatisfied(record.state.barriers[barrier.id] ?? barrier)) {
        void runSynthesis(record.id, barrier.id, options.coordinator_uri);
      }
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<SessionManagerAskQuestionRequest, SessionManagerQuestionResult>(
    "ask_question",
    {
      description: "Record a structured agent/human question and route it to the target endpoint as a question-answer delegation.",
      accepts: "application/json",
      returns: "application/json",
      input: sessionManagerAskQuestionRequestSchema,
      output: sessionManagerAskQuestionResultSchema,
      input_name: "SessionManagerAskQuestionRequest",
      output_name: "SessionManagerQuestionResult",
    },
    async ({ input: request, context }) => {
      const record = requiredSession(request.session_id);
      const question = {
        id: nextQuestionId(record.id),
        session_id: record.id,
        from: request.from ?? context.envelope.header.source,
        to: request.to,
        question: request.question,
        about_refs: request.about_refs,
        status: "asked" as const,
      };
      appendEvent(record, { type: "question_asked", question });
      const delegation = createQuestionDelegation(record, question);
      if (delegation) {
        void runDelegation(record.id, delegation.id, questionMessageForQuestion(record, question), "review");
      }
      return { mime_type: "application/json", data: { question, delegation_id: delegation?.id } };
    },
  );

  node.action<SessionManagerAnswerQuestionRequest, SessionManagerSessionSnapshot>(
    "answer_question",
    {
      description: "Record a structured answer artifact for a question.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
      input: sessionManagerAnswerQuestionRequestSchema,
      output: sessionManagerSessionSnapshotSchema,
      input_name: "SessionManagerAnswerQuestionRequest",
      output_name: "SessionManagerSessionSnapshot",
    },
    async ({ input: request, context }) => {
      const record = requiredSession(request.session_id);
      const question = record.state.questions[request.question_id];
      if (!question) {
        throw new Error(`question not found: ${request.question_id}`);
      }
      const artifact: Artifact = {
        id: request.artifact?.id ?? nextArtifactId(record.id),
        session_id: record.id,
        author: request.artifact?.author ?? context.envelope.header.source,
        kind: "question_answer",
        title: request.artifact?.title ?? `Answer to ${request.question_id}`,
        content: request.artifact?.content ?? request.answer ?? "",
        status: request.artifact?.status ?? "submitted",
        relates_to: uniqueStrings([...(request.artifact?.relates_to ?? []), request.question_id]),
        source_refs: request.artifact?.source_refs ?? [{ kind: "external", uri: context.envelope.header.source, label: "question answer" }],
        created_at: request.artifact?.created_at ?? new Date().toISOString(),
      };
      const artifactEvent = appendEvent(record, { type: "artifact_submitted", artifact });
      appendEvent(record, {
        type: "question_answered",
        session_id: record.id,
        question_id: request.question_id,
        answer_artifact_id: artifact.id,
      });
      if (request.project !== false) {
        void projectArtifact(record, artifact, artifactEvent.id, originMessageRef(record.state));
      }
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<SessionManagerReportMessageRequest, SessionManagerReportMessageResult>(
    "report_message",
    {
      description: `Send a brief IM status pulse, not a report. Agents must call this once with visibility "human" before returning final output for a delegation. For human-visible text, write one natural plain-text sentence under ${HUMAN_REPORT_MESSAGE_MAX_CHARS} characters, aim for 6-14 words, avoid Markdown/headings/bullets/tables/code fences, and put findings, plans, and details in submit_artifact instead.`,
      accepts: "application/json",
      returns: "application/json",
      input: sessionManagerReportMessageRequestSchema,
      output: sessionManagerReportMessageResultSchema,
      input_name: "SessionManagerReportMessageRequest",
      output_name: "SessionManagerReportMessageResult",
    },
    async ({ input: request, context }) => {
      const record = requiredSession(request.session_id);
      const from = context.envelope.header.source;
      const delegationId = resolveReportDelegationId(record, request.delegation_id, from);
      const visibility = reportVisibility(request);
      enforceReportMessageContract(request.text, visibility);
      const at = new Date().toISOString();
      const note: CollaborationNote = {
        id: nextNoteId(record.id),
        session_id: record.id,
        from,
        to: request.to,
        visibility,
        text: request.text,
        delegation_id: delegationId,
        source_refs: reportSourceRefs(record, request, from, delegationId),
        created_at: at,
      };
      const noteEvent = appendEvent(record, { type: "note_posted", note }, at);
      const projected = request.project !== false && noteProjectsToHuman(note) && !isSynthesisReport(record, delegationId, from)
        ? await projectNote(record, note, noteEvent.id)
        : undefined;
      return {
        mime_type: "application/json",
        data: {
          session_id: record.id,
          note,
          projected_message_id: projected?.id,
        },
      };
    },
  );

  node.action<SessionManagerRecordDecisionRequest, SessionManagerSessionSnapshot>(
    "record_decision",
    {
      description: "Record a structured collaboration decision without changing source events.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
      input: sessionManagerRecordDecisionRequestSchema,
      output: sessionManagerSessionSnapshotSchema,
      input_name: "SessionManagerRecordDecisionRequest",
      output_name: "SessionManagerSessionSnapshot",
    },
    async ({ input: request }) => {
      const record = requiredSession(request.session_id);
      appendEvent(record, {
        type: "decision_recorded",
        session_id: record.id,
        decision: request.decision,
        source_refs: request.source_refs ?? [],
        trace_refs: request.trace_refs,
        decider: request.decider,
        relates_to: request.relates_to,
        supersedes: request.supersedes,
      });
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action(
    "link_trace",
    {
      description: "Attach a trace reference to a session object such as artifact, approval, validation, decision, or delegation.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
    },
    async (payload) => {
      const request = readLinkTraceRequest(payload.data);
      const record = requiredSession(request.session_id);
      appendEvent(record, {
        type: "trace_linked",
        session_id: record.id,
        object_ref: request.object_ref,
        trace_ref: request.trace_ref,
      });
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<SessionManagerRecordContextCompactionRequest, ContextCompaction>(
    "record_context_compaction",
    {
      description: "Store a render-time context compaction cache entry. This does not mutate the collaboration event log.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload, context) => {
      const request = readRecordContextCompactionRequest(payload.data);
      const record = requiredSession(request.session_id);
      const compaction: ContextCompaction = {
        id: request.id ?? nextCompactionId(record.id),
        session_id: record.id,
        audience: request.audience,
        purpose: request.purpose,
        covers_refs: request.covers_refs,
        cursor: request.cursor,
        summary_text: request.summary_text,
        structured_digest: request.structured_digest,
        created_at: request.created_at ?? new Date().toISOString(),
        created_by: request.created_by ?? context.envelope.header.source,
        created_from_model: request.created_from_model,
      };
      record.compactions = [...record.compactions.filter((item) => item.id !== compaction.id), compaction];
      return { mime_type: "application/json", data: compaction };
    },
  );

  node.action<SessionManagerListContextCompactionsRequest, SessionManagerListContextCompactionsResult>(
    "list_context_compactions",
    {
      description: "List render-time context compactions for a session, optionally scoped by audience and purpose.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = readListContextCompactionsRequest(payload.data);
      const record = requiredSession(request.session_id);
      return {
        mime_type: "application/json",
        data: {
          compactions: matchingCompactions(record, request.audience, request.purpose),
        },
      };
    },
  );

  node.action<{ session_id: string }, SessionManagerSessionSnapshot>(
    "get_session_state",
    {
      description: "Return a collaboration session's append-only events and current reduced state.",
      accepts: "application/json",
      returns: KAIROS_SESSION_STATE_MIME,
    },
    async (payload) => {
      const sessionId = readSessionId(payload.data);
      const record = requiredSession(sessionId);
      return { mime_type: KAIROS_SESSION_STATE_MIME, data: snapshot(record) };
    },
  );

  node.action<unknown, { sessions: Array<{ session_id: string; session_uri: EndpointUri; status?: string }> }>(
    "list_sessions",
    {
      description: "List collaboration sessions currently owned by this session manager.",
      accepts: "application/json",
      returns: "application/json",
    },
    async () => ({
      mime_type: "application/json",
      data: {
        sessions: [...sessions.values()].map((record) => ({
          session_id: record.id,
          session_uri: record.uri,
          status: record.state.session?.status,
        })),
      },
    }),
  );

  node.action<unknown, SessionManagerWorkSessionsResult>(
    "list_work_sessions",
    {
      description: "Return agile work projections for collaboration sessions.",
      accepts: "application/json",
      returns: "application/json",
    },
    async () => ({
      mime_type: "application/json",
      data: {
        sessions: renderSessionWorkProjections([...sessions.values()].map((record) => record.state)),
      },
    }),
  );

  node.action<SessionManagerDashboardSubscriptionRequest, SessionManagerDashboardSnapshotResult>(
    "get_dashboard_snapshot",
    {
      description: "Return a complete Agile Dashboard projection snapshot from real collaboration sessions.",
      accepts: "application/json",
      returns: KAIROS_DASHBOARD_EVENT_MIME,
    },
    async (payload) => {
      const request = readDashboardSubscriptionRequest(payload.data);
      return {
        mime_type: KAIROS_DASHBOARD_EVENT_MIME,
        data: dashboardSnapshot(request),
      };
    },
  );

  node.action<SessionManagerDashboardSubscriptionRequest, SessionManagerDashboardSubscriptionResult>(
    "subscribe_dashboard",
    {
      description: "Subscribe to realtime Agile Dashboard projection events emitted by the session manager.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload, context) => {
      const request = readDashboardSubscriptionRequest(payload.data);
      const subscriber = context.envelope.header.reply_to ?? context.envelope.header.source;
      const subscription: DashboardSubscription = {
        subscriber,
        correlation_id: context.envelope.header.correlation_id,
        session_id: request.session_id,
        include_detail: request.include_detail === true,
      };
      dashboardSubscribers.set(subscriber, subscription);
      if (request.include_snapshot !== false) {
        emitDashboardEvent(subscription, {
          type: "dashboard_snapshot",
          ...dashboardSnapshot(request),
        });
      }
      return {
        mime_type: "application/json",
        data: { subscribed: true, subscriber, session_id: request.session_id },
      };
    },
  );

  node.action<SessionManagerDashboardUnsubscribeRequest, SessionManagerDashboardUnsubscribeResult>(
    "unsubscribe_dashboard",
    {
      description: "Close an Agile Dashboard subscription and send a terminal dashboard event.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload, context) => {
      const request = readDashboardUnsubscribeRequest(payload.data);
      const subscriber = request.subscriber ?? context.envelope.header.reply_to ?? context.envelope.header.source;
      const existing = dashboardSubscribers.get(subscriber);
      if (existing) {
        endDashboardSubscription(existing, request.reason);
        dashboardSubscribers.delete(subscriber);
      }
      return {
        mime_type: "application/json",
        data: { unsubscribed: Boolean(existing), subscriber, reason: request.reason },
      };
    },
  );

  node.action<{ session_id: string }, SessionManagerWorkSessionResult>(
    "get_work_session",
    {
      description: "Return the agile work projection for a collaboration session.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const record = requiredSession(readSessionId(payload.data));
      return {
        mime_type: "application/json",
        data: { session: renderSessionWorkProjection(record.state) },
      };
    },
  );

  node.action<{ session_id: string }, SessionManagerSessionDetailResult>(
    "get_session_detail",
    {
      description: "Return the full Agile Dashboard detail projection for one collaboration session.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const record = requiredSession(readSessionId(payload.data));
      return {
        mime_type: "application/json",
        data: { session: renderSessionDetailProjection(record.state) },
      };
    },
  );

  node.action<unknown, SessionManagerReviewQueueResult>(
    "list_review_queue",
    {
      description: "Return all review, approval, question, and validation items that require human or reviewer action.",
      accepts: "application/json",
      returns: "application/json",
    },
    async () => ({
      mime_type: "application/json",
      data: { items: renderReviewQueue([...sessions.values()].map((record) => record.state)) },
    }),
  );

  node.action<unknown, SessionManagerAgentWorkloadResult>(
    "list_agent_workload",
    {
      description: "Return current agent workload grouped by agent and session delegation.",
      accepts: "application/json",
      returns: "application/json",
    },
    async () => ({
      mime_type: "application/json",
      data: { agents: renderAgentWorkload([...sessions.values()].map((record) => record.state)) },
    }),
  );

  node.action<SlockCancelAgentRunRequest, SlockCancelAgentRunResult>(
    "cancel_agent_run",
    {
      description: "Cancel active agent delegations that were started from a Slock message.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = readCancelAgentRunRequest(payload.data);
      const runs = activeRunsByMessage.get(request.message_id);
      if (!runs || runs.size === 0) {
        return {
          mime_type: "application/json",
          data: {
            cancelled: false,
            message_id: request.message_id,
            reason: "agent run is not active",
          },
        };
      }

      const reason = request.reason ?? "cancelled";
      const agents = [...runs.keys()];
      for (const [agent, run] of runs) {
        run.cancel_requested = true;
        run.reason = reason;
        const record = sessions.get(run.session_id);
        if (record) {
          appendEvent(record, {
            type: "agent_run_cancelled",
            session_id: run.session_id,
            correlation_id: run.correlation_id,
            reason,
          });
        }
        node.cancel(agent, { mime_type: "application/json", data: { message_id: request.message_id, reason } }, { correlation_id: run.correlation_id });
        void publishAgentCancelled(run.message.channel, { message_id: request.message_id, agent, reason });
      }

      return {
        mime_type: "application/json",
        data: {
          cancelled: true,
          message_id: request.message_id,
          agent: agents[0],
          ...(agents.length > 1 ? { agents } : {}),
          reason,
        },
      };
    },
  );

  function nextDashboardSequence(): number {
    return dashboardSequence++;
  }

  function dashboardStates(sessionId?: string) {
    if (!sessionId) {
      return [...sessions.values()].map((record) => record.state);
    }
    const record = sessions.get(sessionId);
    return record ? [record.state] : [];
  }

  function dashboardSnapshot(
    request: SessionManagerDashboardSubscriptionRequest = {},
    sequence = nextDashboardSequence(),
    at = new Date().toISOString(),
  ): SessionManagerDashboardSnapshotResult {
    const states = dashboardStates(request.session_id);
    const record = request.session_id ? sessions.get(request.session_id) : undefined;
    const detail = request.include_detail && record ? renderSessionDetailProjection(record.state) : undefined;
    return {
      at,
      sequence,
      sessions: renderSessionWorkProjections(states),
      review_queue: renderReviewQueue(states),
      agent_workload: renderAgentWorkload(states),
      ...(request.session_id ? { session_id: request.session_id } : {}),
      ...(detail ? { detail } : {}),
    };
  }

  function publishDashboardUpdate(record: SessionRecord, event: CollaborationEvent): void {
    if (dashboardSubscribers.size === 0) {
      return;
    }
    const session = renderSessionWorkProjection(record.state);
    if (!session) {
      return;
    }
    const sequence = nextDashboardSequence();
    const at = event.at;

    for (const subscription of dashboardSubscribers.values()) {
      if (subscription.session_id && subscription.session_id !== record.id) {
        continue;
      }
      emitDashboardEvent(subscription, {
        type: "session_updated",
        ...dashboardSnapshot({ session_id: subscription.session_id, include_detail: subscription.include_detail }, sequence, at),
        session_id: record.id,
        session,
        source_event: {
          id: event.id,
          type: event.type,
          at: event.at,
        },
      });
    }
  }

  function emitDashboardEvent(subscription: DashboardSubscription, event: SessionManagerDashboardEvent): void {
    try {
      node.emit(subscription.subscriber, event.type, {
        mime_type: KAIROS_DASHBOARD_EVENT_MIME,
        data: event,
      }, { correlation_id: subscription.correlation_id });
    } catch {
      // A dashboard subscriber may disconnect while session work continues.
    }
  }

  function endDashboardSubscription(subscription: DashboardSubscription, reason?: string): void {
    try {
      node.end(subscription.subscriber, "dashboard_subscription_closed", {
        mime_type: KAIROS_DASHBOARD_EVENT_MIME,
        data: {
          type: "dashboard_subscription_closed",
          at: new Date().toISOString(),
          sequence: nextDashboardSequence(),
          subscriber: subscription.subscriber,
          reason,
        },
      }, { correlation_id: subscription.correlation_id });
    } catch {
      // The subscriber may already be gone by the time unsubscribe is processed.
    }
  }

  return {
    node,
    sessions,
    getSession: (id) => sessions.get(id),
  };

  function applySessionGoal(record: SessionRecord, request: SessionManagerUpdateSessionGoalRequest): void {
    const sourceRefs = request.source_refs ?? [];
    if (request.title?.trim() || request.objective?.trim()) {
      appendEvent(record, {
        type: "scope_updated",
        session_id: record.id,
        title: request.title?.trim() || undefined,
        objective: request.objective?.trim() || undefined,
        source_refs: sourceRefs,
      });
    }
    if (request.acceptance_criteria?.length) {
      appendEvent(record, {
        type: "acceptance_criteria_recorded",
        session_id: record.id,
        criteria: request.acceptance_criteria,
        source_refs: sourceRefs,
      });
    }
    for (const constraint of request.constraints ?? []) {
      appendEvent(record, {
        type: "constraint_recorded",
        session_id: record.id,
        constraint,
        source_refs: sourceRefs,
      });
    }
  }

  function requiredArtifact(record: SessionRecord, artifactId: string): Artifact {
    const artifact = record.state.artifacts[artifactId];
    if (!artifact) {
      throw new Error(`artifact not found: ${artifactId}`);
    }
    return artifact;
  }

  function reopenDelegationForRevision(
    record: SessionRecord,
    artifact: Artifact,
    review: ArtifactReview,
    revisionInstruction: string | undefined,
  ): Delegation | undefined {
    const delegation = delegationForArtifact(record, artifact);
    if (!delegation) {
      return undefined;
    }

    const at = review.reviewed_at;
    const instruction = [
      delegation.instruction,
      "",
      `Revision requested for ${artifact.id}:`,
      revisionInstruction ?? review.note ?? "Revise the artifact according to the review.",
    ].join("\n");
    appendEvent(record, {
      type: "delegation_updated",
      session_id: record.id,
      delegation_id: delegation.id,
      patch: {
        instruction,
        status: "pending",
        submitted_artifact_id: undefined,
        updated_at: at,
      },
    }, at);
    appendEvent(record, {
      type: "task_updated",
      session_id: record.id,
      task_id: delegation.task_id,
      patch: { status: "open", updated_at: at },
    }, at);
    const barrier: ReplyBarrier = {
      id: `barrier_revision_${slug(artifact.id)}_${record.events.length + 1}`,
      session_id: record.id,
      task_id: delegation.task_id,
      source_ref: { kind: "artifact", artifact_id: artifact.id },
      owner: review.reviewer,
      expected_from: [delegation.assignee],
      notify: options.coordinator_uri ? [options.coordinator_uri] : [],
      mode: "all",
      synthesis_requested: taskHasSynthesis(record, delegation.task_id) ? true : undefined,
      synthesis_reason: taskHasSynthesis(record, delegation.task_id) ? "revision requested after synthesis" : undefined,
      status: "open",
      replies: {},
      created_at: at,
    };
    appendEvent(record, { type: "barrier_created", barrier }, at);
    return record.state.delegations[delegation.id];
  }

  function delegationForArtifact(record: SessionRecord, artifact: Artifact): Delegation | undefined {
    return Object.values(record.state.delegations).find((delegation) => {
      return delegation.submitted_artifact_id === artifact.id || artifact.relates_to?.includes(delegation.id);
    });
  }

  function taskHasSynthesis(record: SessionRecord, taskId: string): boolean {
    return Object.values(record.state.barriers).some((barrier) => barrier.task_id === taskId && barrier.synthesis_requested)
      || Object.values(record.state.delegations).some((delegation) => delegation.task_id === taskId && delegation.role === "synthesis")
      || Object.values(record.state.artifacts).some((artifact) => artifact.kind === "final_synthesis" && artifact.relates_to?.includes(taskId));
  }

  function revisionMessageForArtifact(
    record: SessionRecord,
    artifact: Artifact,
    review: ArtifactReview,
    revisionInstruction: string | undefined,
  ): SlockMessage {
    const origin = originMessageRef(record.state);
    return {
      id: origin?.message_id ?? `revision_${artifact.id}`,
      channel: origin?.channel ?? record.uri,
      sender: review.reviewer,
      text: revisionInstruction ?? review.note ?? `Revise artifact ${artifact.id}`,
      mentions: [artifact.author],
      thread_id: origin?.message_id ?? null,
      reply_to_id: origin?.message_id ?? null,
      kind: review.reviewer.startsWith("human://") ? "human" : "system",
      created_at: review.reviewed_at,
    };
  }

  function validationSourceRefs(
    record: SessionRecord,
    taskId: string | undefined,
    artifactId: string | undefined,
    source: EndpointUri,
  ): SourceRef[] {
    const refs: SourceRef[] = [];
    if (artifactId) refs.push({ kind: "artifact", artifact_id: artifactId });
    if (taskId) refs.push(...(record.state.tasks[taskId]?.source_refs ?? []));
    if (refs.length === 0) refs.push({ kind: "external", uri: source, label: "validation request" });
    return uniqueSourceRefsForSession(refs);
  }

  function ensureSynthesisBarrier(record: SessionRecord, request: SessionManagerRequestSynthesisRequest): ReplyBarrier | undefined {
    const explicit = request.barrier_id ? record.state.barriers[request.barrier_id] : undefined;
    if (explicit) {
      return explicit;
    }
    const taskId = request.task_id ?? Object.keys(record.state.tasks)[0];
    if (!taskId) {
      return undefined;
    }
    const existing = Object.values(record.state.barriers)
      .filter((barrier) => barrier.task_id === taskId)
      .sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at))[0];
    if (existing) {
      return existing;
    }

    const delegations = Object.values(record.state.delegations).filter((delegation) => delegation.task_id === taskId && delegation.assignee !== options.coordinator_uri);
    const replies = Object.fromEntries(delegations.flatMap((delegation) => {
      return delegation.submitted_artifact_id ? [[delegation.assignee, delegation.submitted_artifact_id]] : [];
    }));
    const barrier: ReplyBarrier = {
      id: `barrier_synthesis_${slug(taskId)}_${record.events.length + 1}`,
      session_id: record.id,
      task_id: taskId,
      source_ref: request.source_refs?.[0] ?? record.state.tasks[taskId]?.source_refs[0] ?? record.state.session?.origin ?? { kind: "external", uri: record.uri, label: "synthesis" },
      owner: record.state.tasks[taskId]?.owner ?? "human://user/local",
      expected_from: delegations.map((delegation) => delegation.assignee),
      notify: options.coordinator_uri ? [options.coordinator_uri] : [],
      mode: "all",
      synthesis_requested: true,
      synthesis_reason: request.reason ?? "explicit synthesis request",
      status: "open",
      replies,
      created_at: new Date().toISOString(),
    };
    const event = appendEvent(record, { type: "barrier_created", barrier }, barrier.created_at);
    const current = record.state.barriers[barrier.id];
    if (current && barrierIsSatisfied(current)) {
      appendEvent(record, { type: "barrier_satisfied", session_id: record.id, barrier_id: current.id }, event.at);
    }
    return record.state.barriers[barrier.id];
  }

  function runValidation(record: SessionRecord, validationId: string, validatorOverride: EndpointUri | undefined): string {
    const validation = record.state.validations[validationId];
    if (!validation) {
      throw new Error(`validation not found: ${validationId}`);
    }
    const validator = validatorOverride ?? validation.validator;
    if (!validator) {
      throw new Error(`validation requires validator: ${validationId}`);
    }
    const at = new Date().toISOString();
    appendEvent(record, {
      type: "validation_started",
      session_id: record.id,
      validation_id: validationId,
      validator,
    }, at);
    const delegation = createValidationDelegation(record, record.state.validations[validationId], validator, at);
    void runDelegation(record.id, delegation.id, validationMessageForValidation(record, record.state.validations[validationId], validator), "validation");
    return delegation.id;
  }

  function createValidationDelegation(record: SessionRecord, validation: ValidationRecord, validator: EndpointUri, at: string): Delegation {
    const existingId = `delegation_validation_${slug(validation.id)}`;
    const existing = record.state.delegations[existingId];
    if (existing) {
      appendEvent(record, {
        type: "delegation_updated",
        session_id: record.id,
        delegation_id: existing.id,
        patch: { status: "pending", updated_at: at },
      }, at);
      return record.state.delegations[existing.id];
    }

    const taskId = validation.task_id ?? taskIdForValidation(record, validation);
    if (!taskId) {
      throw new Error(`validation has no task context: ${validation.id}`);
    }
    const delegation: Delegation = {
      id: existingId,
      session_id: record.id,
      task_id: taskId,
      assignee: validator,
      role: "validation",
      role_label: "Validation",
      instruction: validationInstruction(record, validation),
      expected_output: "A validation result artifact with pass/fail evidence and residual risk.",
      status: "pending",
      source_refs: validation.source_refs,
      trace_refs: validation.trace_refs,
      validation_id: validation.id,
    };
    appendEvent(record, { type: "delegation_created", delegation }, at);
    return record.state.delegations[delegation.id];
  }

  function taskIdForValidation(record: SessionRecord, validation: ValidationRecord): string | undefined {
    if (validation.artifact_id) {
      const artifact = record.state.artifacts[validation.artifact_id];
      const relatedDelegation = artifact ? delegationForArtifact(record, artifact) : undefined;
      if (relatedDelegation) return relatedDelegation.task_id;
    }
    return Object.keys(record.state.tasks)[0];
  }

  function validationInstruction(record: SessionRecord, validation: ValidationRecord): string {
    const targetArtifact = validation.artifact_id ? record.state.artifacts[validation.artifact_id] : undefined;
    return [
      "Validate the requested session work using the session context as source of truth.",
      validation.summary ? `Validation request: ${validation.summary}` : undefined,
      targetArtifact ? `Target artifact: ${targetArtifact.id} (${targetArtifact.title ?? targetArtifact.kind})` : undefined,
      "Return a concise validation result. If validation fails, explain the failure and the evidence clearly.",
    ].filter((line): line is string => Boolean(line)).join("\n");
  }

  function validationMessageForValidation(record: SessionRecord, validation: ValidationRecord, validator: EndpointUri): SlockMessage {
    const origin = originMessageRef(record.state);
    return {
      id: origin?.message_id ?? validation.id,
      channel: origin?.channel ?? record.uri,
      sender: validation.requester,
      text: validation.summary ?? `Validate ${validation.artifact_id ?? validation.task_id ?? record.id}`,
      mentions: [validator],
      thread_id: origin?.message_id ?? null,
      reply_to_id: origin?.message_id ?? null,
      kind: validation.requester.startsWith("human://") ? "human" : validation.requester.startsWith("agent://") ? "agent" : "system",
      created_at: validation.created_at,
    };
  }

  function isSynthesisReport(record: SessionRecord, delegationId: string | undefined, from: EndpointUri): boolean {
    if (options.coordinator_uri && from === options.coordinator_uri) {
      return true;
    }
    const delegation = delegationId ? record.state.delegations[delegationId] : undefined;
    return Boolean(delegation && (delegation.role === "synthesis" || delegation.id.startsWith("delegation_synthesis_")));
  }

  async function runDelegation(
    sessionId: string,
    delegationId: string,
    message: SlockMessage,
    purpose: RenderForAgentRequest["purpose"] = "delegation",
  ): Promise<void> {
    const record = sessions.get(sessionId);
    const delegation = record?.state.delegations[delegationId];
    if (!record || !delegation) {
      return;
    }

    const correlationId = createCorrelationId("sess");
    const startedAt = new Date().toISOString();
    appendEvent(record, {
      type: "delegation_started",
      session_id: sessionId,
      delegation_id: delegationId,
      correlation_id: correlationId,
      started_at: startedAt,
    }, startedAt);
    appendEvent(record, {
      type: "trace_linked",
      session_id: sessionId,
      object_ref: `delegation:${delegationId}`,
      trace_ref: {
        correlation_id: correlationId,
        endpoint: delegation.assignee,
        action: "run",
        label: `${labelFromUri(delegation.assignee)} run`,
        object_ref: `delegation:${delegationId}`,
      },
    }, startedAt);

    const run: ActiveSessionRun = {
      session_id: sessionId,
      delegation_id: delegationId,
      agent: delegation.assignee,
      message,
      correlation_id: correlationId,
      started_at: startedAt,
    };
    rememberActiveRun(run);
    await publishAgentRun(message.channel, "publish_agent_run_started", {
      run_id: correlationId,
      message_id: message.id,
      thread_id: message.thread_id,
      agent: delegation.assignee,
      state: "started",
      started_at: startedAt,
    });

    try {
      const context = await renderRunContext(record, delegation, message, purpose);
      const contextText = context.text;
      const result = await node.call<SlockAgentRun, SlockAgentResult>(
        delegation.assignee,
        "run",
        {
          mime_type: SLOCK_AGENT_RUN_MIME,
          data: {
            channel: message.channel,
            message_id: message.id,
            run_id: correlationId,
            thread_id: message.thread_id,
            text: contextText,
            sender: message.sender,
            session_id: sessionId,
            delegation_id: delegation.id,
            purpose,
            context_text: contextText,
            source_refs: context.source_refs,
            artifact_refs: context.artifact_refs,
            barrier_refs: context.barrier_refs,
          },
        },
        { correlation_id: correlationId, ttl_ms: agentTtlMs, timeout_ms: agentTtlMs },
      );

      const final = result.data;
      if (final.cancelled || run.cancel_requested) {
        if (!run.cancel_requested) {
          appendEvent(record, {
            type: "agent_run_cancelled",
            session_id: sessionId,
            correlation_id: correlationId,
            reason: final.reason,
          });
          if (delegation.validation_id) {
            appendEvent(record, {
              type: "validation_recorded",
              session_id: sessionId,
              validation_id: delegation.validation_id,
              patch: { status: "cancelled", summary: final.reason, trace_refs: [{ correlation_id: correlationId, endpoint: delegation.assignee, action: "run", label: "validation cancelled" }] },
            });
          }
          await publishAgentCancelled(message.channel, { message_id: message.id, agent: delegation.assignee, reason: final.reason });
        }
        await publishAgentRun(message.channel, "publish_agent_run_finished", {
          run_id: correlationId,
          message_id: message.id,
          thread_id: message.thread_id,
          agent: delegation.assignee,
          state: "cancelled",
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          reason: final.reason ?? run.reason,
        });
        return;
      }

      const artifactId = nextArtifactId(record.id);
      const artifact: Artifact = {
        id: artifactId,
        session_id: sessionId,
        author: delegation.assignee,
        kind: delegation.question_id ? "question_answer" : delegation.validation_id ? "validation_result" : purpose === "synthesis" ? "final_synthesis" : "summary",
        title: delegation.question_id
          ? `Answer from ${labelFromUri(delegation.assignee)}`
          : delegation.validation_id
            ? `Validation result from ${labelFromUri(delegation.assignee)}`
          : purpose === "synthesis"
            ? "Final synthesis"
            : `Response from ${labelFromUri(delegation.assignee)}`,
        content: {
          summary: final.summary,
          final_text: final.final_text ?? final.summary,
        },
        status: "submitted",
        relates_to: uniqueStrings([delegation.id, delegation.task_id, delegation.question_id, delegation.validation_id]),
        source_refs: [{ kind: "ipc_envelope", correlation_id: correlationId }],
        trace_refs: [{ correlation_id: correlationId, endpoint: delegation.assignee, action: "run", label: "agent final output", object_ref: `artifact:${artifactId}` }],
        created_at: new Date().toISOString(),
      };
      const artifactEvent = appendEvent(record, { type: "artifact_submitted", artifact, delegation_id: delegation.id });
      if (delegation.question_id) {
        appendEvent(record, {
          type: "question_answered",
          session_id: sessionId,
          question_id: delegation.question_id,
          answer_artifact_id: artifact.id,
        });
      }
      if (delegation.validation_id) {
        appendEvent(record, {
          type: "validation_recorded",
          session_id: sessionId,
          validation_id: delegation.validation_id,
          patch: {
            status: "passed",
            validator: delegation.assignee,
            summary: final.summary,
            artifact_id: artifact.id,
            source_refs: [{ kind: "artifact", artifact_id: artifact.id }],
            trace_refs: artifact.trace_refs,
          },
        });
      }
      updateBarriersForArtifact(record, artifact, delegation.id, artifactEvent.at);
      if (purpose === "synthesis") {
        appendEvent(record, {
          type: "task_updated",
          session_id: sessionId,
          task_id: delegation.task_id,
          patch: { status: "completed" },
        });
      }
      const shouldProjectFinalArtifact = purpose === "synthesis" || !hasHumanReportForDelegation(record, delegation.id);
      const finalMessage = shouldProjectFinalArtifact
        ? await projectArtifact(
          record,
          artifact,
          artifactEvent.id,
          messageSourceRef(message),
          purpose === "synthesis" ? "final_report" : "artifact",
        )
        : undefined;
      await publishAgentRun(message.channel, "publish_agent_run_finished", {
        run_id: correlationId,
        message_id: message.id,
        thread_id: message.thread_id,
        agent: delegation.assignee,
        state: "completed",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        final_message_id: finalMessage?.id,
      });
    } catch (error) {
      const code = error instanceof IpcCallError ? error.code : "AGENT_RUN_FAILED";
      const messageText = error instanceof Error ? error.message : "agent run failed";
      if (run.cancel_requested) {
        await publishAgentRun(message.channel, "publish_agent_run_finished", {
          run_id: correlationId,
          message_id: message.id,
          thread_id: message.thread_id,
          agent: delegation.assignee,
          state: "cancelled",
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          reason: run.reason,
        });
        return;
      }
      appendEvent(record, {
        type: "delegation_updated",
        session_id: sessionId,
        delegation_id: delegation.id,
        patch: { status: "failed", error: messageText, updated_at: new Date().toISOString() },
      });
      if (delegation.validation_id) {
        appendEvent(record, {
          type: "validation_failed",
          session_id: sessionId,
          validation_id: delegation.validation_id,
          summary: messageText,
          trace_refs: [{ correlation_id: correlationId, endpoint: delegation.assignee, action: "run", label: "validation failed", severity: "error" }],
        });
      }
      await publishAgentError(message.channel, { code, message: messageText, source: delegation.assignee });
      await publishAgentRun(message.channel, "publish_agent_run_finished", {
        run_id: correlationId,
        message_id: message.id,
        thread_id: message.thread_id,
        agent: delegation.assignee,
        state: "errored",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: { code, message: messageText },
      });
    } finally {
      forgetActiveRun(run);
    }
  }

  async function runSynthesis(sessionId: string, barrierId: string, coordinatorUri: EndpointUri): Promise<void> {
    const record = sessions.get(sessionId);
    const barrier = record?.state.barriers[barrierId];
    if (!record || !barrier) {
      return;
    }

    const delegationId = `delegation_synthesis_${slug(barrier.id)}`;
    if (record.state.delegations[delegationId]) {
      return;
    }

    const taskId = barrier.task_id ?? Object.keys(record.state.tasks)[0];
    if (!taskId) {
      return;
    }

    const sourceRefs = uniqueSourceRefsForSession([
      barrier.source_ref,
      ...Object.values(barrier.replies).map((artifactId): SourceRef => ({ kind: "artifact", artifact_id: artifactId })),
    ]);
    const delegation: Delegation = {
      id: delegationId,
      session_id: record.id,
      task_id: taskId,
      assignee: coordinatorUri,
      role: "synthesis",
      role_label: "Final synthesis",
      instruction: [
        "Synthesize the completed delegation artifacts into a final human-facing answer.",
        "Use the current collaboration state as the source of truth. Call out consensus, disagreements, residual risk, and concrete next steps when relevant.",
      ].join(" "),
      expected_output: "A final synthesized report based on the completed artifacts in this session.",
      status: "pending",
      source_refs: sourceRefs,
    };
    appendEvent(record, { type: "delegation_created", delegation });
    await runDelegation(record.id, delegation.id, synthesisMessageForBarrier(barrier, coordinatorUri), "synthesis");
  }
}

function normalizeSubmittedArtifact(
  record: SessionRecord,
  request: SessionManagerSubmitArtifactRequest,
  source: EndpointUri,
): Artifact {
  const artifact = request.artifact;
  return {
    id: typeof artifact.id === "string" ? artifact.id : `${record.id}_artifact_external_${Date.now()}`,
    session_id: record.id,
    author: artifact.author ?? source,
    kind: artifact.kind,
    title: artifact.title,
    content: artifact.content,
    status: artifact.status ?? "submitted",
    relates_to: artifact.relates_to,
    supersedes: artifact.supersedes,
    review: artifact.review,
    source_refs: artifact.source_refs ?? [],
    trace_refs: artifact.trace_refs,
    created_at: artifact.created_at ?? new Date().toISOString(),
    updated_at: artifact.updated_at,
  };
}
