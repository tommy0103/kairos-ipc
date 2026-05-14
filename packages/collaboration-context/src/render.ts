import { currentArtifacts, openDelegations, openTasks, sourceRefKey } from "./reducer.ts";
import type {
  Artifact,
  CollaborationNote,
  CollaborationState,
  HumanProjectionItem,
  RenderedAgentContext,
  RenderForAgentRequest,
  SourceRef,
} from "./types.ts";

export function renderForAgent(state: CollaborationState, request: RenderForAgentRequest): RenderedAgentContext {
  const session = requiredSession(state);
  const delegation = request.delegation_id ? state.delegations[request.delegation_id] : undefined;
  const artifacts = currentArtifacts(state);
  const barriers = Object.values(state.barriers).filter((barrier) => barrier.status === "open");
  const sourceRefs = dedupeSourceRefs([
    ...session.source_refs,
    ...(delegation?.source_refs ?? []),
    ...artifacts.flatMap((artifact) => artifact.source_refs),
  ]);

  const lines = [
    `Kairos collaboration session: ${session.id}`,
    `Audience: ${request.audience}`,
    `Purpose: ${request.purpose}`,
  ];

  if (session.objective) {
    lines.push("", "Objective:", session.objective);
  }

  if (session.acceptance_criteria?.length) {
    lines.push("", "Acceptance criteria:", ...session.acceptance_criteria.map((item) => `- ${item}`));
  }

  if (state.constraints.length > 0) {
    lines.push("", "Constraints:", ...state.constraints.map((item) => `- ${clip(compactValue(item.constraint), 600)}`));
  }

  lines.push("", "Current task state:", ...openTasks(state).map((task) => `- ${task.title} (${task.status}, owner ${task.owner})`));

  if (delegation) {
    lines.push("", "Your delegation:", `- id: ${delegation.id}`);
    if (delegation.role_label ?? delegation.role) lines.push(`- role: ${delegation.role_label ?? delegation.role}`);
    lines.push(`- instruction: ${delegation.instruction}`);
    if (delegation.expected_output) lines.push(`- expected output: ${delegation.expected_output}`);
  }

  const otherDelegations = openDelegations(state).filter((item) => item.id !== delegation?.id);
  if (otherDelegations.length > 0) {
    lines.push("", "Other open delegations:");
    for (const item of otherDelegations) {
      const role = item.role_label ?? item.role;
      lines.push(`- ${item.assignee}${role ? ` as ${role}` : ""}: ${item.instruction} (${item.status})`);
    }
  }

  if (artifacts.length > 0) {
    lines.push("", "Current artifacts:");
    for (const artifact of artifacts) {
      lines.push(`- ${artifact.id} by ${artifact.author}: ${artifactTitle(artifact)}`);
      const text = artifactText(artifact);
      if (text) lines.push(indent(clip(text, 1200)));
    }
  }

  if (barriers.length > 0) {
    lines.push("", "Open barriers:");
    for (const barrier of barriers) {
      const replied = Object.keys(barrier.replies);
      const waiting = barrier.expected_from.filter((agent) => !replied.includes(agent));
      lines.push(`- ${barrier.id}: waiting for ${waiting.join(", ") || "nobody"}; received ${replied.join(", ") || "none"}`);
    }
  }

  if (state.decisions.length > 0) {
    lines.push("", "Recorded decisions:");
    state.decisions.forEach((decision, index) => lines.push(`- decision ${index + 1}: ${clip(compactValue(decision.decision), 600)}`));
  }

  const pendingApprovals = Object.values(state.approvals).filter((approval) => approval.status === "pending");
  if (pendingApprovals.length > 0) {
    lines.push("", "Pending approvals:");
    for (const approval of pendingApprovals) {
      lines.push(`- ${approval.id}: ${approval.tool_endpoint} ${approval.action} (${approval.risk}) ${approval.payload_summary}`);
    }
  }

  const validations = Object.values(state.validations).filter((validation) => validation.status === "requested" || validation.status === "running" || validation.status === "failed");
  if (validations.length > 0) {
    lines.push("", "Validation state:");
    for (const validation of validations) {
      lines.push(`- ${validation.id}: ${validation.status}${validation.summary ? `, ${clip(validation.summary, 400)}` : ""}`);
    }
  }

  const notes = visibleNotesForAgent(state, request.audience);
  if (notes.length > 0) {
    lines.push("", "Collaboration notes:");
    for (const note of notes) {
      const targets = note.to?.length ? ` to ${note.to.join(", ")}` : "";
      lines.push(`- ${note.from}${targets}: ${clip(note.text, 800)}`);
    }
  }

  lines.push(
    "",
    "Output contract:",
    "Return a layered final result for this delegation. The session endpoint projects the summary into IM and stores the artifact body as the durable artifact.",
    "For human-visible progress, call ipc_call with target app://kairos/session-manager, action report_message, and payload { session_id, delegation_id, visibility: \"human\", purpose: \"progress\", text }.",
    "Human-visible progress report_message text is one natural plain-text sentence under 80 characters, ideally 6-14 words or a short CJK sentence.",
    "Use progress report_message only for current state or a small handoff, such as checking tests, reading a boundary, or handing off to another agent.",
    "Do not use report_message for final answers. Final answers must be returned as raw output using exactly two sections: Summary: and Artifact:.",
    "Summary: 2-4 short plain-text paragraphs for the IM timeline. Each paragraph should make one point and can use 1-2 concise sentences.",
    "Summary should read like a useful human IM update: state the conclusion, explain the key evidence or reason, name important risk, and suggest the next step when relevant.",
    "Do not use Markdown syntax, headings, bullets, numbered lists, tables, or code in Summary. Keep detailed findings and source-heavy structure in Artifact.",
    "Artifact: the complete deliverable. Use Markdown here when structure helps, including headings, bullets, tables, code fences, and source references.",
    "For agent-to-agent coordination notes, call report_message with visibility \"agents\" and to set to the target agent URIs.",
    "For extra durable deliverables during the run, call submit_artifact; otherwise return the final Artifact section for the session endpoint to store.",
    "For questions that need an answer from a human or another agent, call ask_question instead of mentioning them in prose.",
    "For explicit choices learned from context, call record_decision with a short structured decision payload.",
    "Do not put findings lists, plans, or full reports in report_message. Detailed work belongs in the final Artifact section or submit_artifact.",
  );

  return {
    session_id: session.id,
    audience: request.audience,
    purpose: request.purpose,
    text: lines.filter((line, index, array) => line.length > 0 || array[index - 1]?.length !== 0).join("\n"),
    source_refs: sourceRefs,
    artifact_refs: artifacts.map((artifact) => artifact.id),
    barrier_refs: barriers.map((barrier) => barrier.id),
  };
}

