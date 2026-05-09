import type { EndpointUri } from "../../protocol/src/index.ts";
import type { IpcNode } from "../../sdk/src/index.ts";
import type { Artifact, CollaborationEvent, CollaborationNote, SourceRef } from "../../collaboration-context/src/index.ts";
import {
  SLOCK_PROJECTION_MIME,
  type SlockAgentRunEvent,
  type SlockProjectionInput,
} from "../../slock-channel/src/index.ts";
import { labelFromUri, originMessageRef } from "./helpers.ts";
import type { SessionRecord } from "./types.ts";

type AppendEvent = (
  record: SessionRecord,
  event: Omit<CollaborationEvent, "id" | "at">,
  at?: string,
) => CollaborationEvent;

export function createSessionPublisher(node: IpcNode, appendEvent: AppendEvent) {
  async function projectArtifact(
    record: SessionRecord,
    artifact: Artifact,
    sourceEventId: string,
    sourceRef: SourceRef | undefined,
    presentation: SlockProjectionInput["presentation"] = "artifact",
  ): Promise<{ id: string } | undefined> {
    const channelSource = sourceRef?.kind === "channel_message" ? sourceRef : originMessageRef(record.state);
    if (!channelSource) {
      return undefined;
    }
    const text = artifactProjectionText(artifact, presentation);
    if (!text.trim()) {
      return undefined;
    }

    try {
      const result = await node.call<SlockProjectionInput, { id: string }>(
        channelSource.channel,
        "publish_projection",
        {
          mime_type: SLOCK_PROJECTION_MIME,
          data: {
            sender: presentation === "final_report" ? record.uri : artifact.author,
            text,
            thread_id: channelSource.message_id,
            reply_to_id: channelSource.message_id,
            kind: presentation === "final_report" ? "system" : artifact.author.startsWith("agent://") ? "agent" : "system",
            source_event_id: sourceEventId,
            title: artifact.title,
            presentation,
            author: artifact.author,
            session_id: record.id,
            artifact_id: artifact.id,
          },
        },
        { ttl_ms: 5000, timeout_ms: 5000 },
      );
      appendEvent(record, { type: "projection_emitted", session_id: record.id, target: channelSource.channel, source_event_id: sourceEventId });
      return result.data;
    } catch {
      return undefined;
    }
  }

  async function projectNote(record: SessionRecord, note: CollaborationNote, sourceEventId: string): Promise<{ id: string } | undefined> {
    const channelSource = originMessageRef(record.state);
    if (!channelSource || !note.text.trim()) {
      return undefined;
    }

    try {
      const result = await node.call<SlockProjectionInput, { id: string }>(
        channelSource.channel,
        "publish_projection",
        {
          mime_type: SLOCK_PROJECTION_MIME,
          data: {
            sender: note.from,
            text: note.text,
            thread_id: channelSource.message_id,
            reply_to_id: channelSource.message_id,
            kind: note.from.startsWith("agent://") ? "agent" : "system",
            source_event_id: sourceEventId,
            title: `Report from ${labelFromUri(note.from)}`,
            presentation: "message",
            author: note.from,
          },
        },
        { ttl_ms: 5000, timeout_ms: 5000 },
      );
      appendEvent(record, { type: "projection_emitted", session_id: record.id, target: channelSource.channel, source_event_id: sourceEventId });
      return result.data;
    } catch {
      return undefined;
    }
  }

  async function publishAgentRun(channel: EndpointUri, action: "publish_agent_run_started" | "publish_agent_run_finished", run: SlockAgentRunEvent): Promise<void> {
    try {
      await node.call(channel, action, { mime_type: "application/json", data: run }, { ttl_ms: 5000, timeout_ms: 5000 });
    } catch {
      // Channel projection is best effort; collaboration state remains the source of truth.
    }
  }

  async function publishAgentCancelled(channel: EndpointUri, cancelled: { message_id: string; agent: EndpointUri; reason?: string }): Promise<void> {
    try {
      await node.call(channel, "publish_agent_cancelled", { mime_type: "application/json", data: cancelled }, { ttl_ms: 5000, timeout_ms: 5000 });
    } catch {
      // Best effort UI projection.
    }
  }

  async function publishAgentError(channel: EndpointUri, error: { code: string; message: string; source: EndpointUri }): Promise<void> {
    try {
      await node.call(channel, "publish_agent_error", { mime_type: "application/json", data: error }, { ttl_ms: 5000, timeout_ms: 5000 });
    } catch {
      // Best effort UI projection.
    }
  }

  return {
    projectArtifact,
    projectNote,
    publishAgentRun,
    publishAgentCancelled,
    publishAgentError,
  };
}

function artifactProjectionText(_artifact: Artifact, presentation: SlockProjectionInput["presentation"]): string {
  if (presentation === "final_report") {
    return "Final synthesis ready.";
  }
  return "Artifact ready.";
}
