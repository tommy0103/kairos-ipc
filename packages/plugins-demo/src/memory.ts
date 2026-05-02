import { createNode, z, type IpcNode } from "../../sdk/src/index.ts";
import type { EndpointUri } from "../../protocol/src/index.ts";
import type { SlockCapabilityGrant, SlockGrantStore } from "../../slock-channel/src/index.ts";

export type MemoryScope = "personal" | "task" | "tool";
export type MemoryProvider = "reme-http";

export interface ReMeMemoryPluginOptions {
  uri?: EndpointUri;
  provider?: MemoryProvider;
  base_url: string;
  workspace_id?: string;
  timeout_ms?: number;
  grant_store?: SlockGrantStore;
}

export interface ReMeMemoryPlugin {
  node: IpcNode;
}

interface ReMeResponse {
  provider: MemoryProvider;
  endpoint: string;
  scope?: MemoryScope;
  memories?: string[];
  raw: unknown;
}

const DEFAULT_URI = "plugin://memory/reme" as EndpointUri;
const workspaceIdSchema = z.string().min(1).optional().describe("Optional workspace id. If omitted, the daemon-configured workspace is used.");
const approvalGrantSchema = z.unknown().optional().describe("Temporary Slock approval grant attached by ipc_call after human approval. Do not invent manually.");
const memoryScopeSchema = z.enum(["personal", "task", "tool"]).describe("Memory scope. Use personal for user preferences, task for project decisions, and tool for tool guidance.");
const remeMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]).describe("Message role accepted by ReMe trajectory summarization. Use user for facts or preferences stated by the user."),
  content: z.string().min(1).describe("Natural-language message content."),
  metadata: z.record(z.string(), z.unknown()).optional().describe("Optional message metadata forwarded to ReMe."),
}).describe("One message inside a ReMe memory trajectory.");
const remeTrajectorySchema = z.object({
  messages: z.array(remeMessageSchema).min(1).describe("Ordered conversation messages to summarize. Must be non-empty."),
  score: z.number().optional().describe("Optional success score. Use 1.0 for a positive preference or fact observation."),
  task_id: z.string().optional().describe("Optional task id for task memory grouping."),
  metadata: z.record(z.string(), z.unknown()).optional().describe("Optional trajectory metadata forwarded to ReMe."),
}).describe("Conversation trajectory that ReMe summarizes into long-term memory.");
const retrieveRequestSchema = z.object({
  scope: memoryScopeSchema.describe("Memory scope to retrieve. Use personal for user preferences, task for project decisions, and tool for tool guidance."),
  workspace_id: workspaceIdSchema,
  query: z.string().optional().describe("Retrieval query. Required for personal/task memory; for tool memory prefer retrieve_tool_guidelines."),
  top_k: z.number().int().positive().optional().describe("Maximum result count. Leave unset unless needed; daemon defaults apply."),
  tool_names: z.string().optional().describe("Comma-separated tool names when scope is tool."),
}).passthrough().describe("Retrieve personal, task, or tool memory from ReMe.");
const summarizeRequestSchema = z.object({
  scope: memoryScopeSchema.describe("Target memory scope. User preferences and stable user facts should use personal. Project decisions should use task."),
  workspace_id: workspaceIdSchema,
  trajectories: z.array(remeTrajectorySchema).min(1).describe("Required ReMe input. Do not send a summary field directly; wrap the fact as trajectory messages."),
  approval_grant: approvalGrantSchema,
}).passthrough().describe("Summarize trajectories into long-term memory.");
const toolCallResultSchema = z.object({
  tool_name: z.string().min(1).describe("Tool name, for example plugin://local/workspace search or workspace.search."),
  input: z.unknown().describe("Tool input payload."),
  output: z.unknown().describe("Tool output or error text."),
  success: z.boolean().describe("Whether the tool call succeeded."),
  time_cost: z.number().optional().describe("Optional wall-clock cost in seconds."),
  token_cost: z.number().optional().describe("Optional token cost."),
  create_time: z.string().optional().describe("Optional creation timestamp."),
}).passthrough().describe("Actual tool call outcome to store in ReMe tool memory.");
const recordToolResultRequestSchema = z.object({
  workspace_id: workspaceIdSchema,
  tool_call_results: z.array(toolCallResultSchema).min(1).describe("Actual tool call outcomes only. Do not use this for user preferences."),
  approval_grant: approvalGrantSchema,
}).passthrough().describe("Record actual tool call results into ReMe tool memory.");
const retrieveToolGuidelinesRequestSchema = z.object({
  workspace_id: workspaceIdSchema,
  tool_names: z.string().min(1).describe("Comma-separated tool names."),
}).passthrough().describe("Retrieve usage guidance for named tools.");
const vectorStoreRequestSchema = z.object({
  action: z.string().optional().describe("ReMe vector store action, commonly list, delete, load, dump, or clear."),
  operation: z.string().optional().describe("Slock-compatible alias for action. The plugin rewrites operation to action before calling ReMe."),
  workspace_id: workspaceIdSchema,
  approval_grant: approvalGrantSchema,
}).passthrough().describe("Run administrative ReMe vector-store operations.");
const memoryResponseSchema = z.object({
  provider: z.literal("reme-http").describe("Memory provider used by this plugin."),
  endpoint: z.string().describe("ReMe HTTP endpoint that handled the request."),
  scope: memoryScopeSchema.optional().describe("Memory scope involved in this response, when applicable."),
  memories: z.array(z.string()).optional().describe("Extracted memory strings, when the ReMe response shape contains them."),
  raw: z.unknown().describe("Raw ReMe response body."),
}).describe("Normalized ReMe memory plugin response.");

