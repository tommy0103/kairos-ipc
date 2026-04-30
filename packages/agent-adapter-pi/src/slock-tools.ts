import { Type, type Tool, type ToolCall, type ToolResultMessage } from "@mariozechner/pi-ai";
import type { EndpointUri } from "../../protocol/src/index.ts";
import {
  SLOCK_APPROVAL_REQUEST_MIME,
  SLOCK_SHELL_EXEC_MIME,
  type SlockApprovalRequest,
  type SlockApprovalResult,
  type SlockShellExecRequest,
  type SlockShellExecResult,
} from "../../slock-channel/src/index.ts";
import type { PiToolExecutor, PiToolExecutionContext } from "./pi-agent.ts";

export interface PiSlockToolsOptions {
  workspace_uri?: EndpointUri;
  shell_uri?: EndpointUri;
  approval_uri?: EndpointUri;
  tool_ttl_ms?: number;
  approval_ttl_ms?: number;
}

export interface PiSlockTools {
  tools: Tool[];
  execute_tool: PiToolExecutor;
}

const READ_TOOL = "read";
const WRITE_TOOL = "write";
const EDIT_TOOL = "edit";
const EXEC_TOOL = "exec";

export function createPiSlockTools(options: PiSlockToolsOptions = {}): PiSlockTools {
  const workspaceUri = options.workspace_uri ?? "plugin://local/workspace";
  const shellUri = options.shell_uri ?? "plugin://local/shell";
  const toolTtlMs = options.tool_ttl_ms ?? 30000;
  const approvalTtlMs = options.approval_ttl_ms ?? 300000;

  return {
    tools: createTools(),
    execute_tool: async (toolCall, context) => {
      try {
        return await executeTool(toolCall, context);
      } catch (error) {
        return toolResult(toolCall, error instanceof Error ? error.message : String(error), true);
      }
    },
  };

  async function executeTool(toolCall: ToolCall, context: PiToolExecutionContext): Promise<ToolResultMessage> {
    switch (toolCall.name) {
      case READ_TOOL:
        return await callWorkspaceTool(toolCall, context, "read", normalizeReadArgs(toolCall.arguments));
      case WRITE_TOOL: {
        const payload = normalizeWriteArgs(toolCall.arguments);
        const approved = await requestApproval(toolCall, context, {
          risk: "file_write",
          summary: `Write ${payload.path}`,
          proposed_call: { target: workspaceUri, action: "write", payload },
        });
        return approved ?? await callWorkspaceTool(toolCall, context, "write", payload);
      }
      case EDIT_TOOL: {
        const payload = normalizeEditArgs(toolCall.arguments);
        const approved = await requestApproval(toolCall, context, {
          risk: "file_edit",
          summary: `Edit ${payload.path}`,
          proposed_call: { target: workspaceUri, action: "edit", payload },
        });
        return approved ?? await callWorkspaceTool(toolCall, context, "edit", payload);
      }
      case EXEC_TOOL: {
        const payload = normalizeExecArgs(toolCall.arguments);
        const approved = await requestApproval(toolCall, context, {
          risk: "shell_exec",
          summary: `Run ${payload.command}${payload.args.length > 0 ? ` ${payload.args.join(" ")}` : ""}`,
          proposed_call: { target: shellUri, action: "exec", payload },
        });
        return approved ?? await callShellTool(toolCall, context, payload);
      }
      default:
        return toolResult(toolCall, `Unknown tool: ${toolCall.name}`, true);
    }
  }

  async function callWorkspaceTool(
    toolCall: ToolCall,
    context: PiToolExecutionContext,
    action: "read" | "write" | "edit",
    payload: Record<string, unknown>,
  ): Promise<ToolResultMessage> {
    const result = await context.runtime.node.call(workspaceUri, action, {
      mime_type: "application/json",
      data: payload,
    }, { ttl_ms: toolTtlMs, correlation_id: context.runtime.correlation_id });

    return toolResult(toolCall, JSON.stringify(result.data, null, 2));
  }

  async function callShellTool(
    toolCall: ToolCall,
    context: PiToolExecutionContext,
    payload: SlockShellExecRequest & { args: string[] },
  ): Promise<ToolResultMessage> {
    const result = await context.runtime.node.call<SlockShellExecRequest, SlockShellExecResult>(shellUri, "exec", {
      mime_type: SLOCK_SHELL_EXEC_MIME,
      data: payload,
    }, { ttl_ms: toolTtlMs, correlation_id: context.runtime.correlation_id });

    return toolResult(toolCall, JSON.stringify(result.data, null, 2), result.data.exit_code !== 0);
  }

  async function requestApproval(
    toolCall: ToolCall,
    context: PiToolExecutionContext,
    request: SlockApprovalRequest,
  ): Promise<ToolResultMessage | undefined> {
    const approvalTarget = options.approval_uri ?? context.input.sender;
    const approvalRequest: SlockApprovalRequest = {
      ...request,
      id: request.id ?? `approval_${context.input.message_id}_${toolCall.id}`,
      metadata: {
        ...request.metadata,
        thread_id: context.input.message_id,
        tool_call_id: toolCall.id,
        tool_name: toolCall.name,
      },
    };
    const result = await context.runtime.node.call<SlockApprovalRequest, SlockApprovalResult>(approvalTarget, "request_approval", {
      mime_type: SLOCK_APPROVAL_REQUEST_MIME,
      data: approvalRequest,
    }, { ttl_ms: approvalTtlMs, timeout_ms: approvalTtlMs, correlation_id: context.runtime.correlation_id });

    if (result.data.approved) {
      return undefined;
    }

    return toolResult(
      toolCall,
      `Approval denied${result.data.reason ? `: ${result.data.reason}` : "."}`,
      true,
    );
  }
}

