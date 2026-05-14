import type { EndpointUri } from "../../protocol/src/index.ts";
import type { ReviewQueueItem, SessionWorkProjection, SourceRef } from "../../collaboration-context/src/index.ts";
import type {
  SessionManagerAnswerQuestionRequest,
  SessionManagerAttachSourceRequest,
  SessionManagerCancelDelegationRunRequest,
  SessionManagerCreateSessionRequest,
  SessionManagerDashboardEvent,
  SessionManagerRequestSynthesisRequest,
  SessionManagerResolveApprovalRequest,
  SessionManagerReviewArtifactRequest,
  SessionManagerSessionSnapshot,
  SessionManagerStartDelegationsRequest,
  SessionManagerStartDelegationsResult,
  SessionManagerWorkSessionResult,
} from "../../session-manager/src/index.ts";
import { createMattermostBotClient, MattermostRestError } from "./client.ts";
import { ephemeralResponse, errorResponse, projectStatusCard, reviewQueueItemCard } from "./cards.ts";
import { createMattermostCallbackToken } from "./callback-token.ts";
import { buildMattermostSourceRef } from "./source-refs.ts";
import type {
  MattermostActionErrorResponse,
  MattermostActionResponse,
  MattermostBridgeOptions,
  MattermostCommandResponse,
  MattermostDialogResponse,
  MattermostDialogSubmission,
  MattermostInteractiveActionCallback,
  MattermostSlashCallback,
} from "./types.ts";

export interface MattermostBridgeService {
  handleSlash(payload: MattermostSlashCallback): Promise<MattermostCommandResponse>;
  handleAction(payload: MattermostInteractiveActionCallback): Promise<MattermostActionResponse | MattermostActionErrorResponse>;
  handleDialog(payload: MattermostDialogSubmission): Promise<MattermostDialogResponse>;
  publishSessionProjection(event: SessionManagerDashboardEvent): Promise<MattermostCommandResponse | undefined>;
}

export interface MattermostBridgeServiceOptions extends MattermostBridgeOptions {
  agent_aliases?: Record<string, EndpointUri | EndpointUri[]>;
  allowed_agent_uris?: EndpointUri[];
  default_agents?: EndpointUri[];
  fetch?: typeof fetch;
}

const DEFAULT_AGENT_ALIASES: Record<string, EndpointUri | EndpointUri[]> = {
  alice: "agent://local/alice",
  cindy: "agent://local/cindy",
  reviewer: "agent://local/reviewer",
  tester: "agent://local/tester",
  architect: "agent://local/architect",
};

const DEFAULT_MAX_PROJECTION_POSTS = 2048;

interface ProjectionPostRef {
  channel_id: string;
  post_id: string;
  root_id?: string;
  stale_update_replaced?: boolean;
  updates_disabled?: boolean;
}

