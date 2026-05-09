import type { EndpointUri } from "../../protocol/src/index.ts";
import { sourceRefKey, type Artifact, type CollaborationQuestion, type CollaborationState, type ContextCompaction, type RenderedAgentContext, type ReplyBarrier, type SourceRef } from "../../collaboration-context/src/index.ts";
import type { SlockMessage } from "../../slock-channel/src/index.ts";
import type { SessionRecord } from "./types.ts";

export function questionMessageForQuestion(record: SessionRecord, question: CollaborationQuestion): SlockMessage {
  const origin = originMessageRef(record.state);
  return {
    id: origin?.message_id ?? question.id,
    channel: origin?.channel ?? "app://kairos/session-manager",
    sender: question.from,
    text: question.question,
    mentions: [question.to],
    thread_id: origin?.message_id ?? null,
    reply_to_id: origin?.message_id ?? null,
    kind: question.from.startsWith("agent://") ? "agent" : question.from.startsWith("human://") ? "human" : "system",
    created_at: new Date().toISOString(),
  };
}

export function synthesisMessageForBarrier(barrier: ReplyBarrier, coordinatorUri: EndpointUri): SlockMessage {
  if (barrier.source_ref.kind === "channel_message") {
    return {
      id: barrier.source_ref.message_id,
      channel: barrier.source_ref.channel,
      sender: barrier.owner,
      text: "Synthesize completed collaboration artifacts.",
      mentions: [coordinatorUri],
      thread_id: null,
      reply_to_id: null,
      kind: "human",
      created_at: barrier.created_at,
    };
  }

  return {
    id: barrier.id,
    channel: "app://kairos/session-manager",
    sender: barrier.owner,
    text: "Synthesize completed collaboration artifacts.",
    mentions: [coordinatorUri],
    thread_id: null,
    reply_to_id: null,
    kind: "system",
    created_at: barrier.created_at,
  };
}

export function mergeCompactionsIntoContext(
  context: RenderedAgentContext,
  compactions: ContextCompaction[],
): RenderedAgentContext {
  const compactionText = renderCompactionText(compactions);
  if (!compactionText) {
    return context;
  }

  return {
    ...context,
    text: insertContextSectionsBeforeOutputContract(context.text, [
      [
        "Render-time context compactions (derived cache, not source of truth):",
        compactionText,
      ].join("\n\n"),
    ]),
    source_refs: uniqueSourceRefsForSession([
      ...context.source_refs,
      ...compactions.flatMap((compaction) => compaction.covers_refs),
    ]),
    artifact_refs: uniqueStrings([
      ...context.artifact_refs,
      ...compactions.flatMap((compaction) => compaction.structured_digest?.artifact_refs ?? []),
    ]),
    barrier_refs: uniqueStrings([
      ...context.barrier_refs,
      ...compactions.flatMap((compaction) => compaction.structured_digest?.barrier_refs ?? []),
    ]),
  };
}

export function insertContextSectionsBeforeOutputContract(text: string, sections: Array<string | undefined>): string {
  const material = sections.filter((section): section is string => Boolean(section?.trim())).join("\n\n");
  if (!material) {
    return text;
  }

  const marker = "\n\nOutput contract:\n";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) {
    return [text, material].join("\n\n");
  }

  return [text.slice(0, markerIndex), material, text.slice(markerIndex + 2)].join("\n\n");
}

export function uniqueSourceRefsForSession(sourceRefs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const unique: SourceRef[] = [];
  for (const sourceRef of sourceRefs) {
    const key = sourceRefKey(sourceRef);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(sourceRef);
  }
  return unique;
}

export function messageSourceRef(message: SlockMessage): SourceRef {
  return { kind: "channel_message", channel: message.channel, message_id: message.id };
}

export function explicitSessionSourceRef(source: EndpointUri, title: string | undefined): SourceRef {
  return {
    kind: "external",
    uri: source,
    label: title?.trim() || "explicit session",
  };
}

export function sourceRefLabel(sourceRef: SourceRef): string {
  switch (sourceRef.kind) {
    case "channel_message":
      return `${sourceRef.channel}_${sourceRef.message_id}`;
    case "artifact":
      return sourceRef.artifact_id;
    case "ipc_envelope":
      return sourceRef.correlation_id ?? sourceRef.msg_id ?? sourceRef.trace_id ?? "ipc_envelope";
    case "file":
      return sourceRef.uri;
    case "external":
      return sourceRef.label ?? sourceRef.uri;
  }
}

export function originMessageRef(state: CollaborationState): Extract<SourceRef, { kind: "channel_message" }> | undefined {
  const origin = state.session?.origin;
  return origin?.kind === "channel_message" ? origin : undefined;
}

