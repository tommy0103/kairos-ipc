export type Surface = "rooms" | "projects" | "work" | "artifact" | "diff" | "agents" | "observe" | "settings";

export type AttentionLevel = "none" | "info" | "needs-human" | "blocked" | "failed" | "done";

export interface WorkspaceProjection {
  id: string;
  name: string;
  health: RuntimeHealthProjection;
}

export interface RuntimeHealthProjection {
  status: "healthy" | "degraded" | "offline";
  label: string;
  detail: string;
}

export interface DeskNavigationProjection {
  needsYou: NavigationItemProjection[];
  rooms: NavigationItemProjection[];
  projects: NavigationItemProjection[];
  agents: NavigationItemProjection[];
  observe: NavigationItemProjection[];
}

export interface NavigationItemProjection {
  id: string;
  label: string;
  icon: string;
  surface: Surface;
  targetId: string;
  badge: string | null;
  attention: AttentionLevel;
  quiet: boolean;
}

export interface IpcActionProjection {
  actorId: string;
  actorName: string;
  endpoint: string;
  action: string;
  argsPreview: string;
  traceId: string;
}

export interface RoomProjection {
  id: string;
  name: string;
  topic: string;
  projectIds: string[];
  agentIds: string[];
  latestIpcAction: IpcActionProjection;
  messages: RoomMessageProjection[];
}

export interface RoomMessageProjection {
  id: string;
  actorId: string;
  actorName: string;
  actorInitials: string;
  actorKind: "human" | "agent" | "service" | "system";
  sentAt: string;
  body: string;
  projections: DurableProjection[];
}

export type DurableProjection = DecisionProjection | ArtifactProjection | WorkCardProjection;

export interface DecisionProjection {
  kind: "decision";
  id: string;
  title: string;
  status: "waiting" | "accepted" | "rejected";
  recommendation: string;
  rationale: string;
  primaryAction: string;
  cardId: string;
  traceId: string;
}

export interface ArtifactProjection {
  kind: "artifact";
  id: string;
  title: string;
  status: "draft" | "ready" | "accepted" | "superseded";
  summary: string;
  projectId: string;
  roomId: string;
  traceId: string;
}

export interface WorkCardProjection {
  kind: "work-card";
  id: string;
  title: string;
  phase: ProjectPhase;
  status: AttentionLevel;
  owner: string;
  summary: string;
  projectId: string;
  diffSummary: PatchSummaryProjection | null;
  patchSetIds: string[];
}

export interface LineDeltaProjection {
  addedLines: number;
  removedLines: number;
}

export interface PatchSummaryProjection extends LineDeltaProjection {
  filesChanged: number;
}

export interface PatchAgentReplyProjection {
  actorName: string;
  actorInitials: string;
  sentAt: string;
  body: string;
}

export interface PatchArtifactLinkProjection {
  id: string;
  title: string;
  status: "draft" | "ready" | "accepted" | "superseded";
  summary: string;
}

export interface PatchSetProjection extends PatchSummaryProjection {
  id: string;
  workCardId: string;
  projectId: string;
  title: string;
  createdAtLabel: string;
  traceId: string;
  agentReply: PatchAgentReplyProjection;
  artifactLinks: PatchArtifactLinkProjection[];
  files: FileDiffProjection[];
}

export interface FileDiffProjection extends LineDeltaProjection {
  id: string;
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  previousPath?: string | null;
  hunks: DiffHunkProjection[];
}

export interface DiffHunkProjection {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLineProjection[];
}

export interface DiffLineProjection {
  id: string;
  kind: "context" | "addition" | "deletion" | "collapsed";
  oldLine: number | null;
  newLine: number | null;
  content: string;
  collapsedLines?: number;
  expandedLines?: DiffExpandedLineProjection[];
}

export interface DiffExpandedLineProjection {
  id: string;
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export type ProjectPhase = "Decide" | "Build" | "Review" | "Validate" | "Done";

export interface ProjectProjection {
  id: string;
  title: string;
  summary: string;
  phase: ProjectPhase;
  owner: string;
  roomIds: string[];
  agentIds: string[];
  artifactIds: string[];
  blocker: string | null;
  cards: WorkCardProjection[];
}

export interface ArtifactDetailProjection {
  id: string;
  title: string;
  authorAgentId: string;
  authorName: string;
  projectId: string;
  sourceCardId: string;
  sourceRoomId: string;
  status: "draft" | "ready" | "accepted" | "superseded";
  markdown: string;
  sourceRefs: SourceReferenceProjection[];
  relatedArtifactIds: string[];
  supersedesArtifactId: string | null;
  traceId: string;
}

export interface SourceReferenceProjection {
  label: string;
  targetSurface: Surface;
  targetId: string;
  targetAnchorId?: string | null;
}

export interface AgentProjection {
  id: string;
  name: string;
  role: "builder" | "reviewer" | "service";
  state: "running" | "waiting" | "idle" | "blocked";
  currentDelegation: string;
  linkedProjectId: string | null;
  latestReport: string;
  latestIpcAction: IpcActionProjection | null;
  recentArtifactIds: string[];
  blockers: string[];
  healthLabel: string;
  capabilities: string[];
}

export interface ObserveProjection {
  traceGroups: TraceGroupProjection[];
  endpointHealth: EndpointHealthProjection[];
  evidence: EvidenceProjection[];
}

export interface TraceGroupProjection {
  id: string;
  title: string;
  status: "running" | "complete" | "needs-human" | "failed";
  startedAt: string;
  linkedRoomId: string;
  linkedProjectId: string;
  events: TraceEventProjection[];
}

export interface TraceEventProjection {
  id: string;
  timestamp: string;
  code: string;
  actor: string;
  summary: string;
  severity: "info" | "warning" | "error" | "success";
}

export interface EndpointHealthProjection {
  id: string;
  label: string;
  status: "healthy" | "degraded" | "offline";
  latencyMs: number;
  detail: string;
}

export interface EvidenceProjection {
  id: string;
  kind: "tool-call" | "approval" | "message" | "artifact" | "driver-record";
  title: string;
  summary: string;
  traceId: string;
  linkedSurface: Surface;
  linkedId: string;
  attention: AttentionLevel;
}

export interface InspectorProjection {
  mode: "decision" | "artifact" | "work-card" | "trace" | "room-info";
  title: string;
  subtitle: string;
  decisionId: string | null;
  artifactId: string | null;
  cardId: string | null;
  traceId: string | null;
}

export interface DeskSnapshot {
  workspace: WorkspaceProjection;
  nav: DeskNavigationProjection;
  rooms: RoomProjection[];
  projects: ProjectProjection[];
  patchSets: PatchSetProjection[];
  artifacts: ArtifactDetailProjection[];
  agents: AgentProjection[];
  observe: ObserveProjection;
  inspector: InspectorProjection;
}
