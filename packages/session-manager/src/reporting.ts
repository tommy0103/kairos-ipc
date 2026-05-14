import type { EndpointUri } from "../../protocol/src/index.ts";
import type { CollaborationNote, CollaborationNoteVisibility, SourceRef } from "../../collaboration-context/src/index.ts";
import { uniqueSourceRefsForSession } from "./helpers.ts";
import type { SessionManagerReportMessageRequest, SessionRecord } from "./types.ts";

export const HUMAN_PROGRESS_MESSAGE_MAX_CHARS = 80;
export const LEGACY_FINAL_SUMMARY_MIN_LINES = 2;
export const LEGACY_FINAL_SUMMARY_MAX_LINES = 4;
export const LEGACY_FINAL_SUMMARY_LINE_MAX_CHARS = 96;

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

export function enforceReportMessageContract(text: string, visibility: CollaborationNote["visibility"], purpose: CollaborationNote["purpose"]): void {
  if (visibility !== "human" && visibility !== "all") {
    return;
  }
  if (HUMAN_REPORT_MARKDOWN_PATTERN.test(text)) {
    throw new Error("human-visible report_message must be plain text without Markdown headings, lists, tables, or code fences");
  }
  if (purpose === "final_summary") {
    enforceLegacyFinalSummaryContract(text);
    return;
  }
  if (reportMessageCharacterCount(text) > HUMAN_PROGRESS_MESSAGE_MAX_CHARS) {
    throw new Error(`human-visible report_message must be under ${HUMAN_PROGRESS_MESSAGE_MAX_CHARS} characters; use the final result summary and artifact for more detail`);
  }
  if (/\r|\n/.test(text)) {
    throw new Error("human-visible report_message must be one brief IM status line");
  }
}

function enforceLegacyFinalSummaryContract(text: string): void {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => line.length === 0)) {
    throw new Error("legacy final_summary report_message must use compact non-empty lines without blank spacing");
  }
  if (lines.length < LEGACY_FINAL_SUMMARY_MIN_LINES || lines.length > LEGACY_FINAL_SUMMARY_MAX_LINES) {
    throw new Error(`legacy final_summary report_message must use ${LEGACY_FINAL_SUMMARY_MIN_LINES}-${LEGACY_FINAL_SUMMARY_MAX_LINES} compact lines`);
  }
  const longLine = lines.find((line) => reportMessageCharacterCount(line) > LEGACY_FINAL_SUMMARY_LINE_MAX_CHARS);
  if (longLine) {
    throw new Error(`legacy final_summary report_message lines must stay under ${LEGACY_FINAL_SUMMARY_LINE_MAX_CHARS} characters`);
  }
}

function reportMessageCharacterCount(text: string): number {
  return Array.from(text).length;
}
