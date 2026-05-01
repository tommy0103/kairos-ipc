import { Type, type Tool, type ToolCall, type ToolResultMessage } from "@mariozechner/pi-ai";
import type { EndpointUri } from "../../protocol/src/index.ts";
import { IpcCallError } from "../../sdk/src/index.ts";
import {
  SLOCK_APPROVAL_REQUEST_MIME,
  SLOCK_SHELL_EXEC_MIME,
  type SlockCapabilityGrant,
  type SlockApprovalRequest,
  type SlockApprovalResult,
} from "../../slock-channel/src/index.ts";
import type { PiToolExecutor, PiToolExecutionContext } from "./pi-agent.ts";

export interface PiSlockToolsOptions {
  registry_uri?: EndpointUri;
  workspace_uri?: EndpointUri;
  shell_uri?: EndpointUri;
  memory_uri?: EndpointUri;
  approval_uri?: EndpointUri;
  generic_ipc_call?: boolean;
  ipc_call_targets?: EndpointUri[];
  tool_ttl_ms?: number;
  memory_tool_ttl_ms?: number;
  approval_ttl_ms?: number;
}

export interface PiSlockTools {
  tools: Tool[];
  execute_tool: PiToolExecutor;
}

const IPC_CALL_TOOL = "ipc_call";

type ApprovalOutcome = { grant: SlockCapabilityGrant } | { error: ToolResultMessage };

export function createPiSlockTools(options: PiSlockToolsOptions = {}): PiSlockTools {
  const registryUri = options.registry_uri ?? "slock://registry";
  const workspaceUri = options.workspace_uri ?? "plugin://local/workspace";
  const shellUri = options.shell_uri ?? "plugin://local/shell";
  const memoryUri = options.memory_uri ?? "plugin://memory/reme";
  const toolTtlMs = options.tool_ttl_ms ?? 30000;
  const memoryToolTtlMs = options.memory_tool_ttl_ms ?? 120000;
  const approvalTtlMs = options.approval_ttl_ms ?? 300000;

  return {
    tools: createTools(options, registryUri, workspaceUri, shellUri, memoryUri),
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
      case IPC_CALL_TOOL:
        return await callIpcTool(toolCall, context, normalizeIpcCallArgs(toolCall.arguments, shellUri));
      default:
        return toolResult(toolCall, `Unknown tool: ${toolCall.name}`, true);
    }
  }

  async function callIpcTool(
    toolCall: ToolCall,
    context: PiToolExecutionContext,
    args: IpcCallArgs,
  ): Promise<ToolResultMessage> {
    const approval = await maybeRequestIpcApproval(toolCall, context, args);
    if ("error" in approval) {
      return approval.error;
    }

    const defaultTtlMs = defaultToolTtlMs(args, memoryUri, toolTtlMs, memoryToolTtlMs);
    const result = await context.runtime.node.call(args.target, args.action, {
      mime_type: args.mime_type,
      data: approval.payload,
    }, {
      ttl_ms: args.ttl_ms ?? defaultTtlMs,
      timeout_ms: args.timeout_ms ?? args.ttl_ms ?? defaultTtlMs,
      signal: context.runtime.signal,
    });

    return toolResult(
      toolCall,
      stringifyJson({ mime_type: result.mime_type, data: result.data }),
      isNonZeroShellResult(args, result.data),
    );
  }

  async function maybeRequestIpcApproval(
    toolCall: ToolCall,
    context: PiToolExecutionContext,
    args: IpcCallArgs,
  ): Promise<{ payload: unknown } | { error: ToolResultMessage }> {
    const request = createApprovalRequestForIpcCall(args, workspaceUri, shellUri, memoryUri);
    if (!request) {
      return { payload: args.payload };
    }

    const approval = await requestApproval(toolCall, context, request);
    return "error" in approval
      ? approval
      : { payload: attachApprovalGrant(args.payload, approval.grant, args) };
  }

  async function requestApproval(
    toolCall: ToolCall,
    context: PiToolExecutionContext,
    request: SlockApprovalRequest,
  ): Promise<ApprovalOutcome> {
    const approvalTarget = options.approval_uri ?? context.input.sender;
    const approvalId = request.id ?? `approval_${context.input.message_id}_${toolCall.id}`;
    const approvalRequest: SlockApprovalRequest = {
      ...request,
      id: approvalId,
      metadata: {
        ...request.metadata,
        channel: context.input.channel,
        thread_id: context.input.message_id,
        tool_call_id: toolCall.id,
        tool_name: toolCall.name,
      },
    };
    let result;
    try {
      result = await context.runtime.node.call<SlockApprovalRequest, SlockApprovalResult>(approvalTarget, "request_approval", {
        mime_type: SLOCK_APPROVAL_REQUEST_MIME,
        data: approvalRequest,
      }, { ttl_ms: approvalTtlMs, timeout_ms: approvalTtlMs, signal: context.runtime.signal });
    } catch (error) {
      if (isAbortError(error) || context.runtime.signal?.aborted) {
        await withdrawApproval(context, approvalTarget, approvalId);
      }
      throw error;
    }

    if (result.data.approved) {
      return result.data.grant
        ? { grant: result.data.grant }
        : { error: toolResult(toolCall, "Approval did not include a capability grant.", true) };
    }

    return {
      error: toolResult(
        toolCall,
        `Approval denied${result.data.reason ? `: ${result.data.reason}` : "."}`,
        true,
      ),
    };
  }

  async function withdrawApproval(
    context: PiToolExecutionContext,
    approvalTarget: EndpointUri,
    id: string,
  ): Promise<void> {
    const reason = typeof context.runtime.signal?.reason === "string" ? context.runtime.signal.reason : "cancelled";
    try {
      await context.runtime.node.call(approvalTarget, "withdraw_approval", {
        mime_type: "application/json",
        data: { id, reason },
      }, { ttl_ms: 5000, timeout_ms: 5000 });
    } catch {
      // Best effort: local abort must not hang while cleaning up remote approval UI.
    }
  }
}

