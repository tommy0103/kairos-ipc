import type { AgentRuntime, AgentRuntimeContext, AgentRuntimeEvent } from "./types.ts";
import type { SlockAgentRun } from "../../slock-channel/src/index.ts";

export interface SimpleRuntimeOptions {
  name?: string;
}

export function createSimpleRuntime(options: SimpleRuntimeOptions = {}): AgentRuntime {
  const name = options.name ?? "simple-runtime";

  return {
    async *run(input: SlockAgentRun, _context: AgentRuntimeContext): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "status", text: `${name} received the message.` };
      yield { type: "message_delta", text: `Working on: ${input.text}` };
      yield {
        type: "final",
        result: {
          summary: `${name} completed the request.`,
          final_text: `${name} says: ${input.text}`,
        },
      };
    },
  };
}
