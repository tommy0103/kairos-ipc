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

interface SessionBoardColumn {
  phase: WorkPhase;
  label: string;
  sessions: SessionWorkProjection[];
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
  return ["all", "intake", "shape", "plan", "execute", "review", "validate", "decision", "handoff", "done"]
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
const sessionBoardColumns = computed<SessionBoardColumn[]>(() => {
  const grouped = new Map<WorkPhase, SessionWorkProjection[]>();
  for (const session of visibleWorkSessions.value) {
    const sessions = grouped.get(session.phase) ?? [];
    sessions.push(session);
    grouped.set(session.phase, sessions);
  }
  const phases = sessionPhaseFilter.value === "all"
    ? dashboardPhaseOrder.filter((phase) => (grouped.get(phase)?.length ?? 0) > 0)
    : [sessionPhaseFilter.value as WorkPhase];
  return phases.map((phase) => ({ phase, label: phaseLabel(phase), sessions: grouped.get(phase) ?? [] }));
});
const selectedSession = computed(() => workSessions.value.find((session) => session.session_id === selectedSessionId.value) ?? visibleWorkSessions.value[0] ?? null);
const detailSession = computed(() => sessionDetail.value?.session ?? selectedSession.value ?? null);
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
  if (traceState.loading) return "loading trace";
  if (traceState.error) return "trace error";
  if (!traceState.available) return "trace unavailable";
  return `${traceState.stats.total_events} events in ${traceState.stats.group_count} groups`;
});
const traceIssueCount = computed(() => traceState.events.filter((event) => traceIsIssue(event)).length);
const workspaceTitle = computed(() => {
  if (activeView.value === "sessions") return "Work Dashboard";
  if (activeView.value === "session") return detailSession.value?.title ?? "Session Detail";
  if (activeView.value === "review") return "Review Queue";
  if (activeView.value === "trace") return "Trace";
  if (activeView.value === "agent") return activeAgentUri.value ?? "Agent";
  return channelTitle.value;
});
const workspaceStatus = computed(() => {
  if (activeView.value === "sessions") {
    if (sessionsLoading.value) return "loading sessions";
    if (sessionsError.value) return sessionsError.value;
    return `${workSessions.value.length} sessions · ${activeWorkSessionCount.value} active · ${pendingReviewItemCount.value} waiting`;
  }
  if (activeView.value === "session") {
    if (sessionDetailLoading.value) return "loading session";
    if (sessionDetailError.value) return sessionDetailError.value;
    const session = detailSession.value;
    return session ? `${session.phase_label} · ${session.status} · ${sessionUpdatedAt(session) || "live"}` : "session not selected";
  }
  if (activeView.value === "review") return `${reviewQueue.value.length} waiting · ${visibleReviewQueue.value.length} visible`;
  if (activeView.value === "trace") return traceStatus.value;
  if (activeView.value === "agent") return "agent dashboard";
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
  sessionDetailTab.value = "work";
  selectedInspectorRef.value = objectRef ?? { kind: "session", id: sessionId };
  await loadSessionDetail(sessionId);
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

function selectSession(sessionId: string): void {
  selectedSessionId.value = sessionId;
}

function selectInspector(kind: InspectorKind, id: string): void {
  selectedInspectorRef.value = { kind, id };
  sessionDetailTab.value = sessionDetailTab.value === "reports" ? "inspector" : sessionDetailTab.value;
}

function sessionSearchPlaceholder(): string {
  return workSessions.value.length > 0 ? "Search sessions, agents, blockers" : "Search sessions";
}

function sessionPrimaryText(session: SessionWorkProjection): string {
  return session.objective || session.current_work || session.phase_reason || "No current work recorded";
}

function sessionSignalText(session: SessionWorkProjection): string {
  return session.current_work || session.latest_report || session.phase_reason || "Waiting for next event";
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

function lifecycleColumns(detail: SessionDetailProjection | null): LifecycleColumn[] {
  if (!detail) return [];
  const columns: LifecycleColumn[] = [
    {
      phase: "intake",
      label: "Intake",
      items: [
        { kind: "session", id: detail.session.session_id, title: detail.session.title, meta: detail.session.objective || "Session boundary", status: detail.session.status },
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
      eyebrow: "Session",
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
  const endpoint = ref.endpoint ? endpointLabel(ref.endpoint) : "trace";
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
  return `session final · ${messageTime(message.created_at)}`;
}

function artifactProjectionTitle(message: SlockMessage): string {
  return message.projection?.title || "Artifact ready";
}

function artifactProjectionMeta(message: SlockMessage): string {
  const author = message.projection?.author ?? message.sender;
  return `artifact · @${endpointLabel(author)} · ${messageTime(message.created_at)}`;
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

function streamKey(delta: SlockMessageDelta): string {
  return "stream:" + delta.source + ":" + delta.thread_id;
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

  const id = streamKey(delta);
  let row = streamRows.get(id);
  if (!row) {
    row = appendSimpleRow("delta", delta.source, delta.text, id);
    if (!row) return;
    if (delta.thread_id) row.threadReply = true;
    streamRows.set(id, row);
    return;
  }

  row.text += delta.text;
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
  await postSessionAction(`/api/sessions/${encodeURIComponent(session.session_id)}/synthesis`, { reason: "User requested final synthesis from Session Detail" }, `synthesis:${session.session_id}`);
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
  <main class="app-shell">
    <aside class="navigation-rail" aria-label="Workspace navigation">
      <div class="brand-lockup">
        <span class="brand-glyph" aria-hidden="true"><MessageSquare :size="18" /></span>
        <span class="brand-copy">
          <span class="brand-name">Kairos</span>
          <span class="brand-caption">Slock bridge</span>
        </span>
      </div>

      <section class="nav-section" aria-label="Sessions">
        <div class="nav-heading">
          <span>Sessions</span>
          <span>{{ workSessions.length }}</span>
        </div>
        <div class="nav-list">
          <button
            class="nav-item"
            :class="{ active: activeView === 'sessions' }"
            type="button"
            @click="showSessions"
          >
            <Activity :size="16" aria-hidden="true" />
            <span>Work Dashboard</span>
          </button>
        </div>
      </section>

      <section class="nav-section" aria-label="Review">
        <div class="nav-heading">
          <span>Review</span>
          <span>{{ reviewQueue.length }}</span>
        </div>
        <div class="nav-list">
          <button
            class="nav-item"
            :class="{ active: activeView === 'review' }"
            type="button"
            @click="showReviewQueue"
          >
            <ListChecks :size="16" aria-hidden="true" />
            <span>Queue</span>
          </button>
        </div>
      </section>

      <section class="nav-section" aria-label="Rooms">
        <div class="nav-heading">
          <span>Rooms</span>
          <span>{{ channels.length }}</span>
        </div>
        <div class="nav-list">
          <button
            v-for="channel in channels"
            :key="channel.uri"
            class="nav-item"
            :class="{ active: activeView === 'chat' && activeChannel?.uri === channel.uri }"
            type="button"
            @click="switchChannel(channel.uri)"
          >
            <MessageSquare v-if="channel.kind !== 'dm'" :size="16" aria-hidden="true" />
            <Bot v-else :size="16" aria-hidden="true" />
            <span>{{ channelLabel(channel) }}</span>
          </button>
        </div>
      </section>

      <section class="nav-section" aria-label="Agents">
        <div class="nav-heading">
          <span>Agents</span>
          <span>{{ knownAgents.length }}</span>
        </div>
        <div v-if="knownAgents.length" class="nav-list">
          <button
            v-for="agent in knownAgents"
            :key="agent"
            class="nav-item"
            :class="{ active: activeView === 'agent' && activeAgentUri === agent }"
            type="button"
            @click="openAgentDashboard(agent)"
          >
            <Bot :size="16" aria-hidden="true" />
            <span>{{ agentLabel(agent) }}</span>
          </button>
        </div>
        <div v-else class="nav-empty">Agents appear after a run starts.</div>
      </section>

      <section class="nav-section nav-section-bottom" aria-label="Observe">
        <div class="nav-heading">
          <span>Observe</span>
        </div>
        <div class="nav-list">
          <button
            class="nav-item"
            :class="{ active: activeView === 'trace' }"
            type="button"
            @click="openTraceViewer"
          >
            <Activity :size="16" aria-hidden="true" />
            <span>Trace</span>
          </button>
        </div>
      </section>
    </aside>

    <section class="workspace" :aria-label="activeView === 'sessions' ? 'Work dashboard' : activeView === 'session' ? 'Session detail' : activeView === 'review' ? 'Review queue' : activeView === 'agent' ? 'Agent dashboard' : activeView === 'trace' ? 'Trace viewer' : 'Channel'">
      <header class="topbar">
        <div class="workspace-heading">
          <p class="workspace-kicker">{{ activeView === 'sessions' ? 'Sessions' : activeView === 'session' ? 'Session' : activeView === 'review' ? 'Review' : activeView === 'chat' ? 'Room' : activeView === 'agent' ? 'Agent' : 'Observe' }}</p>
          <h1>{{ workspaceTitle }}</h1>
          <p>{{ workspaceStatus }}</p>
        </div>
        <div class="topbar-actions">
          <button v-if="activeView === 'sessions'" class="ghost icon-label" type="button" :disabled="sessionsLoading" @click="loadSessions">
            <RefreshCw :size="15" aria-hidden="true" />
            <span>Refresh</span>
          </button>
          <template v-else-if="activeView === 'session'">
            <button class="ghost icon-label" type="button" :disabled="sessionDetailLoading || !selectedSessionId" @click="selectedSessionId && loadSessionDetail(selectedSessionId)">
              <RefreshCw :size="15" aria-hidden="true" />
              <span>Refresh</span>
            </button>
            <button v-if="detailSession?.status !== 'open'" class="ghost icon-label" type="button" :disabled="!detailSession || actionPending('reopen:' + detailSession.session_id)" @click="reopenSelectedSession">
              <RotateCcw :size="15" aria-hidden="true" />
              <span>Reopen</span>
            </button>
            <button v-else class="ghost icon-label" type="button" :disabled="!detailSession || actionPending('close:' + detailSession.session_id)" @click="closeSelectedSession('completed')">
              <Archive :size="15" aria-hidden="true" />
              <span>Close</span>
            </button>
          </template>
          <button v-else-if="activeView === 'review'" class="ghost icon-label" type="button" :disabled="sessionsLoading" @click="loadDashboard">
            <RefreshCw :size="15" aria-hidden="true" />
            <span>Refresh</span>
          </button>
          <button v-else-if="activeView === 'chat'" class="ghost icon-label" type="button" @click="refreshHistory">
            <RefreshCw :size="15" aria-hidden="true" />
            <span>Refresh</span>
          </button>
          <button v-else-if="activeView === 'trace'" class="ghost icon-label" type="button" :disabled="traceState.loading" @click="refreshTrace">
            <RefreshCw :size="15" aria-hidden="true" />
            <span>Refresh</span>
          </button>
          <button v-else class="ghost icon-label" type="button" @click="showChat">
            <MessageSquare :size="15" aria-hidden="true" />
            <span>Channel</span>
          </button>
        </div>
      </header>

      <div v-if="activeView === 'sessions'" class="work-dashboard">
        <div class="work-dashboard-toolbar">
          <label class="dashboard-search">
            <Search :size="15" aria-hidden="true" />
            <input v-model="sessionSearch" type="search" :placeholder="sessionSearchPlaceholder()" />
          </label>
          <div class="phase-filter" aria-label="Session phase filter">
            <button
              v-for="item in sessionPhaseFilters"
              :key="item.phase"
              class="phase-filter-item"
              :class="{ active: sessionPhaseFilter === item.phase }"
              type="button"
              @click="sessionPhaseFilter = item.phase"
            >
              <span>{{ item.label }}</span>
              <span>{{ item.count }}</span>
            </button>
          </div>
        </div>

        <div class="dashboard-metrics" aria-label="Work dashboard summary">
          <div class="dashboard-metric">
            <span>Active</span>
            <strong>{{ activeWorkSessionCount }}</strong>
          </div>
          <div class="dashboard-metric">
            <span>Waiting</span>
            <strong>{{ pendingReviewItemCount }}</strong>
          </div>
          <div class="dashboard-metric">
            <span>Blocked</span>
            <strong>{{ blockedWorkSessionCount }}</strong>
          </div>
          <div class="dashboard-metric">
            <span>Agents</span>
            <strong>{{ runningDashboardAgentCount }}</strong>
          </div>
        </div>

        <div v-if="dashboardIsStale" class="dashboard-stale">
          <ShieldAlert :size="16" aria-hidden="true" />
          <span>Dashboard has not received session updates for more than two minutes.</span>
          <button class="subtle-button" type="button" @click="loadDashboard">Retry</button>
        </div>

        <div v-if="sessionsError" class="dashboard-error">
          <ShieldAlert :size="16" aria-hidden="true" />
          <span>{{ sessionsError }}</span>
        </div>

        <div v-if="sessionsLoading && !workSessions.length" class="session-skeleton-list" aria-label="Loading sessions">
          <div v-for="index in 4" :key="index" class="session-skeleton-row"></div>
        </div>

        <div v-else-if="!workSessions.length" class="dashboard-empty">
          <div class="dashboard-empty-title">No work sessions</div>
          <div class="dashboard-empty-text">Session state will appear after a real collaboration session is created.</div>
          <button class="ghost icon-label" type="button" @click="showChat">
            <MessageSquare :size="15" aria-hidden="true" />
            <span>Open room</span>
          </button>
        </div>

        <div v-else-if="!visibleWorkSessions.length" class="dashboard-empty compact-empty">
          <div class="dashboard-empty-title">No matching sessions</div>
          <div class="dashboard-empty-text">Adjust the search or phase filter.</div>
        </div>

        <div v-else class="work-dashboard-layout">
          <section class="session-board" aria-label="Work sessions by lifecycle phase">
            <section v-for="column in sessionBoardColumns" :key="column.phase" class="session-column" :data-phase="column.phase">
              <header class="session-column-header">
                <span class="work-phase" :data-phase="column.phase">{{ column.label }}</span>
                <span>{{ column.sessions.length }}</span>
              </header>

              <article
                v-for="session in column.sessions"
                :key="session.session_id"
                class="session-work-card"
                :class="{ selected: selectedSession?.session_id === session.session_id }"
                :data-phase="sessionPhaseClass(session)"
                :data-stale="sessionIsStale(session)"
              >
                <button class="session-work-card-main" type="button" @click="selectSession(session.session_id)">
                  <span class="session-card-topline">
                    <strong>{{ session.title }}</strong>
                    <span>{{ sessionIsStale(session) ? 'stale' : sessionUpdatedAt(session) }}</span>
                  </span>
                  <span class="session-card-summary">{{ sessionPrimaryText(session) }}</span>
                  <span v-if="session.agents.length" class="session-agent-list" aria-label="Assigned agents">
                    <span v-for="agent in visibleAgents(session)" :key="agent.delegation_id" class="session-agent-chip" :data-state="agent.status">
                      @{{ endpointLabel(agent.agent) }} {{ agentRoleText(agent) }}
                    </span>
                    <span v-if="remainingAgentCount(session)" class="session-agent-chip muted">+{{ remainingAgentCount(session) }}</span>
                  </span>
                  <span class="session-card-current">{{ sessionSignalText(session) }}</span>
                  <span class="session-card-blockers" :data-empty="session.blockers.length === 0">{{ sessionBlockerSummary(session) }}</span>
                </button>

                <div class="session-card-actions" aria-label="Session actions">
                  <button class="icon-button" type="button" title="Open session detail" @click="openSessionDetail(session)">
                    <ChevronRight :size="15" aria-hidden="true" />
                  </button>
                  <button
                    v-for="action in sessionRunnableActions(session)"
                    :key="action.kind + ':' + action.target"
                    class="icon-button"
                    type="button"
                    :title="action.label"
                    @click="sessionAction(session, action)"
                  >
                    <MessageSquare v-if="action.kind === 'open_thread'" :size="15" aria-hidden="true" />
                    <Activity v-else :size="15" aria-hidden="true" />
                  </button>
                </div>
              </article>
            </section>
          </section>

          <aside v-if="selectedSession" class="session-inspector" aria-label="Selected session">
            <div class="session-inspector-header">
              <span class="work-phase" :data-phase="sessionPhaseClass(selectedSession)">{{ selectedSession.phase_label }}</span>
              <h2>{{ selectedSession.title }}</h2>
              <p>{{ selectedSession.phase_reason || selectedSession.status }}</p>
            </div>

            <div class="session-inspector-section">
              <span class="session-section-label">Owner</span>
              <strong>{{ sessionOwnerLabel(selectedSession) }}</strong>
            </div>

            <div v-if="selectedSession.acceptance_criteria?.length" class="session-inspector-section">
              <span class="session-section-label">Acceptance</span>
              <ul class="inspector-list">
                <li v-for="criterion in selectedSession.acceptance_criteria" :key="criterion">{{ criterion }}</li>
              </ul>
            </div>

            <div class="session-inspector-section">
              <span class="session-section-label">Agents</span>
              <div v-if="selectedSession.agents.length" class="inspector-agent-list">
                <div v-for="agent in selectedSession.agents" :key="agent.delegation_id" class="inspector-agent-row">
                  <span>@{{ endpointLabel(agent.agent) }}</span>
                  <strong>{{ delegationStatusLabel(agent.status) }}</strong>
                  <small>{{ agent.current_work || agentWorkloadForSession(selectedSession, agent.agent)?.current_work || agentRoleText(agent) }}</small>
                </div>
              </div>
              <p v-else class="dashboard-muted">No active delegation</p>
            </div>

            <div v-if="selectedSession.latest_report" class="session-inspector-section">
              <span class="session-section-label">Latest Report</span>
              <p>{{ selectedSession.latest_report }}</p>
            </div>

            <div v-if="selectedSession.blockers.length" class="session-inspector-section">
              <span class="session-section-label">Blockers</span>
              <div class="session-blockers">
                <span v-for="blocker in selectedSession.blockers" :key="blocker.kind + ':' + blocker.ref_id" class="session-blocker">{{ blocker.label }}</span>
              </div>
            </div>

            <div v-if="selectedSessionReviews.length" class="session-inspector-section">
              <span class="session-section-label">Review Queue</span>
              <div class="inspector-review-list">
                <div v-for="item in selectedSessionReviews" :key="item.id" class="inspector-review-row">
                  <strong>{{ item.required_action }}</strong>
                  <span>{{ item.title }}</span>
                </div>
              </div>
            </div>

            <div class="session-inspector-section">
              <span class="session-section-label">Latest Tool</span>
              <p>{{ toolCallLabel(selectedAgentWorkload[0]?.latest_tool_call || selectedSession.agents.find((agent) => agent.latest_tool_call)?.latest_tool_call) }}</p>
            </div>

            <div v-if="sessionWorkflowActions(selectedSession).length" class="session-inspector-section">
              <span class="session-section-label">Pending Actions</span>
              <div class="inspector-action-list">
                <span v-for="action in sessionWorkflowActions(selectedSession)" :key="action.kind + ':' + action.target">{{ action.label }}</span>
              </div>
            </div>

            <div class="session-inspector-actions">
              <button class="subtle-button icon-label" type="button" @click="openSessionDetail(selectedSession)">
                <ChevronRight :size="14" aria-hidden="true" />
                <span>Open detail</span>
              </button>
              <button class="subtle-button icon-label" type="button" @click="openSessionThread(selectedSession)">
                <MessageSquare :size="14" aria-hidden="true" />
                <span>Open thread</span>
              </button>
              <button class="subtle-button icon-label" type="button" @click="openSessionTrace(selectedSession)">
                <Activity :size="14" aria-hidden="true" />
                <span>Open trace</span>
              </button>
            </div>
          </aside>
        </div>
      </div>

      <div v-else-if="activeView === 'session'" class="session-detail-view">
        <div class="session-detail-tabs" role="tablist" aria-label="Session detail sections">
          <button type="button" role="tab" :aria-selected="sessionDetailTab === 'work'" :class="{ active: sessionDetailTab === 'work' }" @click="sessionDetailTab = 'work'">Work</button>
          <button type="button" role="tab" :aria-selected="sessionDetailTab === 'reports'" :class="{ active: sessionDetailTab === 'reports' }" @click="sessionDetailTab = 'reports'">Reports</button>
          <button type="button" role="tab" :aria-selected="sessionDetailTab === 'inspector'" :class="{ active: sessionDetailTab === 'inspector' }" @click="sessionDetailTab = 'inspector'">Inspector</button>
        </div>

        <div v-if="sessionDetailError" class="dashboard-error">
          <ShieldAlert :size="16" aria-hidden="true" />
          <span>{{ sessionDetailError }}</span>
          <button class="subtle-button" type="button" :disabled="!selectedSessionId" @click="selectedSessionId && loadSessionDetail(selectedSessionId)">Retry</button>
        </div>

        <div v-if="sessionDetailIsStale" class="dashboard-stale">
          <ShieldAlert :size="16" aria-hidden="true" />
          <span>Session detail has not refreshed for more than two minutes.</span>
          <button class="subtle-button" type="button" :disabled="!selectedSessionId" @click="selectedSessionId && loadSessionDetail(selectedSessionId)">Refresh</button>
        </div>

        <div v-if="sessionDetailLoading && !sessionDetail" class="session-detail-skeleton">
          <div class="session-skeleton-row"></div>
          <div class="session-skeleton-row"></div>
          <div class="session-skeleton-row"></div>
        </div>

        <div v-else-if="!detailSession" class="dashboard-empty">
          <div class="dashboard-empty-title">Session not found</div>
          <div class="dashboard-empty-text">Return to the dashboard or open trace to inspect the raw IPC stream.</div>
          <div class="session-inspector-actions">
            <button class="ghost icon-label" type="button" @click="showSessions">
              <Activity :size="15" aria-hidden="true" />
              <span>Dashboard</span>
            </button>
            <button class="ghost icon-label" type="button" @click="openTraceViewer">
              <TerminalSquare :size="15" aria-hidden="true" />
              <span>Trace</span>
            </button>
          </div>
        </div>

        <div v-else class="session-detail-layout">
          <section class="session-detail-work" :class="{ active: sessionDetailTab === 'work' }" aria-label="Session work canvas">
            <header class="session-detail-header">
              <div>
                <span class="work-phase" :data-phase="sessionPhaseClass(detailSession)">{{ detailSession.phase_label }}</span>
                <h2>{{ detailSession.title }}</h2>
                <p>{{ detailSession.phase_reason || detailSession.status }}</p>
              </div>
              <div class="session-detail-actions">
                <button class="subtle-button icon-label" type="button" :disabled="actionPending('synthesis:' + detailSession.session_id)" @click="requestSelectedSynthesis">
                  <Check :size="14" aria-hidden="true" />
                  <span>Synthesis</span>
                </button>
                <button v-if="detailSession.status === 'open'" class="subtle-button icon-label" type="button" :disabled="actionPending('close:' + detailSession.session_id)" @click="closeSelectedSession('completed')">
                  <Archive :size="14" aria-hidden="true" />
                  <span>Close</span>
                </button>
                <button v-else class="subtle-button icon-label" type="button" :disabled="actionPending('reopen:' + detailSession.session_id)" @click="reopenSelectedSession">
                  <RotateCcw :size="14" aria-hidden="true" />
                  <span>Reopen</span>
                </button>
              </div>
            </header>

            <section class="objective-panel">
              <div>
                <span class="session-section-label">Objective</span>
                <p>{{ detailSession.objective || sessionPrimaryText(detailSession) }}</p>
              </div>
              <div>
                <span class="session-section-label">Acceptance</span>
                <ul v-if="detailSession.acceptance_criteria?.length" class="inspector-list">
                  <li v-for="criterion in detailSession.acceptance_criteria" :key="criterion">{{ criterion }}</li>
                </ul>
                <p v-else class="dashboard-muted">No criteria recorded</p>
              </div>
              <div>
                <span class="session-section-label">Counts</span>
                <div class="detail-counts">
                  <span>{{ detailObjectCounts.tasks }} tasks</span>
                  <span>{{ detailObjectCounts.delegations }} delegations</span>
                  <span>{{ detailObjectCounts.artifacts }} artifacts</span>
                  <span>{{ detailObjectCounts.waiting }} waiting</span>
                </div>
              </div>
            </section>

            <section class="lifecycle-canvas" aria-label="Lifecycle projection">
              <section v-for="column in detailLifecycleColumns" :key="column.phase" class="lifecycle-column" :data-phase="column.phase">
                <header>
                  <span class="work-phase" :data-phase="column.phase">{{ column.label }}</span>
                  <span>{{ column.items.length }}</span>
                </header>
                <button
                  v-for="item in column.items"
                  :key="item.kind + ':' + item.id"
                  class="lifecycle-object"
                  :class="{ selected: selectedInspectorRef.kind === item.kind && selectedInspectorRef.id === item.id }"
                  type="button"
                  @click="selectInspector(item.kind, item.id)"
                >
                  <strong>{{ item.title }}</strong>
                  <span>{{ item.meta }}</span>
                  <small v-if="item.status">{{ item.status }}</small>
                </button>
              </section>
            </section>

            <section v-if="sessionDetail" class="detail-object-grid" aria-label="Session objects">
              <div class="detail-panel">
                <header><span>Tasks</span><span>{{ sessionDetail.tasks.length }}</span></header>
                <button v-for="task in sessionDetail.tasks" :key="task.id" class="detail-object-row" type="button" @click="selectInspector('task', task.id)">
                  <strong>{{ task.title }}</strong>
                  <span>{{ task.status }} · {{ endpointLabel(task.owner) }}</span>
                </button>
                <p v-if="!sessionDetail.tasks.length" class="dashboard-muted">No tasks</p>
              </div>

              <div class="detail-panel">
                <header><span>Delegations</span><span>{{ sessionDetail.delegations.length }}</span></header>
                <button v-for="delegation in sessionDetail.delegations" :key="delegation.id" class="detail-object-row" type="button" @click="selectInspector('delegation', delegation.id)">
                  <strong>@{{ endpointLabel(delegation.assignee) }}</strong>
                  <span>{{ delegation.status }} · {{ delegation.role_label || delegation.role || delegation.instruction }}</span>
                </button>
                <p v-if="!sessionDetail.delegations.length" class="dashboard-muted">No delegations</p>
              </div>

              <div class="detail-panel wide">
                <header><span>Artifacts</span><span>{{ sessionDetail.artifacts.length }}</span></header>
                <article v-for="artifact in sessionDetail.artifacts" :key="artifact.id" class="artifact-review-row" :data-state="artifact.status">
                  <button class="detail-object-row" type="button" @click="selectInspector('artifact', artifact.id)">
                    <strong>{{ artifact.title || artifact.kind }}</strong>
                    <span>{{ artifact.status }} · @{{ endpointLabel(artifact.author) }}</span>
                  </button>
                  <div v-if="artifact.status === 'submitted' || artifact.status === 'revision_requested'" class="inline-action-bar">
                    <input v-model="actionNotes['artifact:' + artifact.id]" type="text" placeholder="Review note" :aria-label="'Review note for ' + (artifact.title || artifact.kind)" />
                    <button type="button" :disabled="actionPending('artifact:' + artifact.id + ':accepted')" @click="reviewArtifact(detailSession.session_id, artifact.id, 'accepted')">Accept</button>
                    <button type="button" :disabled="actionPending('artifact:' + artifact.id + ':revision_requested')" @click="reviewArtifact(detailSession.session_id, artifact.id, 'revision_requested')">Revise</button>
                    <button type="button" :disabled="actionPending('artifact:' + artifact.id + ':rejected')" @click="reviewArtifact(detailSession.session_id, artifact.id, 'rejected')">Reject</button>
                  </div>
                </article>
                <p v-if="!sessionDetail.artifacts.length" class="dashboard-muted">No artifacts</p>
              </div>

              <div class="detail-panel">
                <header><span>Barriers</span><span>{{ sessionDetail.barriers.length }}</span></header>
                <button v-for="barrier in sessionDetail.barriers" :key="barrier.id" class="detail-object-row" type="button" @click="selectInspector('barrier', barrier.id)">
                  <strong>{{ barrier.synthesis_requested ? 'Synthesis barrier' : 'Reply barrier' }}</strong>
                  <span>{{ barrier.status }} · {{ barrier.expected_from.map(endpointLabel).join(', ') }}</span>
                </button>
                <p v-if="!sessionDetail.barriers.length" class="dashboard-muted">No barriers</p>
              </div>

              <div class="detail-panel">
                <header><span>Decisions</span><span>{{ sessionDetail.decisions.length }}</span></header>
                <button v-for="decision in sessionDetail.decisions" :key="decision.id" class="detail-object-row" type="button" @click="selectInspector('decision', decision.id)">
                  <strong>{{ endpointLabel(decision.decider) }}</strong>
                  <span>{{ objectPreview(decision.decision) }}</span>
                </button>
                <p v-if="!sessionDetail.decisions.length" class="dashboard-muted">No decisions</p>
              </div>

              <div class="detail-panel wide">
                <header><span>Approvals and Validations</span><span>{{ sessionDetail.approvals.length + sessionDetail.validations.length }}</span></header>
                <article v-for="approval in sessionDetail.approvals" :key="approval.id" class="artifact-review-row" :data-state="approval.status">
                  <button class="detail-object-row" type="button" @click="selectInspector('approval', approval.id)">
                    <strong>{{ endpointLabel(approval.tool_endpoint) }} {{ approval.action }}</strong>
                    <span>{{ approval.status }} · {{ approval.payload_summary }}</span>
                  </button>
                  <div v-if="approval.status === 'pending'" class="inline-action-bar">
                    <input v-model="actionNotes['approval:' + approval.id]" type="text" placeholder="Resolution note" :aria-label="'Resolution note for ' + approval.action" />
                    <button type="button" :disabled="actionPending('approval:' + approval.id + ':approved')" @click="resolveSessionApproval(detailSession.session_id, approval.id, true)">Approve</button>
                    <button type="button" :disabled="actionPending('approval:' + approval.id + ':rejected')" @click="resolveSessionApproval(detailSession.session_id, approval.id, false)">Reject</button>
                  </div>
                </article>
                <article v-for="validation in sessionDetail.validations" :key="validation.id" class="artifact-review-row" :data-state="validation.status">
                  <button class="detail-object-row" type="button" @click="selectInspector('validation', validation.id)">
                    <strong>{{ validation.summary || 'Validation' }}</strong>
                    <span>{{ validation.status }} · {{ validation.artifact_id || validation.task_id || endpointLabel(validation.requester) }}</span>
                  </button>
                  <div v-if="validation.status === 'requested' || validation.status === 'failed'" class="inline-action-bar">
                    <input v-model="actionNotes['validation:' + validation.id]" type="text" placeholder="Validation summary" :aria-label="'Validation summary for ' + (validation.summary || validation.id)" />
                    <button type="button" :disabled="actionPending('validation:' + validation.id + ':passed')" @click="recordValidation(detailSession.session_id, validation.id, 'passed')">Pass</button>
                    <button type="button" :disabled="actionPending('validation:' + validation.id + ':failed')" @click="recordValidation(detailSession.session_id, validation.id, 'failed')">Fail</button>
                  </div>
                </article>
              </div>
            </section>
          </section>

          <section v-if="sessionDetail" class="session-detail-reports" :class="{ active: sessionDetailTab === 'reports' }" aria-label="Session reports">
            <header class="detail-panel-title">
              <span>Reports</span>
              <span>{{ sessionDetail.notes.length }}</span>
            </header>
            <button v-for="note in sessionDetail.notes" :key="note.id" class="report-object-row" type="button" @click="selectInspector('note', note.id)">
              <span>@{{ endpointLabel(note.from) }}</span>
              <p>{{ note.text }}</p>
              <small>{{ messageTime(note.created_at) }} · {{ note.visibility }}</small>
            </button>
            <p v-if="!sessionDetail.notes.length" class="dashboard-muted">No short reports yet</p>
          </section>

          <aside class="detail-inspector" :class="{ active: sessionDetailTab === 'inspector' }" aria-label="Inspector">
            <template v-if="inspectorObject">
              <header class="detail-inspector-header">
                <span class="session-section-label">{{ inspectorObject.eyebrow }}</span>
                <h2>{{ inspectorObject.title }}</h2>
                <p v-if="inspectorObject.summary">{{ inspectorObject.summary }}</p>
                <span v-if="inspectorObject.status" class="work-phase">{{ inspectorObject.status }}</span>
              </header>

              <section class="inspector-actions-panel">
                <button v-if="inspectorObject.ref.kind === 'session'" class="subtle-button" type="button" @click="requestSelectedSynthesis">Request synthesis</button>
                <button v-if="inspectorObject.ref.kind === 'artifact'" class="subtle-button" type="button" @click="reviewArtifact(currentDetailSessionId(), inspectorObject.ref.id, 'accepted')">Accept</button>
                <button v-if="inspectorObject.ref.kind === 'artifact'" class="subtle-button" type="button" @click="reviewArtifact(currentDetailSessionId(), inspectorObject.ref.id, 'revision_requested')">Request revision</button>
                <button v-if="inspectorObject.ref.kind === 'approval'" class="subtle-button" type="button" @click="resolveSessionApproval(currentDetailSessionId(), inspectorObject.ref.id, true)">Approve</button>
                <button v-if="inspectorObject.ref.kind === 'approval'" class="subtle-button" type="button" @click="resolveSessionApproval(currentDetailSessionId(), inspectorObject.ref.id, false)">Reject</button>
                <button class="subtle-button" type="button" @click="openTraceViewer">Open trace</button>
              </section>

              <section v-if="inspectorObject.ref.kind === 'artifact'" class="session-inspector-section">
                <span class="session-section-label">Artifact</span>
                <ArtifactMarkdown :source="inspectorMarkdownText(inspectorObject)" />
              </section>

              <section v-else class="session-inspector-section">
                <span class="session-section-label">Payload</span>
                <pre class="inspector-pre">{{ objectPreview(inspectorObject.payload) }}</pre>
              </section>

              <section class="session-inspector-section">
                <span class="session-section-label">Source Refs</span>
                <div v-if="inspectorObject.source_refs.length" class="inspector-chip-list">
                  <span v-for="ref in inspectorObject.source_refs" :key="sourceRefLabel(ref)">{{ sourceRefLabel(ref) }}</span>
                </div>
                <p v-else class="dashboard-muted">No source refs</p>
              </section>

              <section class="session-inspector-section">
                <span class="session-section-label">Trace Refs</span>
                <div v-if="inspectorObject.trace_refs.length" class="inspector-chip-list">
                  <button v-for="ref in inspectorObject.trace_refs" :key="traceRefLabel(ref)" type="button" @click="openTraceViewer">{{ traceRefLabel(ref) }}</button>
                </div>
                <p v-else class="dashboard-muted">No trace refs</p>
              </section>

              <section class="session-inspector-section">
                <span class="session-section-label">Related</span>
                <div v-if="inspectorObject.related.length" class="inspector-chip-list">
                  <span v-for="item in inspectorObject.related" :key="item">{{ item }}</span>
                </div>
                <p v-else class="dashboard-muted">No related objects</p>
              </section>

              <section class="session-inspector-section">
                <span class="session-section-label">Events</span>
                <div v-if="inspectorEvents.length" class="inspector-event-list">
                  <button v-for="event in inspectorEvents" :key="event.id" type="button" @click="openTraceViewer">
                    <strong>{{ event.type }}</strong>
                    <span>{{ messageTime(event.at) }} · {{ event.id }}</span>
                  </button>
                </div>
                <p v-else class="dashboard-muted">No matching event history</p>
              </section>
            </template>
          </aside>
        </div>
      </div>

      <div v-else-if="activeView === 'review'" class="review-queue-view">
        <div class="work-dashboard-toolbar">
          <label class="dashboard-search">
            <Search :size="15" aria-hidden="true" />
            <input v-model="reviewSearch" type="search" placeholder="Search queue, sessions, producers" />
          </label>
          <div class="phase-filter" aria-label="Review kind filter">
            <button
              v-for="item in reviewKindFilters"
              :key="item.kind"
              class="phase-filter-item"
              :class="{ active: reviewKindFilter === item.kind }"
              type="button"
              @click="reviewKindFilter = item.kind"
            >
              <span>{{ item.label }}</span>
              <span>{{ item.count }}</span>
            </button>
          </div>
        </div>

        <div v-if="sessionsError" class="dashboard-error">
          <ShieldAlert :size="16" aria-hidden="true" />
          <span>{{ sessionsError }}</span>
          <button class="subtle-button" type="button" @click="loadDashboard">Retry</button>
        </div>

        <div v-if="dashboardIsStale" class="dashboard-stale">
          <ShieldAlert :size="16" aria-hidden="true" />
          <span>Review queue may be stale because dashboard updates have paused.</span>
          <button class="subtle-button" type="button" @click="loadDashboard">Refresh</button>
        </div>

        <div v-if="sessionsLoading && !reviewQueue.length" class="session-skeleton-list">
          <div v-for="index in 3" :key="index" class="session-skeleton-row"></div>
        </div>

        <div v-else-if="!reviewQueue.length" class="dashboard-empty">
          <div class="dashboard-empty-title">Nothing waiting on you</div>
          <div class="dashboard-empty-text">Artifact reviews, approvals, questions, and validations appear here when real session events require human action.</div>
        </div>

        <div v-else-if="!visibleReviewQueue.length" class="dashboard-empty compact-empty">
          <div class="dashboard-empty-title">No matching review items</div>
          <div class="dashboard-empty-text">Adjust the search or queue filter.</div>
        </div>

        <section v-else class="review-queue-list" aria-label="Review queue">
          <article v-for="item in visibleReviewQueue" :key="item.id" class="review-queue-item" :data-kind="item.kind">
            <button class="review-queue-main" type="button" @click="openReviewItem(item)">
              <span class="work-phase">{{ reviewKindLabel(item.kind) }}</span>
              <strong>{{ item.title }}</strong>
              <span>{{ reviewItemMeta(item) }}</span>
              <small>{{ sessionForReview(item)?.title || item.session_id }}</small>
              <p>{{ item.consequence }}</p>
            </button>

            <div class="review-queue-actions">
              <input v-if="item.kind !== 'question'" v-model="actionNotes[item.id]" type="text" placeholder="Note" :aria-label="'Note for ' + item.required_action" />
              <input v-if="item.kind === 'question'" v-model="actionAnswers[item.id]" type="text" placeholder="Answer" :aria-label="'Answer for ' + item.title" />

              <template v-if="item.kind === 'artifact'">
                <button type="button" :disabled="actionPending(item.id + ':accepted')" @click="reviewArtifact(item.session_id, reviewItemObjectId(item), 'accepted')">Accept</button>
                <button type="button" :disabled="actionPending(item.id + ':revision_requested')" @click="reviewArtifact(item.session_id, reviewItemObjectId(item), 'revision_requested')">Revise</button>
                <button type="button" :disabled="actionPending(item.id + ':rejected')" @click="reviewArtifact(item.session_id, reviewItemObjectId(item), 'rejected')">Reject</button>
              </template>
              <template v-else-if="item.kind === 'approval'">
                <button type="button" :disabled="actionPending(item.id + ':approved')" @click="resolveSessionApproval(item.session_id, reviewItemObjectId(item), true)">Approve</button>
                <button type="button" :disabled="actionPending(item.id + ':rejected')" @click="resolveSessionApproval(item.session_id, reviewItemObjectId(item), false)">Reject</button>
              </template>
              <template v-else-if="item.kind === 'validation'">
                <button type="button" :disabled="actionPending(item.id + ':passed')" @click="recordValidation(item.session_id, reviewItemObjectId(item), 'passed')">Pass</button>
                <button type="button" :disabled="actionPending(item.id + ':failed')" @click="recordValidation(item.session_id, reviewItemObjectId(item), 'failed')">Fail</button>
              </template>
              <template v-else-if="item.kind === 'question'">
                <button type="button" :disabled="actionPending(item.id + ':answer')" @click="answerQuestion(item.session_id, reviewItemObjectId(item))">Answer</button>
              </template>
              <button class="icon-button" type="button" title="Open detail" @click="openReviewItem(item)">
                <ChevronRight :size="15" aria-hidden="true" />
              </button>
            </div>
          </article>
        </section>
      </div>

      <div v-else-if="activeView === 'chat'" class="collab-layout">
        <section class="conversation-pane" aria-label="Conversation">
          <div ref="timeline" class="timeline" aria-live="polite">
            <div v-if="!rows.length" class="timeline-empty">
              <div class="empty-title">No messages in this room yet</div>
              <div class="empty-copy">Start with a mention, then agent replies, tool calls, and approvals will stay in the same timeline.</div>
            </div>

            <template v-for="row in rows" :key="row.id">
              <article
                v-if="row.rowType === 'message' && isFinalReportMessage(row.message)"
                class="session-report-row"
                :class="{ 'thread-reply': row.threadReply }"
                :data-rendered-id="row.message.id"
              >
                <div class="session-report-header">
                  <span class="session-report-icon"><Check :size="15" aria-hidden="true" /></span>
                  <span class="actor-meta">
                    <span class="sender">{{ finalReportTitle(row.message) }}</span>
                    <span class="meta">{{ finalReportMeta(row.message) }}</span>
                  </span>
                </div>
                <div class="message-body session-report-body">
                  <ArtifactMarkdown :source="row.message.text" compact />
                  <div v-if="canOpenArtifactProjection(row.message)" class="message-actions session-report-actions">
                    <button class="subtle-button" type="button" @click="openArtifactProjection(row.message)">
                      <FileText :size="14" aria-hidden="true" />
                      <span>Open artifact</span>
                    </button>
                  </div>
                </div>
              </article>

              <article
                v-else-if="row.rowType === 'message' && isArtifactProjectionMessage(row.message)"
                class="artifact-projection-row"
                :class="{ 'thread-reply': row.threadReply }"
                :data-rendered-id="row.message.id"
              >
                <div class="artifact-projection-header">
                  <span class="artifact-projection-icon"><FileText :size="15" aria-hidden="true" /></span>
                  <span class="actor-meta">
                    <span class="sender">{{ artifactProjectionTitle(row.message) }}</span>
                    <span class="meta">{{ artifactProjectionMeta(row.message) }}</span>
                  </span>
                </div>
                <div class="message-body artifact-projection-body">
                  <div class="text">{{ row.message.text }}</div>
                  <div v-if="canOpenArtifactProjection(row.message)" class="message-actions">
                    <button class="subtle-button" type="button" @click="openArtifactProjection(row.message)">
                      <ChevronRight :size="14" aria-hidden="true" />
                      <span>Open artifact</span>
                    </button>
                  </div>
                </div>
              </article>

              <article
                v-else-if="row.rowType === 'message'"
                class="message-row message"
                :class="{ 'thread-reply': row.threadReply }"
                :data-kind="row.message.kind"
                :data-rendered-id="row.message.id"
              >
                <div class="actor-cell">
                  <span class="actor-avatar" :data-kind="row.message.kind">{{ messageActorLabel(row.message).slice(0, 1).toUpperCase() }}</span>
                  <span class="actor-meta">
                    <span class="sender">{{ messageActorLabel(row.message) }}</span>
                    <span class="meta">{{ messageRoleLabel(row.message) }} · {{ messageTime(row.message.created_at) }}</span>
                  </span>
                </div>
                <div class="message-body">
                  <div class="text">{{ row.message.text }}</div>
                  <div class="message-actions">
                    <button
                      v-if="canCancel(row)"
                      class="subtle-button"
                      type="button"
                      :data-run-cancel-for="row.message.id"
                      :disabled="cancelDisabled(row)"
                      @click="cancelRun(row.message.id, row)"
                    >
                      <X v-if="row.runState === 'active'" :size="14" aria-hidden="true" />
                      <Check v-else :size="14" aria-hidden="true" />
                      <span>{{ cancelLabel(row) }}</span>
                    </button>
                    <button class="subtle-button" type="button" @click="setActiveThread(row.message)">
                      <CornerDownRight :size="14" aria-hidden="true" />
                      <span>Reply</span>
                    </button>
                  </div>
                </div>
              </article>

              <article
                v-else-if="row.rowType === 'simple'"
                :class="['system-row', row.className, { 'thread-reply': row.threadReply }]"
                :data-rendered-id="row.renderedId"
              >
                <div class="actor-cell compact">
                  <span class="activity-dot" :data-state="row.className"></span>
                  <span class="meta">{{ endpointLabel(row.meta) }}</span>
                </div>
                <div class="message-body">
                  <div class="text">{{ row.text }}</div>
                </div>
              </article>

              <article
                v-else-if="row.rowType === 'agent-status'"
                class="agent-status-row"
                :class="['activity-row', { 'thread-reply': row.threadReply }]"
                :data-state="agentStatusVisualState(row)"
              >
                <div class="actor-cell compact">
                  <span class="actor-avatar agent-avatar"><Bot :size="15" aria-hidden="true" /></span>
                  <span class="actor-meta">
                    <span class="sender">{{ endpointLabel(row.source) }}</span>
                    <span class="meta">agent status</span>
                  </span>
                </div>
                <div class="agent-status-block">
                  <div class="agent-status-text">
                    <span class="tool-state" :data-state="agentStatusVisualState(row)">{{ agentStatusLabel(row) }}</span>
                    <span>{{ row.text }}</span>
                  </div>
                  <div class="agent-run-meta">
                    <span v-for="chip in agentStatusMetaChips(row)" :key="chip" :title="chip.startsWith('run ') ? row.runId : undefined">{{ chip }}</span>
                  </div>

                  <details
                    v-for="currentTool in currentStatusToolList(row)"
                    :key="currentTool.id"
                    class="agent-current-tool"
                    :open="currentTool.open"
                    :data-state="currentTool.state"
                    @toggle="syncToolOpen(currentTool, $event)"
                  >
                    <summary class="agent-current-tool-summary">
                      <ChevronRight class="details-chevron" :size="15" aria-hidden="true" />
                      <span class="endpoint-kind-icon" :data-kind="toolInlineEndpointKind(currentTool)" :title="toolInlineEndpoint(currentTool)">
                        <Bot v-if="toolInlineEndpointKind(currentTool) === 'agent'" :size="15" aria-hidden="true" />
                        <MessageSquare v-else-if="toolInlineEndpointKind(currentTool) === 'app'" :size="15" aria-hidden="true" />
                        <TerminalSquare v-else :size="15" aria-hidden="true" />
                      </span>
                      <span class="tool-inline-summary">
                        <span class="tool-endpoint" :title="toolInlineEndpoint(currentTool)">{{ toolInlineEndpointLabel(currentTool) }}</span>
                        <span class="tool-action">{{ toolInlineAction(currentTool) }}</span>
                        <span v-if="toolInlinePayload(currentTool)" class="tool-payload">{{ toolInlinePayload(currentTool) }}</span>
                      </span>
                    </summary>

                    <div class="agent-tool-detail-body">
                      <div class="tool-call-detail">
                        <span>endpoint</span>
                        <code>{{ toolInlineEndpoint(currentTool) }}</code>
                        <span>action</span>
                        <code>{{ toolInlineAction(currentTool) }}</code>
                        <span v-if="toolInlinePayload(currentTool)">payload</span>
                        <pre v-if="toolInlinePayload(currentTool)" class="tool-pre inline-payload">{{ toolInlinePayload(currentTool) }}</pre>
                        <span>arguments</span>
                        <pre class="tool-pre inline-payload">{{ currentTool.argumentsText }}</pre>
                        <span v-if="currentTool.resultText !== undefined">result</span>
                        <pre v-if="currentTool.resultText !== undefined" class="tool-pre inline-payload">{{ currentTool.resultText }}</pre>
                      </div>

                      <div v-if="currentTool.approval" class="tool-section tool-approval" :data-approval-id="currentTool.approval.id">
                        <div class="approval-header">
                          <span class="approval-status" :data-state="approvalState(currentTool)">{{ approvalLabel(currentTool) }}</span>
                          <span class="grant-summary">{{ grantSummary(currentTool.approvalResult) }}</span>
                        </div>
                        <div class="approval-card">
                          <div class="approval-summary-line">{{ approvalRiskLabel(currentTool.approval) }}: {{ currentTool.approval.request.summary }}</div>
                          <div class="approval-target-line">{{ approvalPayloadSummary(currentTool.approval) }}</div>
                          <div class="approval-chip-row">
                            <span v-for="chip in approvalDetailChips(currentTool.approval)" :key="chip" class="approval-chip">{{ chip }}</span>
                          </div>
                        </div>
                        <template v-if="diffPreview(currentTool.approval)">
                          <div class="tool-section-label">Diff Preview</div>
                          <pre class="tool-pre">{{ diffPreview(currentTool.approval) }}</pre>
                        </template>
                        <details class="raw-details">
                          <summary>Raw payload</summary>
                          <pre class="tool-pre">{{ approvalRawPayload(currentTool.approval) }}</pre>
                        </details>
                        <div class="approval-actions">
                          <button
                            type="button"
                            data-decision="approve"
                            :disabled="Boolean(currentTool.approvalResult)"
                            @click="decideApproval(currentTool.approval.id, true)"
                          >
                            <Check :size="14" aria-hidden="true" />
                            <span>Approve</span>
                          </button>
                          <button
                            type="button"
                            data-decision="deny"
                            :disabled="Boolean(currentTool.approvalResult)"
                            @click="decideApproval(currentTool.approval.id, false)"
                          >
                            <X :size="14" aria-hidden="true" />
                            <span>Deny</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </details>

                  <details v-if="previousStatusTools(row).length" class="previous-tool-calls agent-tool-history">
                    <summary>
                      <span>Tool history</span>
                      <span>{{ previousStatusTools(row).length }}</span>
                    </summary>
                    <div class="previous-tool-list">
                      <details
                        v-for="previous in previousStatusTools(row)"
                        :key="previous.id"
                        class="previous-tool-call"
                      >
                        <summary>
                          <span class="tool-state" :data-state="previous.state">{{ previous.state }}</span>
                          <span class="tool-inline-summary">
                            <span class="endpoint-kind-icon compact" :data-kind="toolInlineEndpointKind(previous)" :title="toolInlineEndpoint(previous)">
                              <Bot v-if="toolInlineEndpointKind(previous) === 'agent'" :size="13" aria-hidden="true" />
                              <MessageSquare v-else-if="toolInlineEndpointKind(previous) === 'app'" :size="13" aria-hidden="true" />
                              <TerminalSquare v-else :size="13" aria-hidden="true" />
                            </span>
                            <span class="tool-endpoint" :title="toolInlineEndpoint(previous)">{{ toolInlineEndpointLabel(previous) }}</span>
                            <span class="tool-action">{{ toolInlineAction(previous) }}</span>
                            <span v-if="toolInlinePayload(previous)" class="tool-payload">{{ toolInlinePayload(previous) }}</span>
                          </span>
                        </summary>
                        <div class="tool-call-detail previous-tool-detail">
                          <span>endpoint</span>
                          <code>{{ toolInlineEndpoint(previous) }}</code>
                          <span>action</span>
                          <code>{{ toolInlineAction(previous) }}</code>
                          <span v-if="toolInlinePayload(previous)">payload</span>
                          <pre v-if="toolInlinePayload(previous)" class="tool-pre inline-payload">{{ toolInlinePayload(previous) }}</pre>
                          <span>arguments</span>
                          <pre class="tool-pre inline-payload">{{ previous.argumentsText }}</pre>
                          <span v-if="previous.resultText !== undefined">result</span>
                          <pre v-if="previous.resultText !== undefined" class="tool-pre inline-payload">{{ previous.resultText }}</pre>
                        </div>
                      </details>
                    </div>
                  </details>
                </div>
              </article>

              <article v-else-if="row.rowType === 'approval'" class="approval approval-row" :data-approval-id="row.approval.id">
                <div class="actor-cell compact">
                  <span class="actor-avatar approval-avatar"><ShieldAlert :size="15" aria-hidden="true" /></span>
                  <span class="actor-meta">
                    <span class="sender">Approval</span>
                    <span class="meta">{{ row.approval.request.risk }}</span>
                  </span>
                </div>
                <div class="message-body">
                  <div class="approval-card">
                    <div class="approval-summary-line">{{ approvalRiskLabel(row.approval) }}: {{ row.approval.request.summary }}</div>
                    <div class="approval-target-line">{{ approvalPayloadSummary(row.approval) }}</div>
                    <div class="approval-chip-row">
                      <span v-for="chip in approvalDetailChips(row.approval)" :key="chip" class="approval-chip">{{ chip }}</span>
                    </div>
                  </div>
                  <div class="approval-actions">
                    <button type="button" data-decision="approve" @click="decideApproval(row.approval.id, true)">
                      <Check :size="14" aria-hidden="true" />
                      <span>Approve</span>
                    </button>
                    <button type="button" data-decision="deny" @click="decideApproval(row.approval.id, false)">
                      <X :size="14" aria-hidden="true" />
                      <span>Deny</span>
                    </button>
                  </div>
                  <details class="raw-details compact">
                    <summary>Raw payload</summary>
                    <pre class="tool-pre">{{ approvalRawPayload(row.approval) }}</pre>
                  </details>
                </div>
              </article>
            </template>
          </div>

          <form class="composer" @submit.prevent="submitMessage">
            <div v-if="activeThreadId" class="thread-context">
              <CornerDownRight :size="15" aria-hidden="true" />
              <span class="thread-label">{{ activeThreadLabel }}</span>
              <button class="icon-button" type="button" aria-label="Clear thread" @click="clearActiveThread()">
                <X :size="15" aria-hidden="true" />
              </button>
            </div>
            <textarea ref="messageInput" v-model="messageText" rows="2" autocomplete="off" placeholder="Message an agent or the room" />
            <button class="send-button" type="submit">
              <Send :size="16" aria-hidden="true" />
              <span>Send</span>
            </button>
          </form>
        </section>

        <aside class="operations-pane" aria-label="Agent operations">
          <div class="operations-header">
            <div>
              <p class="panel-kicker">Live work</p>
              <h2>Operations</h2>
            </div>
            <span class="operation-count">{{ latestOperations.length }}</span>
          </div>

          <div class="operations-stats">
            <div>
              <span class="stat-value">{{ activeOperationCount }}</span>
              <span class="stat-label">active</span>
            </div>
            <div>
              <span class="stat-value">{{ pendingApprovalCount }}</span>
              <span class="stat-label">pending</span>
            </div>
            <div>
              <span class="stat-value">{{ knownAgents.length }}</span>
              <span class="stat-label">agents</span>
            </div>
          </div>

          <div v-if="currentOperation" class="operations-order">
            <span>Current</span>
            <span>Received</span>
          </div>

          <div v-if="currentOperation" class="operation-list current-operation" aria-label="Current operation">
            <article class="operation-item" :data-state="operationState(currentOperation)">
              <span class="operation-time">
                <span class="operation-sequence">{{ operationSequence(currentOperation) }}</span>
                <span class="operation-clock">{{ operationTime(currentOperation) }}</span>
              </span>
              <span class="operation-icon" :data-kind="operationIcon(currentOperation)">
                <Activity v-if="operationIcon(currentOperation) === 'status'" :size="15" aria-hidden="true" />
                <ShieldAlert v-else-if="operationIcon(currentOperation) === 'approval'" :size="15" aria-hidden="true" />
                <TerminalSquare v-else-if="operationIcon(currentOperation) === 'terminal'" :size="15" aria-hidden="true" />
                <Bot v-else :size="15" aria-hidden="true" />
              </span>
              <span class="operation-copy">
                <span class="operation-title">{{ operationTitle(currentOperation) }}</span>
                <span class="operation-detail">{{ operationDetail(currentOperation) }}</span>
              </span>
              <span class="operation-state">{{ operationState(currentOperation) }}</span>
            </article>
          </div>

          <details v-if="previousOperations.length" class="operation-archive">
            <summary>
              <span>Previous operations</span>
              <span>{{ previousOperations.length }}</span>
            </summary>
            <div class="operation-list archived-operations" aria-label="Previous operations">
              <article
                v-for="row in previousOperations"
                :key="row.id"
                class="operation-item"
                :data-state="operationState(row)"
              >
                <span class="operation-time">
                  <span class="operation-sequence">{{ operationSequence(row) }}</span>
                  <span class="operation-clock">{{ operationTime(row) }}</span>
                </span>
                <span class="operation-icon" :data-kind="operationIcon(row)">
                  <Activity v-if="operationIcon(row) === 'status'" :size="15" aria-hidden="true" />
                  <ShieldAlert v-else-if="operationIcon(row) === 'approval'" :size="15" aria-hidden="true" />
                  <TerminalSquare v-else-if="operationIcon(row) === 'terminal'" :size="15" aria-hidden="true" />
                  <Bot v-else :size="15" aria-hidden="true" />
                </span>
                <span class="operation-copy">
                  <span class="operation-title">{{ operationTitle(row) }}</span>
                  <span class="operation-detail">{{ operationDetail(row) }}</span>
                </span>
                <span class="operation-state">{{ operationState(row) }}</span>
              </article>
            </div>
          </details>
          <div v-if="!currentOperation" class="operations-empty">
            <Activity :size="16" aria-hidden="true" />
            <span>No agent activity yet.</span>
          </div>

          <button class="trace-link" type="button" @click="openTraceViewer">
            <Activity :size="15" aria-hidden="true" />
            <span>Open trace</span>
          </button>
        </aside>
      </div>

      <div v-else-if="activeView === 'agent'" class="agent-dashboard">
        <section class="agent-workload-panel" aria-label="Agent workload">
          <div class="dashboard-list-header agent-workload-header">
            <span>Session</span>
            <span>Phase</span>
            <span>Delegation</span>
          </div>
          <div v-if="activeAgentWorkSessions.length" class="agent-workload-list">
            <button
              v-for="item in activeAgentWorkSessions"
              :key="item.session.session_id"
              class="agent-workload-item"
              type="button"
              @click="openSessionThread(item.session)"
            >
              <span class="agent-workload-title">{{ item.session.title }}</span>
              <span class="work-phase" :data-phase="sessionPhaseClass(item.session)">{{ item.session.phase_label }}</span>
              <span class="dashboard-muted">{{ item.assignments[0]?.current_work || delegationStatusLabel(item.assignments[0]?.status || '') }}</span>
            </button>
          </div>
          <div v-else class="dashboard-empty compact-empty">
            <div class="dashboard-empty-text">No session delegation is assigned to this agent yet.</div>
          </div>
        </section>

        <div class="dashboard-summary">
          <div class="metric">
            <div class="metric-label">activities</div>
            <div class="metric-value">{{ activeAgentRows.length }}</div>
          </div>
          <div class="metric">
            <div class="metric-label">tool calls</div>
            <div class="metric-value">{{ activeAgentToolCount }}</div>
          </div>
          <div class="metric">
            <div class="metric-label">approvals</div>
            <div class="metric-value">{{ activeAgentApprovalCount }}</div>
          </div>
        </div>

        <div class="dashboard-list">
          <div class="dashboard-list-header">
            <span>Status</span>
            <span>Operation</span>
            <span>Target</span>
            <span>Thread</span>
            <span>Channel</span>
          </div>
          <template v-for="row in activeAgentRows" :key="row.id">
            <article v-if="row.rowType === 'agent-status'" class="dashboard-status">
              <span class="tool-state" :data-state="agentStatusVisualState(row)">{{ agentStatusLabel(row) }}</span>
              <span class="dashboard-primary">{{ row.text }}</span>
              <span class="dashboard-secondary">{{ agentRunDuration(row) || 'runtime' }}</span>
              <span class="dashboard-mono">{{ row.threadId }}</span>
              <span class="dashboard-muted">{{ fallbackDash(row.channel) }}</span>
            </article>

            <article v-else class="dashboard-tool" :data-state="row.state">
              <details class="dashboard-details" :open="row.open" @toggle="syncToolOpen(row, $event)">
                <summary class="dashboard-row-summary">
                  <span class="tool-state" :data-state="row.state">{{ row.state }}</span>
                  <span class="dashboard-primary">
                    <span class="tool-name">{{ toolOperation(row) }}</span>
                    <span class="tool-preview">{{ row.preview }}</span>
                  </span>
                  <span class="dashboard-secondary">{{ toolTarget(row) }}</span>
                  <span class="dashboard-mono">{{ row.threadId }}</span>
                  <span class="dashboard-muted">{{ fallbackDash(row.channel) }}</span>
                </summary>

                <div class="dashboard-detail-body">
                  <div class="dashboard-meta">
                    <span>{{ row.toolCallId }}</span>
                    <span>{{ row.threadId }}</span>
                    <span v-if="row.channel">{{ row.channel }}</span>
                  </div>

                  <details class="raw-details tool-section">
                    <summary>Arguments</summary>
                    <pre class="tool-pre">{{ row.argumentsText }}</pre>
                  </details>

                  <div v-if="row.approval" class="tool-section tool-approval" :data-approval-id="row.approval.id">
                    <div class="approval-header">
                      <span class="approval-status" :data-state="approvalState(row)">{{ approvalLabel(row) }}</span>
                      <span class="grant-summary">{{ grantSummary(row.approvalResult) }}</span>
                    </div>
                    <div class="approval-card">
                      <div class="approval-summary-line">{{ approvalRiskLabel(row.approval) }}: {{ row.approval.request.summary }}</div>
                      <div class="approval-target-line">{{ approvalPayloadSummary(row.approval) }}</div>
                      <div class="approval-chip-row">
                        <span v-for="chip in approvalDetailChips(row.approval)" :key="chip" class="approval-chip">{{ chip }}</span>
                      </div>
                    </div>
                    <template v-if="diffPreview(row.approval)">
                      <div class="tool-section-label">Diff Preview</div>
                      <pre class="tool-pre">{{ diffPreview(row.approval) }}</pre>
                    </template>
                    <details class="raw-details">
                      <summary>Raw payload</summary>
                      <pre class="tool-pre">{{ approvalRawPayload(row.approval) }}</pre>
                    </details>
                    <div v-if="!row.approvalResult" class="approval-actions">
                      <button type="button" data-decision="approve" @click="decideApproval(row.approval.id, true)">
                        <Check :size="14" aria-hidden="true" />
                        <span>Approve</span>
                      </button>
                      <button type="button" data-decision="deny" @click="decideApproval(row.approval.id, false)">
                        <X :size="14" aria-hidden="true" />
                        <span>Deny</span>
                      </button>
                    </div>
                  </div>

                  <div v-if="row.resultText !== undefined" class="tool-section tool-result-section">
                    <div class="tool-section-label">Result</div>
                    <div class="tool-result-summary">{{ row.resultSummary }}</div>
                    <details v-if="row.resultText !== row.resultSummary" class="raw-details">
                      <summary>Result detail</summary>
                      <pre class="tool-pre tool-result">{{ row.resultText }}</pre>
                    </details>
                  </div>
                </div>
              </details>
            </article>
          </template>
          <div v-if="!activeAgentRows.length" class="dashboard-empty">
            <div class="dashboard-empty-title">No activity yet</div>
            <div class="dashboard-empty-text">Agent status and tool calls will appear here during a run.</div>
          </div>
        </div>
      </div>

      <div v-else-if="activeView === 'trace'" class="trace-view">
        <div class="trace-controls">
          <label class="trace-filter">
            <span><Search :size="13" aria-hidden="true" /> Search</span>
            <input v-model="traceQuery" class="trace-input" type="search" autocomplete="off" @keydown.enter.prevent="refreshTrace" />
          </label>
          <label class="trace-filter trace-limit">
            <span>Limit</span>
            <input v-model.number="traceLimit" class="trace-input" type="number" min="1" max="1000" step="25" @keydown.enter.prevent="refreshTrace" />
          </label>
          <button class="ghost icon-label" type="button" :disabled="traceState.loading" @click="refreshTrace">
            <RefreshCw :size="15" aria-hidden="true" />
            <span>Apply</span>
          </button>
        </div>

        <div v-if="traceState.tracePath" class="trace-path">{{ traceState.tracePath }}</div>

        <div class="trace-glance" aria-label="Trace summary">
          <span class="trace-glance-chip" :data-tone="traceIssueCount ? 'issue' : 'ok'">
            <span>{{ traceIssueCount }}</span>
            <span>issues</span>
          </span>
          <span class="trace-glance-chip">
            <span>{{ traceMetric(traceState.stats.total_events) }}</span>
            <span>events</span>
          </span>
          <span class="trace-glance-chip">
            <span>{{ traceMetric(traceState.stats.approvals) }}</span>
            <span>approvals</span>
          </span>
          <span class="trace-glance-chip">
            <span>{{ traceRouteCount('dropped') + traceRouteCount('rejected') }}</span>
            <span>blocked</span>
          </span>
          <span class="trace-glance-note">{{ traceMetric(traceState.stats.group_count) }} relation groups</span>
        </div>

        <div v-if="traceState.error" class="trace-empty trace-error">{{ traceState.error }}</div>
        <div v-else-if="!traceState.available" class="trace-empty">Trace is not configured for this bridge.</div>
        <div v-else-if="!traceState.events.length" class="trace-empty">No trace events yet.</div>
        <div v-else class="trace-event-stream" aria-label="Trace event stream">
          <article
            v-for="event in traceState.events"
            :key="event.id"
            class="trace-event"
            :data-route="traceRoute(event)"
            :data-direction="traceDirection(event)"
            :data-tone="traceTone(event)"
            :style="traceDepthStyle(event)"
          >
            <div class="trace-event-rail" aria-hidden="true">
              <span class="trace-lane"><span class="trace-node"></span></span>
            </div>
            <div class="trace-event-body">
              <div class="trace-event-main">
                <span class="trace-time">{{ formatTraceTime(event.timestamp) }}</span>
                <span class="trace-route-badge" :data-route="traceRoute(event)">{{ traceRoute(event) }}</span>
                <span class="trace-direction">{{ traceDirection(event) }}</span>
                <span class="trace-primary">{{ tracePrimaryLine(event) }}</span>
              </div>
              <div class="trace-event-detail">
                <span class="trace-detail-title">{{ event.label }}</span>
                <span v-if="event.detail" class="trace-detail-text">{{ event.detail }}</span>
              </div>
              <div class="trace-event-meta">
                <button class="trace-relation-chip compact" type="button" @click="traceQuery = traceGroupLabel(event); refreshTrace()">
                  group {{ traceGroupLabel(event) }}
                </button>
                <span v-if="traceParent(event)" class="trace-chip">parent {{ traceParent(event) }}</span>
                <button
                  v-for="relation in traceRelations(event)"
                  :key="relation.kind + ':' + relation.value"
                  class="trace-relation-chip compact"
                  type="button"
                  @click="filterTraceRelation(relation)"
                >
                  {{ relation.label }}
                </button>
                <span v-for="chip in traceChips(event)" :key="chip" class="trace-chip">{{ chip }}</span>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  </main>
</template>
