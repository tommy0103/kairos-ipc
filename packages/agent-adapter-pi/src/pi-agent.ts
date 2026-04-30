import {
  stream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderStreamOptions,
  type TextContent,
  type Tool,
} from "@mariozechner/pi-ai";
import { createAgentAdapter, type AgentAdapterEndpoint, type AgentRuntime, type AgentRuntimeContext, type AgentRuntimeEvent } from "../../agent-adapter/src/index.ts";
import type { EndpointUri } from "../../protocol/src/index.ts";
import type { SlockAgentRun } from "../../slock-channel/src/index.ts";

export interface PiRuntimeOptions<TApi extends Api = Api> {
  model: Model<TApi>;
  api_key?: string;
  api_key_env?: string;
  base_url?: string;
  base_url_env?: string;
  headers?: Record<string, string>;
  system_prompt?: string;
  tools?: Tool[];
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
      const piStream = stream(resolveModel(options), piContext, resolveStreamOptions(options, context));
      let streamedText = "";

      for await (const event of piStream) {
        if (event.type === "text_delta") {
          streamedText += event.delta;
          yield { type: "message_delta", thread_id: input.message_id, text: event.delta };
          continue;
        }

        if (event.type === "error") {
          const message = event.error.errorMessage ?? "pi-ai stream failed";
          throw new Error(message);
        }
      }

      const message = await piStream.result();
      const finalText = assistantText(message) || streamedText || fallbackText(message);
      yield {
        type: "final",
        result: {
          summary: summaryText(message, finalText),
          final_text: finalText,
        },
      };
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
    sessionId: options.stream_options?.sessionId ?? context.correlation_id,
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

  return {
    systemPrompt: options.system_prompt,
    messages: [
      {
        role: "user",
        content: input.text,
        timestamp: Date.now(),
      },
    ],
    tools: options.tools,
  };
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
