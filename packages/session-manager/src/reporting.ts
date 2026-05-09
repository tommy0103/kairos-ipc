import type { EndpointUri } from "../../protocol/src/index.ts";
import type { CollaborationNote, CollaborationNoteVisibility, SourceRef } from "../../collaboration-context/src/index.ts";
import { uniqueSourceRefsForSession } from "./helpers.ts";
import type { SessionManagerReportMessageRequest, SessionRecord } from "./types.ts";

export const HUMAN_REPORT_MESSAGE_MAX_CHARS = 80;

const HUMAN_REPORT_MARKDOWN_PATTERN = /```|^\s{0,3}#{1,6}\s|^\s*[-*+]\s|^\s*\d+[.)]\s|\|\s*[-:]{3,}\s*\|/m;

export function resolveReportDelegationId(record: SessionRecord, requested: string | undefined, from: EndpointUri): string | undefined {
  if (requested && record.state.delegations[requested]) {
    return requested;
  }

  const active = Object.values(record.state.active_runs).filter((run) => run.assignee === from);
  return active.length === 1 ? active[0]?.delegation_id : undefined;
}

export function reportSourceRefs(
  record: SessionRecord,
  request: SessionManagerReportMessageRequest,
  from: EndpointUri,
  delegationId: string | undefined,
): SourceRef[] {
  if (request.source_refs?.length) {
    return uniqueSourceRefsForSession(request.source_refs);
  }

  const active = Object.values(record.state.active_runs).find((run) => {
    return run.assignee === from && (!delegationId || run.delegation_id === delegationId);
  });
  return active
    ? [{ kind: "ipc_envelope", correlation_id: active.correlation_id }]
    : [{ kind: "external", uri: from, label: "collaboration note" }];
}

export function reportVisibility(request: SessionManagerReportMessageRequest): CollaborationNoteVisibility {
  if (request.visibility) {
    return request.visibility;
  }
  return request.to?.length ? "agents" : "human";
}

export function noteProjectsToHuman(note: CollaborationNote): boolean {
  return note.visibility === "human" || note.visibility === "all";
}

export function hasHumanReportForDelegation(record: SessionRecord, delegationId: string): boolean {
  return record.events.some((event) => {
    return event.type === "note_posted"
      && event.note.delegation_id === delegationId
      && noteProjectsToHuman(event.note);
  });
}

export function enforceReportMessageContract(text: string, visibility: CollaborationNote["visibility"]): void {
  if (visibility !== "human" && visibility !== "all") {
    return;
  }
  if (reportMessageCharacterCount(text) > HUMAN_REPORT_MESSAGE_MAX_CHARS) {
    throw new Error(`human-visible report_message must be a brief IM status under ${HUMAN_REPORT_MESSAGE_MAX_CHARS} characters; submit detailed content as an artifact`);
  }
  if (HUMAN_REPORT_MARKDOWN_PATTERN.test(text)) {
    throw new Error("human-visible report_message must be plain text without Markdown headings, lists, tables, or code fences");
  }
  if (/\r|\n/.test(text)) {
    throw new Error("human-visible report_message must be one brief IM status line");
  }
}

function reportMessageCharacterCount(text: string): number {
  return Array.from(text).length;
}