function createTools(): Tool[] {
  return [
    {
      name: READ_TOOL,
      description: "Read a UTF-8 file from the local workspace. This does not require approval.",
      parameters: Type.Object({
        path: Type.String({ description: "Workspace-relative file path." }),
        max_bytes: Type.Optional(Type.Number({ description: "Optional maximum bytes to return." })),
      }),
    },
    {
      name: WRITE_TOOL,
      description: "Write a UTF-8 file in the local workspace. Requires human approval before execution.",
      parameters: Type.Object({
        path: Type.String({ description: "Workspace-relative file path." }),
        content: Type.String({ description: "Full file content to write." }),
      }),
    },
    {
      name: EDIT_TOOL,
      description: "Replace exact text in a local workspace file. Requires human approval before execution.",
      parameters: Type.Object({
        path: Type.String({ description: "Workspace-relative file path." }),
        old_text: Type.String({ description: "Exact existing text to replace." }),
        new_text: Type.String({ description: "Replacement text." }),
      }),
    },
    {
      name: EXEC_TOOL,
      description: "Execute a local command with structured args and no shell expansion. Requires human approval before execution.",
      parameters: Type.Object({
        command: Type.String({ description: "Bare executable name, for example pwd, find, or node." }),
        args: Type.Optional(Type.Array(Type.String(), { description: "Command arguments." })),
        cwd: Type.Optional(Type.String({ description: "Optional working directory." })),
      }),
    },
  ];
}

function toolResult(toolCall: ToolCall, text: string, isError = false): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}

function normalizeReadArgs(value: Record<string, unknown>): Record<string, unknown> {
  return { path: readString(value, "path"), max_bytes: readOptionalNumber(value, "max_bytes") };
}

function normalizeWriteArgs(value: Record<string, unknown>): Record<string, unknown> {
  return { path: readString(value, "path"), content: readString(value, "content") };
}

function normalizeEditArgs(value: Record<string, unknown>): Record<string, unknown> {
  return {
    path: readString(value, "path"),
    old_text: readString(value, "old_text"),
    new_text: readString(value, "new_text"),
  };
}

function normalizeExecArgs(value: Record<string, unknown>): SlockShellExecRequest & { args: string[] } {
  const args = Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === "string") : [];
  return {
    command: readString(value, "command"),
    args,
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
  };
}

function readString(value: Record<string, unknown>, key: string): string {
  const next = value[key];
  if (typeof next !== "string" || next.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return next;
}

function readOptionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  const next = value[key];
  return typeof next === "number" && Number.isFinite(next) ? next : undefined;
}
