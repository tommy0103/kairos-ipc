<script setup lang="ts">
import { Activity, Archive, Bot, Check, ChevronRight, CornerDownRight, FileText, ListChecks, MessageSquare, RefreshCw, RotateCcw, Search, Send, ShieldAlert, TerminalSquare, X } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import ArtifactMarkdown from "./components/ArtifactMarkdown";

type EndpointUri = string;
type ActiveView = "sessions" | "session" | "review" | "chat" | "agent" | "trace";
type RowClass = "delta" | "error";
type RunState = "active" | "cancelling" | "cancelled" | "completed";
type ToolState = "running" | "completed" | "errored";
type AgentStatusState = "running" | "streaming" | "completed" | "errored" | "cancelled";
type AgentStatusVisualState = AgentStatusState | "waiting";
type EndpointKind = "agent" | "app" | "plugin" | "local" | "unknown";
type SessionPhaseFilter = WorkPhase | "all";
type ReviewQueueItemKind = "artifact" | "approval" | "question" | "validation" | "decision";
type ReviewKindFilter = ReviewQueueItemKind | "all";
type SessionDetailTab = "work" | "reports" | "inspector";
type ProjectBoardLane = "decide" | "building" | "review" | "validate" | "done";

interface SlockUiBridgeChannel {
  uri: EndpointUri;
  label?: string;
  kind?: "channel" | "dm";
}

interface SlockMessage {
  id: string;
  channel: EndpointUri;
  sender: EndpointUri;
  text: string;
  mentions: EndpointUri[];
  thread_id: string | null;
  reply_to_id: string | null;
  kind: "human" | "agent" | "system";
  created_at: string;
  updated_at?: string;
  projection?: {
    presentation: "message" | "artifact" | "final_report";
    source_event_id?: string;
    title?: string;
    author?: EndpointUri;
    session_id?: string;
    artifact_id?: string;
  };
}

interface SlockMessageDelta {
  thread_id: string;
  text: string;
  source: EndpointUri;
  kind?: "text" | "status";
  metadata?: Record<string, unknown>;
}

interface SlockAgentRunEvent {
  run_id: string;
  message_id: string;
  thread_id?: string | null;
  agent: EndpointUri;
  state: "started" | "completed" | "errored" | "cancelled";
  started_at?: string;
  finished_at?: string;
  final_message_id?: string;
  reason?: string;
  error?: {
    code: string;
    message: string;
  };
}

interface SlockApprovalRequest {
  id?: string;
  risk: string;
  summary: string;
  metadata?: Record<string, unknown>;
  proposed_call: {
    target: EndpointUri;
    action: string;
    payload: unknown;
  };
}

interface SlockApprovalEvent {
  id: string;
  request: SlockApprovalRequest;
  source: EndpointUri;
  created_at: string;
}

interface SlockCapabilityGrant {
  id: string;
  token: string;
  source: EndpointUri;
  target: EndpointUri;
  actions: string[];
  issued_at: string;
  expires_at: string;
  approval_id?: string;
  risk?: string;
}

interface SlockApprovalResult {
  approved: boolean;
  grant_ttl_ms?: number;
  reason?: string;
  grant?: SlockCapabilityGrant;
}

interface SlockChannelEvent {
  type:
    | "bridge_connected"
    | "message_created"
    | "message_updated"
    | "message_delta"
    | "agent_run_started"
    | "agent_run_finished"
    | "typing_started"
    | "approval_requested"
    | "approval_resolved"
    | "subscription_closed"
    | "agent_error"
    | "agent_cancelled";
  channel?: EndpointUri;
  channels?: SlockUiBridgeChannel[];
  message?: SlockMessage;
  delta?: SlockMessageDelta;
  run?: SlockAgentRunEvent;
  error?: {
    code: string;
    message: string;
    source: EndpointUri;
  };
  cancelled?: {
    message_id: string;
    agent: EndpointUri;
    reason?: string;
  };
  typing?: {
    source: EndpointUri;
    thread_id?: string | null;
  };
  subscription?: {
    subscriber: EndpointUri;
    reason?: string;
  };
  approval?: SlockApprovalEvent;
  id?: string;
  result?: SlockApprovalResult;
}

interface DashboardSourceEvent {
  id: string;
  type: string;
  at: string;
}

interface SourceRef extends Record<string, unknown> {
  kind: string;
  channel?: EndpointUri;
  message_id?: string;
  artifact_id?: string;
  uri?: string;
  label?: string;
}

interface TraceRef extends Record<string, unknown> {
  label: string;
  trace_id?: string;
  correlation_id?: string;
  msg_id?: string;
  endpoint?: EndpointUri;
  action?: string;
  severity?: "info" | "warning" | "error";
  object_ref?: string;
}

interface CollaborationEvent extends Record<string, unknown> {
  id: string;
  type: string;
  at: string;
  session_id?: string;
}

interface TraceViewerEvent extends Record<string, unknown> {
  id: string;
  index: number;
  label: string;
  detail: string;
  group_key: string;
  direction: "request" | "response" | "stream" | "lifecycle" | "event";
  endpoint_flow: string;
  relation_summary: string;
  relations: TraceViewerRelation[];
  causal_depth: number;
  causal_parent_id?: string;
  timestamp?: string;
  event?: string;
  msg_id?: string;
  correlation_id?: string | null;
  source?: string;
  target?: string;
  op_code?: string;
  action?: string | null;
  route_result?: string;
  error_reason?: string | null;
  payload_kind?: string;
  payload_size?: number;
  channel?: string;
  message_id?: string;
  thread_id?: string | null;
  approval_id?: string;
  approval_risk?: string;
  approval_target?: string;
  approval_action?: string;
  approval_decision?: boolean;
  shell_command?: string;
  shell_exit_code?: number;
}

interface TraceViewerRelation {
  kind: "thread" | "message" | "correlation" | "approval" | "tool" | "grant" | "channel" | "reply";
  value: string;
  label: string;
}

interface TraceViewerGroupSummary {
  event_count: number;
  first_timestamp?: string;
  last_timestamp?: string;
  route_results: Record<string, number>;
  approvals: number;
  rejected_approvals: number;
  endpoints: string[];
  relations: TraceViewerRelation[];
  requests: number;
  responses: number;
  streams: number;
  failures: number;
}

interface TraceViewerGroup {
  id: string;
  kind: "thread" | "correlation" | "approval" | "endpoint" | "event";
  title: string;
  events: TraceViewerEvent[];
  summary: TraceViewerGroupSummary;
}

interface TraceViewerStats {
  total_events: number;
  group_count: number;
  approvals: number;
  rejected_approvals: number;
  shell_calls: number;
  route_results: Record<string, number>;
}

interface TraceViewerResponse {
  available: boolean;
  trace_path?: string | null;
  events?: TraceViewerEvent[];
  groups?: TraceViewerGroup[];
  stats?: TraceViewerStats;
}

interface TraceState {
  available: boolean;
  loading: boolean;
  error: string;
  tracePath: string | null;
  events: TraceViewerEvent[];
  groups: TraceViewerGroup[];
  stats: TraceViewerStats;
}

type WorkPhase = "intake" | "shape" | "plan" | "execute" | "review" | "validate" | "decision" | "handoff" | "done";

interface ToolCallSummary {
  endpoint: EndpointUri;
  action: string;
  payload_summary?: string;
  status?: string;
}

interface AgentWorkSummary {
  session_id: string;
  session_title?: string;
  agent: EndpointUri;
  status: string;
  delegation_id: string;
  role?: string;
  role_label?: string;
  artifact_id?: string;
  current_work?: string;
  latest_tool_call?: ToolCallSummary;
}

interface WorkBlocker {
  kind: string;
  label: string;
  ref_id?: string;
  waiting_for?: EndpointUri[];
}

interface WorkAction {
  kind: "open_thread" | "review_artifact" | "answer_question" | "resolve_approval" | "record_validation" | "request_revision" | "request_synthesis" | "open_trace";
  label: string;
  target?: string;
}

interface ReviewQueueItem {
  id: string;
  kind: ReviewQueueItemKind;
  session_id: string;
  title: string;
  producer?: EndpointUri;
  required_action: string;
  consequence: string;
  created_at?: string;
  actions: WorkAction[];
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
}

interface AgentWorkloadItem {
  agent: EndpointUri;
  sessions: AgentWorkSummary[];
  latest_report?: string;
  blockers: WorkBlocker[];
  latest_tool_call?: ToolCallSummary;
}

interface ProjectBoardColumn {
  lane: ProjectBoardLane;
  label: string;
  projects: SessionWorkProjection[];
}

type BuildBoardColumnKey = "todo" | "building" | "review" | "validate" | "done";

interface BuildBoardItem {
  id: string;
  kind: "task" | "delegation" | "artifact" | "approval" | "validation";
  title: string;
  status: string;
  owner?: EndpointUri;
  agent?: EndpointUri;
  summary?: string;
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
}

interface BuildBoardColumn {
  key: BuildBoardColumnKey;
  label: string;
  items: BuildBoardItem[];
}

interface BuildBoardProjection {
  active: boolean;
  reason: string;
  write_operations: ToolCallSummary[];
  columns: BuildBoardColumn[];
}

interface LifecycleColumn {
  phase: WorkPhase;
  label: string;
  items: Array<{ kind: InspectorKind; id: string; title: string; meta: string; status?: string }>;
}

interface SessionWorkProjection {
  session_id: string;
  title: string;
  objective?: string;
  acceptance_criteria?: string[];
  phase: WorkPhase;
  phase_label: string;
  phase_reason?: string;
  owner: EndpointUri;
  status: string;
  agents: AgentWorkSummary[];
  current_work?: string;
  latest_report?: string;
  latest_artifact?: {
    id: string;
    title: string;
    kind: string;
    status: string;
    text: string;
  };
  build_board?: BuildBoardProjection;
  blockers: WorkBlocker[];
  actions: WorkAction[];
  origin?: {
    kind: string;
    channel?: EndpointUri;
    message_id?: string;
  };
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
  updated_at?: string;
}

interface DetailTask {
  id: string;
  title: string;
  owner: EndpointUri;
  status: string;
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
  acceptance_criteria?: string[];
  updated_at?: string;
}

interface DetailDelegation {
  id: string;
  task_id: string;
  assignee: EndpointUri;
  status: string;
  instruction: string;
  expected_output?: string;
  role?: string;
  role_label?: string;
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
  correlation_id?: string;
  submitted_artifact_id?: string;
  error?: string;
  updated_at?: string;
}

interface DetailArtifact {
  id: string;
  author: EndpointUri;
  kind: string;
  title?: string;
  content: unknown;
  status: string;
  relates_to?: string[];
  supersedes?: string;
  review?: { reviewer: EndpointUri; status: string; note?: string; reviewed_at: string; source_refs?: SourceRef[]; trace_refs?: TraceRef[] };
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
  created_at: string;
  updated_at?: string;
}

interface DetailBarrier {
  id: string;
  task_id?: string;
  owner: EndpointUri;
  expected_from: EndpointUri[];
  notify: EndpointUri[];
  mode: string;
  status: string;
  replies: Record<EndpointUri, string>;
  synthesis_requested?: boolean;
  synthesis_reason?: string;
  source_ref?: SourceRef;
  trace_refs?: TraceRef[];
  created_at: string;
  updated_at?: string;
}

interface DetailDecision {
  id: string;
  decider: EndpointUri;
  decision: unknown;
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
  relates_to?: string[];
  supersedes?: string;
  created_at: string;
}

interface DetailQuestion {
  id: string;
  from: EndpointUri;
  to: EndpointUri;
  question: string;
  status: string;
  answer_artifact_id?: string;
  about_refs?: SourceRef[];
}

interface DetailApproval {
  id: string;
  requester: EndpointUri;
  tool_endpoint: EndpointUri;
  action: string;
  risk: string;
  payload_summary: string;
  status: string;
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
  created_at: string;
  resolved_at?: string;
  resolved_by?: EndpointUri;
  resolution_note?: string;
}

interface DetailValidation {
  id: string;
  task_id?: string;
  artifact_id?: string;
  requester: EndpointUri;
  validator?: EndpointUri;
  status: string;
  summary?: string;
  source_refs?: SourceRef[];
  trace_refs?: TraceRef[];
  created_at: string;
  updated_at?: string;
}

interface DetailNote {
  id: string;
  from: EndpointUri;
  to?: EndpointUri[];
  visibility: string;
  text: string;
  delegation_id?: string;
  source_refs?: SourceRef[];
  created_at: string;
}

interface DetailConstraint {
  id: string;
  constraint: unknown;
  source_refs?: SourceRef[];
  created_at: string;
}

interface SessionDetailProjection {
  session: SessionWorkProjection;
  tasks: DetailTask[];
  delegations: DetailDelegation[];
  artifacts: DetailArtifact[];
  barriers: DetailBarrier[];
  decisions: DetailDecision[];
  constraints: DetailConstraint[];
  questions: DetailQuestion[];
  approvals: DetailApproval[];
  validations: DetailValidation[];
  notes: DetailNote[];
  trace_refs?: TraceRef[];
}

interface SessionDetailResponse {
  session?: SessionDetailProjection;
  events?: CollaborationEvent[];
}

type InspectorKind = "session" | "task" | "delegation" | "artifact" | "barrier" | "decision" | "question" | "approval" | "validation" | "note" | "constraint" | "review";

interface InspectorRef {
  kind: InspectorKind;
  id: string;
}

interface InspectorObject {
  ref: InspectorRef;
  title: string;
  eyebrow: string;
  status?: string;
  summary?: string;
  payload: unknown;
  source_refs: SourceRef[];
  trace_refs: TraceRef[];
  related: string[];
  actions: WorkAction[];
}

interface DashboardSnapshot {
  at: string;
  sequence: number;
  sessions: SessionWorkProjection[];
  review_queue?: ReviewQueueItem[];
  agent_workload?: AgentWorkloadItem[];
}

type DashboardEvent =
  | (DashboardSnapshot & { type: "dashboard_snapshot" })
  | (DashboardSnapshot & { type: "session_updated"; session_id: string; session?: SessionWorkProjection; source_event?: DashboardSourceEvent })
  | { type: "dashboard_subscription_closed"; at: string; sequence: number; subscriber: EndpointUri; reason?: string };

type BridgeEvent = SlockChannelEvent | DashboardEvent;

interface ToolMetadata extends Record<string, unknown> {
  type: "tool_call";
  tool_call_id: string;
  name: string;
  state?: string;
  arguments?: unknown;
  result?: unknown;
}

interface SimpleRow {
  rowType: "simple";
  id: string;
  className: RowClass;
  meta: string;
  text: string;
  renderedId?: string;
  threadReply?: boolean;
}

interface MessageRow {
  rowType: "message";
  id: string;
  message: SlockMessage;
  threadReply: boolean;
  runState: RunState;
}

interface ToolRow {
  rowType: "tool";
  id: string;
  channel?: EndpointUri;
  source: EndpointUri;
  threadId: string;
  threadReply: boolean;
  receivedAt?: string;
  sequence?: number;
  toolCallId: string;
  state: ToolState;
  name: string;
  preview: string;
  argumentsText: string;
  open: boolean;
  resultSummary?: string;
  resultText?: string;
  approval?: SlockApprovalEvent;
  approvalResult?: SlockApprovalResult;
}

interface AgentStatusRow {
  rowType: "agent-status";
  id: string;
  channel?: EndpointUri;
  source: EndpointUri;
  threadId: string;
  threadReply: boolean;
  receivedAt?: string;
  sequence?: number;
  runId?: string;
  messageId?: string;
  startedAt?: string;
  finishedAt?: string;
  lastActivityAt?: string;
  finalMessageId?: string;
  errorMessage?: string;
  state: AgentStatusState;
  text: string;
  synthetic?: boolean;
}

interface ApprovalRow {
  rowType: "approval";
  id: string;
  approval: SlockApprovalEvent;
}

type UiRow = SimpleRow | MessageRow | ApprovalRow | AgentStatusRow;
type AgentActivityRow = ToolRow | AgentStatusRow;

const timeline = ref<HTMLDivElement | null>(null);
const messageInput = ref<HTMLTextAreaElement | null>(null);
const status = ref("connecting");
const channels = ref<SlockUiBridgeChannel[]>([]);
const activeChannel = ref<SlockUiBridgeChannel | null>(null);
const workSessions = ref<SessionWorkProjection[]>([]);
const reviewQueue = ref<ReviewQueueItem[]>([]);
const agentWorkload = ref<AgentWorkloadItem[]>([]);
const dashboardSequence = ref(0);
const dashboardLastEventAt = ref("");
const sessionsLoading = ref(false);
const sessionsError = ref("");
const sessionSearch = ref("");
const sessionPhaseFilter = ref<SessionPhaseFilter>("all");
const selectedSessionId = ref<string | null>(null);
const sessionDetail = ref<SessionDetailProjection | null>(null);
const sessionDetailEvents = ref<CollaborationEvent[]>([]);
const sessionDetailLoading = ref(false);
const sessionDetailError = ref("");
const sessionDetailLoadedAt = ref("");
const sessionDetailTab = ref<SessionDetailTab>("work");
const selectedInspectorRef = ref<InspectorRef>({ kind: "session", id: "" });
const reviewSearch = ref("");
const reviewKindFilter = ref<ReviewKindFilter>("all");
const actionNotes = ref<Record<string, string>>({});
const actionAnswers = ref<Record<string, string>>({});
const pendingActions = ref<Record<string, boolean>>({});
const rows = ref<UiRow[]>([]);
const agentActivityRows = ref<AgentActivityRow[]>([]);
const knownAgents = ref<EndpointUri[]>([]);
const activeView = ref<ActiveView>("sessions");
const activeAgentUri = ref<EndpointUri | null>(null);
const messageText = ref("@pi read package.json and summarize the scripts");
const activeThreadId = ref<string | null>(null);
const activeReplyToId = ref<string | null>(null);
const activeThreadLabel = ref("");
const clockTick = ref(Date.now());
const traceLimit = ref(250);
const traceQuery = ref("");
const traceState = reactive<TraceState>({
  available: false,
  loading: false,
  error: "",
  tracePath: null,
  events: [],
  groups: [],
  stats: emptyTraceStats(),
});

