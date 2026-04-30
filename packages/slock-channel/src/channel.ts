import { createCorrelationId, type EndpointUri, type EnvelopePayload } from "../../protocol/src/index.ts";
import { createNode, IpcCallError, type IpcNode } from "../../sdk/src/index.ts";
import { inferMentions, type MentionAliases } from "./mentions.ts";
import {
  SLOCK_AGENT_RESULT_MIME,
  SLOCK_AGENT_RUN_MIME,
  SLOCK_CHANNEL_EVENT_MIME,
  SLOCK_MESSAGE_DELTA_MIME,
  SLOCK_MESSAGE_MIME,
  type SlockAgentResult,
  type SlockAgentRun,
  type SlockApprovalEvent,
  type SlockApprovalResult,
  type SlockCancelAgentRunRequest,
  type SlockCancelAgentRunResult,
  type SlockChannelEvent,
  type SlockHistoryRequest,
  type SlockHistoryResult,
  type SlockMessage,
  type SlockMessageInput,
  type SlockMessageUpdateInput,
  type SlockSubscriptionClosedInput,
  type SlockTypingStartedInput,
} from "./types.ts";

export interface SlockChannelOptions {
  uri: EndpointUri;
  mention_aliases?: MentionAliases;
  history_limit?: number;
  default_agent_ttl_ms?: number;
}

export interface SlockChannelEndpoint {
  node: IpcNode;
  messages: SlockMessage[];
  subscribers: Set<EndpointUri>;
}