type RetrieveRequest = z.infer<typeof retrieveRequestSchema>;
type SummarizeRequest = z.infer<typeof summarizeRequestSchema>;
type RecordToolResultRequest = z.infer<typeof recordToolResultRequestSchema>;
type RetrieveToolGuidelinesRequest = z.infer<typeof retrieveToolGuidelinesRequestSchema>;
type VectorStoreRequest = z.infer<typeof vectorStoreRequestSchema>;

export function createReMeMemoryPlugin(options: ReMeMemoryPluginOptions): ReMeMemoryPlugin {
  const uri = options.uri ?? DEFAULT_URI;
  const provider = options.provider ?? "reme-http";
  const timeoutMs = options.timeout_ms ?? 30000;
  const node = createNode(uri);

  node.children([
    {
      uri: `${uri}/personal` as EndpointUri,
      label: "personal memory",
      kind: "namespace",
      description: "Personal long-term memory namespace. Use the root retrieve/summarize actions with scope=personal after reading the root manifest.",
    },
    {
      uri: `${uri}/task` as EndpointUri,
      label: "task memory",
      kind: "namespace",
      description: "Task/project memory namespace. Use the root retrieve/summarize actions with scope=task after reading the root manifest.",
    },
    {
      uri: `${uri}/tool` as EndpointUri,
      label: "tool memory",
      kind: "namespace",
      description: "Tool-use memory namespace. Use retrieve_tool_guidelines, record_tool_result, or vector_store from the root manifest as appropriate.",
    },
  ]);

  if (provider !== "reme-http") {
    throw new Error(`unsupported memory provider: ${provider}`);
  }

  node.action<RetrieveRequest, ReMeResponse>(
    "retrieve",
    {
      doc: "Retrieve personal, task, or tool memory from ReMe.",
      accepts: "application/json",
      returns: "application/json",
      input: retrieveRequestSchema,
      output: memoryResponseSchema,
      input_name: "ReMeRetrieveRequest",
      output_name: "ReMeMemoryResponse",
    },
    async ({ input }) => {
      const request = input;
      const scope = request.scope;
      const endpoint = retrieveEndpoint(scope);
      const raw = await postReMe(endpoint, withWorkspace(request), options.base_url, timeoutMs);
      return { mime_type: "application/json", data: response(provider, endpoint, scope, raw) };
    },
  );

  node.action<SummarizeRequest, ReMeResponse>(
    "summarize",
    {
      doc: "Summarize trajectories into long-term memory. To remember one fact, wrap it as a user message: { scope: \"personal\", trajectories: [{ messages: [{ role: \"user\", content: \"User likes apples.\" }], score: 1.0 }] }. Do not send a summary field directly.",
      accepts: "application/json",
      returns: "application/json",
      input: summarizeRequestSchema,
      output: memoryResponseSchema,
      input_name: "ReMeSummarizeRequest",
      output_name: "ReMeMemoryResponse",
      examples: [{ scope: "personal", trajectories: [{ messages: [{ role: "user", content: "User likes apples." }], score: 1.0 }] }],
    },
    async ({ input, context }) => {
      const request = input;
      assertGrant(options.grant_store, request.approval_grant as SlockCapabilityGrant | undefined, context.envelope.header.source, uri, "summarize");
      const scope = request.scope;
      const endpoint = summarizeEndpoint(scope);
      const raw = await postReMe(endpoint, withWorkspace(omitApprovalGrant(request)), options.base_url, timeoutMs);
      return { mime_type: "application/json", data: response(provider, endpoint, scope, raw) };
    },
  );

  node.action<RecordToolResultRequest, ReMeResponse>(
    "record_tool_result",
    {
      doc: "Record actual tool call results into ReMe tool memory. Do not use for user preferences or project facts.",
      accepts: "application/json",
      returns: "application/json",
      input: recordToolResultRequestSchema,
      output: memoryResponseSchema,
      input_name: "ReMeRecordToolResultRequest",
      output_name: "ReMeMemoryResponse",
    },
    async ({ input, context }) => {
      const request = input;
      assertGrant(options.grant_store, request.approval_grant as SlockCapabilityGrant | undefined, context.envelope.header.source, uri, "record_tool_result");
      const endpoint = "/add_tool_call_result";
      const raw = await postReMe(endpoint, withWorkspace(omitApprovalGrant(request)), options.base_url, timeoutMs);
      return { mime_type: "application/json", data: response(provider, endpoint, "tool", raw) };
    },
  );

  node.action<RetrieveToolGuidelinesRequest, ReMeResponse>(
    "retrieve_tool_guidelines",
    {
      doc: "Retrieve ReMe tool memory guidelines. Payload: { workspace_id?, tool_names }.",
      accepts: "application/json",
      returns: "application/json",
      input: retrieveToolGuidelinesRequestSchema,
      output: memoryResponseSchema,
      input_name: "ReMeRetrieveToolGuidelinesRequest",
      output_name: "ReMeMemoryResponse",
    },
    async ({ input }) => {
      const request = input;
      const endpoint = "/retrieve_tool_memory";
      const raw = await postReMe(endpoint, withWorkspace(request), options.base_url, timeoutMs);
      return { mime_type: "application/json", data: response(provider, endpoint, "tool", raw) };
    },
  );

  node.action<VectorStoreRequest, ReMeResponse>(
    "vector_store",
    {
      doc: "Run an administrative ReMe vector-store operation. Requires approval.",
      accepts: "application/json",
      returns: "application/json",
      input: vectorStoreRequestSchema,
      output: memoryResponseSchema,
      input_name: "ReMeVectorStoreRequest",
      output_name: "ReMeMemoryResponse",
    },
    async ({ input, context }) => {
      const request = input;
      assertGrant(options.grant_store, request.approval_grant as SlockCapabilityGrant | undefined, context.envelope.header.source, uri, "vector_store");
      const endpoint = "/vector_store";
      const raw = await postReMe(endpoint, withWorkspace(normalizeVectorStoreRequest(omitApprovalGrant(request))), options.base_url, timeoutMs);
      return { mime_type: "application/json", data: response(provider, endpoint, undefined, raw) };
    },
  );

  function withWorkspace(request: Record<string, unknown>): Record<string, unknown> {
    if (request.workspace_id || !options.workspace_id) {
      return request;
    }
    return { ...request, workspace_id: options.workspace_id };
  }

  return { node };
}

