import type { ApprovalRequest, Artifact, CollaborationQuestion, ReviewQueueItem } from "../../collaboration-context/src/index.ts";
import type { MattermostAction, MattermostAttachment, MattermostCardActionUrls, MattermostCommandResponse } from "./types.ts";

export interface ProjectCardInput extends MattermostCardActionUrls {
  session_id: string;
  title?: string;
  objective?: string;
  status?: string;
  agents?: string[];
  blockers?: string[];
  latest_summary?: string;
}

export interface ArtifactCardInput extends MattermostCardActionUrls {
  artifact: Artifact;
  summary?: string;
}

export interface ApprovalCardInput extends MattermostCardActionUrls {
  approval: ApprovalRequest;
}

export interface QuestionCardInput extends MattermostCardActionUrls {
  question: CollaborationQuestion;
  answer_summary?: string;
}

export interface ReviewQueueCardInput extends MattermostCardActionUrls {
  item: ReviewQueueItem;
}

export function projectStartedCard(input: ProjectCardInput): MattermostCommandResponse {
  return cardResponse("in_channel", `Project started: ${displayTitle(input)}`, [projectAttachment(input, "#1c7ed6")]);
}

export function projectStatusCard(input: ProjectCardInput): MattermostCommandResponse {
  return cardResponse("ephemeral", `Project status: ${displayTitle(input)}`, [projectAttachment(input, statusColor(input.status))]);
}

export function artifactReadyCard(input: ArtifactCardInput): MattermostCommandResponse {
  const artifact = input.artifact;
  const fields = compactFields([
    ["Artifact", artifact.id],
    ["Session", artifact.session_id],
    ["Author", artifact.author],
    ["Kind", artifact.kind],
    ["Status", artifact.status],
    ["Open artifact", input.artifact_url],
    ["Trace", input.trace_url],
  ]);
  return cardResponse("in_channel", `Artifact ready: ${artifact.title ?? artifact.id}`, [
    {
      fallback: `Artifact ready: ${artifact.title ?? artifact.id}`,
      color: "#2f9e44",
      title: `Artifact ready: ${artifact.title ?? artifact.id}`,
      text: truncate(input.summary, 700),
      fields,
      actions: artifactActions(artifact.session_id, artifact.id, input),
      props: {
        kairos: {
          card: "artifact_ready",
          session_id: artifact.session_id,
          artifact_id: artifact.id,
        },
      },
    },
  ]);
}

export function approvalNeededCard(input: ApprovalCardInput): MattermostCommandResponse {
  return approvalCard(input, "Approval needed", "#f59f00", "in_channel");
}

export function approvalResolvedCard(input: ApprovalCardInput): MattermostCommandResponse {
  return approvalCard(input, "Approval resolved", statusColor(input.approval.status), "in_channel");
}

export function questionNeededCard(input: QuestionCardInput): MattermostCommandResponse {
  const question = input.question;
  return cardResponse("in_channel", `Question needed: ${question.id}`, [
    {
      fallback: `Question needed: ${question.question}`,
      color: "#7950f2",
      title: "Question needed",
      text: truncate(question.question, 700),
      fields: compactFields([
        ["Question", question.id],
        ["Session", question.session_id],
        ["From", question.from],
        ["To", question.to],
        ["Status", question.status],
        ["Trace", input.trace_url],
      ]),
      actions: question.status === "asked" ? questionActions(question.session_id, question.id, input) : [],
      props: { kairos: { card: "question_needed", session_id: question.session_id, question_id: question.id } },
    },
  ]);
}

export function questionAnsweredCard(input: QuestionCardInput): MattermostCommandResponse {
  const question = input.question;
  return cardResponse("in_channel", `Question answered: ${question.id}`, [
    {
      fallback: `Question answered: ${question.id}`,
      color: "#2f9e44",
      title: "Question answered",
      text: truncate(input.answer_summary ?? question.question, 700),
      fields: compactFields([
        ["Question", question.id],
        ["Session", question.session_id],
        ["Answer artifact", question.answer_artifact_id],
        ["Trace", input.trace_url],
      ]),
      actions: [],
      props: { kairos: { card: "question_answered", session_id: question.session_id, question_id: question.id } },
    },
  ]);
}

export function reviewQueueItemCard(input: ReviewQueueCardInput): MattermostCommandResponse {
  const item = input.item;
  const title = item.kind === "approval" ? "Approval needed" : item.kind === "artifact" ? "Artifact ready" : item.title;
  return cardResponse("in_channel", `${title}: ${item.title}`, [
    {
      fallback: `${title}: ${item.title}`,
      color: reviewQueueColor(item.kind),
      title,
      text: truncate(item.consequence, 700),
      fields: compactFields([
        [labelForReviewItem(item.kind), objectId(item.id)],
        ["Session", item.session_id],
        ["Required action", item.required_action],
        ["Producer", item.producer],
        ["Open artifact", item.kind === "artifact" ? input.artifact_url : undefined],
        ["Trace", input.trace_url],
      ]),
      actions: reviewQueueActions(item, input),
      props: {
        kairos: {
          card: item.kind,
          session_id: item.session_id,
          object_ref: item.id,
        },
      },
    },
  ]);
}

export function errorResponse(_message?: unknown): MattermostCommandResponse {
  const safeMessage = "The request could not be completed.";
  return cardResponse("ephemeral", `Kairos error: ${safeMessage}`, [{ fallback: safeMessage, color: "#e03131", title: "Kairos error", text: safeMessage }]);
}

export function ephemeralResponse(message: string): MattermostCommandResponse {
  return cardResponse("ephemeral", message, [{ fallback: message, color: "#868e96", text: truncate(message, 700) }]);
}

