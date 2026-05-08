import type { EndpointUri } from "../../protocol/src/index.ts";
import type {
  Artifact,
  CollaborationEvent,
  CollaborationState,
  RenderForAgentRequest,
  RenderedAgentContext,
  SourceRef,
} from "../../collaboration-context/src/index.ts";
import type { SlockMessage } from "../../slock-channel/src/index.ts";

export const KAIROS_SESSION_MANAGER_URI = "app://kairos/session-manager" as EndpointUri;
export const KAIROS_SESSION_ROUTE_MIME = "application/vnd.kairos.session-route+json";
export const KAIROS_SESSION_STATE_MIME = "application/vnd.kairos.session-state+json";

export interface SessionManagerRouteMessageRequest {
  message: SlockMessage;
  mentions?: EndpointUri[];
}

export interface SessionManagerRouteMessageResult {
  session_id: string;
  session_uri: EndpointUri;
  created: boolean;
  attached: boolean;
  source_ref: SourceRef;
  delegations_created: string[];
  barrier_id?: string;
}

export interface SessionManagerResolveRequest {
  source_ref?: SourceRef;
  channel?: EndpointUri;
  message_id?: string;
  thread_id?: string | null;
}

export interface SessionManagerResolveResult {
  session_id?: string;
  session_uri?: EndpointUri;
}

export interface SessionManagerAttachSourceRequest {
  session_id?: string;
  message?: SlockMessage;
  source_ref?: SourceRef;
  reason?: string;
}

export interface SessionManagerSubmitArtifactRequest {
  session_id: string;
  delegation_id?: string;
  artifact: Partial<Artifact> & Pick<Artifact, "author" | "kind" | "content">;
  project?: boolean;
}

export interface SessionManagerSessionSnapshot {
  session_id: string;
  session_uri: EndpointUri;
  events: CollaborationEvent[];
  state: CollaborationState;
}

export interface SessionManagerRenderContextRequest extends RenderForAgentRequest {
  session_id: string;
}

export type SessionManagerRenderContextResult = RenderedAgentContext;
