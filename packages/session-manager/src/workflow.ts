import type { EndpointUri } from "../../protocol/src/index.ts";
import type {
  CollaborationEvent,
  CollaborationQuestion,
  Delegation,
  ReplyBarrier,
  SourceRef,
  Task,
} from "../../collaboration-context/src/index.ts";
import type { SlockMessage } from "../../slock-channel/src/index.ts";
import {
  delegationInstruction,
  idPrefix,
  messageRequestsSynthesis,
  slug,
  stripMentions,
  taskTitle,
  uniqueSourceRefsForSession,
} from "./helpers.ts";
import type { SessionManagerDelegationPlanItem, SessionRecord } from "./types.ts";
import type { SessionManagerStartDelegationsRequest } from "./types.ts";

type AppendEvent = (
  record: SessionRecord,
  event: Omit<CollaborationEvent, "id" | "at">,
  at?: string,
) => CollaborationEvent;

interface SessionWorkflowOptions {
  appendEvent: AppendEvent;
  coordinator_uri?: EndpointUri;
}

export function createSessionWorkflow(options: SessionWorkflowOptions) {
  const { appendEvent } = options;

  function routeHumanMentions(
    record: SessionRecord,
    message: SlockMessage,
    sourceRef: SourceRef,
    agents: EndpointUri[],
    createdSession: boolean,
    delegationPlan: SessionManagerDelegationPlanItem[] = [],
  ): { delegationIds: string[]; barrierId?: string } {
    if (createdSession) {
      return createDelegationsForMessage(record, message, sourceRef, agents, delegationPlan);
    }

    const existingAgents = agents.filter((agent) => latestDelegationForAssignee(record, agent));
    const newAgents = agents.filter((agent) => !existingAgents.includes(agent));
    const amended = existingAgents.length > 0
      ? amendDelegationsForMessage(record, message, sourceRef, existingAgents, delegationPlan)
      : { delegationIds: [], barrierId: undefined };
    const created = newAgents.length > 0
      ? createDelegationsForMessage(record, message, sourceRef, newAgents, delegationPlan)
      : { delegationIds: [], barrierId: undefined };

    return {
      delegationIds: [...amended.delegationIds, ...created.delegationIds],
      barrierId: amended.barrierId ?? created.barrierId,
    };
  }

  function createDelegationsForMessage(
    record: SessionRecord,
    message: SlockMessage,
    sourceRef: SourceRef,
    agents: EndpointUri[],
    delegationPlan: SessionManagerDelegationPlanItem[] = [],
  ): { delegationIds: string[]; barrierId?: string } {
    const at = new Date().toISOString();
    const task: Task = {
      id: `${idPrefix("task", message)}_${record.events.length + 1}`,
      session_id: record.id,
      title: taskTitle(message.text),
      owner: message.sender,
      status: "open",
      source_refs: [sourceRef],
    };
    appendEvent(record, { type: "task_created", task }, at);

    const delegationIds: string[] = [];
    agents.forEach((agent, index) => {
      const planned = delegationPlanForAgent(message, agent, delegationPlan);
      const delegation: Delegation = {
        id: `${idPrefix("delegation", message)}_${index + 1}`,
        session_id: record.id,
        task_id: task.id,
        assignee: agent,
        role: planned?.role,
        role_label: planned?.role_label,
        instruction: planned?.instruction ?? delegationInstruction(message, agent, planned?.role_label ?? planned?.role),
        expected_output: planned?.expected_output ?? "Submit a concise artifact that can stand alone in the collaboration session.",
        status: "pending",
        source_refs: [sourceRef],
      };
      delegationIds.push(delegation.id);
      appendEvent(record, { type: "delegation_created", delegation }, at);
    });

    if (delegationIds.length === 0) {
      return { delegationIds };
    }

    const barrier: ReplyBarrier = {
      id: `${idPrefix("barrier", message)}_1`,
      session_id: record.id,
      task_id: task.id,
      source_ref: sourceRef,
      owner: message.sender,
      expected_from: agents,
      notify: options.coordinator_uri ? [options.coordinator_uri] : [],
      mode: "all",
      ...synthesisRequestForMessage(message),
      status: "open",
      replies: {},
      created_at: at,
    };
    appendEvent(record, { type: "barrier_created", barrier }, at);
    return { delegationIds, barrierId: barrier.id };
  }

  function amendDelegationsForMessage(
    record: SessionRecord,
    message: SlockMessage,
    sourceRef: SourceRef,
    agents: EndpointUri[],
    delegationPlan: SessionManagerDelegationPlanItem[] = [],
  ): { delegationIds: string[]; barrierId?: string } {
    const at = new Date().toISOString();
    const amendedDelegations = agents
      .map((agent) => latestDelegationForAssignee(record, agent))
      .filter((delegation): delegation is Delegation => Boolean(delegation));

    if (amendedDelegations.length === 0) {
      return { delegationIds: [] };
    }

    const sourceRefs = [sourceRef];
    const amendmentText = stripMentions(message.text) || message.text;
    for (const delegation of amendedDelegations) {
      const planned = delegationPlanForAgent(message, delegation.assignee, delegationPlan);
      appendEvent(record, {
        type: "delegation_updated",
        session_id: record.id,
        delegation_id: delegation.id,
        patch: {
          role: planned?.role ?? delegation.role,
          role_label: planned?.role_label ?? delegation.role_label,
          instruction: planned?.instruction ?? `${delegation.instruction}\n\nAmendment from ${message.id}:\n${amendmentText}`,
          expected_output: planned?.expected_output ?? delegation.expected_output,
          status: delegation.status === "running" ? "running" : "pending",
          source_refs: uniqueSourceRefsForSession([...delegation.source_refs, ...sourceRefs]),
          updated_at: at,
        },
      }, at);

      if (delegation.submitted_artifact_id) {
        supersedeArtifact(record, delegation.submitted_artifact_id, at);
      }
      appendEvent(record, {
        type: "task_updated",
        session_id: record.id,
        task_id: delegation.task_id,
        patch: { status: "open" },
      }, at);
    }

    if (options.coordinator_uri) {
      for (const artifact of Object.values(record.state.artifacts)) {
        if (artifact.author === options.coordinator_uri && (artifact.status === "submitted" || artifact.status === "accepted")) {
          supersedeArtifact(record, artifact.id, at);
        }
      }
    }

    const firstDelegation = amendedDelegations[0];
    const barrier: ReplyBarrier = {
      id: `${idPrefix("barrier_amendment", message)}_1`,
      session_id: record.id,
      task_id: firstDelegation?.task_id,
      source_ref: sourceRef,
      owner: message.sender,
      expected_from: amendedDelegations.map((delegation) => delegation.assignee),
      notify: options.coordinator_uri ? [options.coordinator_uri] : [],
      mode: "all",
      ...synthesisRequestForAmendment(record, message, firstDelegation?.task_id),
      status: "open",
      replies: {},
      created_at: at,
    };
    appendEvent(record, { type: "barrier_created", barrier }, at);

    return { delegationIds: amendedDelegations.map((delegation) => delegation.id), barrierId: barrier.id };
  }

  function createQuestionDelegation(record: SessionRecord, question: CollaborationQuestion): Delegation | undefined {
    const taskId = Object.keys(record.state.tasks)[0];
    if (!taskId) {
      return undefined;
    }
    const delegation: Delegation = {
      id: `delegation_question_${slug(question.id)}`,
      session_id: record.id,
      task_id: taskId,
      assignee: question.to,
      instruction: [
        `Answer this structured collaboration question from ${question.from}:`,
        question.question,
      ].join("\n"),
      expected_output: "A direct answer artifact for the question.",
      status: "pending",
      source_refs: question.about_refs ?? [],
      question_id: question.id,
    };
    appendEvent(record, { type: "delegation_created", delegation });
    return delegation;
  }

  function createDirectDelegations(
    record: SessionRecord,
    request: SessionManagerStartDelegationsRequest,
    owner: EndpointUri,
  ): { taskId: string; delegationIds: string[]; barrierId?: string } {
    const at = new Date().toISOString();
    const sourceRefs = uniqueSourceRefsForSession(request.source_refs?.length
      ? request.source_refs
      : record.state.session?.origin
        ? [record.state.session.origin]
        : [{ kind: "external", uri: record.uri, label: "direct delegation" }]);
    const task = ensureDirectTask(record, request, owner, sourceRefs, at);
    const delegationIds: string[] = [];
    const nextDelegationIndex = Object.keys(record.state.delegations).length + 1;

    request.delegations.forEach((item, index) => {
      const delegation: Delegation = {
        id: `delegation_direct_${slug(record.id)}_${nextDelegationIndex + index}`,
        session_id: record.id,
        task_id: task.id,
        assignee: item.assignee,
        role: item.role,
        role_label: item.role_label,
        instruction: item.instruction ? `${request.instruction}\n\nDelegation focus:\n${item.instruction}` : request.instruction,
        expected_output: item.expected_output ?? request.expected_output ?? "Submit a concise artifact that can stand alone in the collaboration session.",
        status: "pending",
        source_refs: sourceRefs,
      };
      delegationIds.push(delegation.id);
      appendEvent(record, { type: "delegation_created", delegation }, at);
    });

    if (delegationIds.length === 0) {
      return { taskId: task.id, delegationIds };
    }

    const barrier: ReplyBarrier = {
      id: `barrier_direct_${slug(record.id)}_${Object.keys(record.state.barriers).length + 1}`,
      session_id: record.id,
      task_id: task.id,
      source_ref: sourceRefs[0] ?? { kind: "external", uri: record.uri, label: "direct delegation" },
      owner,
      expected_from: request.delegations.map((item) => item.assignee),
      notify: options.coordinator_uri ? [options.coordinator_uri] : [],
      mode: "all",
      synthesis_requested: request.synthesis_requested,
      synthesis_reason: request.synthesis_requested ? request.synthesis_reason ?? "explicit direct delegation request" : undefined,
      status: "open",
      replies: {},
      created_at: at,
    };
    appendEvent(record, { type: "barrier_created", barrier }, at);

    return { taskId: task.id, delegationIds, barrierId: barrier.id };
  }

  function ensureDirectTask(
    record: SessionRecord,
    request: SessionManagerStartDelegationsRequest,
    owner: EndpointUri,
    sourceRefs: SourceRef[],
    at: string,
  ): Task {
    if (request.task_id) {
      const existing = record.state.tasks[request.task_id];
      if (!existing) {
        throw new Error(`task not found: ${request.task_id}`);
      }
      if (existing.status !== "open") {
        appendEvent(record, {
          type: "task_updated",
          session_id: record.id,
          task_id: existing.id,
          patch: { status: "open", updated_at: at },
        }, at);
        return record.state.tasks[existing.id] ?? existing;
      }
      return existing;
    }

    const task: Task = {
      id: `task_direct_${slug(record.id)}_${Object.keys(record.state.tasks).length + 1}`,
      session_id: record.id,
      title: taskTitle(request.task_title ?? request.instruction),
      owner,
      status: "open",
      source_refs: sourceRefs,
    };
    appendEvent(record, { type: "task_created", task }, at);
    return task;
  }

  function supersedeArtifact(record: SessionRecord, artifactId: string, at = new Date().toISOString()): void {
    const artifact = record.state.artifacts[artifactId];
    if (!artifact || artifact.status === "superseded") {
      return;
    }
    appendEvent(record, {
      type: "artifact_updated",
      session_id: record.id,
      artifact_id: artifactId,
      patch: { status: "superseded" },
    }, at);
  }

  function synthesisRequestForMessage(message: SlockMessage): Pick<ReplyBarrier, "synthesis_requested" | "synthesis_reason"> {
    return messageRequestsSynthesis(message.text)
      ? { synthesis_requested: true, synthesis_reason: "explicit human request" }
      : {};
  }

  function synthesisRequestForAmendment(
    record: SessionRecord,
    message: SlockMessage,
    taskId: string | undefined,
  ): Pick<ReplyBarrier, "synthesis_requested" | "synthesis_reason"> {
    if (messageRequestsSynthesis(message.text)) {
      return { synthesis_requested: true, synthesis_reason: "explicit human request" };
    }
    if (taskId && taskHasSynthesis(record, taskId)) {
      return { synthesis_requested: true, synthesis_reason: "existing synthesis requires revision" };
    }
    return {};
  }

  function taskHasSynthesis(record: SessionRecord, taskId: string): boolean {
    const hasRequestedBarrier = Object.values(record.state.barriers).some((barrier) => {
      return barrier.task_id === taskId && barrier.synthesis_requested;
    });
    if (hasRequestedBarrier) {
      return true;
    }

    return Object.values(record.state.artifacts).some((artifact) => {
      return artifact.author === options.coordinator_uri && artifact.relates_to?.includes(taskId);
    });
  }

  return {
    routeHumanMentions,
    createQuestionDelegation,
    createDirectDelegations,
  };
}

