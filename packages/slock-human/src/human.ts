import { createMsgId } from "../../protocol/src/index.ts";
import { createNode, type IpcNode } from "../../sdk/src/index.ts";
import {
  createSlockGrantStore,
  SLOCK_APPROVAL_REQUEST_MIME,
  SLOCK_APPROVAL_RESULT_MIME,
  type SlockApprovalRequest,
  type SlockApprovalResult,
  type SlockApprovalWithdrawRequest,
  type SlockApprovalWithdrawResult,
  type SlockGrantStore,
} from "../../slock-channel/src/index.ts";

export interface PendingApproval {
  id: string;
  request: SlockApprovalRequest;
  source: string;
  created_at: string;
}

export type ApprovalListener = (approval: PendingApproval) => void;
export type ApprovalResolvedListener = (resolution: ApprovalResolution) => void;
export type AutoApprovalPolicy = (approval: PendingApproval) => SlockApprovalResult | Promise<SlockApprovalResult>;

export interface ApprovalResolution {
  id: string;
  result: SlockApprovalResult;
  source: "decide" | "withdraw" | "auto";
}

export interface SlockHumanOptions {
  uri?: string;
  auto_approval?: AutoApprovalPolicy;
  grant_store?: SlockGrantStore;
}

export interface SlockHumanEndpoint {
  node: IpcNode;
  pendingApprovals: Map<string, PendingApproval>;
  onApprovalRequest(listener: ApprovalListener): () => void;
  onApprovalResolved(listener: ApprovalResolvedListener): () => void;
  decide(id: string, result: SlockApprovalResult): void;
}

interface ApprovalWaiter {
  resolve(result: SlockApprovalResult): void;
  reject(error: Error): void;
}

export function createSlockHuman(options: SlockHumanOptions = {}): SlockHumanEndpoint {
  const node = createNode(options.uri ?? "human://user/local");
  const pendingApprovals = new Map<string, PendingApproval>();
  const waiters = new Map<string, ApprovalWaiter>();
  const listeners = new Set<ApprovalListener>();
  const resolvedListeners = new Set<ApprovalResolvedListener>();
  const grantStore = options.grant_store ?? createSlockGrantStore();

  node.action<SlockApprovalRequest, SlockApprovalResult>(
    "request_approval",
    {
      description: "Ask the human endpoint to approve or deny a proposed action.",
      accepts: SLOCK_APPROVAL_REQUEST_MIME,
      returns: SLOCK_APPROVAL_RESULT_MIME,
    },
    async (payload, context) => {
      const request = payload.data;
      const id = request.id ?? createMsgId("approval");
      const approval: PendingApproval = {
        id,
        request: { ...request, id },
        source: context.envelope.header.source,
        created_at: new Date().toISOString(),
      };

      if (options.auto_approval) {
        const result = addGrant(approval, await options.auto_approval(approval));
        notifyResolved({ id, result, source: "auto" });
        return { mime_type: SLOCK_APPROVAL_RESULT_MIME, data: result };
      }

      pendingApprovals.set(id, approval);
      for (const listener of listeners) {
        listener(approval);
      }

      const result = await new Promise<SlockApprovalResult>((resolve, reject) => {
        waiters.set(id, { resolve, reject });
      });

      return { mime_type: SLOCK_APPROVAL_RESULT_MIME, data: result };
    },
  );

  node.action<SlockApprovalWithdrawRequest, SlockApprovalWithdrawResult>(
    "withdraw_approval",
    {
      description: "Withdraw a pending human approval request.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = readWithdrawRequest(payload.data);
      const result: SlockApprovalResult = {
        approved: false,
        reason: request.reason ?? "cancelled",
      };

      const withdrawn = resolveApproval(request.id, result, "withdraw");
      return {
        mime_type: "application/json",
        data: {
          withdrawn,
          id: request.id,
          reason: result.reason,
        },
      };
    },
  );

  return {
    node,
    pendingApprovals,
    onApprovalRequest(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onApprovalResolved(listener) {
      resolvedListeners.add(listener);
      return () => resolvedListeners.delete(listener);
    },
    decide(id, result) {
      if (!resolveApproval(id, result, "decide")) {
        throw new Error(`approval request not found: ${id}`);
      }
    },
  };

  function resolveApproval(id: string, result: SlockApprovalResult, source: ApprovalResolution["source"]): boolean {
    const waiter = waiters.get(id);
    const approval = pendingApprovals.get(id);
    if (!waiter) {
      return false;
    }

    const nextResult = approval ? addGrant(approval, result) : result;
    waiters.delete(id);
    pendingApprovals.delete(id);
    waiter.resolve(nextResult);
    notifyResolved({ id, result: nextResult, source });
    return true;
  }

  function addGrant(approval: PendingApproval, result: SlockApprovalResult): SlockApprovalResult {
    if (!result.approved || result.grant) {
      return result;
    }

    return {
      ...result,
      grant: grantStore.issue({
        source: approval.source,
        target: approval.request.proposed_call.target,
        action: approval.request.proposed_call.action,
        ttl_ms: result.grant_ttl_ms ?? 60000,
        approval_id: approval.id,
        risk: approval.request.risk,
      }),
    };
  }

  function notifyResolved(resolution: ApprovalResolution): void {
    for (const listener of resolvedListeners) {
      listener(resolution);
    }
  }
}

function readWithdrawRequest(value: unknown): SlockApprovalWithdrawRequest {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new Error("withdraw_approval requires id");
  }
  return {
    id: value.id,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