interface IpcCallArgs {
  target: EndpointUri;
  action: string;
  mime_type: string;
  payload: unknown;
  ttl_ms?: number;
  timeout_ms?: number;
}

function createTools(
  options: PiSlockToolsOptions,
  registryUri: EndpointUri,
  workspaceUri: EndpointUri,
  shellUri: EndpointUri,
  memoryUri: EndpointUri,
): Tool[] {
  if (options.generic_ipc_call === false) {
    return [];
  }

  return [{
    name: IPC_CALL_TOOL,
    description: ipcCallDescription(options, registryUri, workspaceUri, shellUri, memoryUri),
    parameters: Type.Object({
      target: Type.String({ description: "Target endpoint URI, for example slock://registry or plugin://local/workspace." }),
      action: Type.String({ description: "Target action name, for example list_endpoints, manifest, list, read, write, edit, or exec." }),
      mime_type: Type.Optional(Type.String({ description: "Payload MIME type. Defaults to application/json, except known non-JSON actions such as shell exec." })),
      payload: Type.Optional(Type.Any({ description: "Value to send as payload.data, or an EnvelopePayload object with mime_type and data." })),
      ttl_ms: Type.Optional(Type.Number({ description: "Optional call TTL in milliseconds. Leave unset unless the user or manifest explicitly needs a custom limit." })),
      timeout_ms: Type.Optional(Type.Number({ description: "Optional local wait timeout in milliseconds. Do not set casually; prefer the default unless the user requested a limit, the manifest says the action is long-running, or a previous default timeout failed." })),
    }),
  }];
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

function normalizeIpcCallArgs(value: Record<string, unknown>, shellUri: EndpointUri): IpcCallArgs {
  const rawPayload = Object.hasOwn(value, "payload")
    ? value.payload
    : Object.hasOwn(value, "data")
      ? value.data
      : {};
  const nestedPayload = readEnvelopePayload(rawPayload);

  return {
    target: readString(value, "target") as EndpointUri,
    action: readString(value, "action"),
    mime_type: readOptionalString(value, "mime_type")
      ?? nestedPayload?.mime_type
      ?? defaultMimeType(readString(value, "target") as EndpointUri, readString(value, "action"), shellUri),
    payload: nestedPayload ? nestedPayload.data : rawPayload,
    ttl_ms: readOptionalPositiveNumber(value, "ttl_ms"),
    timeout_ms: readOptionalPositiveNumber(value, "timeout_ms"),
  };
}

function readEnvelopePayload(value: unknown): { mime_type: string; data: unknown } | undefined {
  if (!isRecord(value) || typeof value.mime_type !== "string" || !Object.hasOwn(value, "data")) {
    return undefined;
  }

  return { mime_type: value.mime_type, data: value.data };
}

function createApprovalRequestForIpcCall(
  args: IpcCallArgs,
  workspaceUri: EndpointUri,
  shellUri: EndpointUri,
  memoryUri: EndpointUri,
): SlockApprovalRequest | undefined {
  if (args.target === workspaceUri && args.action === "write") {
    return {
      risk: "file_write",
      summary: `Write ${payloadPath(args.payload) ?? "workspace file"}`,
      proposed_call: { target: args.target, action: args.action, payload: args.payload },
      metadata: { ipc_target: args.target, ipc_action: args.action },
    };
  }

  if (args.target === workspaceUri && args.action === "edit") {
    return {
      risk: "file_edit",
      summary: `Edit ${payloadPath(args.payload) ?? "workspace file"}`,
      proposed_call: { target: args.target, action: args.action, payload: args.payload },
      metadata: { ipc_target: args.target, ipc_action: args.action },
    };
  }

  if (args.target === shellUri && args.action === "exec") {
    return {
      risk: "shell_exec",
      summary: shellSummary(args.payload),
      proposed_call: { target: args.target, action: args.action, payload: args.payload },
      metadata: { ipc_target: args.target, ipc_action: args.action },
    };
  }

  if (args.target === memoryUri && args.action === "summarize") {
    return {
      risk: "memory_write",
      summary: memorySummary(args.payload, "Summarize long-term memory"),
      proposed_call: { target: args.target, action: args.action, payload: args.payload },
      metadata: { ipc_target: args.target, ipc_action: args.action },
    };
  }

  if (args.target === memoryUri && args.action === "record_tool_result") {
    return {
      risk: "memory_write",
      summary: "Record tool result in long-term memory",
      proposed_call: { target: args.target, action: args.action, payload: args.payload },
      metadata: { ipc_target: args.target, ipc_action: args.action },
    };
  }

  if (args.target === memoryUri && args.action === "vector_store") {
    return {
      risk: "memory_admin",
      summary: memorySummary(args.payload, "Run memory vector-store operation"),
      proposed_call: { target: args.target, action: args.action, payload: args.payload },
      metadata: { ipc_target: args.target, ipc_action: args.action },
    };
  }

  return undefined;
}

function attachApprovalGrant(payload: unknown, grant: SlockCapabilityGrant, args: IpcCallArgs): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new Error(`ipc_call ${args.target} ${args.action} requires an object payload for approval_grant`);
  }
  return { ...payload, approval_grant: grant };
}