const rendered = new Set<string>();
const streamRows = new Map<string, SimpleRow>();
const statusRows = new Map<string, AgentStatusRow>();
const toolRows = new Map<string, ToolRow>();
const approvalById = new Map<string, SlockApprovalEvent>();
const pendingToolApprovals = new Map<string, SlockApprovalEvent>();
const typingTimers = new Map<string, number>();
let nextEphemeralRowId = 1;
let nextAgentStatusRowId = 1;
let nextOperationSequence = 1;
let events: EventSource | undefined;
let clockTimer: number | undefined;
let dashboardFrame = 0;
let pendingDashboardSnapshot: DashboardSnapshot | undefined;
let detailReloadTimer: number | undefined;

const dashboardPhaseOrder: WorkPhase[] = ["intake", "shape", "plan", "execute", "review", "validate", "decision", "handoff", "done"];
const projectBoardLaneOrder: ProjectBoardLane[] = ["decide", "building", "review", "validate", "done"];

const channelTitle = computed(() => activeChannel.value ? channelLabel(activeChannel.value) : "Slock");
const latestOperations = computed(() => agentActivityRows.value
  .slice()
  .sort((left, right) => (right.sequence ?? 0) - (left.sequence ?? 0))
  .slice(0, 14));
const currentOperation = computed(() => latestOperations.value[0] ?? null);
const previousOperations = computed(() => latestOperations.value.slice(1));
const activeAgentRows = computed(() => agentActivityRows.value.filter((row) => row.source === activeAgentUri.value));
const activeAgentWorkSessions = computed(() => workSessions.value
  .map((session) => ({
    session,
    assignments: session.agents.filter((agent) => agent.agent === activeAgentUri.value),
  }))
  .filter((item) => item.assignments.length > 0));
const activeAgentToolCount = computed(() => activeAgentRows.value.filter((row) => row.rowType === "tool").length);
const activeAgentApprovalCount = computed(() => activeAgentRows.value.filter((row) => row.rowType === "tool" && row.approval).length);
const activeOperationCount = computed(() => agentActivityRows.value.filter((row) => row.rowType === "tool" ? row.state === "running" : row.state === "running" || row.state === "streaming").length);
const activeWorkSessionCount = computed(() => workSessions.value.filter((session) => session.phase !== "done").length);
const blockedWorkSessionCount = computed(() => workSessions.value.filter((session) => session.blockers.length > 0).length);
const runningDashboardAgentCount = computed(() => new Set(workSessions.value.flatMap((session) => session.agents)
  .filter((agent) => agent.status === "running" || agent.status === "pending")
  .map((agent) => agent.agent)).size);
