type JsonSchema = Record<string, unknown>;

export function createDifyBridgeOpenApi() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Kairos Dify Bridge",
      version: "0.1.0",
      description: "HTTP/OpenAPI adapter that lets Dify start and observe local-first Kairos IPC collaboration sessions.",
    },
    paths: {
      "/health": {
        get: {
          operationId: "getKairosBridgeHealth",
          summary: "Check Dify bridge health",
          security: [],
          responses: ok("DifyHealthResponse"),
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getKairosBridgeOpenApi",
          summary: "Read this OpenAPI document",
          security: [],
          responses: ok("DifyOpenApiResponse"),
        },
      },
      "/chat": {
        post: {
          operationId: "startKairosChat",
          summary: "Start a Kairos session from a Dify chat message",
          requestBody: jsonBody("DifyChatRequest"),
          responses: okText(),
        },
      },
      "/sessions": {
        post: {
          operationId: "createKairosSession",
          summary: "Create a Kairos collaboration session",
          requestBody: jsonBody("DifyCreateSessionRequest"),
          responses: ok("DifyCreateSessionResponse"),
        },
      },
      "/sessions/{session_id}": {
        get: {
          operationId: "getKairosSession",
          summary: "Get a Kairos session summary",
          parameters: [pathParam("session_id", "Kairos session id")],
          responses: ok("DifySessionSummary"),
        },
      },
      "/sessions/{session_id}/messages": {
        post: {
          operationId: "postKairosMessage",
          summary: "Attach a Dify message source to a session",
          parameters: [pathParam("session_id", "Kairos session id")],
          requestBody: jsonBody("DifyPostMessageRequest"),
          responses: ok("DifySessionSummary"),
        },
      },
      "/sessions/{session_id}/runs": {
        post: {
          operationId: "startKairosRun",
          summary: "Start agent delegations for a session",
          parameters: [pathParam("session_id", "Kairos session id")],
          requestBody: jsonBody("DifyStartRunRequest"),
          responses: ok("DifyStartRunResponse"),
        },
      },
      "/runs/{run_id}/cancel": {
        post: {
          operationId: "cancelKairosRun",
          summary: "Cancel a Kairos delegation run",
          parameters: [pathParam("run_id", "Kairos delegation id")],
          requestBody: jsonBody("DifyCancelRunRequest"),
          responses: ok("DifyCancelRunResponse"),
        },
      },
      "/sessions/{session_id}/artifacts": {
        get: {
          operationId: "listKairosArtifacts",
          summary: "List session artifact metadata",
          parameters: [pathParam("session_id", "Kairos session id")],
          responses: ok("DifyArtifactListResponse"),
        },
      },
      "/artifacts/{artifact_id}": {
        get: {
          operationId: "readKairosArtifact",
          summary: "Read a Kairos artifact body",
          parameters: [
            pathParam("artifact_id", "Kairos artifact id"),
            queryParam("session_id", "Optional session id used to avoid cross-session artifact lookup"),
          ],
          responses: ok("DifyArtifactDetail"),
        },
      },
      "/artifacts/{artifact_id}/review": {
        post: {
          operationId: "reviewKairosArtifact",
          summary: "Review a Kairos artifact",
          parameters: [pathParam("artifact_id", "Kairos artifact id")],
          requestBody: jsonBody("DifyReviewArtifactRequest"),
          responses: ok("DifyReviewArtifactResponse"),
        },
      },
      "/sessions/{session_id}/approvals": {
        get: {
          operationId: "listKairosApprovals",
          summary: "List pending session approvals",
          parameters: [pathParam("session_id", "Kairos session id")],
          responses: ok("DifyApprovalListResponse"),
        },
      },
      "/approvals/{approval_id}/resolve": {
        post: {
          operationId: "resolveKairosApproval",
          summary: "Resolve a Kairos approval",
          parameters: [pathParam("approval_id", "Kairos approval id")],
          requestBody: jsonBody("DifyResolveApprovalRequest"),
          responses: ok("DifyResolveApprovalResponse"),
        },
      },
      "/sessions/{session_id}/trace": {
        get: {
          operationId: "getKairosSessionTrace",
          summary: "Read trace events related to a session",
          parameters: [pathParam("session_id", "Kairos session id")],
          responses: ok("DifyTraceResult"),
        },
      },
      "/runs/{run_id}/trace": {
        get: {
          operationId: "getKairosRunTrace",
          summary: "Read trace events related to a delegation run",
          parameters: [pathParam("run_id", "Kairos delegation id")],
          responses: ok("DifyTraceResult"),
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        bridgeToken: { type: "apiKey", in: "header", name: "x-kairos-bridge-token" },
      },
      schemas: createSchemas(),
    },
    security: [{ bearerAuth: [] }, { bridgeToken: [] }],
  };
}