function defaultMimeType(target: EndpointUri, action: string, shellUri: EndpointUri): string {
  return target === shellUri && action === "exec" ? SLOCK_SHELL_EXEC_MIME : "application/json";
}

function isNonZeroShellResult(args: IpcCallArgs, data: unknown): boolean {
  return args.mime_type === SLOCK_SHELL_EXEC_MIME
    && isRecord(data)
    && typeof data.exit_code === "number"
    && data.exit_code !== 0;
}

function defaultToolTtlMs(args: IpcCallArgs, memoryUri: EndpointUri, toolTtlMs: number, memoryToolTtlMs: number): number {
  return args.target === memoryUri && isMemoryWriteAction(args.action) ? memoryToolTtlMs : toolTtlMs;
}

function isMemoryWriteAction(action: string): boolean {
  return action === "summarize" || action === "record_tool_result" || action === "vector_store";
}

function payloadPath(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.path === "string" ? payload.path : undefined;
}

function shellSummary(payload: unknown): string {
  if (!isRecord(payload) || typeof payload.command !== "string") {
    return "Run shell command";
  }
  const args = Array.isArray(payload.args) ? payload.args.filter((item): item is string => typeof item === "string") : [];
  return `Run ${payload.command}${args.length > 0 ? ` ${args.join(" ")}` : ""}`;
}

function memorySummary(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) {
    return fallback;
  }
  const scope = typeof payload.scope === "string" ? payload.scope : undefined;
  const operation = typeof payload.operation === "string" ? payload.operation : undefined;
  if (scope && operation) {
    return `${fallback}: ${scope}/${operation}`;
  }
  if (scope) {
    return `${fallback}: ${scope}`;
  }
  if (operation) {
    return `${fallback}: ${operation}`;
  }
  return fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof IpcCallError && (error.code === "CALL_ABORTED" || error.code === "PIPELINE_ABORTED");
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

function readOptionalPositiveNumber(value: Record<string, unknown>, key: string): number | undefined {
  const next = readOptionalNumber(value, key);
  return next !== undefined && next > 0 ? next : undefined;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const next = value[key];
  return typeof next === "string" && next.trim().length > 0 ? next : undefined;
}

function ipcCallDescription(
  options: PiSlockToolsOptions,
  registryUri: EndpointUri,
  workspaceUri: EndpointUri,
  shellUri: EndpointUri,
  memoryUri: EndpointUri,
): string {
  const targets = uniqueEndpointUris([registryUri, ...(options.ipc_call_targets ?? [workspaceUri, shellUri, memoryUri])]);
  const targetHint = targets.length > 0 ? ` Known useful target URIs: ${targets.join(", ")}.` : "";
  return [
    "Call IPC endpoint actions through a single CALL/RESOLVE request; all plugin work should go through this tool.",
    `Use ${registryUri} list_endpoints to discover mounted endpoints before choosing a plugin URI.`,
    "For an endpoint you have not inspected in this run, call its manifest action before endpoint-specific actions and follow the manifest payload notes.",
    "Leave timeout_ms and ttl_ms unset by default; only set them when the user asks for a specific limit, the manifest requires it, or a previous default wait timed out. Memory writes have a longer internal default wait.",
    `Use ${workspaceUri} manifest/list/search/read for workspace discovery and file reads.`,
    `Use ${memoryUri} retrieve for long-term memory when user preferences, project history, or prior decisions matter.`,
    "For workspace write/edit and shell exec, this tool requests human approval and attaches the returned capability grant before forwarding the IPC call.",
    "Memory summarize, record_tool_result, and vector_store also request human approval before forwarding.",
    targetHint,
  ].join(" ").trim();
}

function uniqueEndpointUris(values: EndpointUri[]): EndpointUri[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
