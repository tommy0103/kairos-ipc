import type { SourceRef } from "../../collaboration-context/src/index.ts";
import type { DifySourceMetadata } from "./types.ts";

export function sourceRefFromDifyMetadata(source: DifySourceMetadata | undefined, fallbackLabel: string): Extract<SourceRef, { kind: "external" }> {
  return {
    kind: "external",
    uri: sourceUri(source, fallbackLabel),
    label: fallbackLabel,
  };
}

function sourceUri(source: DifySourceMetadata | undefined, fallbackLabel: string): string {
  const appId = clean(source?.app_id);
  const conversationId = clean(source?.conversation_id);
  const messageId = clean(source?.message_id);
  const workflowRunId = clean(source?.workflow_run_id);
  const userId = clean(source?.user_id);

  if (appId || conversationId || messageId) {
    const parts: string[] = [];
    if (appId) parts.push("app", encodePart(appId));
    if (conversationId) parts.push("conversation", encodePart(conversationId));
    if (messageId) parts.push("message", encodePart(messageId));
    if (!conversationId && !messageId && workflowRunId) parts.push("workflow-run", encodePart(workflowRunId));
    if (!conversationId && !messageId && !workflowRunId && userId) parts.push("user", encodePart(userId));
    return `dify://${parts.join("/")}`;
  }

  if (workflowRunId) {
    return `dify://workflow-run/${encodePart(workflowRunId)}`;
  }

  if (userId) {
    return `dify://user/${encodePart(userId)}`;
  }

  return `dify://source/${encodePart(fallbackLabel || "unknown")}`;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function encodePart(value: string): string {
  return encodeURIComponent(value);
}