const pendingReviewItemCount = computed(() => reviewQueue.value.length);
const attentionPreviewItems = computed(() => reviewQueue.value.slice(0, 4));
const readyArtifactProjectCount = computed(() => workSessions.value.filter((session) => Boolean(session.latest_artifact) && session.latest_artifact?.status !== "accepted").length);
const readyArtifactProjects = computed(() => workSessions.value.filter((session) => Boolean(session.latest_artifact)).slice(0, 5));
const recentlyConsumedProjects = computed(() => workSessions.value.filter((session) => session.phase === "done").slice(0, 4));
const roomProjectCards = computed(() => {
  const channel = activeChannel.value?.uri;
  if (!channel) return workSessions.value.slice(0, 5);
  return workSessions.value.filter((session) => session.origin?.channel === channel).slice(0, 5);
});
const projectDetailNeeds = computed(() => {
  const session = detailSession.value;
  if (!session) return [];
  return reviewQueue.value.filter((item) => item.session_id === session.session_id).slice(0, 4);
});
const projectDetailNotes = computed(() => sessionDetail.value?.notes.slice(-8).reverse() ?? []);
const agentRuntimeRows = computed(() => knownAgents.value.map((agent) => {
  const workload = agentWorkload.value.find((item) => item.agent === agent);
  const project = workSessions.value.find((session) => session.agents.some((item) => item.agent === agent));
  const activeRow = agentActivityRows.value.find((row) => row.source === agent);
  return { agent, workload, project, activeRow };
}));
const observeAuditEvents = computed(() => traceState.events.slice(0, 12));
const dashboardUpdatedAt = computed(() => dashboardLastEventAt.value);
const dashboardIsStale = computed(() => {
  if (!dashboardUpdatedAt.value) return false;
  return clockTick.value - new Date(dashboardUpdatedAt.value).getTime() > 120000;
});
const sessionDetailIsStale = computed(() => {
  if (!sessionDetail.value || !sessionDetailLoadedAt.value || sessionDetailLoading.value) return false;
  const loadedAt = new Date(sessionDetailLoadedAt.value).getTime();
  if (Number.isNaN(loadedAt)) return false;
  return clockTick.value - loadedAt > 120000;
});
const sessionPhaseFilters = computed(() => {
  const counts = new Map<SessionPhaseFilter, number>();
  counts.set("all", workSessions.value.length);
  for (const session of workSessions.value) {
    counts.set(session.phase, (counts.get(session.phase) ?? 0) + 1);
  }
  return ["all", ...dashboardPhaseOrder]
    .map((phase) => ({ phase: phase as SessionPhaseFilter, label: phase === "all" ? "All" : phaseLabel(phase as WorkPhase), count: counts.get(phase as SessionPhaseFilter) ?? 0 }))
    .filter((item) => item.phase === "all" || item.count > 0);
});
const visibleWorkSessions = computed(() => {
  const query = sessionSearch.value.trim().toLowerCase();
  return workSessions.value.filter((session) => {
    if (sessionPhaseFilter.value !== "all" && session.phase !== sessionPhaseFilter.value) return false;
    if (!query) return true;
    const searchable = [
      session.title,
      session.objective,
      session.current_work,
      session.latest_report,
      session.owner,
      ...session.agents.map((agent) => agent.agent),
      ...session.blockers.map((blocker) => blocker.label),
    ].filter(Boolean).join(" ").toLowerCase();
    return searchable.includes(query);
  });
});
const projectBoardColumns = computed<ProjectBoardColumn[]>(() => {
  const grouped = new Map<ProjectBoardLane, SessionWorkProjection[]>();
  for (const session of visibleWorkSessions.value) {
    const lane = projectBoardLane(session);
    const projects = grouped.get(lane) ?? [];
    projects.push(session);
    grouped.set(lane, projects);
  }
  return projectBoardLaneOrder.map((lane) => ({ lane, label: projectBoardLaneLabel(lane), projects: grouped.get(lane) ?? [] }));
});
const selectedSession = computed(() => workSessions.value.find((session) => session.session_id === selectedSessionId.value) ?? visibleWorkSessions.value[0] ?? null);
const detailSession = computed(() => sessionDetail.value?.session ?? selectedSession.value ?? null);
const selectedBuildBoard = computed(() => selectedSession.value?.build_board ?? null);
const detailBuildBoard = computed(() => detailSession.value?.build_board ?? null);
const selectedSessionReviews = computed(() => selectedSession.value ? reviewQueue.value.filter((item) => item.session_id === selectedSession.value?.session_id) : []);
const detailObjectCounts = computed(() => {
  const detail = sessionDetail.value;
  return {
    tasks: detail?.tasks.length ?? 0,
    delegations: detail?.delegations.length ?? 0,
    artifacts: detail?.artifacts.length ?? 0,
    barriers: detail?.barriers.length ?? 0,
    decisions: detail?.decisions.length ?? 0,
    waiting: selectedSessionReviews.value.length,
  };
});
const detailLifecycleColumns = computed(() => lifecycleColumns(sessionDetail.value));
const inspectorObject = computed(() => resolveInspectorObject(selectedInspectorRef.value));
const inspectorEvents = computed(() => inspectorObject.value ? eventsForObject(inspectorObject.value.ref) : []);
const artifactReaderObject = computed(() => {
  const object = inspectorObject.value;
  return object?.ref.kind === "artifact" ? object : null;
});
const artifactReaderId = computed(() => artifactReaderObject.value?.ref.id ?? "");
const artifactReaderTitle = computed(() => artifactReaderObject.value?.title ?? "Artifact");
const artifactReaderStatus = computed(() => artifactReaderObject.value?.status ?? "recorded");
const artifactReaderAuthor = computed(() => {
  const payload = artifactReaderObject.value?.payload;
  return isRecord(payload) && typeof payload.author === "string" ? endpointLabel(payload.author) : "agent";
});
const artifactReaderMarkdown = computed(() => artifactReaderObject.value ? inspectorMarkdownText(artifactReaderObject.value) : "");
const artifactReaderSourceLabels = computed(() => artifactReaderObject.value?.source_refs.map(sourceRefLabel) ?? []);
const artifactReaderTraceLabels = computed(() => artifactReaderObject.value?.trace_refs.map(traceRefLabel) ?? []);
const detailArtifacts = computed(() => sessionDetail.value?.artifacts ?? []);
const inspectorTitle = computed(() => inspectorObject.value?.title ?? "Work card");
const inspectorEyebrow = computed(() => inspectorObject.value?.eyebrow ?? "Work card");
const inspectorStatus = computed(() => inspectorObject.value?.status ?? "recorded");
const inspectorSummary = computed(() => inspectorObject.value?.summary ?? "No summary recorded");
const inspectorPayloadPreview = computed(() => inspectorObject.value ? objectPreview(inspectorObject.value.payload) : "No payload recorded");
const inspectorSourceLabels = computed(() => inspectorObject.value?.source_refs.map(sourceRefLabel) ?? []);
const inspectorTraceLabels = computed(() => inspectorObject.value?.trace_refs.map(traceRefLabel) ?? []);
const selectedAgentWorkload = computed(() => {
  const session = selectedSession.value;
  if (!session) return [];
  return agentWorkload.value.filter((workload) => workload.sessions.some((item) => item.session_id === session.session_id));
});
const reviewKindFilters = computed(() => {
  const counts = new Map<ReviewKindFilter, number>();
  counts.set("all", reviewQueue.value.length);
  for (const item of reviewQueue.value) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return ["all", "artifact", "approval", "question", "validation", "decision"]
    .map((kind) => ({ kind: kind as ReviewKindFilter, label: kind === "all" ? "All" : reviewKindLabel(kind), count: counts.get(kind as ReviewKindFilter) ?? 0 }))
    .filter((item) => item.kind === "all" || item.count > 0);
});
const visibleReviewQueue = computed(() => {
  const query = reviewSearch.value.trim().toLowerCase();
  return reviewQueue.value.filter((item) => {
    if (reviewKindFilter.value !== "all" && item.kind !== reviewKindFilter.value) return false;
    if (!query) return true;
    const session = sessionForReview(item);
    return [item.title, item.required_action, item.consequence, item.producer, session?.title, session?.phase_label]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
});
const pendingApprovalCount = computed(() => rows.value.filter((row) => row.rowType === "approval").length
  + agentActivityRows.value.filter((row) => row.rowType === "tool" && Boolean(row.approval) && !row.approvalResult).length);
const traceStatus = computed(() => {
  if (traceState.loading) return "loading audit";
  if (traceState.error) return "observe error";
  if (!traceState.available) return "observe unavailable";
  return `${traceState.stats.total_events} events in ${traceState.stats.group_count} audit groups`;
});
const traceIssueCount = computed(() => traceState.events.filter((event) => traceIsIssue(event)).length);
const workspaceKicker = computed(() => {
  if (activeView.value === "sessions") return "Projects";
  if (activeView.value === "session") return "Project";
  if (activeView.value === "review") return "Projects / Needs You";
  if (activeView.value === "trace") return "Observe";
  if (activeView.value === "agent") return "Agents";
  return "Room";
});
const workspaceAriaLabel = computed(() => {
  if (activeView.value === "sessions") return "Projects dashboard";
  if (activeView.value === "session") return "Project detail";
  if (activeView.value === "review") return "Needs You";
  if (activeView.value === "agent") return "Agent workload";
  if (activeView.value === "trace") return "Observe runtime audit";
  return "Room conversation";
});
const workspaceTitle = computed(() => {
  if (activeView.value === "sessions") return "Projects";
  if (activeView.value === "session") return detailSession.value ? `Project: ${detailSession.value.title}` : "Project Detail";
  if (activeView.value === "review") return "Needs You";
  if (activeView.value === "trace") return "Observe";
  if (activeView.value === "agent") return activeAgentUri.value ? `Agent: ${agentLabel(activeAgentUri.value)}` : "Agents";
  return channelTitle.value;
});
const workspaceStatus = computed(() => {
  if (activeView.value === "sessions") {
    if (sessionsLoading.value) return "loading projects";
    if (sessionsError.value) return sessionsError.value;
    return `${workSessions.value.length} projects · ${activeWorkSessionCount.value} active · ${pendingReviewItemCount.value} need you`;
  }
  if (activeView.value === "session") {
    if (sessionDetailLoading.value) return "loading project";
    if (sessionDetailError.value) return sessionDetailError.value;
    const session = detailSession.value;
    return session ? `${projectLaneLabelForSession(session)} · ${session.status} · ${sessionUpdatedAt(session) || "live"}` : "project not selected";
  }
  if (activeView.value === "review") return `${reviewQueue.value.length} need you · ${visibleReviewQueue.value.length} visible`;
  if (activeView.value === "trace") return traceStatus.value;
  if (activeView.value === "agent") return "actor lens across projects";
  return status.value;
});

onMounted(() => {
  clockTimer = window.setInterval(() => {
    clockTick.value = Date.now();
  }, 1000);
  events = new EventSource("/events");
  events.onopen = () => setStatus("connected");
  events.onerror = () => setStatus("reconnecting");
  events.onmessage = (message) => renderEvent(JSON.parse(message.data) as BridgeEvent);

  loadChannels().catch((error: unknown) => appendSimpleRow("error", "bridge", errorMessage(error)));
  void loadSessions();
});

onBeforeUnmount(() => {
  events?.close();
  if (clockTimer) window.clearInterval(clockTimer);
  if (dashboardFrame) window.cancelAnimationFrame(dashboardFrame);
  if (detailReloadTimer) window.clearTimeout(detailReloadTimer);
  for (const timer of typingTimers.values()) window.clearTimeout(timer);
});

watch(visibleWorkSessions, (sessions) => {
  if (selectedSessionId.value && sessions.some((session) => session.session_id === selectedSessionId.value)) {
    return;
  }
  selectedSessionId.value = sessions[0]?.session_id ?? null;
});

watch(selectedSessionId, (sessionId) => {
  if (!sessionId) return;
  if (selectedInspectorRef.value.id.length === 0 || selectedInspectorRef.value.kind === "session") {
    selectedInspectorRef.value = { kind: "session", id: sessionId };
  }
});

function setStatus(value: string): void {
  status.value = value;
}

function channelLabel(channel: SlockUiBridgeChannel): string {
  const label = channel.label || channel.uri.split("/").filter(Boolean).pop() || channel.uri;
  return (channel.kind === "dm" ? "@ " : "# ") + label;
}

function channelUrl(path: string): string {
  const url = new URL(path, window.location.origin);
  if (activeChannel.value) url.searchParams.set("channel", activeChannel.value.uri);
  return url.pathname + url.search;
}

function showSessions(): void {
  activeAgentUri.value = null;
  activeView.value = "sessions";
  void loadSessions();
}

function showReviewQueue(): void {
  activeAgentUri.value = null;
  activeView.value = "review";
  void loadDashboard();
}

async function switchChannel(uri: EndpointUri): Promise<void> {
  const next = channels.value.find((channel) => channel.uri === uri);
  if (!next) return;
  if (activeChannel.value?.uri === next.uri) {
    showChat();
    return;
  }
  activeChannel.value = next;
  showChat();
  clearActiveThread(false);
  resetTimeline();
  await loadHistory().catch((error: unknown) => appendSimpleRow("error", "bridge", errorMessage(error)));
}

function showChat(): void {
  activeView.value = "chat";
  activeAgentUri.value = null;
}

function showAgents(): void {
  activeView.value = "agent";
  activeAgentUri.value = activeAgentUri.value ?? knownAgents.value[0] ?? null;
}

function openAgentDashboard(uri: EndpointUri): void {
  rememberAgent(uri);
  activeAgentUri.value = uri;
  activeView.value = "agent";
}

function openTraceViewer(): void {
  activeAgentUri.value = null;
  activeView.value = "trace";
  void refreshTrace();
}

async function openSessionDetail(session: SessionWorkProjection | string, objectRef?: InspectorRef): Promise<void> {
  const sessionId = typeof session === "string" ? session : session.session_id;
  selectedSessionId.value = sessionId;
  activeAgentUri.value = null;
  activeView.value = "session";
  sessionDetailTab.value = objectRef ? "inspector" : "work";
  selectedInspectorRef.value = objectRef ?? { kind: "session", id: sessionId };
  await loadSessionDetail(sessionId);
}

function openSessionArtifacts(): void {
  sessionDetailTab.value = "inspector";
  const firstArtifact = detailArtifacts.value[0];
  if (firstArtifact) {
    selectedInspectorRef.value = { kind: "artifact", id: firstArtifact.id };
    return;
  }
  const session = detailSession.value;
  if (session) selectedInspectorRef.value = { kind: "session", id: session.session_id };
}

async function openSessionThread(session: SessionWorkProjection): Promise<void> {
  const channel = session.origin?.channel;
  if (channel) {
    await switchChannel(channel);
    if (session.origin?.message_id) {
      activeThreadId.value = session.origin.message_id;
      activeReplyToId.value = session.origin.message_id;
      activeThreadLabel.value = `thread ${session.origin.message_id}`;
    }
  } else {
    showChat();
  }
}

function openSessionTrace(_session: SessionWorkProjection): void {
  openTraceViewer();
}

function rememberAgent(uri: EndpointUri): void {
  if (!uri.startsWith("agent://") || knownAgents.value.includes(uri)) return;
  knownAgents.value = [...knownAgents.value, uri];
}

function agentLabel(uri: EndpointUri): string {
  return "@ " + (uri.split("/").filter(Boolean).pop() || uri);
}

function endpointLabel(uri: EndpointUri): string {
  const parts = uri.split("/").filter(Boolean);
  return parts.at(-1) ?? uri;
}

function phaseLabel(phase: WorkPhase): string {
  switch (phase) {
    case "intake": return "Intake";
    case "shape": return "Shape";
    case "plan": return "Plan";
    case "execute": return "Execute";
    case "review": return "Review";
    case "validate": return "Validate";
    case "decision": return "Decision";
    case "handoff": return "Handoff";
    case "done": return "Done";
  }
}

function projectBoardLane(session: SessionWorkProjection): ProjectBoardLane {
  if (session.phase === "done") return "done";
  if (session.phase === "review") return "review";
  if (session.phase === "validate") return "validate";
  if (session.phase === "execute" || session.phase === "handoff") return "building";
  return "decide";
}

function projectBoardLaneLabel(lane: ProjectBoardLane): string {
  switch (lane) {
    case "decide": return "Decide";
    case "building": return "Building";
    case "review": return "Review";
    case "validate": return "Validate";
    case "done": return "Done";
  }
}

function projectLaneLabelForSession(session: SessionWorkProjection): string {
  return projectBoardLaneLabel(projectBoardLane(session));
}

function selectSession(sessionId: string): void {
  selectedSessionId.value = sessionId;
}

function selectInspector(kind: InspectorKind, id: string): void {
  selectedInspectorRef.value = { kind, id };
  sessionDetailTab.value = "inspector";
}

function sessionSearchPlaceholder(): string {
  return workSessions.value.length > 0 ? "Search projects, agents, blockers" : "Search projects";
}

function compactPreviewText(value: string | undefined, fallback: string, maxLength = 180): string {
  const normalized = (value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/#{1,6}\s+/g, "")
    .replace(/-{3,}/g, " ")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[>*_|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const text = normalized || fallback;
  return text.length > maxLength ? `${text.slice(0, maxLength - 3).trim()}...` : text;
}

function sessionPrimaryText(session: SessionWorkProjection): string {
  return compactPreviewText(session.objective || session.current_work || session.phase_reason, "No current work recorded");
}

function sessionSignalText(session: SessionWorkProjection): string {
  return compactPreviewText(session.current_work || session.latest_report || session.phase_reason, "Waiting for next event");
}

function sessionBlockerSummary(session: SessionWorkProjection): string {
  if (session.blockers.length === 0) return "Clear";
  return session.blockers.map((blocker) => blocker.label).join(" · ");
}

function sessionRunnableActions(session: SessionWorkProjection): WorkAction[] {
  return session.actions.filter((action) => action.kind === "open_thread" || action.kind === "open_trace");
}

function sessionIsStale(session: SessionWorkProjection): boolean {
  if (!session.updated_at || session.phase === "done") return false;
  return clockTick.value - new Date(session.updated_at).getTime() > 15 * 60 * 1000;
}

function sessionWorkflowActions(session: SessionWorkProjection): WorkAction[] {
  return session.actions.filter((action) => action.kind !== "open_thread" && action.kind !== "open_trace");
}

function visibleAgents(session: SessionWorkProjection): AgentWorkSummary[] {
  return session.agents.slice(0, 3);
}

function remainingAgentCount(session: SessionWorkProjection): number {
  return Math.max(0, session.agents.length - visibleAgents(session).length);
}

function agentRoleText(agent: AgentWorkSummary): string {
  return agent.role_label || agent.role || delegationStatusLabel(agent.status);
}

function agentWorkloadForSession(session: SessionWorkProjection, agent: EndpointUri): AgentWorkSummary | undefined {
  return agentWorkload.value.find((workload) => workload.agent === agent)?.sessions.find((item) => item.session_id === session.session_id);
}

function toolCallLabel(toolCall?: ToolCallSummary): string {
  if (!toolCall) return "No tool activity";
  return `${endpointLabel(toolCall.endpoint)}.${toolCall.action}${toolCall.payload_summary ? ` ${toolCall.payload_summary}` : ""}`;
}

function buildBoardTitle(board: BuildBoardProjection): string {
  return board.active ? "Scrum build board" : "Build review";
}

function buildBoardStatus(board: BuildBoardProjection): string {
  const activeColumns = board.columns.filter((column) => column.items.length > 0);
  const cardCount = activeColumns.reduce((sum, column) => sum + column.items.length, 0);
  const writeCount = board.write_operations.length;
  return `${cardCount} cards · ${writeCount} write ${writeCount === 1 ? "operation" : "operations"}`;
}

function buildBoardItemMeta(item: BuildBoardItem): string {
  const owner = item.agent ?? item.owner;
  return [item.kind, item.status, owner ? `@${endpointLabel(owner)}` : ""].filter(Boolean).join(" · ");
}

function buildBoardItemKey(item: BuildBoardItem): string {
  return `${item.kind}:${item.id}`;
}

function buildBoardColumnEmptyText(column: BuildBoardColumn): string {
  switch (column.key) {
    case "todo": return "No decision queued";
    case "building": return "No active build";
    case "review": return "No review item";
    case "validate": return "No validation";
    case "done": return "No completed card";
  }
}

function buildBoardColumnLabel(column: BuildBoardColumn): string {
  switch (column.key) {
    case "todo": return "Decide";
    case "building": return "Building";
    case "review": return "Review";
    case "validate": return "Validate";
    case "done": return "Done";
  }
}

function projectHomeRoomLabel(session: SessionWorkProjection): string {
  return roomLabelFromUri(session.origin?.channel);
}

function roomLabelFromUri(uri?: EndpointUri): string {
  if (!uri) return "No room linked";
  const channel = channels.value.find((item) => item.uri === uri);
  if (channel) return channelLabel(channel);
  const label = endpointLabel(uri);
  return uri.includes("/dm/") ? `@ ${label}` : `# ${label}`;
}

function projectAttentionCount(session: SessionWorkProjection): number {
  return reviewQueue.value.filter((item) => item.session_id === session.session_id).length;
}

function projectAttentionText(session: SessionWorkProjection): string {
  const count = projectAttentionCount(session);
  return count > 0 ? `${count} need you` : "No human action";
}

function projectArtifactText(session: SessionWorkProjection): string {
  if (!session.latest_artifact) return "No artifact yet";
  return `${session.latest_artifact.title || session.latest_artifact.kind} · ${session.latest_artifact.status}`;
}

function projectTone(session: SessionWorkProjection): "need" | "live" | "doc" | "done" | "plain" {
  if (projectAttentionCount(session) > 0 || session.blockers.length > 0 || session.phase === "decision") return "need";
  if (session.latest_artifact && session.phase === "review") return "doc";
  if (session.phase === "execute" || session.phase === "handoff" || session.agents.some((agent) => agent.status === "running" || agent.status === "pending")) return "live";
  if (session.phase === "done") return "done";
  return "plain";
}

function projectToneClass(session: SessionWorkProjection): string {
  const tone = projectTone(session);
  return tone === "plain" ? "" : tone;
}

function reviewTone(kind: ReviewQueueItemKind): "need" | "doc" | "observe" | "plain" {
  if (kind === "artifact") return "doc";
  if (kind === "validation") return "observe";
  if (kind === "approval" || kind === "question" || kind === "decision") return "need";
  return "plain";
}

function reviewToneClass(kind: ReviewQueueItemKind): string {
  const tone = reviewTone(kind);
  return tone === "plain" ? "" : tone;
}

function cardOwnerLabel(item: BuildBoardItem): string {
  return item.agent ? `@${endpointLabel(item.agent)}` : item.owner ? endpointLabel(item.owner) : item.kind;
}

function workCardTone(item: BuildBoardItem): "need" | "live" | "doc" | "observe" | "done" | "plain" {
  if (item.kind === "approval" || item.status === "pending" || item.status === "revision_requested") return "need";
  if (item.kind === "artifact") return "doc";
  if (item.kind === "validation") return "observe";
  if (item.status === "accepted" || item.status === "passed" || item.status === "completed") return "done";
  if (item.kind === "delegation" || item.status === "running") return "live";
  return "plain";
}

function workCardToneClass(item: BuildBoardItem): string {
  const tone = workCardTone(item);
  return tone === "plain" ? "" : tone;
}

function agentRowState(agent: EndpointUri): string {
  const row = agentActivityRows.value.find((item) => item.source === agent);
  if (row?.rowType === "agent-status") return agentStatusVisualState(row);
  if (row?.rowType === "tool") return row.state;
  const workload = agentWorkload.value.find((item) => item.agent === agent);
  if (workload?.blockers.length) return "blocked";
  return workload?.sessions.length ? "assigned" : "idle";
}

function agentLatestIpc(agent: EndpointUri): string {
  const workload = agentWorkload.value.find((item) => item.agent === agent);
  const latest = workload?.latest_tool_call;
  if (latest) return toolCallLabel(latest);
  const row = agentActivityRows.value.find((item) => item.source === agent);
  if (!row) return "No IPC activity";
  return row.rowType === "tool" ? `${toolOperation(row)} ${row.preview}` : row.text;
}

function buildBoardWriteOperationLabel(operation: ToolCallSummary): string {
  return `${endpointLabel(operation.endpoint)} ${operation.action}`;
}

function openBuildBoardItem(session: SessionWorkProjection, item: BuildBoardItem): void {
  void openSessionDetail(session, { kind: item.kind, id: item.id });
}

function selectBuildBoardItem(item: BuildBoardItem): void {
  selectInspector(item.kind, item.id);
}

function lifecycleColumns(detail: SessionDetailProjection | null): LifecycleColumn[] {
  if (!detail) return [];
  const columns: LifecycleColumn[] = [
    {
      phase: "intake",
      label: "Intake",
      items: [
        { kind: "session", id: detail.session.session_id, title: detail.session.title, meta: detail.session.objective || "Project boundary", status: detail.session.status },
        ...detail.constraints.map((item) => ({ kind: "constraint" as const, id: item.id, title: "Constraint", meta: compactText(item.constraint), status: "recorded" })),
      ],
    },
    {
      phase: "plan",
      label: "Plan",
      items: detail.tasks.map((task) => ({ kind: "task" as const, id: task.id, title: task.title, meta: endpointLabel(task.owner), status: task.status })),
    },
    {
      phase: "execute",
      label: "Execute",
      items: detail.delegations.map((delegation) => ({ kind: "delegation" as const, id: delegation.id, title: `@${endpointLabel(delegation.assignee)}`, meta: delegation.role_label || delegation.instruction, status: delegation.status })),
    },
    {
      phase: "review",
      label: "Review",
      items: detail.artifacts.map((artifact) => ({ kind: "artifact" as const, id: artifact.id, title: artifact.title || artifact.kind, meta: endpointLabel(artifact.author), status: artifact.status })),
    },
    {
      phase: "decision",
      label: "Decision",
      items: [
        ...detail.approvals.map((approval) => ({ kind: "approval" as const, id: approval.id, title: `${endpointLabel(approval.tool_endpoint)} ${approval.action}`, meta: approval.payload_summary, status: approval.status })),
        ...detail.questions.map((question) => ({ kind: "question" as const, id: question.id, title: `Question for ${endpointLabel(question.to)}`, meta: question.question, status: question.status })),
        ...detail.decisions.map((decision) => ({ kind: "decision" as const, id: decision.id, title: "Decision", meta: compactText(decision.decision), status: "recorded" })),
      ],
    },
    {
      phase: "validate",
      label: "Validate",
      items: detail.validations.map((validation) => ({ kind: "validation" as const, id: validation.id, title: validation.summary || "Validation", meta: validation.validator ? endpointLabel(validation.validator) : endpointLabel(validation.requester), status: validation.status })),
    },
    {
      phase: "handoff",
      label: "Handoff",
      items: detail.barriers.map((barrier) => ({ kind: "barrier" as const, id: barrier.id, title: barrier.synthesis_requested ? "Synthesis barrier" : "Reply barrier", meta: barrier.expected_from.map(endpointLabel).join(", "), status: barrier.status })),
    },
  ];
  return columns.filter((column) => column.items.length > 0);
}

function resolveInspectorObject(ref: InspectorRef): InspectorObject | null {
  const detail = sessionDetail.value;
  const session = detail?.session ?? selectedSession.value;
  if (!session) return null;
  if (ref.kind === "session") {
    return {
      ref: { kind: "session", id: session.session_id },
      title: session.title,
      eyebrow: "Project",
      status: session.status,
      summary: session.objective || session.phase_reason,
      payload: session,
      source_refs: session.source_refs ?? [],
      trace_refs: session.trace_refs ?? [],
      related: session.agents.map((agent) => agent.delegation_id),
      actions: session.actions,
    };
  }
  if (!detail) return null;
  const task = ref.kind === "task" ? detail.tasks.find((item) => item.id === ref.id) : undefined;
  if (task) return objectFromDetail(ref, task.title, "Task", task.status, endpointLabel(task.owner), task, task.source_refs, task.trace_refs, task.acceptance_criteria ?? []);
  const delegation = ref.kind === "delegation" ? detail.delegations.find((item) => item.id === ref.id) : undefined;
  if (delegation) return objectFromDetail(ref, `@${endpointLabel(delegation.assignee)}`, "Delegation", delegation.status, delegation.instruction, delegation, delegation.source_refs, delegation.trace_refs, [delegation.task_id, delegation.submitted_artifact_id].filter(isString));
  const artifact = ref.kind === "artifact" ? detail.artifacts.find((item) => item.id === ref.id) : undefined;
  if (artifact) return objectFromDetail(ref, artifact.title || artifact.kind, "Artifact", artifact.status, artifactText(artifact), artifact, artifact.source_refs, artifact.trace_refs, artifact.relates_to ?? []);
  const barrier = ref.kind === "barrier" ? detail.barriers.find((item) => item.id === ref.id) : undefined;
  if (barrier) return objectFromDetail(ref, barrier.synthesis_requested ? "Synthesis barrier" : "Reply barrier", "Barrier", barrier.status, barrier.expected_from.map(endpointLabel).join(", "), barrier, barrier.source_ref ? [barrier.source_ref] : [], barrier.trace_refs, Object.values(barrier.replies));
  const decision = ref.kind === "decision" ? detail.decisions.find((item) => item.id === ref.id) : undefined;
  if (decision) return objectFromDetail(ref, "Decision", "Decision", "recorded", compactText(decision.decision), decision, decision.source_refs, decision.trace_refs, decision.relates_to ?? []);
  const question = ref.kind === "question" ? detail.questions.find((item) => item.id === ref.id) : undefined;
  if (question) return objectFromDetail(ref, `Question for ${endpointLabel(question.to)}`, "Question", question.status, question.question, question, question.about_refs, [], [question.answer_artifact_id].filter(isString));
  const approval = ref.kind === "approval" ? detail.approvals.find((item) => item.id === ref.id) : undefined;
  if (approval) return objectFromDetail(ref, `${endpointLabel(approval.tool_endpoint)} ${approval.action}`, "Approval", approval.status, approval.payload_summary, approval, approval.source_refs, approval.trace_refs, []);
  const validation = ref.kind === "validation" ? detail.validations.find((item) => item.id === ref.id) : undefined;
  if (validation) return objectFromDetail(ref, validation.summary || "Validation", "Validation", validation.status, validation.artifact_id || validation.task_id || endpointLabel(validation.requester), validation, validation.source_refs, validation.trace_refs, [validation.artifact_id, validation.task_id].filter(isString));
  const note = ref.kind === "note" ? detail.notes.find((item) => item.id === ref.id) : undefined;
  if (note) return objectFromDetail(ref, `Report from ${endpointLabel(note.from)}`, "Report", note.visibility, note.text, note, note.source_refs, [], [note.delegation_id].filter(isString));
  const constraint = ref.kind === "constraint" ? detail.constraints.find((item) => item.id === ref.id) : undefined;
  if (constraint) return objectFromDetail(ref, "Constraint", "Constraint", "recorded", compactText(constraint.constraint), constraint, constraint.source_refs, [], []);
  const review = ref.kind === "review" ? reviewQueue.value.find((item) => item.id === ref.id) : undefined;
  if (review) return objectFromDetail(ref, review.title, reviewKindLabel(review.kind), "waiting", review.consequence, review, review.source_refs, review.trace_refs, review.actions.map((action) => action.label), review.actions);
  return null;
}

function objectFromDetail(
  ref: InspectorRef,
  title: string,
  eyebrow: string,
  status: string | undefined,
  summary: string | undefined,
  payload: unknown,
  sourceRefs: SourceRef[] = [],
  traceRefs: TraceRef[] = [],
  related: string[] = [],
  actions: WorkAction[] = [],
): InspectorObject {
  return { ref, title, eyebrow, status, summary, payload, source_refs: sourceRefs, trace_refs: traceRefs, related, actions };
}

function eventsForObject(ref: InspectorRef): CollaborationEvent[] {
  return sessionDetailEvents.value.filter((event) => eventMatchesObject(event, ref)).slice(-12).reverse();
}

function eventMatchesObject(event: CollaborationEvent, ref: InspectorRef): boolean {
  const text = JSON.stringify(event);
  return text.includes(ref.id) || (ref.kind === "session" && text.includes(selectedSessionId.value ?? ""));
}

function artifactText(artifact: DetailArtifact): string {
  return artifactContentText(artifact.content);
}

function artifactContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (isRecord(content)) {
    if (typeof content.final_text === "string") return content.final_text;
    if (typeof content.text === "string") return content.text;
    if (typeof content.summary === "string") return content.summary;
  }
  return formatValue(content);
}

function inspectorMarkdownText(object: InspectorObject): string {
  if (object.ref.kind === "artifact" && isRecord(object.payload)) {
    return artifactContentText(object.payload.content);
  }
  return object.summary || objectPreview(object.payload);
}

function objectPreview(value: unknown): string {
  return truncate(compactText(value), 360);
}

function sourceRefLabel(ref: SourceRef): string {
  if (ref.kind === "channel_message") return `${endpointLabel(String(ref.channel ?? "channel"))} ${String(ref.message_id ?? "")}`.trim();
  if (ref.kind === "artifact") return `artifact ${String(ref.artifact_id ?? "")}`.trim();
  if (ref.label) return ref.label;
  if (ref.uri) return ref.uri;
  return ref.kind;
}

function traceRefLabel(ref: TraceRef): string {
  const endpoint = ref.endpoint ? endpointLabel(ref.endpoint) : "observe";
  return [ref.label, endpoint, ref.action].filter(Boolean).join(" · ");
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function messageActorLabel(message: SlockMessage): string {
  if (message.kind === "human") return endpointLabel(message.sender);
  if (message.kind === "agent") return "@" + endpointLabel(message.sender);
  return endpointLabel(message.sender);
}

function messageRoleLabel(message: SlockMessage): string {
  if (message.kind === "human") return "human";
  if (message.kind === "agent") return "agent";
  return "system";
}

function isFinalReportMessage(message: SlockMessage): boolean {
  return message.projection?.presentation === "final_report";
}

function isArtifactProjectionMessage(message: SlockMessage): boolean {
  return message.projection?.presentation === "artifact";
}

function finalReportTitle(message: SlockMessage): string {
  return message.projection?.title || "Final synthesis";
}

function finalReportMeta(message: SlockMessage): string {
  return `${projectionProjectLabel(message)} · final synthesis · ${messageTime(message.created_at)}`;
}

function artifactProjectionTitle(message: SlockMessage): string {
  return message.projection?.title || "Artifact ready";
}

function artifactProjectionMeta(message: SlockMessage): string {
  const author = message.projection?.author ?? message.sender;
  return `${projectionProjectLabel(message)} · artifact · @${endpointLabel(author)} · ${messageTime(message.created_at)}`;
}

function projectionSummaryText(message: SlockMessage): string {
  const fallback = isFinalReportMessage(message) ? "Final synthesis is ready." : "Submitted an artifact.";
  return compactPreviewText(message.text, fallback, 320);
}

function projectionAttachmentTitle(message: SlockMessage): string {
  return isFinalReportMessage(message) ? finalReportTitle(message) : artifactProjectionTitle(message);
}

function projectionAttachmentMeta(message: SlockMessage): string {
  return isFinalReportMessage(message) ? finalReportMeta(message) : artifactProjectionMeta(message);
}

function projectionAttachmentKind(message: SlockMessage): string {
  return isFinalReportMessage(message) ? "Final synthesis" : "Artifact";
}

function projectionProjectLabel(message: SlockMessage): string {
  const sessionId = message.projection?.session_id;
  if (!sessionId) return "Project";
  return workSessions.value.find((session) => session.session_id === sessionId)?.title ?? `Project ${sessionId}`;
}

function canOpenArtifactProjection(message: SlockMessage): boolean {
  return Boolean(message.projection?.session_id && message.projection?.artifact_id);
}

function openArtifactProjection(message: SlockMessage): void {
  const sessionId = message.projection?.session_id;
  const artifactId = message.projection?.artifact_id;
  if (!sessionId || !artifactId) return;
  void openSessionDetail(sessionId, { kind: "artifact", id: artifactId });
}

function sessionPhaseClass(session: SessionWorkProjection): string {
  return session.phase;
}

function sessionUpdatedAt(session: SessionWorkProjection): string {
  if (!session.updated_at) return "";
  return messageTime(session.updated_at);
}

function sessionOwnerLabel(session: SessionWorkProjection): string {
  return endpointLabel(session.owner);
}

function delegationStatusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

function sessionAction(session: SessionWorkProjection, action: SessionWorkProjection["actions"][number]): void {
  if (action.kind === "open_trace") {
    openSessionTrace(session);
    return;
  }
  if (action.kind === "open_thread") {
    void openSessionThread(session);
    return;
  }
}

function sessionObjectAction(session: SessionWorkProjection, kind: InspectorKind, id: string): void {
  void openSessionDetail(session, { kind, id });
}

function openReviewItem(item: ReviewQueueItem): void {
  void openSessionDetail(item.session_id, reviewInspectorRef(item));
}

function reviewInspectorRef(item: ReviewQueueItem): InspectorRef {
  const separator = item.id.indexOf(":");
  const objectId = separator >= 0 ? item.id.slice(separator + 1) : item.id;
  if (item.kind === "artifact") return { kind: "artifact", id: objectId };
  if (item.kind === "approval") return { kind: "approval", id: objectId };
  if (item.kind === "question") return { kind: "question", id: objectId };
  if (item.kind === "validation") return { kind: "validation", id: objectId };
  return { kind: "review", id: item.id };
}

function reviewKindLabel(kind: string): string {
  switch (kind) {
    case "artifact": return "Artifacts";
    case "approval": return "Approvals";
    case "question": return "Questions";
    case "validation": return "Validations";
    case "decision": return "Decisions";
    default: return "All";
  }
}

function reviewItemMeta(item: ReviewQueueItem): string {
  const parts = [
    item.required_action,
    item.producer ? `from ${endpointLabel(item.producer)}` : undefined,
    sessionForReview(item)?.phase_label,
  ];
  return parts.filter(Boolean).join(" · ");
}

function sessionForReview(item: ReviewQueueItem): SessionWorkProjection | undefined {
  return workSessions.value.find((session) => session.session_id === item.session_id);
}

function reviewItemObjectId(item: ReviewQueueItem): string {
  const separator = item.id.indexOf(":");
  return separator >= 0 ? item.id.slice(separator + 1) : item.id;
}

function currentDetailSessionId(): string {
  return detailSession.value?.session_id ?? selectedSessionId.value ?? "";
}

function messageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function resetTimeline(): void {
  for (const timer of typingTimers.values()) window.clearTimeout(timer);
  rendered.clear();
  streamRows.clear();
  statusRows.clear();
  toolRows.clear();
  agentActivityRows.value = [];
  knownAgents.value = [];
  approvalById.clear();
  pendingToolApprovals.clear();
  typingTimers.clear();
  rows.value = [];
  nextOperationSequence = 1;
}

function insertRow<T extends UiRow>(row: T): T {
  const reactiveRow = reactive(row) as T;
  rows.value.push(reactiveRow);
  scrollTimeline();
  return reactiveRow;
}

function insertAgentActivityRow<T extends AgentActivityRow>(row: T): T {
  row.receivedAt = row.receivedAt ?? new Date().toISOString();
  row.sequence = row.sequence ?? nextOperationSequence++;
  const reactiveRow = reactive(row) as T;
  agentActivityRows.value.push(reactiveRow);
  rememberAgent(row.source);
  return reactiveRow;
}

function ensureAgentStatusRow(row: Omit<AgentStatusRow, "rowType" | "id">): AgentStatusRow {
  const id = statusKeyFromParts(row.source, row.threadId);
  let existing = statusRows.get(id);
  if (!existing) {
    existing = insertRow({
      rowType: "agent-status",
      id,
      ...row,
    });
    statusRows.set(id, existing);
    return existing;
  }

  existing.channel = row.channel;
  existing.threadReply = row.threadReply;
  existing.receivedAt = row.receivedAt ?? existing.receivedAt;
  existing.sequence = row.sequence ?? existing.sequence;
  existing.runId = row.runId ?? existing.runId;
  existing.messageId = row.messageId ?? existing.messageId;
  existing.startedAt = row.startedAt ?? existing.startedAt;
  existing.finishedAt = row.finishedAt ?? existing.finishedAt;
  existing.lastActivityAt = row.lastActivityAt ?? row.receivedAt ?? existing.lastActivityAt;
  existing.finalMessageId = row.finalMessageId ?? existing.finalMessageId;
  existing.errorMessage = row.errorMessage ?? existing.errorMessage;
  existing.state = row.state;
  existing.text = row.text;
  existing.synthetic = row.synthetic;
  scrollTimeline();
  return existing;
}

function ensureAgentStatusRowForTool(row: ToolRow): void {
  const id = statusKeyFromParts(row.source, row.threadId);
  const existing = statusRows.get(id);
  const receivedAt = row.receivedAt ?? new Date().toISOString();

  if (!existing) {
    ensureAgentStatusRow({
      channel: row.channel,
      source: row.source,
      threadId: row.threadId,
      threadReply: row.threadReply,
      messageId: row.threadId,
      receivedAt,
      lastActivityAt: receivedAt,
      state: row.state === "errored" ? "errored" : "running",
      text: row.state === "errored" ? "Tool call failed." : row.state === "running" ? "Using tool." : "Tool call completed.",
      synthetic: true,
    });
    return;
  }

  const wasCompleted = existing.state === "completed";
  existing.channel = row.channel;
  existing.threadReply = row.threadReply;
  existing.messageId = existing.messageId ?? row.threadId;
  existing.lastActivityAt = receivedAt;
  if (row.state === "running") {
    existing.state = "running";
    if (existing.synthetic || wasCompleted) {
      existing.text = "Using tool.";
      existing.synthetic = true;
    }
  } else if (row.state === "errored") {
    existing.state = "errored";
    if (existing.synthetic) existing.text = "Tool call failed.";
  } else if (existing.synthetic) {
    existing.text = "Tool call completed.";
  }
  scrollTimeline();
}

function appendSimpleRow(className: RowClass, meta: string, text: string, id?: string): SimpleRow | undefined {
  if (id && rendered.has(id)) return undefined;
  if (id) rendered.add(id);
  return insertRow({
    rowType: "simple",
    id: id ?? `row:${nextEphemeralRowId++}`,
    className,
    meta,
    text,
    renderedId: id,
  });
}

function removeRow(id: string): void {
  rendered.delete(id);
  rows.value = rows.value.filter((row) => row.id !== id);
}

function streamKey(delta: Pick<SlockMessageDelta, "source" | "thread_id">): string {
  return "stream:" + delta.source + ":" + delta.thread_id;
}

function removeStreamRow(delta: Pick<SlockMessageDelta, "source" | "thread_id">): void {
  const id = streamKey(delta);
  streamRows.delete(id);
  removeRow(id);
}

function statusKeyFromParts(source: EndpointUri, threadId: string): string {
  return "agent-status:" + source + ":" + threadId;
}

function toolKeyFromParts(source: EndpointUri, threadId: string, toolCallId: string): string {
  return "tool:" + source + ":" + threadId + ":" + toolCallId;
}

function toolKey(delta: SlockMessageDelta, tool: ToolMetadata): string {
  return toolKeyFromParts(delta.source, delta.thread_id, tool.tool_call_id);
}

function approvalToolKey(approval: SlockApprovalEvent): string | undefined {
  const metadata = approval.request.metadata;
  if (!isRecord(metadata) || typeof metadata.thread_id !== "string" || typeof metadata.tool_call_id !== "string") {
    return undefined;
  }
  return toolKeyFromParts(approval.source, metadata.thread_id, metadata.tool_call_id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isToolMetadata(value: unknown): value is ToolMetadata {
  return isRecord(value)
    && value.type === "tool_call"
    && typeof value.tool_call_id === "string"
    && typeof value.name === "string";
}

function agentStatusState(metadata: unknown): AgentStatusState {
  if (!isRecord(metadata)) return "running";
  const state = metadata.phase_state;
  return state === "streaming" || state === "completed" || state === "errored" ? state : "running";
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength - 1) + "..." : value;
}

function compactText(value: unknown): string {
  if (isRecord(value) || Array.isArray(value)) return formatValue(value).replace(/\s+/g, " ").trim();
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function toolPreview(tool: ToolMetadata): string {
  const args = isRecord(tool.arguments) ? tool.arguments : {};
  if (typeof args.path === "string") return args.path;
  if (typeof args.command === "string") {
    const argv = Array.isArray(args.args) ? args.args.filter((item): item is string => typeof item === "string") : [];
    return truncate([args.command, ...argv].join(" "), 120);
  }
  return truncate(formatValue(tool.arguments).replace(/\s+/g, " "), 120);
}

function formatShellResult(result: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("exit_code: " + String(result.exit_code ?? ""));
  if (typeof result.cwd === "string") lines.push("cwd: " + result.cwd);
  if (typeof result.stdout === "string" && result.stdout.length > 0) {
    lines.push("", "stdout:", result.stdout.trimEnd());
  }
  if (typeof result.stderr === "string" && result.stderr.length > 0) {
    lines.push("", "stderr:", result.stderr.trimEnd());
  }
  return lines.join("\n");
}

function unwrapIpcResult(value: unknown): unknown {
  return isRecord(value) && typeof value.mime_type === "string" && Object.prototype.hasOwnProperty.call(value, "data")
    ? value.data
    : value;
}

function formatShellResultSummary(result: Record<string, unknown>): string {
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const parts = ["exit " + String(result.exit_code ?? "")];
  if (stdout.length > 0) parts.push("stdout " + stdout.length + " chars");
  if (stderr.length > 0) parts.push("stderr " + stderr.length + " chars");
  return parts.join(" | ");
}

function formatToolResultSummary(tool: ToolMetadata): string {
  const parsed = parseJsonMaybe(tool.result);
  const data = unwrapIpcResult(parsed);
  if (isRecord(data) && typeof data.exit_code === "number") {
    return formatShellResultSummary(data);
  }
  if (isRecord(data) && typeof data.status === "number" && typeof data.final_url === "string") {
    const title = typeof data.title === "string" && data.title.length > 0 ? " | " + data.title : "";
    return String(data.status) + (data.ok === false ? " failed" : " ok") + title;
  }
  if (isRecord(data) && typeof data.ok === "boolean") {
    return data.ok ? "ok" : "failed";
  }
  if (isRecord(data) && Object.prototype.hasOwnProperty.call(data, "result")) {
    return "result: " + truncate(compactText(data.result), 120);
  }
  return truncate(compactText(data), 120) || "completed";
}

function formatToolResult(tool: ToolMetadata): string {
  const parsed = parseJsonMaybe(tool.result);
  const data = unwrapIpcResult(parsed);
  if (isRecord(data) && typeof data.exit_code === "number") {
    return formatShellResult(data);
  }
  return formatValue(parsed);
}

function grantSummary(result?: SlockApprovalResult): string {
  const grant = result?.grant;
  if (!isRecord(grant)) return "";
  const actions = Array.isArray(grant.actions) ? grant.actions.filter((action): action is string => typeof action === "string").join(",") : "";
  const target = typeof grant.target === "string" ? grant.target : "target";
  const expires = typeof grant.expires_at === "string" ? grant.expires_at : "";
  return "grant " + target + (actions ? " " + actions : "") + (expires ? " until " + expires : "");
}

function diffPreview(approval: SlockApprovalEvent): string {
  const call = approval.request.proposed_call;
  const payload = call?.payload;
  if (!isRecord(call) || call.action !== "edit" || !isRecord(payload)) return "";
  if (typeof payload.old_text !== "string" || typeof payload.new_text !== "string") return "";
  const path = typeof payload.path === "string" ? payload.path : "file";
  const oldLines = payload.old_text.split("\n").map((line) => "- " + line);
  const newLines = payload.new_text.split("\n").map((line) => "+ " + line);
  return ["--- " + path, "+++ " + path, ...oldLines, ...newLines].join("\n");
}

function approvalRiskLabel(approval: SlockApprovalEvent): string {
  switch (approval.request.risk) {
    case "file_write":
      return "File write";
    case "file_edit":
      return "File edit";
    case "shell_exec":
      return "Shell command";
    case "memory_write":
      return "Memory write";
    case "memory_admin":
      return "Memory admin";
    default:
      return approval.request.risk.replace(/_/g, " ");
  }
}

function approvalCallLine(approval: SlockApprovalEvent): string {
  const call = approval.request.proposed_call;
  return call.target + " " + call.action;
}

function approvalPayload(approval: SlockApprovalEvent): unknown {
  return approval.request.proposed_call.payload;
}

function approvalPayloadSummary(approval: SlockApprovalEvent): string {
  const call = approval.request.proposed_call;
  const payload = approvalPayload(approval);
  if (!isRecord(payload)) return truncate(compactText(payload), 160);

  if (call.action === "exec" && typeof payload.command === "string") {
    const argv = Array.isArray(payload.args) ? payload.args.filter((item): item is string => typeof item === "string") : [];
    return truncate([payload.command, ...argv].join(" "), 160);
  }
  if ((call.action === "write" || call.action === "edit") && typeof payload.path === "string") {
    return payload.path;
  }
  if ((call.action === "summarize" || call.action === "record_tool_result" || call.action === "vector_store") && typeof payload.scope === "string") {
    const operation = typeof payload.operation === "string" ? " / " + payload.operation : "";
    return payload.scope + operation;
  }
  return truncate(formatValue(payload).replace(/\s+/g, " "), 160);
}

function approvalDetailChips(approval: SlockApprovalEvent): string[] {
  const call = approval.request.proposed_call;
  const payload = approvalPayload(approval);
  const chips = [approvalCallLine(approval)];
  if (isRecord(payload)) {
    if (typeof payload.path === "string") chips.push(payload.path);
    if (typeof payload.cwd === "string") chips.push("cwd " + payload.cwd);
    if (typeof payload.content === "string") chips.push(payload.content.length + " chars");
    if (typeof payload.old_text === "string" && typeof payload.new_text === "string") {
      chips.push(payload.old_text.length + " -> " + payload.new_text.length + " chars");
    }
    if (Array.isArray(payload.trajectories)) chips.push(payload.trajectories.length + " trajectories");
    if (call.action === "record_tool_result" && typeof payload.tool_name === "string") chips.push(payload.tool_name);
  }
  return [...new Set(chips.filter((chip) => chip.length > 0))];
}

function approvalRawPayload(approval: SlockApprovalEvent): string {
  return formatValue(approval.request.proposed_call.payload);
}

function toolNameFromApproval(approval: SlockApprovalEvent): string {
  const metadata = approval.request.metadata;
  if (isRecord(metadata) && typeof metadata.tool_name === "string") return metadata.tool_name;
  return approval.request.proposed_call.action;
}

function toolPreviewFromApproval(approval: SlockApprovalEvent): string {
  const call = approval.request.proposed_call;
  return call.target + " " + call.action;
}

function createToolRowForApproval(id: string, approval: SlockApprovalEvent): ToolRow | undefined {
  const metadata = approval.request.metadata;
  if (!isRecord(metadata) || typeof metadata.thread_id !== "string" || typeof metadata.tool_call_id !== "string") return undefined;
  const row = insertAgentActivityRow({
    rowType: "tool",
    id,
    channel: typeof metadata.channel === "string" ? metadata.channel : activeChannel.value?.uri,
    source: approval.source,
    threadId: metadata.thread_id,
    threadReply: Boolean(metadata.thread_id),
    toolCallId: metadata.tool_call_id,
    state: "running",
    name: toolNameFromApproval(approval),
    preview: toolPreviewFromApproval(approval),
    argumentsText: formatValue(approval.request.proposed_call.payload),
    open: true,
  });
  toolRows.set(id, row);
  return row;
}

function renderToolDelta(delta: SlockMessageDelta, tool: ToolMetadata): void {
  const id = toolKey(delta, tool);
  let row = toolRows.get(id);
  if (!row) {
    row = insertAgentActivityRow({
      rowType: "tool",
      id,
      channel: activeChannel.value?.uri,
      source: delta.source,
      threadId: delta.thread_id,
      threadReply: Boolean(delta.thread_id),
      toolCallId: tool.tool_call_id,
      state: "running",
      name: tool.name,
      preview: toolPreview(tool),
      argumentsText: formatValue(tool.arguments),
      open: false,
    });
    toolRows.set(id, row);
  }

  updateToolRow(row, tool);
  const pendingApproval = pendingToolApprovals.get(id);
  if (pendingApproval) {
    attachApprovalToToolRow(row, pendingApproval);
  }
  ensureAgentStatusRowForTool(row);
}

function updateToolRow(row: ToolRow, tool: ToolMetadata): void {
  const state = tool.state === "completed" || tool.state === "errored" ? tool.state : "running";
  row.state = state;
  row.name = tool.name;
  row.preview = toolPreview(tool);
  row.argumentsText = formatValue(tool.arguments);
  row.open = state === "running" && Boolean(row.approval);

  if (state !== "running" && Object.prototype.hasOwnProperty.call(tool, "result")) {
    row.resultSummary = formatToolResultSummary(tool);
    row.resultText = formatToolResult(tool);
  }
}

function attachApprovalToToolRow(row: ToolRow, approval: SlockApprovalEvent): void {
  removeApprovalRow(approval.id);
  row.approval = approval;
  row.approvalResult = undefined;
  row.open = true;
  ensureAgentStatusRowForTool(row);
}

function updateToolApproval(row: ToolRow, result: SlockApprovalResult): boolean {
  if (!row.approval) return false;
  row.approvalResult = result;
  return true;
}

function removeApprovalRow(id: string): void {
  removeRow("approval:" + id);
}

function appendApproval(approval: SlockApprovalEvent): void {
  const id = "approval:" + approval.id;
  if (rendered.has(id)) return;
  rendered.add(id);
  insertRow({ rowType: "approval", id, approval });
}

function renderApprovalRequested(approval: SlockApprovalEvent): void {
  rememberAgent(approval.source);
  approvalById.set(approval.id, approval);
  const key = approvalToolKey(approval);
  if (key) {
    pendingToolApprovals.set(key, approval);
    const row = toolRows.get(key) ?? createToolRowForApproval(key, approval);
    if (row) {
      attachApprovalToToolRow(row, approval);
      scrollTimeline();
      return;
    }
  }

  appendApproval(approval);
}

function renderApprovalResolved(id: string, result: SlockApprovalResult): void {
  const approval = approvalById.get(id);
  const key = approval ? approvalToolKey(approval) : undefined;
  if (key) {
    const row = toolRows.get(key);
    pendingToolApprovals.delete(key);
    if (row && updateToolApproval(row, result)) {
      removeApprovalRow(id);
      approvalById.delete(id);
      return;
    }
  }

  removeApprovalRow(id);
  approvalById.delete(id);
  const summary = grantSummary(result);
  appendSimpleRow("delta", "approval", (result.approved ? "Approved" : "Denied") + (summary ? "\n" + summary : ""));
}

function renderAgentRunStarted(run: SlockAgentRunEvent): void {
  rememberAgent(run.agent);
  const receivedAt = run.started_at ?? new Date().toISOString();
  const activity: AgentStatusRow = insertAgentActivityRow({
    rowType: "agent-status",
    id: `agent-run:${run.run_id}:started`,
    channel: activeChannel.value?.uri,
    source: run.agent,
    threadId: run.message_id,
    threadReply: Boolean(run.thread_id),
    runId: run.run_id,
    messageId: run.message_id,
    startedAt: receivedAt,
    lastActivityAt: receivedAt,
    state: "running",
    text: "Run started.",
  });

  ensureAgentStatusRow({
    channel: activity.channel,
    source: activity.source,
    threadId: activity.threadId,
    threadReply: activity.threadReply,
    receivedAt: activity.receivedAt,
    sequence: activity.sequence,
    runId: run.run_id,
    messageId: run.message_id,
    startedAt: receivedAt,
    lastActivityAt: receivedAt,
    state: "running",
    text: "Run started.",
    synthetic: false,
  });
}

function renderAgentRunFinished(run: SlockAgentRunEvent): void {
  rememberAgent(run.agent);
  removeStreamRow({ source: run.agent, thread_id: run.message_id });
  const receivedAt = run.finished_at ?? new Date().toISOString();
  const state = run.state === "started" ? "running" : run.state;
  const text = agentRunText(run);
  const activity: AgentStatusRow = insertAgentActivityRow({
    rowType: "agent-status",
    id: `agent-run:${run.run_id}:finished`,
    channel: activeChannel.value?.uri,
    source: run.agent,
    threadId: run.message_id,
    threadReply: Boolean(run.thread_id),
    runId: run.run_id,
    messageId: run.message_id,
    startedAt: run.started_at,
    finishedAt: receivedAt,
    lastActivityAt: receivedAt,
    finalMessageId: run.final_message_id,
    errorMessage: run.error?.message,
    state,
    text,
  });

  ensureAgentStatusRow({
    channel: activity.channel,
    source: activity.source,
    threadId: activity.threadId,
    threadReply: activity.threadReply,
    receivedAt: activity.receivedAt,
    sequence: activity.sequence,
    runId: run.run_id,
    messageId: run.message_id,
    startedAt: run.started_at,
    finishedAt: receivedAt,
    lastActivityAt: receivedAt,
    finalMessageId: run.final_message_id,
    errorMessage: run.error?.message,
    state,
    text,
    synthetic: false,
  });
}

function agentRunText(run: SlockAgentRunEvent): string {
  if (run.state === "completed") return "Run completed.";
  if (run.state === "cancelled") return "Run cancelled" + (run.reason ? ": " + run.reason : ".");
  if (run.state === "errored") return run.error?.message ? "Run failed: " + run.error.message : "Run failed.";
  return "Run started.";
}

function renderMessage(message: SlockMessage): void {
  if (message.kind === "agent") rememberAgent(message.sender);
  if (message.kind === "agent" && message.thread_id) {
    const runId = message.reply_to_id || message.thread_id;
    markRunFinished(runId, "completed");
    const id = "stream:" + message.sender + ":" + runId;
    streamRows.delete(id);
    removeRow(id);
  }
  if (rendered.has(message.id)) return;
  rendered.add(message.id);
  insertRow({
    rowType: "message",
    id: message.id,
    message,
    threadReply: Boolean(message.thread_id),
    runState: "active",
  });
}

function renderMessageUpdated(message: SlockMessage): void {
  const row = rows.value.find((entry): entry is MessageRow => entry.rowType === "message" && entry.message.id === message.id);
  if (!row) {
    renderMessage(message);
    return;
  }

  row.message = message;
  row.threadReply = Boolean(message.thread_id);
}

function renderTypingStarted(typing: { source: EndpointUri; thread_id?: string | null }): void {
  const source = typing.source || "channel";
  const id = "typing:" + source + ":" + (typing.thread_id ?? "");
  let row = rows.value.find((entry): entry is SimpleRow => entry.rowType === "simple" && entry.id === id);
  if (!row) {
    row = appendSimpleRow("delta", source, "typing...", id);
  }

  const currentTimer = typingTimers.get(id);
  if (currentTimer) window.clearTimeout(currentTimer);
  typingTimers.set(id, window.setTimeout(() => {
    typingTimers.delete(id);
    removeRow(id);
  }, 2000));
}

function renderSubscriptionClosed(subscription: { subscriber: EndpointUri; reason?: string }): void {
  setStatus("subscription closed");
  const reason = subscription.reason ? ": " + subscription.reason : "";
  appendSimpleRow("delta", subscription.subscriber || "channel", "Subscription closed" + reason);
}

function setActiveThread(message: SlockMessage): void {
  activeThreadId.value = message.thread_id || message.id;
  activeReplyToId.value = message.id;
  activeThreadLabel.value = "Thread: " + truncate(compactText(message.text) || activeThreadId.value, 96);
  nextTick(() => messageInput.value?.focus());
}

function clearActiveThread(focus = true): void {
  activeThreadId.value = null;
  activeReplyToId.value = null;
  activeThreadLabel.value = "";
  if (focus) nextTick(() => messageInput.value?.focus());
}

function markRunFinished(messageId: string, state: "cancelled" | "completed"): void {
  const row = rows.value.find((entry): entry is MessageRow => entry.rowType === "message" && entry.message.id === messageId);
  if (!row) return;
  row.runState = state;
}

function markAgentStatusCancelled(agent: EndpointUri, messageId: string, reason?: string): void {
  const row = statusRows.get(statusKeyFromParts(agent, messageId));
  if (!row) return;
  const receivedAt = new Date().toISOString();
  row.state = "cancelled";
  row.finishedAt = row.finishedAt ?? receivedAt;
  row.lastActivityAt = receivedAt;
  row.text = "Run cancelled" + (reason ? ": " + reason : ".");
  row.synthetic = false;
}

function renderDelta(delta: SlockMessageDelta): void {
  rememberAgent(delta.source);
  if (delta.kind === "status") {
    if (isToolMetadata(delta.metadata)) {
      renderToolDelta(delta, delta.metadata);
      return;
    }

    const state = agentStatusState(delta.metadata);

    const activityRow: AgentStatusRow = insertAgentActivityRow({
      rowType: "agent-status",
      id: `agent-status:${nextAgentStatusRowId++}`,
      channel: activeChannel.value?.uri,
      source: delta.source,
      threadId: delta.thread_id,
      threadReply: Boolean(delta.thread_id),
      state,
      text: delta.text,
    });

    ensureAgentStatusRow({
      channel: activityRow.channel,
      source: activityRow.source,
      threadId: activityRow.threadId,
      threadReply: activityRow.threadReply,
      messageId: activityRow.threadId,
      receivedAt: activityRow.receivedAt,
      sequence: activityRow.sequence,
      lastActivityAt: activityRow.receivedAt,
      state,
      text: delta.text,
      synthetic: false,
    });
    return;
  }

  removeStreamRow(delta);
  const receivedAt = new Date().toISOString();
  ensureAgentStatusRow({
    channel: activeChannel.value?.uri,
    source: delta.source,
    threadId: delta.thread_id,
    threadReply: Boolean(delta.thread_id),
    messageId: delta.thread_id,
    receivedAt,
    lastActivityAt: receivedAt,
    state: "streaming",
    text: "Drafting response.",
    synthetic: true,
  });
  scrollTimeline();
}

function renderEvent(event: BridgeEvent): void {
  if (isDashboardEvent(event)) {
    renderDashboardEvent(event);
    return;
  }
  if (event.type === "bridge_connected") {
    void loadDashboard();
    return;
  }
  if (event.channel && activeChannel.value && event.channel !== activeChannel.value.uri) {
    return;
  }
  if (event.type === "message_created" && event.message) {
    renderMessage(event.message);
    return;
  }
  if (event.type === "message_updated" && event.message) {
    renderMessageUpdated(event.message);
    return;
  }
  if (event.type === "message_delta" && event.delta) {
    renderDelta(event.delta);
    return;
  }
  if (event.type === "agent_run_started" && event.run) {
    renderAgentRunStarted(event.run);
    return;
  }
  if (event.type === "agent_run_finished" && event.run) {
    renderAgentRunFinished(event.run);
    return;
  }
  if (event.type === "typing_started" && event.typing) {
    renderTypingStarted(event.typing);
    return;
  }
  if (event.type === "subscription_closed" && event.subscription) {
    renderSubscriptionClosed(event.subscription);
    return;
  }
  if (event.type === "agent_error" && event.error) {
    rememberAgent(event.error.source);
    appendSimpleRow("error", event.error.source, event.error.code + ": " + event.error.message);
    return;
  }
  if (event.type === "agent_cancelled" && event.cancelled) {
    rememberAgent(event.cancelled.agent);
    markRunFinished(event.cancelled.message_id, "cancelled");
    markAgentStatusCancelled(event.cancelled.agent, event.cancelled.message_id, event.cancelled.reason);
    appendSimpleRow("delta", event.cancelled.agent, "Cancelled" + (event.cancelled.reason ? ": " + event.cancelled.reason : ""));
    return;
  }
  if (event.type === "approval_requested" && event.approval) {
    renderApprovalRequested(event.approval);
    return;
  }
  if (event.type === "approval_resolved" && event.id && event.result) {
    renderApprovalResolved(event.id, event.result);
  }
}

function isDashboardEvent(event: BridgeEvent): event is DashboardEvent {
  return event.type === "dashboard_snapshot" || event.type === "session_updated" || event.type === "dashboard_subscription_closed";
}

function renderDashboardEvent(event: DashboardEvent): void {
  if (event.type === "dashboard_subscription_closed") {
    sessionsError.value = event.reason ? `dashboard closed: ${event.reason}` : "dashboard subscription closed";
    return;
  }
  queueDashboardSnapshot(event);
  if (event.type === "session_updated" && activeView.value === "session" && event.session_id === selectedSessionId.value) {
    scheduleSessionDetailReload(event.session_id);
  }
}

function queueDashboardSnapshot(snapshot: DashboardSnapshot): void {
  if ((snapshot.sequence ?? 0) < dashboardSequence.value) return;
  pendingDashboardSnapshot = snapshot;
  if (dashboardFrame) return;
  dashboardFrame = window.requestAnimationFrame(() => {
    dashboardFrame = 0;
    if (!pendingDashboardSnapshot) return;
    applyDashboardSnapshot(pendingDashboardSnapshot);
    pendingDashboardSnapshot = undefined;
  });
}

function applyDashboardSnapshot(snapshot: DashboardSnapshot): void {
  if ((snapshot.sequence ?? 0) < dashboardSequence.value) return;
  dashboardSequence.value = Math.max(dashboardSequence.value, snapshot.sequence ?? 0);
  workSessions.value = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  reviewQueue.value = Array.isArray(snapshot.review_queue) ? snapshot.review_queue : [];
  agentWorkload.value = Array.isArray(snapshot.agent_workload) ? snapshot.agent_workload : [];
  dashboardLastEventAt.value = snapshot.at || new Date().toISOString();
  sessionsError.value = "";
}

function scheduleSessionDetailReload(sessionId: string): void {
  if (detailReloadTimer) window.clearTimeout(detailReloadTimer);
  detailReloadTimer = window.setTimeout(() => {
    detailReloadTimer = undefined;
    void loadSessionDetail(sessionId, { quiet: true });
  }, 240);
}

async function decideApproval(id: string, approved: boolean): Promise<void> {
  const response = await fetch("/api/approvals/" + encodeURIComponent(id), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved }),
  });
  if (!response.ok) {
    appendSimpleRow("error", "approval", await response.text());
  }
}

async function cancelRun(messageId: string, row: MessageRow): Promise<void> {
  row.runState = "cancelling";
  const response = await fetch(channelUrl("/api/runs/" + encodeURIComponent(messageId) + "/cancel"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: activeChannel.value?.uri, reason: "user cancelled" }),
  });
  if (!response.ok) {
    row.runState = "active";
    appendSimpleRow("error", "cancel", await response.text());
  }
}

async function loadHistory(): Promise<void> {
  if (!activeChannel.value) return;
  const response = await fetch(channelUrl("/api/history"));
  if (!response.ok) throw new Error(await response.text());
  const body = await response.json() as { messages?: SlockMessage[] };
  for (const message of body.messages ?? []) renderMessage(message);
}

async function loadSessions(): Promise<void> {
  await loadDashboard();
}

async function loadDashboard(): Promise<void> {
  sessionsLoading.value = true;
  sessionsError.value = "";
  try {
    const response = await fetch("/api/dashboard");
    if (!response.ok) throw new Error(await response.text());
    applyDashboardSnapshot(await response.json() as DashboardSnapshot);
  } catch (error) {
    sessionsError.value = errorMessage(error);
  } finally {
    sessionsLoading.value = false;
  }
}

async function loadSessionDetail(sessionId: string, options: { quiet?: boolean } = {}): Promise<void> {
  if (!options.quiet) {
    sessionDetailLoading.value = true;
  }
  sessionDetailError.value = "";
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/detail`);
    if (!response.ok) throw new Error(await response.text());
    const body = await response.json() as SessionDetailResponse;
    if (!body.session) throw new Error("session detail not found");
    sessionDetail.value = body.session;
    sessionDetailEvents.value = Array.isArray(body.events) ? body.events : [];
    sessionDetailLoadedAt.value = new Date().toISOString();
    if (selectedInspectorRef.value.id.length === 0 || selectedInspectorRef.value.kind === "session") {
      selectedInspectorRef.value = { kind: "session", id: body.session.session.session_id };
    }
  } catch (error) {
    sessionDetailError.value = errorMessage(error);
  } finally {
    sessionDetailLoading.value = false;
  }
}

async function postSessionAction(path: string, body: Record<string, unknown>, actionKey: string): Promise<boolean> {
  pendingActions.value = { ...pendingActions.value, [actionKey]: true };
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await response.text());
    await loadDashboard();
    if (selectedSessionId.value) await loadSessionDetail(selectedSessionId.value, { quiet: true });
    return true;
  } catch (error) {
    sessionDetailError.value = errorMessage(error);
    return false;
  } finally {
    const next = { ...pendingActions.value };
    delete next[actionKey];
    pendingActions.value = next;
  }
}

async function closeSelectedSession(status: "completed" | "archived" | "cancelled" = "completed"): Promise<void> {
  const session = detailSession.value;
  if (!session) return;
  await postSessionAction(`/api/sessions/${encodeURIComponent(session.session_id)}/close`, { status }, `close:${session.session_id}`);
}

async function reopenSelectedSession(): Promise<void> {
  const session = detailSession.value;
  if (!session) return;
  await postSessionAction(`/api/sessions/${encodeURIComponent(session.session_id)}/reopen`, {}, `reopen:${session.session_id}`);
}

async function requestSelectedSynthesis(): Promise<void> {
  const session = detailSession.value;
  if (!session) return;
  await postSessionAction(`/api/sessions/${encodeURIComponent(session.session_id)}/synthesis`, { reason: "User requested final synthesis from Project Detail" }, `synthesis:${session.session_id}`);
}

async function reviewArtifact(sessionId: string, artifactId: string, status: "accepted" | "rejected" | "revision_requested"): Promise<void> {
  const key = `artifact:${artifactId}`;
  const note = actionNotes.value[key];
  const ok = await postSessionAction(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/review`, {
    status,
    note,
    revision_instruction: status === "revision_requested" ? note : undefined,
  }, `${key}:${status}`);
  if (ok) clearActionDraft(key);
}