export function createSlockChannel(options: SlockChannelOptions): SlockChannelEndpoint {
  const node = createNode(options.uri);
  const messages: SlockMessage[] = [];
  const subscribers = new Set<EndpointUri>();
  const subscriptionCorrelations = new Map<EndpointUri, string | undefined>();
  const activeRuns = new Map<string, Map<EndpointUri, { correlation_id: string; cancel_requested?: boolean; reason?: string }>>();
  const mentionAliases = options.mention_aliases ?? {};
  const historyLimit = options.history_limit ?? 100;
  const agentTtlMs = options.default_agent_ttl_ms ?? 600000;
  let nextMessageId = 1;

  node.action(
    "subscribe",
    {
      description: "Subscribe to channel events.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (_payload, context) => {
      const subscriber = context.envelope.header.reply_to ?? context.envelope.header.source;
      subscribers.add(subscriber);
      subscriptionCorrelations.set(subscriber, context.envelope.header.correlation_id);
      return { mime_type: "application/json", data: { subscribed: true, channel: options.uri } };
    },
  );

  node.action<SlockHistoryRequest, SlockHistoryResult>(
    "history",
    {
      description: "Return recent channel messages.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = readHistoryRequest(payload.data, 50);
      return { mime_type: "application/json", data: { messages: selectHistory(request) } };
    },
  );

  node.action<SlockMessageInput>(
    "post_message",
    {
      description: "Append a message and trigger mention routing.",
      accepts: SLOCK_MESSAGE_MIME,
      returns: SLOCK_MESSAGE_MIME,
    },
    async (payload, context) => {
      const input = payload.data;
      const threadId = input.thread_id ?? null;
      const inferredMentions = inferMentions(input.text, input.mentions, mentionAliases);
      const mentions = inferredMentions.length > 0 ? inferredMentions : inferThreadMentions(threadId);
      const message = appendMessage({
        sender: context.envelope.header.source,
        text: input.text,
        mentions,
        thread_id: threadId,
        reply_to_id: input.reply_to_id ?? threadId,
        kind: context.envelope.header.source.startsWith("agent://") ? "agent" : "human",
      });

      broadcast("message_created", { message });

      for (const agentUri of message.mentions) {
        void runMentionedAgent(agentUri, message);
      }

      return { mime_type: SLOCK_MESSAGE_MIME, data: message };
    },
  );

  node.action<SlockMessageUpdateInput>(
    "update_message",
    {
      description: "Update a channel message and broadcast message_updated.",
      accepts: "application/json",
      returns: SLOCK_MESSAGE_MIME,
    },
    async (payload) => {
      const request = readMessageUpdate(payload.data);
      const message = messages.find((message) => message.id === request.message_id);
      if (!message) {
        throw new Error(`message not found: ${request.message_id}`);
      }

      message.text = request.text;
      message.updated_at = new Date().toISOString();
      broadcast("message_updated", { message });
      return { mime_type: SLOCK_MESSAGE_MIME, data: message };
    },
  );

  node.action<SlockTypingStartedInput>(
    "typing_started",
    {
      description: "Broadcast that an endpoint started typing in this channel.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload, context) => {
      const request = readTypingStarted(payload.data);
      broadcast("typing_started", {
        typing: {
          source: context.envelope.header.source,
          thread_id: request.thread_id ?? null,
        },
      });
      return { mime_type: "application/json", data: { typing: true, channel: options.uri } };
    },
  );

  node.action<SlockSubscriptionClosedInput>(
    "unsubscribe",
    {
      description: "Close a channel subscription and send subscription_closed as a terminal event.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload, context) => {
      const request = readSubscriptionClosed(payload.data);
      const subscriber = request.subscriber ?? context.envelope.header.reply_to ?? context.envelope.header.source;
      sendSubscriptionClosed(subscriber, request.reason);
      subscribers.delete(subscriber);
      subscriptionCorrelations.delete(subscriber);
      return { mime_type: "application/json", data: { unsubscribed: true, channel: options.uri, subscriber } };
    },
  );

  node.action<SlockApprovalEvent>(
    "publish_approval_requested",
    {
      description: "Broadcast a pending human approval request into the channel event stream.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const approval = readApprovalEvent(payload.data);
      broadcast("approval_requested", { approval });
      return { mime_type: "application/json", data: { published: true, id: approval.id } };
    },
  );

  node.action<{ id: string; result: SlockApprovalResult }>(
    "publish_approval_resolved",
    {
      description: "Broadcast a human approval resolution into the channel event stream.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const resolution = readApprovalResolution(payload.data);
      broadcast("approval_resolved", { id: resolution.id, result: resolution.result });
      return { mime_type: "application/json", data: { published: true, id: resolution.id } };
    },
  );

  node.action<SlockCancelAgentRunRequest, SlockCancelAgentRunResult>(
    "cancel_agent_run",
    {
      description: "Cancel the active agent stream started by a channel message.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = readCancelAgentRunRequest(payload.data);
      const runs = activeRuns.get(request.message_id);
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
      for (const [agentUri, run] of runs) {
        run.cancel_requested = true;
        run.reason = reason;
        node.cancel(agentUri, {
          mime_type: "application/json",
          data: { message_id: request.message_id, reason },
        }, { correlation_id: run.correlation_id });
        broadcast("agent_cancelled", {
          cancelled: {
            message_id: request.message_id,
            agent: agentUri,
            reason,
          },
        });
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

  node.onEmit("message_delta", async (payload, context) => {
    if (payload.mime_type !== SLOCK_MESSAGE_DELTA_MIME || !isRecord(payload.data)) {
      return;
    }

    broadcast("message_delta", {
      delta: {
        thread_id: String(payload.data.thread_id ?? ""),
        text: String(payload.data.text ?? ""),
        source: context.envelope.header.source,
        kind: payload.data.kind === "status" ? "status" : "text",
        ...(isRecord(payload.data.metadata) ? { metadata: payload.data.metadata } : {}),
      },
    });
  });

  return { node, messages, subscribers };

  function appendMessage(input: {
    sender: EndpointUri;
    text: string;
    mentions?: EndpointUri[];
    thread_id?: string | null;
    reply_to_id?: string | null;
    kind: SlockMessage["kind"];
  }): SlockMessage {
    const message: SlockMessage = {
      id: `channel_msg_${nextMessageId++}`,
      channel: options.uri,
      sender: input.sender,
      text: input.text,
      mentions: input.mentions ?? [],
      thread_id: input.thread_id ?? null,
      reply_to_id: input.reply_to_id ?? null,
      kind: input.kind,
      created_at: new Date().toISOString(),
    };

    messages.push(message);
    while (messages.length > historyLimit) {
      messages.shift();
    }
    return message;
  }

  function inferThreadMentions(threadId: string | null): EndpointUri[] {
    if (!threadId) {
      return [];
    }

    const mentions = new Set<EndpointUri>();
    for (const message of messages) {
      if (message.id !== threadId && message.thread_id !== threadId) {
        continue;
      }

      for (const mention of message.mentions) {
        if (mention.startsWith("agent://")) {
          mentions.add(mention);
        }
      }

      if (message.kind === "agent" && message.sender.startsWith("agent://")) {
        mentions.add(message.sender);
      }
    }

    return [...mentions];
  }

  function broadcast(type: SlockChannelEvent["type"], event: Omit<SlockChannelEvent, "type" | "channel">): void {
    const payload: EnvelopePayload<SlockChannelEvent> = {
      mime_type: SLOCK_CHANNEL_EVENT_MIME,
      data: { type, channel: options.uri, ...event },
    };

    for (const subscriber of subscribers) {
      try {
        node.emit(subscriber, type, payload, { correlation_id: subscriptionCorrelations.get(subscriber) });
      } catch {
        // Late async agent/tool completions can arrive while the channel endpoint is closing.
      }
    }
  }

  function sendSubscriptionClosed(subscriber: EndpointUri, reason?: string): void {
    const payload: EnvelopePayload<SlockChannelEvent> = {
      mime_type: SLOCK_CHANNEL_EVENT_MIME,
      data: {
        type: "subscription_closed",
        channel: options.uri,
        subscription: { subscriber, reason },
      },
    };

    try {
      node.end(subscriber, "subscription_closed", payload, { correlation_id: subscriptionCorrelations.get(subscriber) });
    } catch {
      // The subscriber may already be gone by the time an unsubscribe is processed.
    }
  }

  async function runMentionedAgent(agentUri: EndpointUri, message: SlockMessage): Promise<void> {
    const correlationId = createCorrelationId("conv");
    const runs = activeRuns.get(message.id) ?? new Map<EndpointUri, { correlation_id: string; cancel_requested?: boolean; reason?: string }>();
    activeRuns.set(message.id, runs);
    runs.set(agentUri, { correlation_id: correlationId });
    try {
      const result = await node.call<SlockAgentRun, SlockAgentResult>(
        agentUri,
        "run",
        {
          mime_type: SLOCK_AGENT_RUN_MIME,
          data: {
            channel: options.uri,
            message_id: message.id,
            thread_id: message.thread_id,
            text: stripMentions(message.text),
            sender: message.sender,
          },
        },
        { correlation_id: correlationId, ttl_ms: agentTtlMs, timeout_ms: agentTtlMs },
      );

      const final = result.data;
      const activeRun = activeRuns.get(message.id)?.get(agentUri);
      if (final.cancelled || activeRun?.cancel_requested) {
        if (!activeRun?.cancel_requested) {
          broadcast("agent_cancelled", {
            cancelled: {
              message_id: message.id,
              agent: agentUri,
              reason: final.reason,
            },
          });
        }
        return;
      }

      const finalMessage = appendMessage({
        sender: agentUri,
        text: final.final_text ?? final.summary,
        thread_id: message.thread_id ?? message.id,
        reply_to_id: message.id,
        kind: "agent",
      });
      final.final_message_id = finalMessage.id;
      broadcast("message_created", { message: finalMessage });
    } catch (error) {
      const code = error instanceof IpcCallError ? error.code : "AGENT_RUN_FAILED";
      const messageText = error instanceof Error ? error.message : "agent run failed";
      broadcast("agent_error", { error: { code, message: messageText, source: agentUri } });
    } finally {
      const runs = activeRuns.get(message.id);
      runs?.delete(agentUri);
      if (runs?.size === 0) {
        activeRuns.delete(message.id);
      }
    }
  }

  function selectHistory(request: Required<Pick<SlockHistoryRequest, "limit">> & Omit<SlockHistoryRequest, "limit">): SlockMessage[] {
    let selected = messages;
    if (request.until_id) {
      const index = selected.findIndex((message) => message.id === request.until_id);
      selected = index >= 0 ? selected.slice(0, index + 1) : selected;
    }

    if (request.thread_id) {
      selected = selected.filter((message) => message.id === request.thread_id || message.thread_id === request.thread_id);
    }

    return selected.slice(-request.limit);
  }
}

function readCancelAgentRunRequest(value: unknown): SlockCancelAgentRunRequest {
  if (!isRecord(value) || typeof value.message_id !== "string" || value.message_id.trim().length === 0) {
    throw new Error("cancel_agent_run requires message_id");
  }
  return {
    message_id: value.message_id,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

function readMessageUpdate(value: unknown): SlockMessageUpdateInput {
  if (!isRecord(value) || typeof value.message_id !== "string" || value.message_id.trim().length === 0) {
    throw new Error("update_message requires message_id");
  }
  if (typeof value.text !== "string") {
    throw new Error("update_message requires text");
  }
  return { message_id: value.message_id, text: value.text };
}

function readTypingStarted(value: unknown): SlockTypingStartedInput {
  if (!isRecord(value)) {
    return {};
  }
  return { thread_id: typeof value.thread_id === "string" ? value.thread_id : value.thread_id === null ? null : undefined };
}

function readSubscriptionClosed(value: unknown): SlockSubscriptionClosedInput {
  if (!isRecord(value)) {
    return {};
  }
  return {
    subscriber: typeof value.subscriber === "string" ? value.subscriber : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

function readApprovalEvent(value: unknown): SlockApprovalEvent {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.request) || typeof value.source !== "string") {
    throw new Error("publish_approval_requested requires id, request, and source");
  }
  return {
    id: value.id,
    request: value.request as SlockApprovalEvent["request"],
    source: value.source,
    created_at: typeof value.created_at === "string" ? value.created_at : new Date().toISOString(),
  };
}

function readApprovalResolution(value: unknown): { id: string; result: SlockApprovalResult } {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.result)) {
    throw new Error("publish_approval_resolved requires id and result");
  }
  return { id: value.id, result: value.result as SlockApprovalResult };
}

function readHistoryRequest(
  value: unknown,
  fallbackLimit: number,
): Required<Pick<SlockHistoryRequest, "limit">> & Omit<SlockHistoryRequest, "limit"> {
  if (!isRecord(value)) {
    return { limit: fallbackLimit };
  }

  return {
    limit: readLimit(value.limit, fallbackLimit),
    until_id: typeof value.until_id === "string" ? value.until_id : undefined,
    thread_id: typeof value.thread_id === "string" ? value.thread_id : value.thread_id === null ? null : undefined,
  };
}

function readLimit(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(500, Math.trunc(value)));
  }
  return fallback;
}

function stripMentions(text: string): string {
  return text.replace(/(^|\s)@\S+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