export function createMattermostBridgeService(options: MattermostBridgeServiceOptions): MattermostBridgeService {
  const human = options.human_node;
  const sessionManagerUri = options.session_manager_uri;
  const agentAliases = { ...DEFAULT_AGENT_ALIASES, ...(options.agent_aliases ?? {}) };
  const allowedAgentUris = new Set(options.allowed_agent_uris ?? []);
  const hasAgentAllowlist = Boolean(options.allowed_agent_uris);
  const maxProjectionPosts = options.max_projection_posts ?? DEFAULT_MAX_PROJECTION_POSTS;
  const projectionPosts = new Map<string, ProjectionPostRef>();
  const publicUrl = options.bridge_public_url;
  const bot = createMattermostBotClient({
    mattermost_base_url: options.mattermost_base_url,
    bot_token: options.bot_token,
    timeout_ms: options.mattermost_request_timeout_ms,
    fetch: options.fetch,
  });

  return { handleSlash, handleAction, handleDialog, publishSessionProjection };

  async function handleSlash(payload: MattermostSlashCallback): Promise<MattermostCommandResponse> {
    try {
      const { command, rest } = parseSlashText(payload.text);
      if (command === "start") return startSession(payload, rest);
      if (command === "status") return statusSession(rest);
      if (command === "attach") return attachSource(payload, rest);
      if (command === "artifact") return linkResponse("Artifact", artifactUrl(firstToken(rest), publicUrl), "artifact id");
      if (command === "trace") return linkResponse("Trace", traceUrl(firstToken(rest), publicUrl), "session id");
      return ephemeralResponse("Usage: /kairos start|status|attach|artifact|trace ...");
    } catch (error) {
      return errorResponse(error);
    }
  }

  async function handleAction(payload: MattermostInteractiveActionCallback): Promise<MattermostActionResponse | MattermostActionErrorResponse> {
    try {
      const context = payload.context ?? {};
      const action = cleanString(context.action) ?? cleanString(payload.selected_option);
      if (!action) return actionResponseFromCommand(ephemeralResponse("Kairos action is missing context."));

      if (action === "approve" || action === "reject") {
        const sessionId = requiredContextString(context.session_id, "session_id");
        const approvalId = requiredContextString(context.approval_id, "approval_id");
        const approved = action === "approve";
        await human.call<SessionManagerResolveApprovalRequest, SessionManagerSessionSnapshot>(sessionManagerUri, "resolve_approval", {
          mime_type: "application/json",
          data: {
            session_id: sessionId,
            approval_id: approvalId,
            status: approved ? "approved" : "rejected",
            approved,
            resolved_by: actionActor(payload, action),
            resolution_note: `Mattermost ${action} by ${payload.user_name ?? payload.user_id}`,
          },
        });
        return actionResponseFromCommand(ephemeralResponse(`Approval ${approved ? "approved" : "rejected"}.`));
      }

      if (action === "accept_artifact") {
        await reviewArtifact(payload, "accepted");
        return actionResponseFromCommand(ephemeralResponse("Artifact accepted. See the artifact and trace links."));
      }

      if (action === "request_revision") {
        await openTextDialog(payload, "request_revision", "Request revision", [
          { display_name: "Note", name: "note", type: "textarea", optional: true },
          { display_name: "Revision instruction", name: "revision_instruction", type: "textarea" },
        ]);
        return actionResponseFromCommand(ephemeralResponse("Opening revision dialog."));
      }

      if (action === "answer_question") {
        await openTextDialog(payload, "answer_question", "Answer question", [
          { display_name: "Answer", name: "answer", type: "textarea" },
        ]);
        return actionResponseFromCommand(ephemeralResponse("Opening answer dialog."));
      }

      if (action === "cancel_run") {
        const sessionId = requiredContextString(context.session_id, "session_id");
        const delegationId = requiredContextString(context.delegation_id, "delegation_id");
        await human.call<SessionManagerCancelDelegationRunRequest>(sessionManagerUri, "cancel_delegation_run", {
          mime_type: "application/json",
          data: { session_id: sessionId, delegation_id: delegationId, reason: `Mattermost cancel by ${payload.user_name ?? payload.user_id}` },
        });
        return actionResponseFromCommand(ephemeralResponse("Run cancellation requested."));
      }

      if (action === "request_synthesis") {
        const sessionId = requiredContextString(context.session_id, "session_id");
        await human.call<SessionManagerRequestSynthesisRequest, SessionManagerSessionSnapshot>(sessionManagerUri, "request_synthesis", {
          mime_type: "application/json",
          data: { session_id: sessionId, reason: `Mattermost synthesis request by ${payload.user_name ?? payload.user_id}`, source_refs: [actionSourceRef(payload, action)] },
        });
        return actionResponseFromCommand(ephemeralResponse("Synthesis requested. Full details will stay in Kairos links and trace."));
      }

      if (action === "open_trace") {
        const sessionId = requiredContextString(context.session_id, "session_id");
        return actionResponseFromCommand(linkResponse("Trace", traceUrl(sessionId, publicUrl), "session id"));
      }

      return actionResponseFromCommand(ephemeralResponse(`Unsupported Kairos action: ${action}`));
    } catch (error) {
      return safeActionErrorResponse(error);
    }
  }

  async function handleDialog(payload: MattermostDialogSubmission): Promise<MattermostDialogResponse> {
    if (payload.cancelled) return {};
    try {
      const context = parseDialogState(payload.state, payload.callback_id);
      if (!context) return dialogFailure();
      if (context.action === "request_revision") {
        const sessionId = requiredContextString(context.session_id, "session_id");
        const artifactId = requiredContextString(context.artifact_id, "artifact_id");
        await human.call<SessionManagerReviewArtifactRequest, SessionManagerSessionSnapshot>(sessionManagerUri, "request_revision", {
          mime_type: "application/json",
          data: {
            session_id: sessionId,
            artifact_id: artifactId,
            status: "revision_requested",
            note: cleanString(payload.submission.note),
            revision_instruction: cleanString(payload.submission.revision_instruction),
            reviewer: dialogActor(payload, "request_revision"),
            source_refs: [dialogSourceRef(payload, "request_revision")],
          },
        });
        return {};
      }

      if (context.action === "answer_question") {
        const sessionId = requiredContextString(context.session_id, "session_id");
        const questionId = requiredContextString(context.question_id, "question_id");
        await human.call<SessionManagerAnswerQuestionRequest, SessionManagerSessionSnapshot>(sessionManagerUri, "answer_question", {
          mime_type: "application/json",
          data: {
            session_id: sessionId,
            question_id: questionId,
            answer: requiredSubmissionString(payload.submission.answer, "answer"),
            artifact: {
              author: dialogActor(payload, "answer_question"),
              content: requiredSubmissionString(payload.submission.answer, "answer"),
              source_refs: [dialogSourceRef(payload, "answer_question")],
            },
            project: true,
          },
        });
        return {};
      }

      return dialogFailure("Unsupported Kairos dialog.");
    } catch (error) {
      return dialogFailure();
    }
  }

  async function publishSessionProjection(event: SessionManagerDashboardEvent): Promise<MattermostCommandResponse | undefined> {
    if (event.type !== "dashboard_snapshot" && event.type !== "session_updated") return undefined;
    const sessions = event.type === "session_updated" ? [event.session].filter((session): session is SessionWorkProjection => Boolean(session)) : event.sessions;
    const sessionTargets = new Map<string, { channelId: string; postId?: string }>();
    let firstResponse: MattermostCommandResponse | undefined;
    for (const session of sessions) {
      const response = await publishOneSessionProjection(event.type, session);
      firstResponse ??= response;
      const target = targetForSession(session);
      if (target) sessionTargets.set(session.session_id, target);
    }
    for (const item of event.review_queue) {
      const response = await publishReviewQueueProjection(item, sessionTargets.get(item.session_id));
      firstResponse ??= response;
    }
    return firstResponse;
  }

  async function publishOneSessionProjection(eventType: "dashboard_snapshot" | "session_updated", session: SessionWorkProjection): Promise<MattermostCommandResponse | undefined> {
    if (!session) return undefined;
    const target = targetForSession(session);
    if (!target?.channelId) return undefined;
    const response = projectStatusCard({
      session_id: session.session_id,
      title: session.title,
      objective: session.objective,
      status: session.status,
      agents: session.agents.map((agent) => agent.agent),
      blockers: session.blockers.map((blocker) => blocker.label),
      latest_summary: session.latest_report ?? session.current_work ?? session.latest_artifact?.text,
      trace_url: traceUrl(session.session_id, publicUrl),
    });
    const key = sessionPostKey(session.session_id);
    const existing = projectionPosts.get(key);
    const post = {
      channel_id: target.channelId,
      root_id: target.postId ?? existing?.root_id,
      message: response.text ?? `Kairos session update: ${session.session_id}`,
      props: { attachments: response.attachments, kairos: { session_id: session.session_id, event_type: eventType } },
    };
    await publishProjectionPost(key, post);
    return response;
  }

  async function publishReviewQueueProjection(item: ReviewQueueItem, sessionTarget: { channelId: string; postId?: string } | undefined): Promise<MattermostCommandResponse | undefined> {
    if (item.kind !== "artifact" && item.kind !== "approval") return undefined;
    const existing = projectionPosts.get(objectPostKey(item.id));
    const sourceTarget = findMattermostTarget(item.source_refs ?? []);
    const target = sourceTarget ?? sessionTarget ?? (existing ? { channelId: existing.channel_id, postId: existing.root_id } : undefined);
    if (!target?.channelId) return undefined;

    const objectRefId = objectId(item.id);
    const response = reviewQueueItemCard({
      item,
      action_url: callbackUrl("/mattermost/action", publicUrl, options.slash_command_token, options.callback_token_ttl_ms),
      artifact_url: item.kind === "artifact" ? artifactUrl(objectRefId, publicUrl) : undefined,
      trace_url: traceUrl(item.session_id, publicUrl),
    });
    const post = {
      channel_id: target.channelId,
      root_id: target.postId ?? existing?.root_id,
      message: response.text ?? `${item.kind}: ${item.title}`,
      props: {
        attachments: response.attachments,
        kairos: {
          card: item.kind,
          session_id: item.session_id,
          object_ref: item.id,
          ...(item.kind === "approval" ? { approval_id: objectRefId } : { artifact_id: objectRefId }),
        },
      },
    };

    await publishProjectionPost(objectPostKey(item.id), post);
    return response;
  }

  async function publishProjectionPost(key: string, post: { channel_id: string; root_id?: string; message: string; props?: Record<string, unknown> }): Promise<void> {
    const existing = projectionPosts.get(key);
    if (existing?.post_id && existing.channel_id === post.channel_id) {
      if (existing.updates_disabled) return;
      try {
        await bot.updatePost(existing.post_id, post);
        return;
      } catch (error) {
        if (isStaleProjectionUpdateError(error) && !existing.stale_update_replaced) {
          const created = await bot.createPost(post);
          setProjectionPost(key, { channel_id: created.channel_id, post_id: created.id, root_id: post.root_id, stale_update_replaced: true });
          return;
        }
        if (isForbiddenProjectionUpdateError(error) || isStaleProjectionUpdateError(error)) {
          setProjectionPost(key, { ...existing, updates_disabled: true });
        }
        throw error;
      }
    }

    const created = await bot.createPost(post);
    setProjectionPost(key, { channel_id: created.channel_id, post_id: created.id, root_id: post.root_id });
  }

  function setProjectionPost(key: string, value: ProjectionPostRef): void {
    if (projectionPosts.has(key)) projectionPosts.delete(key);
    projectionPosts.set(key, value);
    while (projectionPosts.size > maxProjectionPosts) {
      const oldestKey = projectionPosts.keys().next().value;
      if (!oldestKey) break;
      projectionPosts.delete(oldestKey);
    }
  }

  function targetForSession(session: SessionWorkProjection): { channelId: string; postId?: string } | undefined {
    const sourceTarget = findMattermostTarget([session.origin, ...(session.source_refs ?? [])].filter((sourceRef): sourceRef is SourceRef => Boolean(sourceRef)));
    if (sourceTarget) return sourceTarget;
    const existing = projectionPosts.get(sessionPostKey(session.session_id));
    return existing ? { channelId: existing.channel_id, postId: existing.root_id } : undefined;
  }

  async function startSession(payload: MattermostSlashCallback, rest: string): Promise<MattermostCommandResponse> {
    const parsed = parseAgents(rest);
    if (parsed.rejected_agents.length > 0) {
      return ephemeralResponse(`These agents are not allowed for this Mattermost bridge: ${parsed.rejected_agents.join(", ")}.`);
    }
    if (parsed.agents.length === 0) {
      return ephemeralResponse("No Kairos agents selected. Mention an agent alias such as alice or cindy, or configure mattermost_bridge.default_agents.");
    }
    const objective = parsed.text || "Kairos Mattermost session";
    const sourceRef = slashSourceRef(payload, "Mattermost slash command");
    const created = await human.call<SessionManagerCreateSessionRequest, SessionManagerSessionSnapshot>(sessionManagerUri, "create_session", {
      mime_type: "application/json",
      data: {
        title: titleFromText(objective),
        objective,
        source_ref: sourceRef,
        owner: actionActorFromParts(payload, "start"),
      },
    });
    const sessionId = created.data.session_id;
    if (parsed.agents.length > 0) {
      await human.call<SessionManagerStartDelegationsRequest, SessionManagerStartDelegationsResult>(sessionManagerUri, "start_delegations", {
        mime_type: "application/json",
        data: {
          session_id: sessionId,
          instruction: objective,
          mode: "parallel",
          synthesis_requested: false,
          source_refs: [sourceRef],
          delegations: parsed.agents.map((assignee) => ({ assignee })),
        },
      });
    }
    return ephemeralResponse(`Kairos session started: ${sessionId}. Agents: ${parsed.agents.map(agentLabel).join(", ")}.`);
  }

  async function statusSession(rest: string): Promise<MattermostCommandResponse> {
    const sessionId = firstToken(rest);
    if (!sessionId) return ephemeralResponse("Please include a session id, for example: /kairos status session_1");
    try {
      const result = await human.call<{ session_id: string }, SessionManagerWorkSessionResult>(sessionManagerUri, "get_work_session", {
        mime_type: "application/json",
        data: { session_id: sessionId },
      });
      const session = result.data.session;
      if (!session) return ephemeralResponse(`No Kairos session found for ${sessionId}.`);
      return projectStatusCard({
        session_id: session.session_id,
        title: session.title,
        objective: session.objective,
        status: session.status,
        agents: session.agents.map((agent) => agent.agent),
        blockers: session.blockers.map((blocker) => blocker.label),
        latest_summary: session.latest_report ?? session.current_work ?? session.latest_artifact?.text,
        trace_url: traceUrl(session.session_id, publicUrl),
      });
    } catch (error) {
      if (!isNotFoundError(error)) return errorResponse(error);
      return ephemeralResponse(`No Kairos session found for ${sessionId}.`);
    }
  }

  async function attachSource(payload: MattermostSlashCallback, rest: string): Promise<MattermostCommandResponse> {
    const sessionId = firstToken(rest);
    if (!sessionId) return ephemeralResponse("Please include a session id, for example: /kairos attach session_1");
    const label = cleanString(payload.post_id) ? "Mattermost post" : "Mattermost channel";
    const sourceRef = slashSourceRef(payload, label);
    await human.call<SessionManagerAttachSourceRequest, SessionManagerSessionSnapshot>(sessionManagerUri, "attach_source", {
      mime_type: "application/json",
      data: { session_id: sessionId, source_ref: sourceRef, reason: `Mattermost source attached by ${payload.user_name ?? payload.user_id}` },
    });
    return ephemeralResponse(`Attached Mattermost source to ${sessionId}.`);
  }

  async function reviewArtifact(payload: MattermostInteractiveActionCallback, status: "accepted" | "rejected" | "revision_requested"): Promise<void> {
    const context = payload.context ?? {};
    await human.call<SessionManagerReviewArtifactRequest, SessionManagerSessionSnapshot>(sessionManagerUri, "review_artifact", {
      mime_type: "application/json",
      data: {
        session_id: requiredContextString(context.session_id, "session_id"),
        artifact_id: requiredContextString(context.artifact_id, "artifact_id"),
        status,
        reviewer: actionActor(payload, cleanString(context.action) ?? status),
        source_refs: [actionSourceRef(payload, cleanString(context.action) ?? status)],
      },
    });
  }

  async function openTextDialog(payload: MattermostInteractiveActionCallback, action: string, title: string, elements: Parameters<typeof bot.openDialog>[0]["dialog"]["elements"]): Promise<void> {
    const triggerId = cleanString(payload.trigger_id);
    const baseUrl = cleanString(options.bridge_public_url);
    if (!triggerId) throw new Error("Mattermost action requires trigger_id to open a dialog");
    if (!baseUrl) throw new Error("Mattermost bridge_public_url is required to open a dialog");
    await bot.openDialog({
      trigger_id: triggerId,
      url: callbackUrl("/mattermost/dialog", baseUrl, options.slash_command_token, options.callback_token_ttl_ms) ?? `${trimTrailingSlashes(baseUrl)}/mattermost/dialog`,
      dialog: {
        title,
        submit_label: "Submit",
        callback_id: action,
        state: JSON.stringify({ action, ...(payload.context ?? {}) }),
        elements,
      },
    });
  }

  function parseAgents(text: string): { agents: EndpointUri[]; text: string; rejected_agents: string[] } {
    const tokens = text.split(/\s+/).filter(Boolean);
    const agents: EndpointUri[] = [];
    const rejectedAgents: string[] = [];
    const remaining: string[] = [];
    let sawAgentRequest = false;
    for (const token of tokens) {
      const cleaned = token.replace(/^[,@]+|[,:;.!?]+$/g, "");
      const aliasValue = agentAliases[cleaned.toLowerCase()];
      const recognizedAlias = aliasValue !== undefined;
      const explicitAgent = cleaned.startsWith("agent://");
      const inferred = explicitAgent ? allowlistedExplicitAgent(cleaned) : aliasAgents(aliasValue);
      if (inferred.length > 0) {
        sawAgentRequest = true;
        for (const agent of inferred) {
          if (!agents.includes(agent)) agents.push(agent);
        }
      } else if (explicitAgent || recognizedAlias) {
        sawAgentRequest = true;
        rejectedAgents.push(cleaned);
        continue;
      } else {
        remaining.push(token);
      }
    }
    if (!sawAgentRequest && agents.length === 0 && options.default_agents?.length) agents.push(...unique(filterAllowedAgents(options.default_agents)));
    return { agents, text: remaining.join(" ").trim(), rejected_agents: unique(rejectedAgents) };
  }

  function allowlistedExplicitAgent(value: string): EndpointUri[] {
    if (!hasAgentAllowlist) return [];
    return filterAllowedAgents([value as EndpointUri]);
  }

  function aliasAgents(value: EndpointUri | EndpointUri[] | undefined): EndpointUri[] {
    if (!value) return [];
    return filterAllowedAgents(Array.isArray(value) ? value : [value]);
  }

  function filterAllowedAgents(values: EndpointUri[]): EndpointUri[] {
    if (!hasAgentAllowlist) return values;
    return values.filter((value) => allowedAgentUris.has(value));
  }
}