async function resolveSessionApproval(sessionId: string, approvalId: string, approved: boolean): Promise<void> {
  const key = `approval:${approvalId}`;
  const ok = await postSessionAction(`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}/resolve`, {
    approved,
    note: actionNotes.value[key],
  }, `${key}:${approved ? "approved" : "rejected"}`);
  if (ok) clearActionDraft(key);
}

async function answerQuestion(sessionId: string, questionId: string): Promise<void> {
  const key = `question:${questionId}`;
  const answer = actionAnswers.value[key]?.trim();
  if (!answer) {
    sessionDetailError.value = "answer is required";
    return;
  }
  const ok = await postSessionAction(`/api/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}/answer`, { answer }, `${key}:answer`);
  if (ok) clearActionDraft(key);
}

async function recordValidation(sessionId: string, validationId: string, status: "passed" | "failed" | "cancelled"): Promise<void> {
  const key = `validation:${validationId}`;
  const ok = await postSessionAction(`/api/sessions/${encodeURIComponent(sessionId)}/validations/${encodeURIComponent(validationId)}/record`, {
    status,
    note: actionNotes.value[key],
  }, `${key}:${status}`);
  if (ok) clearActionDraft(key);
}

function clearActionDraft(key: string): void {
  const notes = { ...actionNotes.value };
  const answers = { ...actionAnswers.value };
  delete notes[key];
  delete answers[key];
  actionNotes.value = notes;
  actionAnswers.value = answers;
}