function createSchemas(): Record<string, JsonSchema> {
  return {
    DifyHealthResponse: object({ ok: { type: "boolean" } }, ["ok"]),
    DifyOpenApiResponse: { type: "object", additionalProperties: true },
    DifyApiError: object({
      error: object({
        code: { type: "string" },
        message: { type: "string" },
      }, ["code", "message"]),
    }, ["error"]),
    DifySourceMetadata: object({
      app_id: { type: "string" },
      conversation_id: { type: "string" },
      message_id: { type: "string" },
      user_id: { type: "string" },
      workflow_run_id: { type: "string" },
    }),
    SourceRef: {
      oneOf: [
        object({
          kind: { const: "channel_message" },
          channel: { type: "string" },
          message_id: { type: "string" },
        }, ["kind", "channel", "message_id"]),
        object({
          kind: { const: "artifact" },
          artifact_id: { type: "string" },
        }, ["kind", "artifact_id"]),
        object({
          kind: { const: "ipc_envelope" },
          trace_id: { type: "string" },
          correlation_id: { type: "string" },
          msg_id: { type: "string" },
        }, ["kind"]),
        object({
          kind: { const: "file" },
          uri: { type: "string" },
          version: { type: "string" },
        }, ["kind", "uri"]),
        object({
          kind: { const: "external" },
          uri: { type: "string" },
          label: { type: "string" },
        }, ["kind", "uri"]),
      ],
    },
    TraceRef: object({
      trace_id: { type: "string" },
      correlation_id: { type: "string" },
      msg_id: { type: "string" },
      endpoint: { type: "string" },
      action: { type: "string" },
      label: { type: "string" },
      severity: { type: "string", enum: ["info", "warning", "error"] },
      object_ref: { type: "string" },
    }, ["label"]),
    DifyCreateSessionRequest: object({
      title: { type: "string" },
      objective: { type: "string" },
      acceptance_criteria: arrayOf({ type: "string" }),
      source: ref("DifySourceMetadata"),
    }),
    DifyCreateSessionResponse: object({
      session_id: { type: "string" },
      session_uri: { type: "string" },
      status: { type: "string" },
    }, ["session_id", "session_uri"]),
    DifyPostMessageRequest: object({
      text: { type: "string" },
      source: ref("DifySourceMetadata"),
    }),
    DifyChatRequest: object({
      message: { type: "string" },
      title: { type: "string" },
      agents: arrayOf({ type: "string" }),
      acceptance_criteria: arrayOf({ type: "string" }),
      expected_output: { type: "string" },
      source: ref("DifySourceMetadata"),
    }, ["message"]),
    DifyDelegationPlanItem: object({
      assignee: { type: "string" },
      role: { type: "string" },
      role_label: { type: "string" },
      instruction: { type: "string" },
      expected_output: { type: "string" },
    }, ["assignee"]),
    DifyStartRunRequest: {
      ...object({
        instruction: { type: "string" },
        agents: arrayOf({ type: "string" }),
        mode: { type: "string", enum: ["parallel", "sequential"] },
        expected_output: { type: "string" },
        synthesis_requested: { type: "boolean" },
        delegation_plan: arrayOf(ref("DifyDelegationPlanItem")),
        source: ref("DifySourceMetadata"),
      }, ["instruction"]),
      anyOf: [{ required: ["agents"] }, { required: ["delegation_plan"] }],
    },
    DifyRunSummary: object({
      agent: { type: "string" },
      delegation_id: { type: "string" },
      status: { type: "string" },
    }, ["agent", "delegation_id"]),
    DifyStartRunResponse: object({
      session_id: { type: "string" },
      runs: arrayOf(ref("DifyRunSummary")),
      task_id: { type: "string" },
      barrier_id: { type: "string" },
      mode: { type: "string", enum: ["parallel", "sequential"] },
      status_url: { type: "string" },
    }, ["session_id", "runs", "status_url"]),
    DifyCancelRunRequest: object({
      session_id: { type: "string" },
      reason: { type: "string" },
    }),
    DifyCancelRunResponse: object({
      cancelled: { type: "boolean" },
      session_id: { type: "string" },
      delegation_id: { type: "string" },
      agent: { type: "string" },
      reason: { type: "string" },
    }, ["cancelled", "session_id", "delegation_id"]),
    DifySessionSummary: object({
      session_id: { type: "string" },
      session_uri: { type: "string" },
      title: { type: "string" },
      objective: { type: "string" },
      phase: { type: "string" },
      status: { type: "string" },
      agents: arrayOf({ type: "string" }),
      latest_summary: { type: "string" },
      latest_artifact: ref("DifyArtifactMetadata"),
      blockers: arrayOf({ type: "string" }),
      pending_approvals: arrayOf(ref("DifyApprovalSummary")),
      trace_refs: arrayOf(ref("TraceRef")),
    }, ["session_id", "agents", "blockers", "pending_approvals", "trace_refs"]),
    DifyArtifactMetadata: object({
      id: { type: "string" },
      session_id: { type: "string" },
      author: { type: "string" },
      kind: { type: "string" },
      title: { type: "string" },
      status: { type: "string" },
      summary: { type: "string", maxLength: 320 },
      created_at: { type: "string" },
      updated_at: { type: "string" },
      source_refs: arrayOf(ref("SourceRef")),
      trace_refs: arrayOf(ref("TraceRef")),
    }, ["id", "session_id", "author", "kind"]),
    DifyArtifactListResponse: object({
      session_id: { type: "string" },
      artifacts: arrayOf(ref("DifyArtifactMetadata")),
    }, ["session_id", "artifacts"]),
    DifyArtifactReview: object({
      reviewer: { type: "string" },
      status: { type: "string", enum: ["accepted", "rejected", "revision_requested"] },
      note: { type: "string" },
      reviewed_at: { type: "string" },
    }, ["reviewer", "status", "reviewed_at"]),
    DifyArtifactDetail: {
      allOf: [
        ref("DifyArtifactMetadata"),
        object({
          content: {},
          review: ref("DifyArtifactReview"),
          relates_to: arrayOf({ type: "string" }),
        }, ["content"]),
      ],
    },
    DifyReviewArtifactRequest: object({
      session_id: { type: "string" },
      status: { type: "string", enum: ["accepted", "rejected", "revision_requested"] },
      note: { type: "string" },
      reviewer: { type: "string" },
      revision_instruction: { type: "string" },
      rerun: { type: "boolean" },
      source: ref("DifySourceMetadata"),
    }, ["status"]),
    DifyReviewArtifactResponse: object({
      session_id: { type: "string" },
      artifact_id: { type: "string" },
      status: { type: "string", enum: ["accepted", "rejected", "revision_requested"] },
      note: { type: "string" },
    }, ["session_id", "artifact_id", "status"]),
    DifyApprovalSummary: object({
      id: { type: "string" },
      session_id: { type: "string" },
      requester: { type: "string" },
      tool_endpoint: { type: "string" },
      action: { type: "string" },
      risk: { type: "string" },
      payload_summary: { type: "string" },
      status: { type: "string" },
      created_at: { type: "string" },
      resolved_at: { type: "string" },
      resolved_by: { type: "string" },
      resolution_note: { type: "string" },
    }, ["id", "session_id", "requester", "tool_endpoint", "action", "risk", "payload_summary", "status"]),
    DifyApprovalListResponse: object({
      session_id: { type: "string" },
      approvals: arrayOf(ref("DifyApprovalSummary")),
    }, ["session_id", "approvals"]),
    DifyResolveApprovalRequest: object({
      session_id: { type: "string" },
      status: { type: "string", enum: ["approved", "rejected", "cancelled", "expired"] },
      approved: { type: "boolean" },
      resolved_by: { type: "string" },
      resolution_note: { type: "string" },
    }),
    DifyResolveApprovalResponse: object({
      session_id: { type: "string" },
      approval_id: { type: "string" },
      status: { type: "string" },
    }, ["session_id", "approval_id", "status"]),
    DifyTraceResult: object({
      available: { type: "boolean" },
      trace_path: { type: "string" },
      view: { type: "object", additionalProperties: true },
    }, ["available", "view"]),
  };
}

function object(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  };
}

function arrayOf(items: JsonSchema): JsonSchema {
  return { type: "array", items };
}

function ref(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonBody(schemaName: string): JsonSchema {
  return {
    required: true,
    content: {
      "application/json": {
        schema: ref(schemaName),
      },
    },
  };
}

function ok(schemaName: string): JsonSchema {
  return {
    "200": {
      description: "OK",
      content: {
        "application/json": {
          schema: ref(schemaName),
        },
      },
    },
    default: {
      description: "Error",
      content: {
        "application/json": {
          schema: ref("DifyApiError"),
        },
      },
    },
  };
}

function okText(): JsonSchema {
  return {
    "200": {
      description: "OK",
      content: {
        "text/plain": {
          schema: { type: "string" },
        },
      },
    },
    default: {
      description: "Error",
      content: {
        "application/json": {
          schema: ref("DifyApiError"),
        },
      },
    },
  };
}

function pathParam(name: string, description: string): JsonSchema {
  return {
    name,
    in: "path",
    required: true,
    description,
    schema: { type: "string" },
  };
}

function queryParam(name: string, description: string): JsonSchema {
  return {
    name,
    in: "query",
    required: false,
    description,
    schema: { type: "string" },
  };
}
