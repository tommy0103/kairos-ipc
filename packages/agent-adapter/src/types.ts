import type { EndpointUri } from "../../protocol/src/index.ts";
import type { IpcNode } from "../../sdk/src/index.ts";
import type { SlockAgentRun, SlockAgentResult } from "../../slock-channel/src/index.ts";

export type AgentRuntimeIpc = Pick<IpcNode, "call" | "uri">;

export interface AgentRuntimeContext {
  agent_uri: EndpointUri;
  correlation_id?: string;
  node: AgentRuntimeIpc;
  signal?: AbortSignal;
}

export type AgentRuntimeEvent =
  | {
      type: "message_delta";
      text: string;
      thread_id?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "status";
      text: string;
      thread_id?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "final";
      result: SlockAgentResult;
    };

export interface AgentRuntime {
  run(input: SlockAgentRun, context: AgentRuntimeContext): AsyncIterable<AgentRuntimeEvent>;
}

export interface AgentAdapterOptions {
  uri?: EndpointUri;
  runtime: AgentRuntime;
}