function actionPending(key: string): boolean {
  return Boolean(pendingActions.value[key]);
}

async function loadChannels(): Promise<void> {
  const response = await fetch("/api/channels");
  if (!response.ok) throw new Error(await response.text());
  const body = await response.json() as { channels?: SlockUiBridgeChannel[]; default_channel?: string };
  channels.value = Array.isArray(body.channels) ? body.channels : [];
  activeChannel.value = channels.value.find((channel) => channel.uri === body.default_channel) || channels.value[0] || null;
  if (!activeChannel.value) throw new Error("no channels configured");
  await loadHistory();
}

async function refreshHistory(): Promise<void> {
  await loadHistory().catch((error: unknown) => appendSimpleRow("error", "bridge", errorMessage(error)));
}

function emptyTraceStats(): TraceViewerStats {
  return {
    total_events: 0,
    group_count: 0,
    approvals: 0,
    rejected_approvals: 0,
    shell_calls: 0,
    route_results: {},
  };
}

function traceApiUrl(): string {
  const url = new URL("/api/trace", window.location.origin);
  const limit = Number.isFinite(traceLimit.value) && traceLimit.value > 0 ? Math.min(Math.floor(traceLimit.value), 1000) : 250;
  url.searchParams.set("limit", String(limit));
  const query = traceQuery.value.trim();
  if (query) url.searchParams.set("q", query);
  return url.pathname + url.search;
}

