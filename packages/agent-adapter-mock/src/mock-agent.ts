import { createAgentAdapter, type AgentRuntime, type AgentRuntimeContext, type AgentRuntimeEvent } from "../../agent-adapter/src/index.ts";
import type { IpcNode } from "../../sdk/src/index.ts";
import {
  SLOCK_APPROVAL_REQUEST_MIME,
  SLOCK_SHELL_EXEC_MIME,
  type SlockAgentResult,
  type SlockAgentRun,
  type SlockApprovalRequest,
  type SlockApprovalResult,
  type SlockShellExecRequest,
  type SlockShellExecResult,
} from "../../slock-channel/src/index.ts";

export interface MockAgentOptions {
  uri?: string;
  calculator_uri?: string;
  shell_uri?: string;
}

export interface MockAgentAdapter {
  node: IpcNode;
}

export function createMockAgent(options: MockAgentOptions = {}): MockAgentAdapter {
  const uri = options.uri ?? "agent://local/mock";
  const calculatorUri = options.calculator_uri ?? "plugin://demo/calculator";
  const shellUri = options.shell_uri ?? "plugin://local/shell";

  const runtime: AgentRuntime = {
    async *run(run: SlockAgentRun, context: AgentRuntimeContext): AsyncIterable<AgentRuntimeEvent> {
      yield messageDelta(run, "Reading the request...");

      if (wantsShell(run.text)) {
        yield* handleShellRun(run, context, shellUri);
        return;
      }

      const calculation = await context.node.call<{ a: number; b: number }, { result: number }>(
        calculatorUri,
        "add",
        { mime_type: "application/json", data: { a: 2, b: 3 } },
        { ttl_ms: 30000, signal: context.signal },
      );

      yield messageDelta(run, `Calculator returned ${calculation.data.result}.`);
      yield finalResult({
        summary: `Mock handled: ${run.text}`,
        final_text: `Mock agent handled "${run.text}" and calculator says 2 + 3 = ${calculation.data.result}.`,
      });
    },
  };

  return createAgentAdapter({ uri, runtime });
}

async function* handleShellRun(
  run: SlockAgentRun,
  context: AgentRuntimeContext,
  shellUri: string,
): AsyncIterable<AgentRuntimeEvent> {
  const proposedCall = {
    target: shellUri,
    action: "exec",
    payload: { command: "pwd", args: [] },
  };

  yield messageDelta(run, "Requesting approval for shell exec...");

  const approval = await context.node.call<SlockApprovalRequest, SlockApprovalResult>(
    run.sender,
    "request_approval",
    {
      mime_type: SLOCK_APPROVAL_REQUEST_MIME,
      data: {
        risk: "shell_exec",
        summary: "Run pwd to show the current working directory.",
        metadata: { channel: run.channel, thread_id: run.message_id },
        proposed_call: proposedCall,
      },
    },
    { ttl_ms: 300000, timeout_ms: 300000, signal: context.signal },
  );

  if (!approval.data.approved) {
    yield finalResult({
      summary: "Shell execution was not approved.",
      final_text: `Shell execution was not approved${approval.data.reason ? `: ${approval.data.reason}` : "."}`,
    });
    return;
  }

  const shell = await context.node.call<SlockShellExecRequest, SlockShellExecResult>(
    shellUri,
    "exec",
    {
      mime_type: SLOCK_SHELL_EXEC_MIME,
      data: proposedCall.payload,
    },
    { ttl_ms: approval.data.grant_ttl_ms ?? 30000, signal: context.signal },
  );

  yield messageDelta(run, `Shell command exited ${shell.data.exit_code}.`);
  yield finalResult({
    summary: "Shell command completed.",
    final_text: `Approved shell exec: ${shell.data.command}\n${shell.data.stdout.trim()}`,
  });
}

function messageDelta(run: SlockAgentRun, text: string): AgentRuntimeEvent {
  return { type: "message_delta", thread_id: run.message_id, text };
}

function finalResult(result: SlockAgentResult): AgentRuntimeEvent {
  return { type: "final", result };
}

function wantsShell(text: string): boolean {
  return /\b(shell|pwd|command|terminal)\b/i.test(text);
}
