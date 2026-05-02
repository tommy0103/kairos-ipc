import type { EndpointUri } from "../../protocol/src/index.ts";
import { createNode, type IpcNode } from "../../sdk/src/index.ts";

export const SLOCK_REGISTRY_URI = "slock://registry" as EndpointUri;

export type SlockRegistryEndpointKind = "system" | "plugin" | "agent" | "channel" | "human" | "app";

export interface SlockRegistryEndpoint {
  uri: EndpointUri;
  kind: SlockRegistryEndpointKind;
  label?: string;
  description?: string;
  manifest_action?: "manifest";
  internal?: boolean;
}

export interface SlockRegistryOptions {
  uri?: EndpointUri;
  endpoints: SlockRegistryEndpoint[];
}

export interface SlockRegistry {
  node: IpcNode;
}

interface ListEndpointsRequest {
  kind?: SlockRegistryEndpointKind;
  include_internal?: boolean;
}

interface ListEndpointsResponse {
  registry_uri: EndpointUri;
  endpoints: SlockRegistryEndpoint[];
}

export function createSlockRegistry(options: SlockRegistryOptions): SlockRegistry {
  const uri = options.uri ?? SLOCK_REGISTRY_URI;
  const node = createNode(uri);
  const endpoints = uniqueEndpoints([
    {
      uri,
      kind: "system",
      label: "Slock registry",
      description: "Lists daemon-mounted IPC endpoints.",
      manifest_action: "manifest",
    },
    ...options.endpoints,
  ]);

  node.action<ListEndpointsRequest, ListEndpointsResponse>(
    "list_endpoints",
    {
      description: "List daemon-mounted root IPC endpoints only. Call a root endpoint's manifest before endpoint-specific actions; if that manifest exposes list_children, use it for deeper endpoint/namespace discovery and read child manifests before child endpoint actions.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = readRequest(payload.data);
      const visible = endpoints.filter((endpoint) => endpointVisible(endpoint, request));
      return {
        mime_type: "application/json",
        data: {
          registry_uri: uri,
          endpoints: visible,
        },
      };
    },
  );

  return { node };
}

function endpointVisible(endpoint: SlockRegistryEndpoint, request: ListEndpointsRequest): boolean {
  if (!request.include_internal && endpoint.internal) {
    return false;
  }
  return !request.kind || endpoint.kind === request.kind;
}

function readRequest(value: unknown): ListEndpointsRequest {
  if (value === null || value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("registry.list_endpoints requires an object payload");
  }

  const kind = typeof value.kind === "string" && isEndpointKind(value.kind) ? value.kind : undefined;
  return {
    ...(kind ? { kind } : {}),
    ...(value.include_internal === true ? { include_internal: true } : {}),
  };
}

function uniqueEndpoints(endpoints: SlockRegistryEndpoint[]): SlockRegistryEndpoint[] {
  const seen = new Set<EndpointUri>();
  const result: SlockRegistryEndpoint[] = [];
  for (const endpoint of endpoints) {
    if (seen.has(endpoint.uri)) {
      continue;
    }
    seen.add(endpoint.uri);
    result.push(endpoint.manifest_action ? endpoint : { ...endpoint, manifest_action: "manifest" });
  }
  return result;
}

function isEndpointKind(value: string): value is SlockRegistryEndpointKind {
  return value === "system" || value === "plugin" || value === "agent" || value === "channel" || value === "human" || value === "app";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