function parseSlashText(text: string | undefined): { command: string; rest: string } {
  const cleaned = (text ?? "").trim().replace(/^\/kairos\b/i, "").trim();
  const [command = "status", ...rest] = cleaned.split(/\s+/).filter(Boolean);
  return { command: command.toLowerCase(), rest: rest.join(" ").trim() };
}

function firstToken(text: string): string | undefined {
  return cleanString(text.split(/\s+/).find(Boolean));
}

function linkResponse(label: string, url: string | undefined, missing: string): MattermostCommandResponse {
  if (!url) return ephemeralResponse(`Please include a ${missing}, for example: /kairos ${label.toLowerCase()} ${label === "Trace" ? "session_1" : "artifact_1"}`);
  return ephemeralResponse(`${label}: ${url}`);
}

function actionResponseFromCommand(response: MattermostCommandResponse): MattermostActionResponse {
  const actionResponse: MattermostActionResponse = { skip_slack_parsing: true };
  if (response.text) actionResponse.ephemeral_text = response.text;
  if (response.response_type === "in_channel") {
    const props = response.attachments || response.props ? { ...(response.props ?? {}), ...(response.attachments ? { attachments: response.attachments } : {}) } : undefined;
    actionResponse.update = { message: response.text, props };
  }
  return actionResponse;
}