function projectAttachment(input: ProjectCardInput, color: string): MattermostAttachment {
  return {
    fallback: `Project ${input.status ?? "status"}: ${displayTitle(input)}`,
    color,
    title: displayTitle(input),
    text: truncate(input.latest_summary ?? input.objective, 700),
    fields: compactFields([
      ["Session", input.session_id],
      ["Status", input.status],
      ["Agents", input.agents?.join(", ")],
      ["Blockers", input.blockers?.join(", ")],
    ]),
    actions: projectActions(input),
    props: { kairos: { card: "project", session_id: input.session_id } },
  };
}

function approvalCard(input: ApprovalCardInput, title: string, color: string, responseType: "ephemeral" | "in_channel"): MattermostCommandResponse {
  const approval = input.approval;
  return cardResponse(responseType, `${title}: ${approval.action}`, [
    {
      fallback: `${title}: ${approval.action}`,
      color,
      title,
      text: truncate(approval.payload_summary, 700),
      fields: compactFields([
        ["Approval", approval.id],
        ["Session", approval.session_id],
        ["Tool", approval.tool_endpoint],
        ["Action", approval.action],
        ["Risk", approval.risk],
        ["Status", approval.status],
        ["Resolved by", approval.resolved_by],
        ["Trace", input.trace_url],
      ]),
      actions: approval.status === "pending" ? approvalActions(approval.session_id, approval.id, input) : [],
      props: { kairos: { card: "approval", session_id: approval.session_id, approval_id: approval.id } },
    },
  ]);
}

function artifactActions(sessionId: string, artifactId: string, urls: MattermostCardActionUrls): MattermostAction[] {
  const actions: MattermostAction[] = [];
  if (urls.action_url) {
    actions.push(actionButton("accept_artifact", "Accept", urls.action_url, { session_id: sessionId, artifact_id: artifactId, action: "accept_artifact" }, "success"));
    actions.push(actionButton("request_revision", "Request revision", urls.action_url, { session_id: sessionId, artifact_id: artifactId, action: "request_revision" }, "warning"));
  }
  return actions;
}

function approvalActions(sessionId: string, approvalId: string, urls: MattermostCardActionUrls): MattermostAction[] {
  if (!urls.action_url) return [];
  return [
    actionButton("approve", "Approve", urls.action_url, { session_id: sessionId, approval_id: approvalId, action: "approve" }, "success"),
    actionButton("reject", "Reject", urls.action_url, { session_id: sessionId, approval_id: approvalId, action: "reject" }, "danger"),
  ];
}

function questionActions(sessionId: string, questionId: string, urls: MattermostCardActionUrls): MattermostAction[] {
  if (!urls.action_url) return [];
  return [actionButton("answer_question", "Answer", urls.action_url, { session_id: sessionId, question_id: questionId, action: "answer_question" }, "primary")];
}

function projectActions(urls: MattermostCardActionUrls & { session_id: string }): MattermostAction[] {
  const actions: MattermostAction[] = [];
  if (urls.action_url) actions.push(actionButton("request_synthesis", "Synthesis", urls.action_url, { session_id: urls.session_id, action: "request_synthesis" }, "primary"));
  return actions;
}

function reviewQueueActions(item: ReviewQueueItem, urls: MattermostCardActionUrls): MattermostAction[] {
  if (!urls.action_url) return [];
  const id = objectId(item.id);
  if (item.kind === "approval") {
    return approvalActions(item.session_id, id, urls);
  }
  if (item.kind === "artifact") {
    return artifactActions(item.session_id, id, urls);
  }
  if (item.kind === "question") {
    return questionActions(item.session_id, id, urls);
  }
  return [];
}

function labelForReviewItem(kind: ReviewQueueItem["kind"]): string {
  if (kind === "approval") return "Approval";
  if (kind === "artifact") return "Artifact";
  if (kind === "question") return "Question";
  return "Item";
}

function reviewQueueColor(kind: ReviewQueueItem["kind"]): string {
  if (kind === "approval") return "#f59f00";
  if (kind === "artifact") return "#2f9e44";
  if (kind === "question") return "#7950f2";
  return "#1c7ed6";
}

function objectId(objectRef: string): string {
  return objectRef.includes(":") ? objectRef.slice(objectRef.indexOf(":") + 1) : objectRef;
}

function actionButton(id: string, name: string, url: string, context: Record<string, unknown>, style: MattermostAction["style"] = "default"): MattermostAction {
  return { id, name, type: "button", style, integration: { url, context } };
}

function cardResponse(responseType: "ephemeral" | "in_channel", text: string, attachments: MattermostAttachment[]): MattermostCommandResponse {
  return { response_type: responseType, text, attachments };
}

function compactFields(entries: Array<[string, string | undefined]>): MattermostAttachment["fields"] {
  return entries.flatMap(([title, value]) => {
    const text = truncate(value, 180);
    return text ? [{ title, value: text, short: text.length <= 64 }] : [];
  });
}

function displayTitle(input: ProjectCardInput): string {
  return input.title?.trim() || input.objective?.trim() || input.session_id;
}

function statusColor(status: string | undefined): string {
  if (status === "approved" || status === "accepted" || status === "completed" || status === "answered") return "#2f9e44";
  if (status === "rejected" || status === "failed" || status === "cancelled" || status === "expired") return "#e03131";
  if (status === "pending" || status === "revision_requested" || status === "blocked") return "#f59f00";
  return "#1c7ed6";
}

function truncate(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1))}...` : trimmed;
}
