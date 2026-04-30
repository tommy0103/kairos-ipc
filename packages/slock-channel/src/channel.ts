import { createCorrelationId, type EndpointUri, type EnvelopePayload } from "../../protocol/src/index.ts";
import { createNode, IpcCallError, type IpcNode } from "../../sdk/src/index.ts";
import {
  SLOCK_AGENT_RESULT_MIME,
  SLOCK_AGENT_RUN_MIME,
  SLOCK_CHANNEL_EVENT_MIME,
  SLOCK_MESSAGE_DELTA_MIME,
  SLOCK_MESSAGE_MIME,
  type SlockAgentResult,
  type SlockAgentRun,
  type SlockCancelAgentRunRequest,
  type SlockCancelAgentRunResult,
  type SlockChannelEvent,
  type SlockHistoryRequest,
  type SlockHistoryResult,
  type SlockMessage,
  type SlockMessageInput,
} from "./types.ts";

export interface SlockChannelOptions {
  uri: EndpointUri;
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
  const activeRuns = new Map<string, { agent_uri: EndpointUri; correlation_id: string; cancel_requested?: boolean; reason?: string }>();
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
      const message = appendMessage({
        sender: context.envelope.header.source,
        text: input.text,
        mentions: input.mentions ?? [],
        thread_id: input.thread_id ?? null,
        kind: context.envelope.header.source.startsWith("agent://") ? "agent" : "human",
      });

      broadcast("message_created", { message });

      for (const agentUri of message.mentions) {
        void runMentionedAgent(agentUri, message);
      }

      return { mime_type: SLOCK_MESSAGE_MIME, data: message };
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
      const run = activeRuns.get(request.message_id);
      if (!run) {
        return {
          mime_type: "application/json",
          data: {
            cancelled: false,
            message_id: request.message_id,
            reason: "agent run is not active",
          },
        };
      }

      run.cancel_requested = true;
      run.reason = request.reason ?? "cancelled";
      node.cancel(run.agent_uri, {
        mime_type: "application/json",
        data: { message_id: request.message_id, reason: run.reason },
      }, { correlation_id: run.correlation_id });
      broadcast("agent_cancelled", {
        cancelled: {
          message_id: request.message_id,
          agent: run.agent_uri,
          reason: run.reason,
        },
      });

      return {
        mime_type: "application/json",
        data: {
          cancelled: true,
          message_id: request.message_id,
          agent: run.agent_uri,
          reason: run.reason,
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
    kind: SlockMessage["kind"];
  }): SlockMessage {
    const message: SlockMessage = {
      id: `channel_msg_${nextMessageId++}`,
      channel: options.uri,
      sender: input.sender,
      text: input.text,
      mentions: input.mentions ?? [],
      thread_id: input.thread_id ?? null,
      kind: input.kind,
      created_at: new Date().toISOString(),
    };

    messages.push(message);
    while (messages.length > historyLimit) {
      messages.shift();
    }
    return message;
  }

  function broadcast(type: SlockChannelEvent["type"], event: Omit<SlockChannelEvent, "type" | "channel">): void {
    const payload: EnvelopePayload<SlockChannelEvent> = {
      mime_type: SLOCK_CHANNEL_EVENT_MIME,
      data: { type, channel: options.uri, ...event },
    };

    for (const subscriber of subscribers) {
      node.emit(subscriber, type, payload);
    }
  }

  async function runMentionedAgent(agentUri: EndpointUri, message: SlockMessage): Promise<void> {
    const correlationId = createCorrelationId("conv");
    activeRuns.set(message.id, { agent_uri: agentUri, correlation_id: correlationId });
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
      const activeRun = activeRuns.get(message.id);
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
        thread_id: message.id,
        kind: "agent",
      });
      final.final_message_id = finalMessage.id;
      broadcast("message_created", { message: finalMessage });
    } catch (error) {
      const code = error instanceof IpcCallError ? error.code : "AGENT_RUN_FAILED";
      const messageText = error instanceof Error ? error.message : "agent run failed";
      broadcast("agent_error", { error: { code, message: messageText, source: agentUri } });
    } finally {
      activeRuns.delete(message.id);
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