async function refreshTrace(): Promise<void> {
  traceState.loading = true;
  traceState.error = "";

  try {
    const response = await fetch(traceApiUrl());
    if (!response.ok) throw new Error(await response.text());
    const body = await response.json() as TraceViewerResponse;
    traceState.available = Boolean(body.available);
    traceState.tracePath = body.trace_path ?? null;
    traceState.events = Array.isArray(body.events) ? body.events : [];
    traceState.groups = Array.isArray(body.groups) ? body.groups : [];
    traceState.stats = body.stats ?? emptyTraceStats();
  } catch (error) {
    traceState.error = errorMessage(error);
  } finally {
    traceState.loading = false;
  }
}

async function submitMessage(): Promise<void> {
  const text = messageText.value.trim();
  if (!text) return;
  messageText.value = "";
  const response = await fetch(channelUrl("/api/messages"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channel: activeChannel.value?.uri,
      text,
      thread_id: activeThreadId.value,
      reply_to_id: activeReplyToId.value,
    }),
  });
  if (!response.ok) {
    appendSimpleRow("error", "bridge", await response.text());
  }
}

function canCancel(row: MessageRow): boolean {
  return row.message.kind === "human" && Array.isArray(row.message.mentions) && row.message.mentions.length > 0;
}

function cancelDisabled(row: MessageRow): boolean {
  return row.runState !== "active";
}

function cancelLabel(row: MessageRow): string {
  if (row.runState === "cancelling") return "Cancelling";
  if (row.runState === "cancelled") return "Cancelled";
  if (row.runState === "completed") return "Completed";
  return "Cancel";
}

function approvalState(row: ToolRow): "pending" | "approved" | "denied" {
  if (!row.approvalResult) return "pending";
  return row.approvalResult.approved ? "approved" : "denied";
}

function approvalLabel(row: ToolRow): string {
  if (!row.approvalResult) return "approval required";
  return row.approvalResult.approved ? "approved" : "denied";
}

function agentStatusLabel(row: AgentStatusRow): string {
  if (agentStatusVisualState(row) === "waiting") return "waiting";
  return row.state === "streaming" ? "active" : row.state;
}

function agentStatusVisualState(row: AgentStatusRow): AgentStatusVisualState {
  return pendingStatusApprovals(row).length > 0 ? "waiting" : row.state;
}

function pendingStatusApprovals(row: AgentStatusRow): ToolRow[] {
  return statusToolRows(row).filter((tool) => Boolean(tool.approval) && !tool.approvalResult);
}

function agentStatusMetaChips(row: AgentStatusRow): string[] {
  const chips: string[] = [];
  const duration = agentRunDuration(row);
  const tools = statusToolRows(row).length;
  const pending = pendingStatusApprovals(row).length;
  if (duration) chips.push("elapsed " + duration);
  if (row.lastActivityAt) chips.push("last " + compactTime(row.lastActivityAt));
  chips.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  if (pending) chips.push(`${pending} approval${pending === 1 ? "" : "s"}`);
  if (row.runId) chips.push("run " + shortRunId(row.runId));
  return chips;
}

function agentRunDuration(row: AgentStatusRow): string {
  const started = parseTimeMs(row.startedAt);
  if (started === undefined) return "";
  const finished = parseTimeMs(row.finishedAt);
  const end = finished ?? clockTick.value;
  return formatDurationMs(Math.max(0, end - started));
}

function parseTimeMs(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return "<1s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function compactTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "00:00:00";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortRunId(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function operationTitle(row: AgentActivityRow): string {
  return row.rowType === "agent-status" ? row.text : `${toolInlineEndpointLabel(row)} ${toolInlineAction(row)}`;
}

function operationDetail(row: AgentActivityRow): string {
  if (row.rowType === "agent-status") {
    const duration = agentRunDuration(row);
    const tools = statusToolRows(row).length;
    return [endpointLabel(row.source), duration, `${tools} tools`].filter(Boolean).join(" · ");
  }
  return toolInlinePayload(row) || row.resultSummary || row.toolCallId;
}

function operationState(row: AgentActivityRow): string {
  return row.rowType === "agent-status" ? agentStatusLabel(row) : row.state;
}