function safeActionErrorResponse(_error: unknown): MattermostActionErrorResponse {
  return { error: { message: "The request could not be completed." } };
}

function dialogFailure(message = "The request could not be completed."): MattermostDialogResponse {
  return { error: message };
}

function slashSourceRef(payload: MattermostSlashCallback, label: string): Extract<SourceRef, { kind: "external" }> {
  return buildMattermostSourceRef({ team_id: payload.team_id, channel_id: payload.channel_id, post_id: payload.post_id }, label);
}

function actionSourceRef(payload: MattermostInteractiveActionCallback, action: string): Extract<SourceRef, { kind: "external" }> {
  return buildMattermostSourceRef({ team_id: payload.team_id, channel_id: payload.channel_id, post_id: payload.post_id, user_id: payload.user_id, action }, "Mattermost action");
}

function dialogSourceRef(payload: MattermostDialogSubmission, action: string): Extract<SourceRef, { kind: "external" }> {
  return buildMattermostSourceRef({ team_id: payload.team_id, channel_id: payload.channel_id, user_id: payload.user_id, action }, "Mattermost dialog");
}

function actionActor(payload: MattermostInteractiveActionCallback, action: string): EndpointUri {
  return actionActorFromParts(payload, action);
}

function dialogActor(payload: MattermostDialogSubmission, action: string): EndpointUri {
  return actionActorFromParts(payload, action);
}

