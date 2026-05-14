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

const PROJECTION_PREVIEW_MAX_PARAGRAPHS = 4;
const PROJECTION_PREVIEW_MAX_PARAGRAPH_CHARS = 220;

function artifactProjectionText(artifact: Artifact, presentation: SlockProjectionInput["presentation"]): string {
  const preview = compactArtifactPreview(artifact);
  if (presentation === "final_report") {
    return preview ?? "Final synthesis ready.";
  }
  return preview ?? "Artifact ready.";
}

function compactArtifactPreview(artifact: Artifact): string | undefined {
  const raw = artifactContentSummary(artifact.content);
  if (!raw?.trim()) {
    return undefined;
  }

  const paragraphs = projectionParagraphs(raw)
    .slice(0, PROJECTION_PREVIEW_MAX_PARAGRAPHS)
    .map((paragraph) => clipProjectionParagraph(paragraph));

  return paragraphs.length > 0 ? paragraphs.join("\n\n") : undefined;
}

function artifactContentSummary(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!content || typeof content !== "object") {
    return undefined;
  }
  const record = content as Record<string, unknown>;
  return typeof record.summary === "string"
    ? record.summary
    : typeof record.text === "string"
      ? record.text
      : typeof record.final_text === "string"
        ? record.final_text
        : undefined;
}

function projectionParagraphs(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const blankLineBlocks = trimmed.split(/\r?\n\s*\r?\n/);
  const blocks = blankLineBlocks.length > 1 ? blankLineBlocks : trimmed.split(/\r?\n/);
  return blocks
    .map((block) => block.split(/\r?\n/).map(sanitizeProjectionLine).filter(Boolean).join(" ").trim())
    .filter((paragraph) => paragraph.length > 0);
}

function sanitizeProjectionLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function clipProjectionParagraph(paragraph: string): string {
  const chars = Array.from(paragraph);
  return chars.length <= PROJECTION_PREVIEW_MAX_PARAGRAPH_CHARS
    ? paragraph
    : `${chars.slice(0, PROJECTION_PREVIEW_MAX_PARAGRAPH_CHARS - 3).join("")}...`;
}