export function sessionUri(sessionId: string): EndpointUri {
  return `app://kairos/session/${encodeURIComponent(sessionId)}`;
}

export function sessionIdForMessage(message: SlockMessage): string {
  return `session_${slug(`${message.channel}_${message.id}`)}`;
}

export function idPrefix(prefix: string, message: SlockMessage): string {
  return `${prefix}_${slug(`${message.channel}_${message.id}`)}`;
}

export function threadKey(channel: EndpointUri, threadId: string): string {
  return `${channel}:${threadId}`;
}

export function uniqueAgentUris(uris: EndpointUri[]): EndpointUri[] {
  return [...new Set(uris.filter((uri) => uri.startsWith("agent://")))];
}

export function uniqueEndpointUris(values: unknown[]): EndpointUri[] {
  return [...new Set(values.filter((value): value is EndpointUri => typeof value === "string" && value.trim().length > 0))];
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function taskTitle(text: string): string {
  const stripped = stripMentions(text).replace(/\s+/g, " ").trim();
  if (!stripped) return "Agent collaboration task";
  return stripped.length > 72 ? `${stripped.slice(0, 69)}...` : stripped;
}

export function delegationInstruction(message: SlockMessage, agent: EndpointUri, roleLabel?: string): string {
  const request = stripMentions(message.text) || message.text;
  const lines = [
    `You are responsible for the part of this collaboration assigned to ${agent}.`,
    roleLabel ? `Role: ${roleLabel}.` : undefined,
    "Use the session context as the source of truth. Return a self-contained artifact for your delegation.",
    "",
    `Human request:\n${request}`,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export function artifactText(artifact: Artifact): string {
  const content = artifact.content;
  if (typeof content === "string") return content;
  if (isRecord(content)) {
    if (typeof content.final_text === "string") return content.final_text;
    if (typeof content.text === "string") return content.text;
    if (typeof content.summary === "string") return content.summary;
  }
  try {
    return JSON.stringify(content, null, 2) ?? "";
  } catch {
    return String(content);
  }
}

export function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

export function stripMentions(text: string): string {
  return text.replace(/(^|\s)@\S+/g, " ").trim();
}

export function messageRequestsSynthesis(text: string): boolean {
  const request = stripMentions(text).toLowerCase();
  return /\b(final|synthesis|synthesize|synthesise|summary|summarize|summarise|report|conclusion|recommendation)\b/.test(request)
    || /最后|最终|汇总|总结|综合|整合|结论|报告|建议/.test(request);
}

export function labelFromUri(uri: EndpointUri): string {
  const parts = uri.split("/").filter(Boolean);
  return decodeURIComponent(parts.at(-1) ?? uri);
}

export function isDmChannel(uri: EndpointUri): boolean {
  return uri.startsWith("app://slock/dm/");
}

export function clipText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

export function indentText(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}

export function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "session";
}

function renderCompactionText(compactions: ContextCompaction[]): string | undefined {
  if (compactions.length === 0) {
    return undefined;
  }

  return compactions.map((compaction) => {
    const lines = [
      `- ${compaction.id} (${compaction.purpose}${compaction.audience ? ` for ${compaction.audience}` : ", shared"})`,
      indentText(clipText(compaction.summary_text, 2000)),
    ];

    const cursor = renderCompactionCursor(compaction);
    if (cursor) {
      lines.push(`  cursor: ${cursor}`);
    }

    const digest = renderCompactionDigest(compaction);
    if (digest) {
      lines.push(indentText(digest));
    }

    return lines.join("\n");
  }).join("\n");
}

function renderCompactionCursor(compaction: ContextCompaction): string | undefined {
  const parts = [
    compaction.cursor.before_event_id ? `before event ${compaction.cursor.before_event_id}` : undefined,
    typeof compaction.cursor.before_time_ms === "number" ? `before ${compaction.cursor.before_time_ms}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function renderCompactionDigest(compaction: ContextCompaction): string | undefined {
  const digest = compaction.structured_digest;
  if (!digest) {
    return undefined;
  }

  const lines: string[] = [];
  if (digest.claims?.length) {
    lines.push(`claims: ${clipText(formatUnknown(digest.claims), 1000)}`);
  }
  if (digest.decisions?.length) {
    lines.push(`decisions: ${clipText(formatUnknown(digest.decisions), 1000)}`);
  }
  if (digest.open_questions?.length) {
    lines.push(`open questions: ${clipText(formatUnknown(digest.open_questions), 1000)}`);
  }
  if (digest.artifact_refs?.length) {
    lines.push(`artifact refs: ${digest.artifact_refs.join(", ")}`);
  }
  if (digest.barrier_refs?.length) {
    lines.push(`barrier refs: ${digest.barrier_refs.join(", ")}`);
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
