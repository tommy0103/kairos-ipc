import { createMsgId } from "../../protocol/src/index.ts";
import { createNode, type IpcNode } from "../../sdk/src/index.ts";
import {
  SLOCK_APPROVAL_REQUEST_MIME,
  SLOCK_APPROVAL_RESULT_MIME,
  type SlockApprovalRequest,
  type SlockApprovalResult,
} from "../../slock-channel/src/index.ts";

export interface PendingApproval {
  id: string;
  request: SlockApprovalRequest;
  source: string;
  created_at: string;
}

export type ApprovalListener = (approval: PendingApproval) => void;
export type AutoApprovalPolicy = (approval: PendingApproval) => SlockApprovalResult | Promise<SlockApprovalResult>;

export interface SlockHumanOptions {
  uri?: string;
  auto_approval?: AutoApprovalPolicy;
}

export interface SlockHumanEndpoint {
  node: IpcNode;
  pendingApprovals: Map<string, PendingApproval>;
  onApprovalRequest(listener: ApprovalListener): () => void;
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
        return { mime_type: SLOCK_APPROVAL_RESULT_MIME, data: await options.auto_approval(approval) };
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

  return {
    node,
    pendingApprovals,
    onApprovalRequest(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    decide(id, result) {
      const waiter = waiters.get(id);
      if (!waiter) {
        throw new Error(`approval request not found: ${id}`);
      }
      waiters.delete(id);
      pendingApprovals.delete(id);
      waiter.resolve(result);
    },
  };
}
