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
  const activeRuns = new Map<string, AbortController>();

  node.onCancel("*", (payload, context) => {
    const correlationId = context.envelope.header.correlation_id;
    if (!correlationId) {
      return;
    }

    const controller = activeRuns.get(correlationId);
    if (!controller || controller.signal.aborted) {
      return;
    }

    controller.abort(readCancelReason(payload.data));
  });

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
      const controller = new AbortController();
      const correlationId = context.envelope.header.correlation_id;

      if (correlationId) {
        activeRuns.set(correlationId, controller);
      }

      try {
        for await (const event of options.runtime.run(input, {
          agent_uri: uri,
          correlation_id: context.envelope.header.correlation_id,
          node,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) {
            break;
          }

          if (event.type === "final") {
            final = event.result;
            continue;
          }

          emitRuntimeEvent(event, input, context.envelope.header.correlation_id);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          throw error;
        }
      } finally {
        if (correlationId && activeRuns.get(correlationId) === controller) {
          activeRuns.delete(correlationId);
        }
      }

      if (controller.signal.aborted) {
        return {
          mime_type: SLOCK_AGENT_RESULT_MIME,
          data: {
            summary: "Agent run cancelled.",
            final_text: "Agent run cancelled.",
            cancelled: true,
            reason: readAbortReason(controller.signal),
          },
        };
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
          kind: event.type === "status" ? "status" : "text",
          ...(event.metadata ? { metadata: event.metadata } : {}),
        },
      },
      { correlation_id: correlationId },
    );
  }
}

function readCancelReason(value: unknown): string {
  if (isRecord(value) && typeof value.reason === "string" && value.reason.trim().length > 0) {
    return value.reason;
  }
  return "cancelled";
}

function readAbortReason(signal: AbortSignal): string | undefined {
  return typeof signal.reason === "string" ? signal.reason : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