function visibleNotesForAgent(state: CollaborationState, audience: string): CollaborationNote[] {
  return Object.values(state.notes).filter((note) => {
    if (note.from === audience) return true;
    if (note.visibility === "all") return true;
    if (note.visibility !== "agents") return false;
    return !note.to?.length || note.to.includes(audience);
  });
}

export function renderForHuman(state: CollaborationState): HumanProjectionItem[] {
  const session = requiredSession(state);
  return currentArtifacts(state).map((artifact) => ({
    kind: "artifact" as const,
    id: artifact.id,
    author: artifact.author,
    title: artifactTitle(artifact),
    text: artifactText(artifact) || artifactTitle(artifact),
    source_event_id: `${session.id}:${artifact.id}`,
  }));
}

function requiredSession(state: CollaborationState) {
  if (!state.session) {
    throw new Error("collaboration state has no session");
  }
  return state.session;
}

function artifactTitle(artifact: Artifact): string {
  return artifact.title || artifact.kind.replace(/_/g, " ");
}

function artifactText(artifact: Artifact): string {
  const content = artifact.content;
  if (typeof content === "string") return content;
  if (isRecord(content)) {
    if (typeof content.text === "string") return content.text;
    if (typeof content.summary === "string") return content.summary;
    if (typeof content.final_text === "string") return content.final_text;
  }
  return compactValue(content);
}

function compactValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function clip(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength - 3) + "..." : value;
}

function indent(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}

function dedupeSourceRefs(sourceRefs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const unique: SourceRef[] = [];
  for (const sourceRef of sourceRefs) {
    const key = sourceRefKey(sourceRef);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(sourceRef);
  }
  return unique;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
