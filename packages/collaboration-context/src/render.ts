import { currentArtifacts, openDelegations, openTasks, sourceRefKey } from "./reducer.ts";
import type {
  Artifact,
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
    "",
    "Current task state:",
    ...openTasks(state).map((task) => `- ${task.title} (${task.status}, owner ${task.owner})`),
  ];

  if (delegation) {
    lines.push("", "Your delegation:", `- id: ${delegation.id}`, `- instruction: ${delegation.instruction}`);
    if (delegation.expected_output) lines.push(`- expected output: ${delegation.expected_output}`);
  }

  const otherDelegations = openDelegations(state).filter((item) => item.id !== delegation?.id);
  if (otherDelegations.length > 0) {
    lines.push("", "Other open delegations:");
    for (const item of otherDelegations) {
      lines.push(`- ${item.assignee}: ${item.instruction} (${item.status})`);
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
    state.decisions.forEach((decision, index) => lines.push(`- decision ${index + 1}: ${clip(compactValue(decision), 600)}`));
  }

  lines.push(
    "",
    "Output contract:",
    "Return a concise, self-contained result for this delegation. The session endpoint will store it as an artifact and project it to the human view.",
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
