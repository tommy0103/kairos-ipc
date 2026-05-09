import type { EndpointUri } from "../../protocol/src/index.ts";
import {
  barrierIsSatisfied,
  type Artifact,
  type CollaborationEvent,
  type ReplyBarrier,
} from "../../collaboration-context/src/index.ts";
import type { SessionRecord } from "./types.ts";

type AppendEvent = (
  record: SessionRecord,
  event: Omit<CollaborationEvent, "id" | "at">,
  at?: string,
) => CollaborationEvent;

interface BarrierControllerOptions {
  sessions: Map<string, SessionRecord>;
  appendEvent: AppendEvent;
  coordinator_uri?: EndpointUri;
  runSynthesis: (sessionId: string, barrierId: string, coordinatorUri: EndpointUri) => Promise<void>;
}

export function createBarrierController(options: BarrierControllerOptions) {
  const { appendEvent, sessions } = options;

  function updateBarriersForArtifact(record: SessionRecord, artifact: Artifact, delegationId: string | undefined, at = new Date().toISOString()): void {
    const delegation = delegationId ? record.state.delegations[delegationId] : undefined;
    const assignee = delegation?.assignee ?? artifact.author;
    const barriers = Object.values(record.state.barriers).filter((barrier) => {
      if (barrier.status !== "open") return false;
      if (!barrier.expected_from.includes(assignee)) return false;
      return !delegation || barrier.task_id === delegation.task_id;
    });

    for (const barrier of barriers) {
      appendEvent(record, {
        type: "barrier_updated",
        session_id: record.id,
        barrier_id: barrier.id,
        patch: {
          replies: { ...barrier.replies, [assignee]: artifact.id },
          updated_at: at,
        },
      }, at);
      const updated = record.state.barriers[barrier.id];
      if (updated && barrierIsSatisfied(updated)) {
        appendEvent(record, { type: "barrier_satisfied", session_id: record.id, barrier_id: barrier.id }, at);
        void notifyBarrierSatisfied(record.id, updated.id);
      }
    }
  }

  async function notifyBarrierSatisfied(sessionId: string, barrierId: string): Promise<void> {
    const record = sessions.get(sessionId);
    const barrier = record?.state.barriers[barrierId];
    if (!record || !barrier || barrier.status !== "satisfied") {
      return;
    }

    let synthesisStarted = false;
    for (const target of barrier.notify) {
      if (target === options.coordinator_uri && !barrier.expected_from.includes(target) && shouldRunSynthesisForBarrier(record, barrier)) {
        synthesisStarted = true;
        await options.runSynthesis(record.id, barrier.id, target);
      }
    }

    if (!synthesisStarted && barrier.task_id) {
      completeTaskIfReady(record, barrier.task_id);
    }
  }

  function shouldRunSynthesisForBarrier(record: SessionRecord, barrier: ReplyBarrier): boolean {
    if (!options.coordinator_uri) {
      return false;
    }
    if (barrier.synthesis_requested) {
      return true;
    }
    return hasStructuredCollaborationForBarrier(record, barrier);
  }

  function hasStructuredCollaborationForBarrier(record: SessionRecord, barrier: ReplyBarrier): boolean {
    const participants = new Set(barrier.expected_from);
    if (options.coordinator_uri) {
      participants.delete(options.coordinator_uri);
    }
    if (participants.size < 2) {
      return false;
    }

    const hasAgentQuestion = Object.values(record.state.questions).some((question) => {
      return participants.has(question.from) || participants.has(question.to);
    });
    return hasAgentQuestion || record.state.decisions.length > 0;
  }

  function completeTaskIfReady(record: SessionRecord, taskId: string): void {
    const task = record.state.tasks[taskId];
    if (!task || task.status === "completed" || task.status === "cancelled") {
      return;
    }

    const hasOpenBarrier = Object.values(record.state.barriers).some((barrier) => {
      return barrier.task_id === taskId && barrier.status === "open";
    });
    if (hasOpenBarrier) {
      return;
    }

    const hasOpenDelegation = Object.values(record.state.delegations).some((delegation) => {
      return delegation.task_id === taskId && (delegation.status === "pending" || delegation.status === "running");
    });
    if (hasOpenDelegation) {
      return;
    }

    appendEvent(record, {
      type: "task_updated",
      session_id: record.id,
      task_id: taskId,
      patch: { status: "completed" },
    });
  }

  return {
    updateBarriersForArtifact,
    notifyBarrierSatisfied,
    completeTaskIfReady,
  };
}