function operationTime(row: AgentActivityRow): string {
  if (!row.receivedAt) return "00:00:00";
  const date = new Date(row.receivedAt);
  if (Number.isNaN(date.getTime())) return "00:00:00";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function operationSequence(row: AgentActivityRow): string {
  return "#" + String(row.sequence ?? 0).padStart(2, "0");
}

function operationIcon(row: AgentActivityRow): "status" | "approval" | "tool" | "terminal" {
  if (row.rowType === "agent-status") return "status";
  if (row.approval && !row.approvalResult) return "approval";
  return row.name.includes("shell") || row.preview.startsWith("exec") ? "terminal" : "tool";
}

function endpointKind(uri: string): EndpointKind {
  if (uri.startsWith("agent://")) return "agent";
  if (uri.startsWith("app://")) return "app";
  if (uri.startsWith("plugin://")) return "plugin";
  if (uri.startsWith("local://")) return "local";
  return "unknown";
}

function endpointDisplayLabel(uri: string): string {
  const schemeIndex = uri.indexOf("://");
  return schemeIndex >= 0 ? uri.slice(schemeIndex + 3) : uri;
}

function toolCallParts(row: ToolRow): { endpoint: string; action: string; payload: unknown } {
  const args = toolArguments(row);
  const approvalCall = row.approval?.request.proposed_call;
  const endpoint = isRecord(args) && typeof args.target === "string"
    ? args.target
    : approvalCall?.target ?? row.preview;
  const action = isRecord(args) && typeof args.action === "string"
    ? args.action
    : approvalCall?.action ?? row.name;
  const payload = isRecord(args) && Object.prototype.hasOwnProperty.call(args, "payload")
    ? args.payload
    : approvalCall?.payload;
  return { endpoint, action, payload };
}

function toolInlineEndpoint(row: ToolRow): string {
  return toolCallParts(row).endpoint || endpointLabel(row.source);
}

function toolInlineEndpointLabel(row: ToolRow): string {
  return endpointDisplayLabel(toolInlineEndpoint(row));
}

function toolInlineEndpointKind(row: ToolRow): EndpointKind {
  return endpointKind(toolInlineEndpoint(row));
}

function toolInlineAction(row: ToolRow): string {
  return toolCallParts(row).action || row.name;
}

function toolInlinePayload(row: ToolRow): string {
  const payload = toolCallParts(row).payload;
  if (payload === undefined) return "";
  return truncate(compactText(payload), 180);
}

function statusToolRows(row: AgentStatusRow): ToolRow[] {
  return agentActivityRows.value
    .filter((entry): entry is ToolRow => entry.rowType === "tool" && entry.source === row.source && entry.threadId === row.threadId)
    .slice()
    .sort((left, right) => (right.sequence ?? 0) - (left.sequence ?? 0));
}

function currentStatusToolList(row: AgentStatusRow): ToolRow[] {
  const current = statusToolRows(row)[0];
  return current ? [current] : [];
}

function previousStatusTools(row: AgentStatusRow): ToolRow[] {
  return statusToolRows(row).slice(1);
}

function toolArguments(row: ToolRow): unknown {
  return parseJsonMaybe(row.argumentsText);
}

function toolTarget(row: ToolRow): string {
  const args = toolArguments(row);
  if (isRecord(args) && typeof args.target === "string") return args.target;
  if (row.approval) return row.approval.request.proposed_call.target;
  return row.preview;
}

function toolOperation(row: ToolRow): string {
  const args = toolArguments(row);
  if (isRecord(args) && typeof args.action === "string") return row.name + " / " + args.action;
  return row.name;
}

function fallbackDash(value?: string): string {
  return value && value.length > 0 ? value : "-";
}

function traceMetric(value: number | undefined): number {
  return typeof value === "number" ? value : 0;
}

function traceRouteCount(route: string): number {
  return traceState.stats.route_results[route] ?? 0;
}

function formatTraceTime(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function traceEndpoint(event: TraceViewerEvent): string {
  const source = traceString(event.source);
  const target = traceString(event.target);
  if (source || target) return `${source || "unknown"} -> ${target || "unknown"}`;
  return traceString(event.uri) || "-";
}

function traceOperation(event: TraceViewerEvent): string {
  const op = traceString(event.op_code);
  const action = traceString(event.action);
  if (op && action) return `${op} ${action}`;
  return op || action || traceString(event.event) || "-";
}

function traceRoute(event: TraceViewerEvent): string {
  return traceString(event.route_result) || traceString(event.event) || "event";
}

function traceIsIssue(event: TraceViewerEvent): boolean {
  const route = traceRoute(event);
  return route === "rejected" || route === "dropped" || route === "parse_error" || Boolean(traceString(event.error_reason));
}

function traceTone(event: TraceViewerEvent): "issue" | "response" | "stream" | "event" {
  if (traceIsIssue(event)) return "issue";
  const direction = traceDirection(event);
  if (direction === "response") return "response";
  if (direction === "stream") return "stream";
  return "event";
}

function traceDirection(event: TraceViewerEvent): string {
  return traceString(event.direction) || "event";
}

function traceFlow(event: TraceViewerEvent): string {
  return traceString(event.endpoint_flow) || traceEndpoint(event);
}

function tracePrimaryLine(event: TraceViewerEvent): string {
  const operation = traceOperation(event);
  const flow = traceFlow(event);
  return operation + (flow !== "-" ? " · " + flow : "");
}

function traceGroupLabel(event: TraceViewerEvent): string {
  const group = traceString(event.group_key);
  if (!group) return "ungrouped";
  const separator = group.indexOf(":");
  return separator >= 0 ? group.slice(separator + 1) : group;
}

function traceDepthStyle(event: TraceViewerEvent): Record<string, string> {
  const depth = typeof event.causal_depth === "number" ? Math.max(0, Math.min(event.causal_depth, 5)) : 0;
  return {
    "--trace-band": `${depth * 18 + 12}px`,
    "--trace-indent": `${depth * 10}px`,
  };
}

function traceParent(event: TraceViewerEvent): string {
  return traceString(event.causal_parent_id);
}

function traceRelations(event: TraceViewerEvent): TraceViewerRelation[] {
  return Array.isArray(event.relations) ? event.relations : [];
}

function traceGroupRelations(group: TraceViewerGroup): TraceViewerRelation[] {
  return Array.isArray(group.summary.relations) ? group.summary.relations : [];
}

function filterTraceRelation(relation: TraceViewerRelation): void {
  traceQuery.value = relation.value;
  void refreshTrace();
}

function traceChips(event: TraceViewerEvent): string[] {
  const chips = [
    traceString(event.payload_kind),
    traceString(event.channel),
    traceString(event.approval_risk),
    traceString(event.approval_target),
    typeof event.approval_decision === "boolean" ? (event.approval_decision ? "approved" : "denied") : "",
    typeof event.shell_exit_code === "number" ? `exit ${event.shell_exit_code}` : "",
    typeof event.payload_size === "number" ? `${event.payload_size} bytes` : "",
  ];
  return chips.filter((chip) => chip.length > 0);
}

function traceGroupRange(group: TraceViewerGroup): string {
  const first = formatTraceTime(group.summary.first_timestamp);
  const last = formatTraceTime(group.summary.last_timestamp);
  return first === last ? first : `${first} - ${last}`;
}

function traceEndpointSummary(group: TraceViewerGroup): string {
  if (!group.summary.endpoints.length) return "-";
  return group.summary.endpoints.slice(0, 3).join(" | ") + (group.summary.endpoints.length > 3 ? " ..." : "");
}

function traceString(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "";
}

function syncToolOpen(row: ToolRow, event: Event): void {
  row.open = event.target instanceof HTMLDetailsElement ? event.target.open : row.open;
}

function scrollTimeline(): void {
  void nextTick(() => {
    if (timeline.value) timeline.value.scrollTop = timeline.value.scrollHeight;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
</script>

<template>
  <main class="atlas-app" :aria-label="workspaceAriaLabel">
    <aside class="rail" aria-label="Workspace navigation">
      <div class="brand">
        <div class="brand-mark">K</div>
        <span>Kairos IPC</span>
      </div>

      <div class="nav-group">
        <div class="nav-label">Navigate</div>
        <button class="nav-item" :class="{ active: activeView === 'sessions' || activeView === 'session' || activeView === 'review' }" type="button" @click="showSessions">
          <strong><span class="dot live"></span>Projects</strong>
          <span class="nav-count">{{ workSessions.length }}</span>
        </button>
        <button class="nav-item" :class="{ active: activeView === 'chat' }" type="button" @click="showChat">
          <strong><span class="dot doc"></span>Rooms</strong>
          <span class="nav-count">{{ channels.length }}</span>
        </button>
        <button class="nav-item" :class="{ active: activeView === 'agent' }" type="button" @click="showAgents">
          <strong><span class="dot live"></span>Agents</strong>
          <span class="nav-count">{{ knownAgents.length }}</span>
        </button>
        <button class="nav-item" :class="{ active: activeView === 'trace' }" type="button" @click="openTraceViewer">
          <strong><span class="dot observe"></span>Observe</strong>
          <span class="nav-count">trace</span>
        </button>
      </div>

      <div v-if="activeView === 'sessions' || activeView === 'session' || activeView === 'review'" class="nav-group">
        <div class="nav-label">Project views</div>
        <button class="nav-item" :class="{ active: activeView === 'sessions' }" type="button" @click="showSessions">
          <strong>Dashboard</strong>
          <span class="nav-count">now</span>
        </button>
        <button class="nav-item" :class="{ active: activeView === 'review' }" type="button" @click="showReviewQueue">
          <strong><span class="dot need"></span>Needs you</strong>
          <span class="nav-count">{{ pendingReviewItemCount }}</span>
        </button>
        <button
          v-for="session in workSessions.slice(0, 5)"
          :key="session.session_id"
          class="nav-item project-nav-row"
          :class="{ active: activeView === 'session' && selectedSessionId === session.session_id }"
          type="button"
          @click="openSessionDetail(session)"
        >
          <strong><span class="dot" :class="projectToneClass(session)"></span>{{ session.title }}</strong>
          <span class="nav-count">{{ projectAttentionCount(session) || projectLaneLabelForSession(session) }}</span>
        </button>
      </div>

      <div v-if="activeView === 'chat'" class="nav-group">
        <div class="nav-label">Rooms</div>
        <button
          v-for="channel in channels"
          :key="channel.uri"
          class="nav-item"
          :class="{ active: activeChannel?.uri === channel.uri }"
          type="button"
          @click="switchChannel(channel.uri)"
        >
          <strong><span class="dot quiet"></span>{{ channelLabel(channel) }}</strong>
          <span class="nav-count">room</span>
        </button>
      </div>

      <div v-if="activeView === 'agent'" class="nav-group">
        <div class="nav-label">Agents</div>
        <button
          v-for="agent in knownAgents"
          :key="agent"
          class="nav-item"
          :class="{ active: activeAgentUri === agent }"
          type="button"
          @click="openAgentDashboard(agent)"
        >
          <strong><span class="dot live"></span>{{ agentLabel(agent) }}</strong>
          <span class="nav-count">{{ agentRowState(agent) }}</span>
        </button>
        <div v-if="!knownAgents.length" class="nav-empty">Agents appear after a run starts.</div>
      </div>

      <div v-if="activeView === 'trace'" class="nav-group">
        <div class="nav-label">Observe</div>
        <button class="nav-item active" type="button" @click="refreshTrace"><strong>Runtime audit</strong><span class="nav-count">now</span></button>
        <button class="nav-item" type="button" @click="traceQuery = ''; refreshTrace()"><strong>Trace timeline</strong><span class="nav-count">{{ traceState.stats.total_events }}</span></button>
        <button class="nav-item" type="button" @click="traceQuery = 'rejected'; refreshTrace()"><strong><span class="dot bad"></span>Failures</strong><span class="nav-count">{{ traceIssueCount }}</span></button>
      </div>
    </aside>

    <section class="main">
      <header class="topbar">
        <nav class="mobile-nav" aria-label="Primary navigation">
          <button class="mobile-nav-item" :class="{ active: activeView === 'sessions' || activeView === 'session' || activeView === 'review' }" type="button" @click="showSessions">Projects</button>
          <button class="mobile-nav-item" :class="{ active: activeView === 'chat' }" type="button" @click="showChat">Rooms</button>
          <button class="mobile-nav-item" :class="{ active: activeView === 'agent' }" type="button" @click="showAgents">Agents</button>
          <button class="mobile-nav-item" :class="{ active: activeView === 'trace' }" type="button" @click="openTraceViewer">Observe</button>
        </nav>
        <div class="top-row">
          <div class="title">
            <h1>{{ workspaceTitle }}</h1>
            <p>{{ workspaceStatus }}</p>
          </div>
          <div class="toolbar">
            <button v-if="activeView === 'sessions'" class="button-tonal" type="button" :disabled="sessionsLoading" @click="loadSessions">Refresh</button>
            <button v-if="activeView === 'session'" class="button-tonal" type="button" :disabled="sessionDetailLoading || !selectedSessionId" @click="selectedSessionId && loadSessionDetail(selectedSessionId)">Refresh</button>
            <button v-if="activeView === 'review'" class="button-tonal" type="button" :disabled="sessionsLoading" @click="loadDashboard">Refresh</button>
            <button v-if="activeView === 'chat'" class="button-tonal" type="button" @click="refreshHistory">Refresh</button>
            <button v-if="activeView === 'trace'" class="button" type="button" :disabled="traceState.loading" @click="refreshTrace">Refresh</button>
            <button v-if="activeView === 'session' && detailSession?.status === 'open'" class="button-text" type="button" :disabled="!detailSession || actionPending('close:' + detailSession.session_id)" @click="closeSelectedSession('completed')">Close</button>
            <button v-if="activeView === 'session' && detailSession?.status !== 'open'" class="button-text" type="button" :disabled="!detailSession || actionPending('reopen:' + detailSession.session_id)" @click="reopenSelectedSession">Reopen</button>
          </div>
        </div>

        <div v-if="activeView === 'sessions' || activeView === 'review'" class="tabs">
          <button class="tab" :class="{ active: activeView === 'sessions' }" type="button" role="tab" @click="showSessions">Dashboard</button>
          <button class="tab need" :class="{ active: activeView === 'review' }" type="button" @click="showReviewQueue">Needs you {{ pendingReviewItemCount }}</button>
          <span class="tab">Active {{ activeWorkSessionCount }}</span>
          <span class="tab doc">Artifacts {{ readyArtifactProjectCount }}</span>
          <span class="tab">Done {{ recentlyConsumedProjects.length }}</span>
        </div>
        <div v-else-if="activeView === 'session'" class="tabs">
          <button class="tab" :class="{ active: sessionDetailTab === 'work' }" type="button" @click="sessionDetailTab = 'work'">Board</button>
          <button class="tab need" type="button" @click="showReviewQueue">Needs you {{ projectDetailNeeds.length }}</button>
          <button class="tab doc" :class="{ active: sessionDetailTab === 'inspector' && artifactReaderObject }" type="button" @click="openSessionArtifacts">Artifacts {{ detailObjectCounts.artifacts }}</button>
          <button class="tab" type="button" @click="sessionDetailTab = 'reports'">Rooms {{ projectDetailNotes.length }}</button>
          <button class="tab observe" type="button" @click="openTraceViewer">Observe</button>
        </div>
        <div v-else-if="activeView === 'chat'" class="tabs">
          <span class="tab active">Chat</span>
          <span class="tab need">Project cards {{ roomProjectCards.length }}</span>
          <span class="tab">Attach</span>
        </div>
        <div v-else-if="activeView === 'agent'" class="tabs">
          <span class="tab active">Workload</span>
          <span class="tab">Capabilities</span>
          <span class="tab">Health</span>
          <span class="tab observe">Services</span>
        </div>
        <div v-else-if="activeView === 'trace'" class="tabs">
          <span class="tab active observe">Runtime audit</span>
          <span class="tab">Trace timeline {{ traceState.stats.total_events }}</span>
          <span class="tab">Endpoints</span>
          <span class="tab bad">Failures {{ traceIssueCount }}</span>
        </div>
      </header>

      <section v-if="activeView === 'sessions'" class="content two-col">
        <div class="stack">
          <article v-if="attentionPreviewItems.length" class="banner">
            <div>
              <strong>{{ pendingReviewItemCount }} {{ pendingReviewItemCount === 1 ? 'item needs' : 'items need' }} you before agents can continue.</strong>
              <p>Approvals, questions, validations, and artifact reviews live on Projects. Handled items recede from this surface.</p>
            </div>
            <div class="actions"><button class="mini human" type="button" @click="showReviewQueue">Open Needs You</button></div>
          </article>

          <div v-if="sessionsError" class="banner bad"><div><strong>Project dashboard error</strong><p>{{ sessionsError }}</p></div><button class="mini soft" type="button" @click="loadDashboard">Retry</button></div>
          <div v-else-if="sessionsLoading && !workSessions.length" class="panel"><h3>Loading projects</h3><p>Project projections will appear here after the dashboard snapshot loads.</p></div>
          <div v-else-if="!workSessions.length" class="panel empty-panel"><h3>No projects yet</h3><p>Start from a room mention. Durable Project cards, artifacts, and approvals will appear here.</p><button class="mini primary" type="button" @click="showChat">Open room</button></div>

          <section v-else class="project-grid" aria-label="Active projects">
            <article v-for="session in visibleWorkSessions.slice(0, 9)" :key="session.session_id" class="project-card" :class="projectToneClass(session)">
              <button class="card-button" type="button" @click="openSessionDetail(session)">
                <span class="card-top project-card-head project-card-head--compact">
                  <span class="project-card-head-title"><span>Project</span><strong>{{ session.title }}</strong></span>
                  <span class="chip" :class="projectToneClass(session)">{{ projectLaneLabelForSession(session) }}</span>
                </span>
                <p class="project-signal-preview project-signal-preview--digest">
                  <span>{{ session.latest_artifact ? 'Latest artifact' : 'Current work' }}</span>
                  <strong>{{ sessionSignalText(session) }}</strong>
                </p>
                <span class="meta"><span>{{ projectHomeRoomLabel(session) }}</span><span>{{ projectAttentionText(session) }}</span></span>
                <span class="tiny-progress"><span :style="{ width: session.phase === 'done' ? '100%' : projectBoardLane(session) === 'validate' ? '78%' : projectBoardLane(session) === 'review' ? '62%' : projectBoardLane(session) === 'building' ? '42%' : '18%' }"></span></span>
              </button>
            </article>
          </section>

          <section v-if="visibleWorkSessions.length" class="board-shell" aria-label="Scrum board overview">
            <div class="section-head"><h3>Scrum board</h3><span>Project state, not room ownership.</span></div>
            <div class="board">
              <div v-for="column in projectBoardColumns" :key="column.lane" class="column">
                <div class="column-head"><strong>{{ column.label }}</strong><span>{{ column.projects.length }}</span></div>
                <article v-for="session in column.projects.slice(0, 4)" :key="session.session_id" class="work-card" :class="projectToneClass(session)">
                  <button class="card-button" type="button" @click="openSessionDetail(session)">
                    <span class="card-top"><strong>{{ session.title }}</strong><span class="chip" :class="projectToneClass(session)">{{ projectAttentionCount(session) ? 'you' : projectLaneLabelForSession(session) }}</span></span>
                    <p>{{ sessionPrimaryText(session) }}</p>
                    <span class="meta"><span>{{ visibleAgents(session).map((agent) => '@' + endpointLabel(agent.agent)).join(', ') || sessionOwnerLabel(session) }}</span></span>
                  </button>
                </article>
              </div>
            </div>
          </section>
        </div>

        <aside class="stack">
          <section class="panel">
            <div class="section-head"><h3>Ready to read</h3><span>{{ readyArtifactProjects.length }}</span></div>
            <button v-for="session in readyArtifactProjects" :key="session.session_id" class="artifact-row" type="button" @click="openSessionDetail(session, session.latest_artifact ? { kind: 'artifact', id: session.latest_artifact.id } : undefined)">
              <strong>{{ session.latest_artifact?.title || session.title }}</strong>
              <span class="chip doc">{{ session.title }}</span>
            </button>
            <p v-if="!readyArtifactProjects.length">Submitted artifacts will appear here as compact readers.</p>
          </section>
          <section class="panel quiet-panel">
            <h3>Recently consumed</h3>
            <p v-if="recentlyConsumedProjects.length">{{ recentlyConsumedProjects.map((session) => session.title).join(', ') }}</p>
            <p v-else>Accepted work stays available, but stops pulling attention.</p>
          </section>
        </aside>
      </section>

      <section v-else-if="activeView === 'review'" class="review-queue-view" :class="['content', 'wide-side']">
        <div class="stack">
          <div class="work-dashboard-toolbar atlas-filter-row">
            <label class="dashboard-search"><Search :size="15" aria-hidden="true" /><input v-model="reviewSearch" type="search" placeholder="Search actions, projects, agents" /></label>
            <div class="phase-filter" aria-label="Needs You kind filter">
              <button v-for="item in reviewKindFilters" :key="item.kind" class="phase-filter-item" :class="{ active: reviewKindFilter === item.kind }" type="button" @click="reviewKindFilter = item.kind"><span>{{ item.label }}</span><span>{{ item.count }}</span></button>
            </div>
          </div>
          <article v-for="item in visibleReviewQueue" :key="item.id" class="work-card attention-card" :class="reviewToneClass(item.kind)">
            <button class="card-button" type="button" @click="openReviewItem(item)">
              <span class="card-top"><strong>{{ item.title }}</strong><span class="chip" :class="reviewToneClass(item.kind)">{{ reviewKindLabel(item.kind) }}</span></span>
              <p>{{ item.consequence || item.required_action }}</p>
              <span class="meta"><span>{{ sessionForReview(item)?.title || item.session_id }}</span><span>{{ reviewItemMeta(item) }}</span></span>
            </button>
            <div class="actions">
              <input v-if="item.kind !== 'question'" v-model="actionNotes[item.id]" class="atlas-input" type="text" placeholder="Note" :aria-label="'Note for ' + item.required_action" />
              <input v-if="item.kind === 'question'" v-model="actionAnswers[item.id]" class="atlas-input" type="text" placeholder="Answer" :aria-label="'Answer for ' + item.title" />
              <template v-if="item.kind === 'artifact'"><button class="mini primary" type="button" :disabled="actionPending(item.id + ':accepted')" @click="reviewArtifact(item.session_id, reviewItemObjectId(item), 'accepted')">Accept</button><button class="mini soft" type="button" :disabled="actionPending(item.id + ':revision_requested')" @click="reviewArtifact(item.session_id, reviewItemObjectId(item), 'revision_requested')">Revise</button></template>
              <template v-else-if="item.kind === 'approval'"><button class="mini human" type="button" :disabled="actionPending(item.id + ':approved')" @click="resolveSessionApproval(item.session_id, reviewItemObjectId(item), true)">Approve</button><button class="mini soft" type="button" :disabled="actionPending(item.id + ':rejected')" @click="resolveSessionApproval(item.session_id, reviewItemObjectId(item), false)">Reject</button></template>
              <template v-else-if="item.kind === 'validation'"><button class="mini primary" type="button" :disabled="actionPending(item.id + ':passed')" @click="recordValidation(item.session_id, reviewItemObjectId(item), 'passed')">Pass</button><button class="mini soft" type="button" :disabled="actionPending(item.id + ':failed')" @click="recordValidation(item.session_id, reviewItemObjectId(item), 'failed')">Fail</button></template>
              <template v-else-if="item.kind === 'question'"><button class="mini human" type="button" :disabled="actionPending(item.id + ':answer')" @click="answerQuestion(item.session_id, reviewItemObjectId(item))">Answer</button></template>
            </div>
          </article>
          <div v-if="!visibleReviewQueue.length" class="panel empty-panel"><h3>Nothing waiting on you</h3><p>Handled approvals and artifacts will stay linked from their Projects.</p></div>
        </div>
        <aside class="panel"><h3>Human attention model</h3><p>Needs You is a Project lens, not a separate queue. Each item opens the durable card, artifact, approval, question, or validation that produced it.</p></aside>
      </section>

      <section v-else-if="activeView === 'session'" class="session-detail-view" :class="['content', artifactReaderObject ? 'three-col artifact-reader-grid' : 'two-col']">
        <template v-if="detailSession && artifactReaderObject">
          <aside class="panel reader-nav">
            <h3>Artifacts</h3>
            <button
              v-for="artifact in detailArtifacts"
              :key="artifact.id"
              class="artifact-row"
              :class="{ active: artifact.id === artifactReaderId }"
              type="button"
              @click="selectInspector('artifact', artifact.id)"
            >
              <strong>{{ artifact.title || artifact.kind }}</strong>
              <span class="chip doc">{{ artifact.status }}</span>
            </button>
            <p v-if="!detailArtifacts.length">No artifacts have been submitted for this Project.</p>
          </aside>

          <article class="reader">
            <header class="reader-head">
              <div><strong>{{ artifactReaderTitle }}</strong><br><span>{{ detailSession.title }} · @{{ artifactReaderAuthor }}</span></div>
              <span class="chip doc">{{ artifactReaderStatus }}</span>
            </header>
            <div class="reader-body">
              <ArtifactMarkdown :source="artifactReaderMarkdown" />
            </div>
          </article>

          <aside class="detail-inspector" :class="'stack'">
            <section class="panel">
              <h3>Review</h3>
              <p>Accept the artifact as project context, or ask the agent to revise it.</p>
              <div class="actions">
                <button class="mini primary" type="button" :disabled="!artifactReaderId || actionPending(artifactReaderId + ':accepted')" @click="reviewArtifact(detailSession.session_id, artifactReaderId, 'accepted')">Accept</button>
                <button class="mini soft" type="button" :disabled="!artifactReaderId || actionPending(artifactReaderId + ':revision_requested')" @click="reviewArtifact(detailSession.session_id, artifactReaderId, 'revision_requested')">Revise</button>
              </div>
            </section>
            <section class="panel">
              <h3>Linked work</h3>
              <p>Project: {{ detailSession.title }}<br>Room: {{ projectHomeRoomLabel(detailSession) }}</p>
              <button class="mini soft" type="button" @click="sessionDetailTab = 'work'">Back to board</button>
            </section>
            <section class="panel">
              <h3>Evidence</h3>
              <p v-if="artifactReaderTraceLabels.length">{{ artifactReaderTraceLabels.join(' · ') }}</p>
              <p v-else-if="artifactReaderSourceLabels.length">{{ artifactReaderSourceLabels.join(' · ') }}</p>
              <p v-else>No trace or source reference recorded yet.</p>
              <button class="mini soft" type="button" @click="openTraceViewer">Open Observe</button>
            </section>
          </aside>
        </template>

        <template v-else-if="detailSession && sessionDetailTab === 'inspector' && inspectorObject">
          <div class="stack">
            <article class="banner">
              <div><strong>{{ inspectorTitle }}</strong><p>{{ inspectorSummary }}</p></div>
              <div class="actions"><button class="mini soft" type="button" @click="sessionDetailTab = 'work'">Back to board</button></div>
            </article>
            <section class="session-inspector" :class="['panel', 'work-detail-panel']">
              <div class="section-head"><h3>{{ inspectorEyebrow }}</h3><span>{{ inspectorStatus }}</span></div>
              <p>{{ inspectorPayloadPreview }}</p>
              <div v-if="inspectorEvents.length" class="trace-list compact-trace-list">
                <article v-for="event in inspectorEvents.slice(0, 5)" :key="String(event.sequence ?? event.type) + ':' + event.type" class="trace-event">
                  <span class="trace-time">{{ 'created_at' in event && typeof event.created_at === 'string' ? messageTime(event.created_at) : '' }}</span>
                  <span class="trace-dot"></span>
                  <div class="trace-body"><strong>{{ event.type }}</strong><span>{{ objectPreview(event) }}</span></div>
                </article>
              </div>
            </section>
          </div>
          <aside class="stack">
            <section class="panel"><h3>Linked work</h3><p>Project: {{ detailSession.title }}<br>Room: {{ projectHomeRoomLabel(detailSession) }}</p></section>
            <section class="panel"><h3>Evidence</h3><p v-if="inspectorTraceLabels.length">{{ inspectorTraceLabels.join(' · ') }}</p><p v-else-if="inspectorSourceLabels.length">{{ inspectorSourceLabels.join(' · ') }}</p><p v-else>No source reference recorded yet.</p><button class="mini soft" type="button" @click="openTraceViewer">Open Observe</button></section>
          </aside>
        </template>

        <template v-else-if="detailSession">
          <div class="stack">
            <article v-if="projectDetailNeeds.length" class="banner">
              <div><strong>{{ projectDetailNeeds.length }} item {{ projectDetailNeeds.length === 1 ? 'needs' : 'need' }} you in this Project.</strong><p>{{ projectDetailNeeds[0]?.required_action }}: {{ projectDetailNeeds[0]?.title }}</p></div>
              <div class="actions"><button class="mini human" type="button" @click="showReviewQueue">Open Needs You</button></div>
            </article>

            <section class="session-board" :class="'board-shell'">
              <div class="section-head"><h3>Scrum board</h3><span>{{ projectHomeRoomLabel(detailSession) }} · {{ detailObjectCounts.artifacts }} artifacts</span></div>
              <div v-if="detailBuildBoard" class="build-scrum-board" :class="'board'">
                <div v-for="column in detailBuildBoard.columns" :key="column.key" class="column">
                  <div class="column-head"><strong>{{ buildBoardColumnLabel(column) }}</strong><span>{{ column.items.length }}</span></div>
                  <article v-for="item in column.items" :key="buildBoardItemKey(item)" class="session-work-card" :class="['work-card', workCardToneClass(item)]">
                    <button class="card-button" type="button" @click="selectBuildBoardItem(item)">
                      <span class="card-top"><strong>{{ item.title }}</strong><span class="chip" :class="workCardToneClass(item)">{{ cardOwnerLabel(item) }}</span></span>
                      <p>{{ item.summary || buildBoardItemMeta(item) }}</p>
                    </button>
                  </article>
                  <p v-if="!column.items.length" class="column-empty">{{ buildBoardColumnEmptyText(column) }}</p>
                </div>
              </div>
              <div v-else class="board">
                <div v-for="column in detailLifecycleColumns" :key="column.phase" class="column">
                  <div class="column-head"><strong>{{ column.label }}</strong><span>{{ column.items.length }}</span></div>
                  <article v-for="item in column.items" :key="item.kind + ':' + item.id" class="work-card">
                    <button class="card-button" type="button" @click="selectInspector(item.kind, item.id)">
                      <span class="card-top"><strong>{{ item.title }}</strong><span class="chip">{{ item.status || item.kind }}</span></span>
                      <p>{{ item.meta }}</p>
                    </button>
                  </article>
                </div>
              </div>
            </section>

            <section v-if="sessionDetail" class="project-grid detail-object-grid-atlas">
              <article class="project-card"><strong>Objective</strong><p>{{ detailSession.objective || sessionPrimaryText(detailSession) }}</p></article>
              <article class="project-card"><strong>Acceptance</strong><p>{{ detailSession.acceptance_criteria?.join(' · ') || 'No criteria recorded' }}</p></article>
              <article class="project-card doc"><strong>Artifacts</strong><p>{{ sessionDetail.artifacts.map((artifact) => artifact.title || artifact.kind).join(', ') || 'No artifacts yet' }}</p></article>
            </section>
          </div>

          <aside class="room-stream">
            <div class="room-head"><div><strong>Home room: {{ projectHomeRoomLabel(detailSession) }}</strong><br><span>Filtered reports and evidence for this Project.</span></div><button class="mini soft" type="button" @click="openSessionThread(detailSession)">Open room</button></div>
            <div class="messages">
              <article v-for="note in projectDetailNotes" :key="note.id" class="message">
                <div class="avatar agent">{{ endpointLabel(note.from).slice(0, 2).toUpperCase() }}</div>
                <div class="message-body"><div class="message-meta"><strong>@{{ endpointLabel(note.from) }}</strong><span>{{ messageTime(note.created_at) }}</span></div><p class="message-text">{{ note.text }}</p></div>
              </article>
              <section v-for="artifact in sessionDetail?.artifacts.slice(0, 4)" :key="artifact.id" class="room-card doc">
                <span class="chip doc">Artifact</span><p class="message-text">{{ artifact.title || artifact.kind }} · {{ artifact.status }}</p><button class="mini soft" type="button" @click="selectInspector('artifact', artifact.id)">Read</button>
              </section>
              <p v-if="!projectDetailNotes.length && !(sessionDetail?.artifacts.length)" class="room-empty">No linked reports yet.</p>
            </div>
          </aside>
        </template>
        <div v-else class="panel empty-panel"><h3>Project not found</h3><p>Return to Projects or open Observe to inspect the raw IPC stream.</p><button class="mini primary" type="button" @click="showSessions">Projects</button></div>
      </section>

      <section v-else-if="activeView === 'chat'" class="content two-col">
        <section class="room-stream full-room">
          <div class="room-head"><div><strong>{{ channelTitle }}</strong><br><span>Rooms own conversation. Project cards are projections.</span></div><span class="chip">{{ status }}</span></div>
          <div ref="timeline" class="messages" aria-live="polite">
            <div v-if="!rows.length" class="panel empty-panel"><h3>No messages in this room yet</h3><p>Start with an agent mention. Short replies, approvals, and artifact cards will stay in this timeline.</p></div>
            <template v-for="row in rows" :key="row.id">
              <article v-if="row.rowType === 'message' && !isArtifactProjectionMessage(row.message) && !isFinalReportMessage(row.message)" class="message" :class="{ 'thread-reply': row.threadReply }">
                <div class="avatar" :class="row.message.kind">{{ messageActorLabel(row.message).slice(0, 2).toUpperCase() }}</div>
                <div class="message-body"><div class="message-meta"><strong>{{ messageActorLabel(row.message) }}</strong><span>{{ messageTime(row.message.created_at) }}</span></div><p class="message-text">{{ row.message.text }}</p><div class="actions"><button v-if="canCancel(row)" class="mini soft" type="button" :disabled="cancelDisabled(row)" @click="cancelRun(row.message.id, row)">{{ cancelLabel(row) }}</button><button class="mini soft reply-action" type="button" @click="setActiveThread(row.message)">Reply</button></div></div>
              </article>
              <template v-else-if="row.rowType === 'message' && (isArtifactProjectionMessage(row.message) || isFinalReportMessage(row.message))">
                <article class="message" :class="{ 'thread-reply': row.threadReply }">
                  <div class="avatar" :class="row.message.kind">{{ messageActorLabel(row.message).slice(0, 2).toUpperCase() }}</div>
                  <div class="message-body"><div class="message-meta"><strong>{{ messageActorLabel(row.message) }}</strong><span>{{ messageTime(row.message.created_at) }}</span></div><p class="message-text">{{ projectionSummaryText(row.message) }}</p><div class="actions"><button class="mini soft reply-action" type="button" @click="setActiveThread(row.message)">Reply</button></div></div>
                </article>
                <section class="artifact-attachment doc">
                  <div class="artifact-attachment-head"><span class="chip doc">{{ projectionAttachmentKind(row.message) }}</span><span>{{ projectionAttachmentMeta(row.message) }}</span></div>
                  <strong>{{ projectionAttachmentTitle(row.message) }}</strong>
                  <p>{{ projectionProjectLabel(row.message) }}</p>
                  <button v-if="canOpenArtifactProjection(row.message)" class="mini artifact-open" type="button" @click="openArtifactProjection(row.message)">Open artifact</button>
                </section>
              </template>
              <section v-else-if="row.rowType === 'agent-status'" class="agent-status-row" :class="['room-card', 'live']">
                <span class="chip live">@{{ endpointLabel(row.source) }} · {{ agentStatusLabel(row) }}</span><p class="message-text">{{ row.text }}</p>
                <details v-if="currentStatusToolList(row).length" class="agent-current-tool" :class="'tool-line'"><summary><span class="endpoint-kind-icon" :data-kind="toolInlineEndpointKind(currentStatusToolList(row)[0])" aria-hidden="true"></span>{{ toolInlineEndpointLabel(currentStatusToolList(row)[0]) }} · {{ toolInlineAction(currentStatusToolList(row)[0]) }} {{ toolInlinePayload(currentStatusToolList(row)[0]) }}</summary><span v-if="currentStatusToolList(row)[0].resultSummary" class="tool-result-summary">{{ currentStatusToolList(row)[0].resultSummary }}</span><pre aria-label="Raw payload">{{ currentStatusToolList(row)[0].argumentsText }}</pre></details>
              </section>
              <section v-else-if="row.rowType === 'approval'" class="approval-card" :class="['room-card', 'need']"><span class="chip need">Approval · {{ row.approval.request.risk }}</span><p class="message-text">{{ row.approval.request.summary }}</p><div class="actions"><button class="mini human" type="button" @click="decideApproval(row.approval.id, true)">Approve</button><button class="mini soft" type="button" @click="decideApproval(row.approval.id, false)">Deny</button></div></section>
              <article v-else-if="row.rowType === 'simple'" class="message system-message"><div class="avatar">S</div><div class="message-body"><div class="message-meta"><strong>{{ endpointLabel(row.meta) }}</strong></div><p class="message-text">{{ row.text }}</p></div></article>
            </template>
          </div>
          <form class="composer" @submit.prevent="submitMessage">
            <div v-if="activeThreadId" class="thread-context"><CornerDownRight :size="15" aria-hidden="true" /><span>{{ activeThreadLabel }}</span><button class="mini soft" type="button" @click="clearActiveThread()">Clear</button></div>
            <div class="composer-box"><textarea ref="messageInput" v-model="messageText" rows="2" autocomplete="off" placeholder="Message an agent or the room" /><button class="button" type="submit">Send</button></div>
          </form>
        </section>

        <aside class="stack">
          <section class="panel"><h3>Projects discussed here</h3><button v-for="session in roomProjectCards" :key="session.session_id" class="room-row" type="button" @click="openSessionDetail(session)"><strong>{{ session.title }}</strong><p>{{ projectAttentionText(session) }} · {{ projectLaneLabelForSession(session) }}</p></button><p v-if="!roomProjectCards.length">No linked Project cards in this room yet.</p></section>
          <section class="panel"><h3>Current operation</h3><div v-if="currentOperation" class="mono-line"><code>{{ operationState(currentOperation) }}</code><code>{{ operationTitle(currentOperation) }}</code><span>{{ operationDetail(currentOperation) }}</span></div><p v-else>No agent activity yet.</p><button class="mini soft" type="button" @click="openTraceViewer">Open Observe</button></section>
        </aside>
      </section>

      <section v-else-if="activeView === 'agent'" class="content">
        <div class="table-shell">
          <div class="row header"><span>Agent</span><span>Project responsibility</span><span>State</span><span>Latest IPC</span><span>Action</span></div>
          <div v-for="item in agentRuntimeRows" :key="item.agent" class="row">
            <strong>{{ agentLabel(item.agent) }}<br><span>{{ item.agent }}</span></strong>
            <span>{{ item.project?.title || item.workload?.sessions[0]?.session_title || 'No active Project responsibility' }}</span>
            <span class="chip" :class="agentRowState(item.agent) === 'running' || agentRowState(item.agent) === 'streaming' ? 'live' : agentRowState(item.agent) === 'blocked' || agentRowState(item.agent) === 'errored' ? 'bad' : ''">{{ agentRowState(item.agent) }}</span>
            <div class="mono-line"><code>{{ endpointLabel(item.agent) }}</code><code>ipc</code><span>{{ agentLatestIpc(item.agent) }}</span></div>
            <button class="mini primary" type="button" @click="openAgentDashboard(item.agent)">Open</button>
          </div>
          <div v-if="!agentRuntimeRows.length" class="panel empty-panel"><h3>No agents yet</h3><p>Agents appear after a room run starts.</p></div>
        </div>
      </section>

      <section v-else-if="activeView === 'trace'" class="trace-view" :class="['content', 'two-col']">
        <div class="stack">
          <div class="trace-controls atlas-trace-controls"><label class="trace-filter"><span><Search :size="13" aria-hidden="true" /> Search</span><input v-model="traceQuery" class="trace-input" type="search" autocomplete="off" @keydown.enter.prevent="refreshTrace" /></label><label class="trace-filter trace-limit"><span>Limit</span><input v-model.number="traceLimit" class="trace-input" type="number" min="1" max="1000" step="25" @keydown.enter.prevent="refreshTrace" /></label><button class="button-tonal" type="button" :disabled="traceState.loading" @click="refreshTrace">Apply</button></div>
          <div class="table-shell"><div class="row header"><span>Trace group</span><span>Runtime state</span><span>Latest IPC</span><span>Linked object</span><span>Evidence</span></div><div v-for="event in observeAuditEvents.slice(0, 8)" :key="event.id" class="row"><strong>{{ traceGroupLabel(event) }}<br><span>{{ formatTraceTime(event.timestamp) }}</span></strong><span>{{ event.label }}</span><div class="mono-line"><code>{{ traceEndpoint(event) }}</code><code>{{ traceOperation(event) }}</code><span>{{ event.detail || tracePrimaryLine(event) }}</span></div><span>{{ traceChips(event)[0] || traceRoute(event) }}</span><button class="mini primary" type="button" @click="traceQuery = traceGroupLabel(event); refreshTrace()">Trace</button></div></div>
          <div v-if="traceState.error" class="panel bad-panel"><h3>Observe error</h3><p>{{ traceState.error }}</p></div>
          <div v-else-if="!traceState.available" class="panel empty-panel"><h3>Observe unavailable</h3><p>Trace is not configured for this bridge.</p></div>
          <div v-else-if="!traceState.events.length" class="panel empty-panel"><h3>No runtime audit events yet</h3><p>Trace events will appear when IPC traffic starts.</p></div>
          <div v-else class="trace-event-stream" :class="'trace-list'"><article v-for="event in observeAuditEvents" :key="event.id" class="trace-event"><span class="trace-time">{{ formatTraceTime(event.timestamp) }}</span><span class="trace-dot" :class="{ bad: traceIsIssue(event), good: traceRoute(event) === 'delivered' }"></span><div class="trace-body"><strong>{{ tracePrimaryLine(event) }}</strong><span>{{ event.detail || event.label }}</span></div></article></div>
        </div>
        <aside class="stack"><section class="panel"><h3>Runtime audit</h3><p>{{ traceStatus }}</p><p v-if="traceState.tracePath">{{ traceState.tracePath }}</p></section><section class="panel"><h3>Endpoint health</h3><p>{{ traceMetric(traceState.stats.total_events) }} events, {{ traceMetric(traceState.stats.approvals) }} approvals, {{ traceRouteCount('dropped') + traceRouteCount('rejected') }} blocked.</p></section></aside>
      </section>
    </section>
  </main>

</template>
