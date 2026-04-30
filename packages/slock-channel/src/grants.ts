import { randomUUID } from "node:crypto";
import type { EndpointUri } from "../../protocol/src/index.ts";
import type { SlockCapabilityGrant } from "./types.ts";

export interface SlockGrantIssueRequest {
  source: EndpointUri;
  target: EndpointUri;
  action: string;
  ttl_ms: number;
  approval_id?: string;
  risk?: string;
}

export interface SlockGrantCheckRequest {
  grant?: SlockCapabilityGrant;
  source: EndpointUri;
  target: EndpointUri;
  action: string;
  now?: Date;
}

export interface SlockGrantDecision {
  allowed: boolean;
  code?: string;
  message?: string;
}

export interface SlockGrantStore {
  issue(request: SlockGrantIssueRequest): SlockCapabilityGrant;
  check(request: SlockGrantCheckRequest): SlockGrantDecision;
}

export function createSlockGrantStore(): SlockGrantStore {
  const grants = new Map<string, SlockCapabilityGrant>();

  return {
    issue(request) {
      const issuedAt = new Date();
      const grant: SlockCapabilityGrant = {
        id: `grant_${randomUUID()}`,
        token: randomUUID(),
        source: request.source,
        target: request.target,
        actions: [request.action],
        issued_at: issuedAt.toISOString(),
        expires_at: new Date(issuedAt.getTime() + Math.max(0, request.ttl_ms)).toISOString(),
        approval_id: request.approval_id,
        risk: request.risk,
      };
      grants.set(grant.id, grant);
      return grant;
    },

    check(request) {
      const grant = request.grant;
      if (!grant) {
        return { allowed: false, code: "GRANT_REQUIRED", message: "capability grant is required" };
      }

      const stored = grants.get(grant.id);
      if (!stored || stored.token !== grant.token) {
        return { allowed: false, code: "GRANT_INVALID", message: "capability grant is invalid" };
      }

      const now = request.now ?? new Date();
      if (Date.parse(stored.expires_at) <= now.getTime()) {
        grants.delete(stored.id);
        return { allowed: false, code: "GRANT_EXPIRED", message: "capability grant has expired" };
      }

      if (stored.source !== request.source) {
        return { allowed: false, code: "GRANT_SOURCE_MISMATCH", message: "capability grant source does not match caller" };
      }

      if (stored.target !== request.target) {
        return { allowed: false, code: "GRANT_TARGET_MISMATCH", message: "capability grant target does not match endpoint" };
      }

      if (!stored.actions.includes(request.action)) {
        return { allowed: false, code: "GRANT_ACTION_DENIED", message: "capability grant does not allow this action" };
      }

      return { allowed: true };
    },
  };
}