function actionActorFromParts(payload: { team_id: string; channel_id: string; post_id?: string; user_id: string }, action: string): EndpointUri {
  return buildMattermostSourceRef({ team_id: payload.team_id, channel_id: payload.channel_id, post_id: payload.post_id, user_id: payload.user_id, action }, "Mattermost user action").uri as EndpointUri;
}

function parseDialogState(state: string | undefined, callbackId: string | undefined): (Record<string, unknown> & { action?: string }) | undefined {
  const callbackAction = cleanString(callbackId);
  if (!state?.trim()) return { action: callbackAction };
  try {
    const parsed = JSON.parse(state);
    if (typeof parsed !== "object" || parsed === null) return { action: callbackAction };
    const stateAction = cleanString((parsed as Record<string, unknown>).action);
    if (callbackAction && stateAction && callbackAction !== stateAction) return undefined;
    return { ...parsed, action: callbackAction };
  } catch {
    return { action: callbackAction };
  }
}

function requiredContextString(value: unknown, name: string): string {
  const text = cleanString(value);
  if (!text) throw new Error(`Mattermost action requires ${name}`);
  return text;
}

function requiredSubmissionString(value: unknown, name: string): string {
  const text = cleanString(value);
  if (!text) throw new Error(`Mattermost dialog requires ${name}`);
  return text;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isStaleProjectionUpdateError(error: unknown): boolean {
  return error instanceof MattermostRestError && (error.status === 404 || error.status === 410);
}

function isForbiddenProjectionUpdateError(error: unknown): boolean {
  return error instanceof MattermostRestError && error.status === 403;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && /not found|missing|unknown session/i.test(error.message);
}

function titleFromText(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69)}...`;
}

function agentLabel(uri: EndpointUri): string {
  return uri.startsWith("agent://local/") ? uri.slice("agent://local/".length) : uri;
}

function traceUrl(sessionId: string | undefined, baseUrl?: string): string | undefined {
  return sessionId ? bridgeUrl(`/trace/${encodeURIComponent(sessionId)}`, baseUrl) : undefined;
}

function artifactUrl(artifactId: string | undefined, baseUrl?: string): string | undefined {
  return artifactId ? bridgeUrl(`/artifacts/${encodeURIComponent(artifactId)}`, baseUrl) : undefined;
}

function bridgeUrl(path: string, publicUrl?: string): string {
  const baseUrl = cleanString(publicUrl);
  if (!baseUrl) return path;
  return `${trimTrailingSlashes(baseUrl)}${path}`;
}

function callbackUrl(path: string, publicUrl: string | undefined, token: string | undefined, ttlMs?: number): string | undefined {
  const baseUrl = cleanString(publicUrl);
  if (!baseUrl) return undefined;
  const url = new URL(`${trimTrailingSlashes(baseUrl)}${path}`);
  const callbackToken = cleanString(token);
  if (callbackToken) url.searchParams.set("kairos_callback_token", createMattermostCallbackToken(callbackToken, { path, ttl_ms: ttlMs }));
  return url.toString();
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/g, "");
}

function sessionPostKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function objectPostKey(objectRef: string): string {
  return `object:${objectRef}`;
}

function objectId(objectRef: string): string {
  return objectRef.includes(":") ? objectRef.slice(objectRef.indexOf(":") + 1) : objectRef;
}

function findMattermostTarget(sourceRefs: SourceRef[]): { channelId: string; postId?: string } | undefined {
  for (const sourceRef of sourceRefs) {
    if (sourceRef.kind !== "external") continue;
    const match = sourceRef.uri.match(/^mattermost:\/\/team\/[^/]+\/channel\/([^/]+)(?:\/post\/([^/]+))?/);
    if (match?.[1]) return { channelId: decodeURIComponent(match[1]), postId: match[2] ? decodeURIComponent(match[2]) : undefined };
  }
  return undefined;
}
