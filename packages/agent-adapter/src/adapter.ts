import { createNode, type IpcNode } from "../../sdk/src/index.ts";
import {
  SLOCK_AGENT_RESULT_MIME,
  SLOCK_AGENT_RUN_MIME,
  SLOCK_MESSAGE_DELTA_MIME,
  type SlockAgentResult,
  type SlockAgentRun,
} from "../../slock-channel/src/index.ts";
import type { AgentAdapterOptions, AgentRuntimeEvent } from "./types.ts";

export interface AgentAdapterEndpoint {
  node: IpcNode;
}

export function createAgentAdapter(options: AgentAdapterOptions): AgentAdapterEndpoint {
  const uri = options.uri ?? "agent://local/adapter";
  const node = createNode(uri);

  node.action<SlockAgentRun, SlockAgentResult>(
    "run",
    {
      description: "Run an agent runtime and project its events onto Slock IPC.",
      accepts: SLOCK_AGENT_RUN_MIME,
      returns: SLOCK_AGENT_RESULT_MIME,
    },
    async (payload, context) => {
      const input = payload.data;
      let final: SlockAgentResult | undefined;

      for await (const event of options.runtime.run(input, {
        agent_uri: uri,
        correlation_id: context.envelope.header.correlation_id,
        node,
      })) {
        if (event.type === "final") {
          final = event.result;
          continue;
        }

        emitRuntimeEvent(event, input, context.envelope.header.correlation_id);
      }

      return {
        mime_type: SLOCK_AGENT_RESULT_MIME,
        data: final ?? {
          summary: "Agent runtime completed without a final event.",
          final_text: "Agent runtime completed without a final event.",
        },
      };
    },
  );

  return { node };

  function emitRuntimeEvent(event: Exclude<AgentRuntimeEvent, { type: "final" }>, input: SlockAgentRun, correlationId?: string): void {
    node.emit(
      input.channel,
      "message_delta",
      {
        mime_type: SLOCK_MESSAGE_DELTA_MIME,
        data: {
          thread_id: event.thread_id ?? input.message_id,
          text: event.text,
        },
      },
      { correlation_id: correlationId },
    );
  }
}
