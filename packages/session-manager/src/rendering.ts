import type { EndpointUri } from "../../protocol/src/index.ts";
import type { IpcNode } from "../../sdk/src/index.ts";
import {
  renderForAgent,
  type ContextCompaction,
  type Delegation,
  type RenderedAgentContext,
  type RenderForAgentRequest,
} from "../../collaboration-context/src/index.ts";
import type { SlockHistoryRequest, SlockHistoryResult, SlockMessage } from "../../slock-channel/src/index.ts";
import { clipText, insertContextSectionsBeforeOutputContract, mergeCompactionsIntoContext } from "./helpers.ts";
import type { SessionManagerRenderContextRequest, SessionRecord } from "./types.ts";

export function createSessionContextRenderer(node: IpcNode) {
  async function renderRunContext(
    record: SessionRecord,
    delegation: Delegation,
    message: SlockMessage,
    purpose: RenderForAgentRequest["purpose"],
  ) {
    const context = renderForAgent(record.state, {
      audience: delegation.assignee,
      purpose,
      delegation_id: delegation.id,
    });

    const visibleHistory = await renderVisibleRoomHistory(message);
    const compactedContext = mergeCompactionsIntoContext(context, matchingCompactions(record, delegation.assignee, purpose));
    const text = insertContextSectionsBeforeOutputContract(compactedContext.text, [
      visibleHistory ? `Visible room history:\n${visibleHistory}` : undefined,
    ]);
    return { ...compactedContext, text };
  }

  function renderSessionContext(record: SessionRecord, request: SessionManagerRenderContextRequest): RenderedAgentContext {
    const context = renderForAgent(record.state, request);
    return mergeCompactionsIntoContext(context, matchingCompactions(record, request.audience, request.purpose));
  }

  async function renderVisibleRoomHistory(message: SlockMessage): Promise<string | undefined> {
    try {
      const history = await node.call<SlockHistoryRequest, SlockHistoryResult>(
        message.channel,
        "history",
        {
          mime_type: "application/json",
          data: {
            limit: 20,
            until_id: message.id,
            ...(message.thread_id ? { thread_id: message.thread_id } : {}),
          },
        },
        { ttl_ms: 5000, timeout_ms: 5000 },
      );
      const lines = history.data.messages
        .filter((item) => item.text.trim().length > 0)
        .map((item) => `- ${item.kind} ${item.sender}${item.id === message.id ? " (current)" : ""}: ${clipText(item.text, 1200)}`);
      return lines.length > 0 ? lines.join("\n") : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    renderRunContext,
    renderSessionContext,
    renderVisibleRoomHistory,
  };
}

export function matchingCompactions(
  record: SessionRecord,
  audience?: EndpointUri,
  purpose?: RenderForAgentRequest["purpose"],
): ContextCompaction[] {
  return record.compactions.filter((compaction) => {
    if (purpose && compaction.purpose !== purpose) return false;
    if (audience && compaction.audience && compaction.audience !== audience) return false;
    return true;
  });
}