function retrieveEndpoint(scope: MemoryScope): string {
  switch (scope) {
    case "personal":
      return "/retrieve_personal_memory";
    case "task":
      return "/retrieve_task_memory";
    case "tool":
      return "/retrieve_tool_memory";
  }
}

function summarizeEndpoint(scope: MemoryScope): string {
  switch (scope) {
    case "personal":
      return "/summary_personal_memory";
    case "task":
      return "/summary_task_memory";
    case "tool":
      return "/summary_tool_memory";
  }
}

function omitApprovalGrant(request: Record<string, unknown>): Record<string, unknown> {
  const { approval_grant: _approvalGrant, ...rest } = request;
  return rest;
}

function normalizeVectorStoreRequest(request: Record<string, unknown>): Record<string, unknown> {
  if (typeof request.action === "string" || typeof request.operation !== "string") {
    return request;
  }
  const { operation, ...rest } = request;
  return { ...rest, action: operation };
}

function response(provider: MemoryProvider, endpoint: string, scope: MemoryScope | undefined, raw: unknown): ReMeResponse {
  return {
    provider,
    endpoint,
    ...(scope ? { scope } : {}),
    memories: extractMemories(raw),
    raw,
  };
}

async function postReMe(endpoint: string, payload: Record<string, unknown>, baseUrl: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await fetch(joinUrl(baseUrl, endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await result.text();
    const data = text.length > 0 ? parseJson(text) : null;
    if (!result.ok) {
      throw new Error(`ReMe ${endpoint} failed with HTTP ${result.status}: ${text}`);
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`ReMe ${endpoint} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function joinUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

function extractMemories(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(extractMemories).filter(Boolean);
  }

  if (!isRecord(value)) {
    return [];
  }

  for (const key of ["memories", "memory", "results", "result", "data", "content", "guidelines", "summary"]) {
    if (Object.hasOwn(value, key)) {
      const extracted = extractMemories(value[key]);
      if (extracted.length > 0) {
        return extracted;
      }
    }
  }

  if (typeof value.text === "string") {
    return [value.text];
  }
  if (typeof value.content === "string") {
    return [value.content];
  }

  return [];
}

function assertGrant(
  store: SlockGrantStore | undefined,
  grant: SlockCapabilityGrant | undefined,
  source: string,
  target: string,
  action: string,
): void {
  if (!store) {
    return;
  }

  const decision = store.check({ grant, source, target, action });
  if (!decision.allowed) {
    throw new Error(decision.message ?? decision.code ?? "capability grant denied");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
