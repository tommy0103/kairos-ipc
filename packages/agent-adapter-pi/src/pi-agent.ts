import {
  stream,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type ProviderStreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import { createAgentAdapter, type AgentAdapterEndpoint, type AgentRuntime, type AgentRuntimeContext, type AgentRuntimeEvent } from "../../agent-adapter/src/index.ts";
import type { EndpointUri } from "../../protocol/src/index.ts";
import type { SlockAgentRun, SlockHistoryRequest, SlockHistoryResult, SlockMessage } from "../../slock-channel/src/index.ts";

export interface PiToolExecutionContext {
  input: SlockAgentRun;
  runtime: AgentRuntimeContext;
}

export type PiToolExecutor = (
  toolCall: ToolCall,
  context: PiToolExecutionContext,
) => ToolResultMessage | Promise<ToolResultMessage>;

export type PiMemoryScope = "personal" | "task" | "tool";

export interface PiMemoryContextOptions {
  enabled?: boolean;
  uri?: EndpointUri;
  workspace_id?: string;
  inject_context?: boolean;
  scopes?: PiMemoryScope[];
  top_k?: number;
  timeout_ms?: number;
}

export interface PiRuntimeOptions<TApi extends Api = Api> {
  model: Model<TApi>;
  api_key?: string;
  api_key_env?: string;
  base_url?: string;
  base_url_env?: string;
  headers?: Record<string, string>;
  system_prompt?: string;
  tools?: Tool[];
  execute_tool?: PiToolExecutor;
  max_tool_turns?: number;
  context_history_limit?: number;
  context_history_scope?: "channel" | "thread";
  memory?: PiMemoryContextOptions;
  stream_options?: ProviderStreamOptions;
  build_context?: (input: SlockAgentRun, context: AgentRuntimeContext) => Context | Promise<Context>;
}

export interface PiAgentOptions<TApi extends Api = Api> extends PiRuntimeOptions<TApi> {
  uri?: EndpointUri;
}

export function createPiAgent<TApi extends Api = Api>(options: PiAgentOptions<TApi>): AgentAdapterEndpoint {
  return createAgentAdapter({
    uri: options.uri ?? "agent://local/pi-assistant",
    runtime: createPiRuntime(options),
  });
}

export function createPiRuntime<TApi extends Api = Api>(options: PiRuntimeOptions<TApi>): AgentRuntime {
  return {
    async *run(input: SlockAgentRun, context: AgentRuntimeContext): AsyncIterable<AgentRuntimeEvent> {
      const piContext = await buildContext(input, context, options);
      const maxToolTurns = options.max_tool_turns ?? 8;
      let lastStreamedText = "";

      for (let turn = 0; turn <= maxToolTurns; turn++) {
        if (context.signal?.aborted) {
          yield cancelledFinalEvent(context.signal);
          return;
        }

        const piStream = stream(resolveModel(options), piContext, resolveStreamOptions(options, context));
        let streamedText = "";

        for await (const event of piStream) {
          if (context.signal?.aborted) {
            yield cancelledFinalEvent(context.signal);
            return;
          }

          if (event.type === "text_delta") {
            streamedText += event.delta;
            yield { type: "message_delta", thread_id: input.message_id, text: event.delta };
            continue;
          }

          if (event.type === "error") {
            if (event.reason === "aborted" || context.signal?.aborted) {
              yield cancelledFinalEvent(context.signal);
              return;
            }
            const message = event.error.errorMessage ?? "pi-ai stream failed";
            throw new Error(message);
          }
        }

        if (context.signal?.aborted) {
          yield cancelledFinalEvent(context.signal);
          return;
        }

        const message = await piStream.result();
        lastStreamedText = streamedText || lastStreamedText;
        piContext.messages.push(message);

        const toolCalls = message.content.filter(isToolCall);
        if (message.stopReason !== "toolUse" || toolCalls.length === 0) {
          yield finalEvent(message, streamedText || lastStreamedText);
          return;
        }

        if (!options.execute_tool) {
          yield finalEvent(message, streamedText || lastStreamedText);
          return;
        }

        for (const toolCall of toolCalls) {
          if (context.signal?.aborted) {
            yield cancelledFinalEvent(context.signal);
            return;
          }

          yield toolStatusEvent(input.message_id, toolCall, "running");
          let result: ToolResultMessage;
          try {
            result = await options.execute_tool(toolCall, { input, runtime: context });
          } catch (error) {
            yield toolStatusEvent(
              input.message_id,
              toolCall,
              "errored",
              error instanceof Error ? error.message : String(error),
              true,
            );
            throw error;
          }
          yield toolStatusEvent(input.message_id, toolCall, result.isError ? "errored" : "completed", toolResultText(result), result.isError);
          piContext.messages.push(result);
        }
      }

      throw new Error(`pi-ai exceeded max tool turns: ${maxToolTurns}`);
    },
  };
}

function toolStatusEvent(
  threadId: string,
  toolCall: ToolCall,
  state: "running" | "completed" | "errored",
  result?: string,
  isError = false,
): AgentRuntimeEvent {
  const verb = state === "running" ? "Running" : state === "completed" ? "Completed" : "Failed";
  return {
    type: "status",
    thread_id: threadId,
    text: `${verb} ${toolCall.name}`,
    metadata: {
      type: "tool_call",
      tool_call_id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      state,
      ...(result !== undefined ? { result } : {}),
      ...(isError ? { is_error: true } : {}),
    },
  };
}

function toolResultText(result: ToolResultMessage): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function finalEvent(message: AssistantMessage, streamedText: string): AgentRuntimeEvent {
  const finalText = assistantText(message) || streamedText || fallbackText(message);
  return {
    type: "final",
    result: {
      summary: summaryText(message, finalText),
      final_text: finalText,
    },
  };
}

function resolveModel<TApi extends Api>(options: PiRuntimeOptions<TApi>): Model<TApi> {
  const baseUrl = firstConfiguredValue(options.base_url, readEnv(options.base_url_env));
  if (!baseUrl && !options.headers) {
    return options.model;
  }

  return {
    ...options.model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(options.headers ? { headers: { ...options.model.headers, ...options.headers } } : {}),
  };
}

function resolveStreamOptions<TApi extends Api>(
  options: PiRuntimeOptions<TApi>,
  context: AgentRuntimeContext,
): ProviderStreamOptions {
  const apiKey = firstConfiguredValue(options.api_key, readEnv(options.api_key_env), options.stream_options?.apiKey);
  const headers = options.headers
    ? { ...options.stream_options?.headers, ...options.headers }
    : options.stream_options?.headers;

  return {
    ...options.stream_options,
    ...(apiKey ? { apiKey } : {}),
    ...(headers ? { headers } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    sessionId: options.stream_options?.sessionId ?? context.correlation_id,
  };
}

function cancelledFinalEvent(signal: AbortSignal | undefined): AgentRuntimeEvent {
  return {
    type: "final",
    result: {
      summary: "pi-ai run cancelled.",
      final_text: "pi-ai run cancelled.",
      cancelled: true,
      reason: typeof signal?.reason === "string" ? signal.reason : undefined,
    },
  };
}

function firstConfiguredValue(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function readEnv(name: string | undefined): string | undefined {
  return name ? process.env[name] : undefined;
}

async function buildContext<TApi extends Api>(
  input: SlockAgentRun,
  context: AgentRuntimeContext,
  options: PiRuntimeOptions<TApi>,
): Promise<Context> {
  if (options.build_context) {
    return await options.build_context(input, context);
  }

  const messages = await buildHistoryMessages(input, context, options);
  const memory = await retrieveMemoryContext(input, context, options.memory);

  return {
    systemPrompt: buildSystemPrompt(options.system_prompt, options.memory, memory),
    messages,
    tools: options.tools,
  };
}

async function retrieveMemoryContext(
  input: SlockAgentRun,
  context: AgentRuntimeContext,
  options: PiMemoryContextOptions | undefined,
): Promise<string[]> {
  if (!isMemoryContextEnabled(options)) {
    return [];
  }

  const uri = options.uri ?? "plugin://memory/reme";
  const scopes = options.scopes && options.scopes.length > 0 ? options.scopes : ["personal", "task"];
  const query = stripMentions(input.text) || input.text;
  const topK = options.top_k ?? 5;
  const timeoutMs = options.timeout_ms ?? 5000;
  const memories: string[] = [];

  for (const scope of scopes) {
    if (context.signal?.aborted) {
      return memories;
    }

    try {
      const result = await context.node.call<Record<string, unknown>, Record<string, unknown>>(uri, "retrieve", {
        mime_type: "application/json",
        data: {
          scope,
          query,
          top_k: topK,
          ...(options.workspace_id ? { workspace_id: options.workspace_id } : {}),
        },
      }, { ttl_ms: timeoutMs, timeout_ms: timeoutMs, signal: context.signal });

      for (const memory of extractMemoryStrings(result.data)) {
        memories.push(`${scope}: ${memory}`);
      }
    } catch {
      // Memory is helpful context, not a hard dependency for answering.
    }
  }

  return uniqueStrings(memories).slice(0, Math.max(topK * scopes.length, topK));
}

function buildSystemPrompt(
  basePrompt: string | undefined,
  memoryOptions: PiMemoryContextOptions | undefined,
  memories: string[],
): string | undefined {
  const parts = [basePrompt?.trim()].filter((part): part is string => Boolean(part));

  if (memoryOptions?.enabled) {
    const uri = memoryOptions.uri ?? "plugin://memory/reme";
    parts.push([
      `Long-term memory is available through ipc_call target ${uri}.`,
      "Use retrieve for user preferences, project history, or prior decisions when the injected context is insufficient.",
      "Inspect the memory endpoint manifest before writing memory in a run; use summarize for personal/task memories, reserve record_tool_result for actual tool-call outcomes, and use vector_store only for administrative operations. Memory writes require approval.",
    ].join(" "));
  }

  if (memories.length > 0) {
    parts.push(`Relevant long-term memory:\n${memories.map((memory) => `- ${clipMemory(memory)}`).join("\n")}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function isMemoryContextEnabled(options: PiMemoryContextOptions | undefined): options is PiMemoryContextOptions {
  return Boolean(options?.enabled && options.inject_context !== false);
}

async function buildHistoryMessages<TApi extends Api>(
  input: SlockAgentRun,
  context: AgentRuntimeContext,
  options: PiRuntimeOptions<TApi>,
): Promise<Message[]> {
  const limit = options.context_history_limit ?? 20;
  if (limit <= 0) {
    return [currentUserMessage(input)];
  }

  try {
    const request: SlockHistoryRequest = {
      limit,
      until_id: input.message_id,
      ...(options.context_history_scope === "thread" ? { thread_id: input.thread_id ?? input.message_id } : {}),
    };
    const history = await context.node.call<SlockHistoryRequest, SlockHistoryResult>(input.channel, "history", {
      mime_type: "application/json",
      data: request,
    }, { ttl_ms: 5000, signal: context.signal });

    const model = resolveModel(options);
    const messages = history.data.messages.flatMap((message) => toPiMessage(message, input, model));
    return history.data.messages.some((message) => message.id === input.message_id) ? messages : [...messages, currentUserMessage(input)];
  } catch {
    return [currentUserMessage(input)];
  }
}

function toPiMessage<TApi extends Api>(message: SlockMessage, input: SlockAgentRun, model: Model<TApi>): Message[] {
  if (message.kind === "human") {
    const content = message.id === input.message_id ? input.text : stripMentions(message.text);
    return content.trim().length > 0
      ? [{ role: "user", content, timestamp: messageTimestamp(message) }]
      : [];
  }

  if (message.kind === "agent") {
    return message.text.trim().length > 0
      ? [assistantHistoryMessage(message, model)]
      : [];
  }

  return [];
}

function currentUserMessage(input: SlockAgentRun): Message {
  return {
    role: "user",
    content: input.text,
    timestamp: Date.now(),
  };
}

function assistantHistoryMessage<TApi extends Api>(message: SlockMessage, model: Model<TApi>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: message.text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: messageTimestamp(message),
  };
}

function messageTimestamp(message: SlockMessage): number {
  const timestamp = Date.parse(message.created_at);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function stripMentions(text: string): string {
  return text.replace(/(^|\s)@\S+/g, " ").trim();
}

function extractMemoryStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value.trim()] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(extractMemoryStrings);
  }

  if (!isRecord(value)) {
    return [];
  }

  for (const key of ["memories", "memory", "results", "result", "data", "content", "guidelines", "summary", "raw"]) {
    if (Object.hasOwn(value, key)) {
      const extracted = extractMemoryStrings(value[key]);
      if (extracted.length > 0) {
        return extracted;
      }
    }
  }

  if (typeof value.text === "string") {
    return [value.text.trim()].filter(Boolean);
  }

  return [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clipMemory(value: string): string {
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

function assistantText(message: AssistantMessage): string {
  return message.content.filter(isTextContent).map((block) => block.text).join("").trim();
}

function summaryText(message: AssistantMessage, finalText: string): string {
  if (message.stopReason === "toolUse") {
    return "pi-ai stopped after requesting tool use.";
  }
  if (message.stopReason === "length") {
    return "pi-ai stopped because the response reached its length limit.";
  }
  return finalText;
}

function fallbackText(message: AssistantMessage): string {
  if (message.stopReason === "toolUse") {
    const calls = message.content.filter((block) => block.type === "toolCall");
    const names = calls.map((call) => call.name).join(", ");
    return names ? `pi-ai requested tool use: ${names}` : "pi-ai requested tool use.";
  }

  return message.errorMessage ?? `pi-ai completed with stop reason: ${message.stopReason}`;
}

function isTextContent(block: AssistantMessage["content"][number]): block is TextContent {
  return block.type === "text";
}

function isToolCall(block: AssistantMessage["content"][number]): block is ToolCall {
  return block.type === "toolCall";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