function delegationPlanForAgent(
  message: SlockMessage,
  agent: EndpointUri,
  delegationPlan: SessionManagerDelegationPlanItem[],
): SessionManagerDelegationPlanItem | undefined {
  const explicit = delegationPlan.find((item) => item.assignee === agent);
  if (explicit) {
    return explicit;
  }

  const roleLabel = inferRoleLabel(message.text, agent);
  return roleLabel ? { assignee: agent, role: roleIdFromLabel(roleLabel), role_label: roleLabel } : undefined;
}

function inferRoleLabel(text: string, agent: EndpointUri): string | undefined {
  const label = escapeRegExp(labelFromAgent(agent));
  const patterns = [
    new RegExp(`@?${label}\\s*(?:负责(?:看|检查|研究)?|看|检查|研究)\\s*([^，,。；;\\n]+)`, "i"),
    new RegExp(`@?${label}\\s*(?:is\\s+)?(?:responsible\\s+for|owns|focus(?:es)?\\s+on|reviews?)\\s+([^.,;\\n]+)`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const role = match?.[1]?.replace(/^[:：\s]+/, "").trim();
    if (role) {
      return role.length > 80 ? `${role.slice(0, 77)}...` : role;
    }
  }
  return undefined;
}

function labelFromAgent(agent: EndpointUri): string {
  const parts = agent.split("/").filter(Boolean);
  return decodeURIComponent(parts.at(-1) ?? agent);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function roleIdFromLabel(value: string): string | undefined {
  const role = value.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return role || undefined;
}

export function latestDelegationForAssignee(record: SessionRecord, assignee: EndpointUri): Delegation | undefined {
  return Object.values(record.state.delegations)
    .filter((delegation) => delegation.assignee === assignee && delegation.status !== "cancelled" && delegation.status !== "failed")
    .at(-1);
}
