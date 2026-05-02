export interface TraceViewFilters {
  q?: string;
  correlation_id?: string;
  message_id?: string;
  thread_id?: string;
  channel?: string;
  source?: string;
  target?: string;
  payload_kind?: string;
  route_result?: string;
  approval_id?: string;
}

export interface TraceViewerEvent extends Record<string, unknown> {
  id: string;
  index: number;
  label: string;
  detail: string;
  group_key: string;
  direction: TraceViewerDirection;
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
  reply_to?: string | null;
  op_code?: string;
  action?: string | null;
  mime_type?: string;
  route_result?: string;
  error_reason?: string | null;
  payload_kind?: string;
  payload_hash?: string;
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

export type TraceViewerDirection = "request" | "response" | "stream" | "lifecycle" | "event";
export type TraceViewerRelationKind = "thread" | "message" | "correlation" | "approval" | "tool" | "grant" | "channel" | "reply";

export interface TraceViewerRelation {
  kind: TraceViewerRelationKind;
  value: string;
  label: string;
}

export type TraceViewerGroupKind = "thread" | "correlation" | "approval" | "endpoint" | "event";

export interface TraceViewerGroupSummary {
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

export interface TraceViewerGroup {
  id: string;
  kind: TraceViewerGroupKind;
  title: string;
  events: TraceViewerEvent[];
  summary: TraceViewerGroupSummary;
}

export interface TraceViewerStats {
  total_events: number;
  group_count: number;
  approvals: number;
  rejected_approvals: number;
  shell_calls: number;
  route_results: Record<string, number>;
}

export interface TraceView {
  events: TraceViewerEvent[];
  groups: TraceViewerGroup[];
  stats: TraceViewerStats;
}

export interface BuildTraceViewOptions {
  limit?: number;
  filters?: TraceViewFilters;
}

const FILTER_KEYS: Array<keyof Omit<TraceViewFilters, "q">> = [
  "correlation_id",
  "message_id",
  "thread_id",
  "channel",
  "source",
  "target",
  "payload_kind",
  "route_result",
  "approval_id",
];

export function parseTraceJsonl(text: string): TraceViewerEvent[] {
  const events: TraceViewerEvent[] = [];
  const lines = text.split(/\r?\n/);

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber].trim();
    if (!line) continue;

    try {
      events.push(sanitizeTraceEvent(JSON.parse(line), events.length));
    } catch (error) {
      events.push(sanitizeTraceEvent({
        event: "parse_error",
        line_number: lineNumber + 1,
        error_reason: error instanceof Error ? error.message : "invalid trace line",
      }, events.length));
    }
  }

  return events;
}

export function buildTraceView(events: TraceViewerEvent[] | Array<Record<string, unknown>>, options: BuildTraceViewOptions = {}): TraceView {
  const safeEvents = annotateTraceEvents(events.map((event, index) => sanitizeTraceEvent(event, index)));
  const filtered = filterTraceEvents(safeEvents, options.filters ?? {});
  const limited = annotateTraceEvents(limitTraceEvents(filtered, options.limit));
  const groups = groupTraceEvents(limited);

  return {
    events: limited,
    groups,
    stats: summarizeTraceView(limited, groups.length),
  };
}

export function sanitizeTraceEvent(input: unknown, index: number): TraceViewerEvent {
  const source = isRecord(input) ? input : { event: "invalid_trace_event" };
  const event: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === "payload") continue;
    event[key] = value;
  }

  event.index = index;
  event.id = traceEventId(event, index);
  event.group_key = traceGroupKey(event, index);
  event.label = traceEventLabel(event);
  event.detail = traceEventDetail(event);
  event.direction = traceDirection(event);
  event.endpoint_flow = traceEndpointFlow(event);
  event.relations = traceRelations(event);
  event.relation_summary = traceRelationSummary(event.relations as TraceViewerRelation[]);
  event.causal_depth = 0;
  return event as TraceViewerEvent;
}

function annotateTraceEvents(events: TraceViewerEvent[]): TraceViewerEvent[] {
  const firstByMsgId = new Map<string, TraceViewerEvent>();
  const firstByCorrelationId = new Map<string, TraceViewerEvent>();

  for (const event of events) {
    if (typeof event.msg_id === "string" && !firstByMsgId.has(event.msg_id)) {
      firstByMsgId.set(event.msg_id, event);
    }
    if (typeof event.correlation_id === "string" && !firstByCorrelationId.has(event.correlation_id)) {
      firstByCorrelationId.set(event.correlation_id, event);
    }
  }

  const depthById = new Map<string, number>();
  const parentById = new Map<string, string>();

  function depthFor(event: TraceViewerEvent, seen = new Set<string>()): number {
    const cached = depthById.get(event.id);
    if (cached !== undefined) return cached;
    if (seen.has(event.id)) return 0;
    seen.add(event.id);

    const parent = causalParent(event, firstByMsgId, firstByCorrelationId);
    const depth = parent ? Math.min(depthFor(parent, seen) + 1, 5) : 0;
    if (parent) parentById.set(event.id, parent.id);
    depthById.set(event.id, depth);
    return depth;
  }

  for (const event of events) {
    event.causal_depth = depthFor(event);
    event.causal_parent_id = parentById.get(event.id);
  }

  return events;
}

function causalParent(
  event: TraceViewerEvent,
  firstByMsgId: Map<string, TraceViewerEvent>,
  firstByCorrelationId: Map<string, TraceViewerEvent>,
): TraceViewerEvent | undefined {
  const correlationId = stringValue(event.correlation_id);
  if (!correlationId) return undefined;

  const msgParent = firstByMsgId.get(correlationId);
  if (msgParent && msgParent.id !== event.id && msgParent.index < event.index) {
    return msgParent;
  }

  const correlationParent = firstByCorrelationId.get(correlationId);
  if (correlationParent && correlationParent.id !== event.id && correlationParent.index < event.index) {
    return correlationParent;
  }

  return undefined;
}

function filterTraceEvents(events: TraceViewerEvent[], filters: TraceViewFilters): TraceViewerEvent[] {
  const query = filters.q?.trim().toLowerCase();

  return events.filter((event) => {
    for (const key of FILTER_KEYS) {
      const expected = filters[key]?.trim();
      if (expected && String(event[key] ?? "") !== expected) {
        return false;
      }
    }

    if (!query) {
      return true;
    }

    return searchableText(event).includes(query);
  });
}

function limitTraceEvents(events: TraceViewerEvent[], limit?: number): TraceViewerEvent[] {
  if (limit === undefined) return events;
  const normalized = Math.max(1, Math.floor(limit));
  return events.slice(Math.max(0, events.length - normalized));
}

function groupTraceEvents(events: TraceViewerEvent[]): TraceViewerGroup[] {
  const grouped = new Map<string, TraceViewerEvent[]>();
  for (const event of events) {
    const key = event.group_key;
    const entries = grouped.get(key) ?? [];
    entries.push(event);
    grouped.set(key, entries);
  }

  return [...grouped.entries()].map(([id, groupEvents]) => ({
    id,
    kind: traceGroupKind(id),
    title: traceGroupTitle(id),
    events: groupEvents,
    summary: summarizeTraceGroup(groupEvents),
  }));
}

function summarizeTraceView(events: TraceViewerEvent[], groupCount: number): TraceViewerStats {
  return {
    total_events: events.length,
    group_count: groupCount,
    approvals: events.filter(isApprovalEvent).length,
    rejected_approvals: events.filter((event) => event.approval_decision === false).length,
    shell_calls: events.filter(isShellEvent).length,
    route_results: countRouteResults(events),
  };
}

function summarizeTraceGroup(events: TraceViewerEvent[]): TraceViewerGroupSummary {
  const timestamps = events.map((event) => event.timestamp).filter((value): value is string => typeof value === "string");
  const endpoints = new Set<string>();
  for (const event of events) {
    if (typeof event.source === "string") endpoints.add(event.source);
    if (typeof event.target === "string") endpoints.add(event.target);
    if (typeof event.approval_target === "string") endpoints.add(event.approval_target);
  }

  return {
    event_count: events.length,
    first_timestamp: timestamps[0],
    last_timestamp: timestamps.at(-1),
    route_results: countRouteResults(events),
    approvals: events.filter(isApprovalEvent).length,
    rejected_approvals: events.filter((event) => event.approval_decision === false).length,
    endpoints: [...endpoints].sort(),
    relations: summarizeRelations(events),
    requests: events.filter((event) => event.direction === "request").length,
    responses: events.filter((event) => event.direction === "response").length,
    streams: events.filter((event) => event.direction === "stream").length,
    failures: events.filter((event) => event.route_result === "rejected" || event.route_result === "dropped" || event.event === "parse_error").length,
  };
}

function summarizeRelations(events: TraceViewerEvent[]): TraceViewerRelation[] {
  const ranked = new Map<string, { relation: TraceViewerRelation; count: number; first_index: number }>();

  for (const event of events) {
    for (const relation of event.relations) {
      const key = `${relation.kind}:${relation.value}`;
      const entry = ranked.get(key);
      if (entry) {
        entry.count++;
        continue;
      }
      ranked.set(key, { relation, count: 1, first_index: event.index });
    }
  }

  return [...ranked.values()]
    .sort((left, right) => right.count - left.count || left.first_index - right.first_index)
    .slice(0, 8)
    .map((entry) => entry.relation);
}

function countRouteResults(events: TraceViewerEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const route = typeof event.route_result === "string" ? event.route_result : undefined;
    if (!route) continue;
    counts[route] = (counts[route] ?? 0) + 1;
  }
  return counts;
}

function traceEventId(event: Record<string, unknown>, index: number): string {
  const msgId = stringValue(event.msg_id);
  if (msgId) return `message:${msgId}`;
  const eventType = stringValue(event.event) ?? "event";
  return `trace:${index}:${eventType}`;
}

function traceGroupKey(event: Record<string, unknown>, index: number): string {
  const threadId = stringValue(event.thread_id);
  if (threadId) return `thread:${threadId}`;

  const messageId = stringValue(event.message_id);
  if (messageId) return `thread:${messageId}`;

  const approvalId = stringValue(event.approval_id);
  if (approvalId) return `approval:${approvalId}`;

  const correlationId = stringValue(event.correlation_id);
  if (correlationId) return `correlation:${correlationId}`;

  const msgId = stringValue(event.msg_id);
  if (msgId) return `correlation:${msgId}`;

  const uri = stringValue(event.uri);
  if (uri) return `endpoint:${uri}`;

  const source = stringValue(event.source);
  const target = stringValue(event.target);
  if (source || target) return `endpoint:${source ?? "unknown"}->${target ?? "unknown"}`;

  return `event:${index}`;
}

function traceGroupKind(id: string): TraceViewerGroupKind {
  const prefix = id.split(":", 1)[0];
  if (prefix === "thread" || prefix === "correlation" || prefix === "approval" || prefix === "endpoint") {
    return prefix;
  }
  return "event";
}

function traceGroupTitle(id: string): string {
  const kind = traceGroupKind(id);
  const value = id.slice(kind.length + 1);
  return `${kind} ${value}`;
}

function traceEventLabel(event: Record<string, unknown>): string {
  const eventType = stringValue(event.event);
  if (eventType === "parse_error") return "parse error";
  if (eventType === "endpoint_registered") return "endpoint registered";
  if (eventType === "endpoint_unregistered") return "endpoint unregistered";

  const decision = booleanValue(event.approval_decision);
  if (decision !== undefined) return decision ? "approval approved" : "approval denied";

  const approvalAction = stringValue(event.approval_action);
  if (approvalAction) return `approval ${approvalAction}`;

  const payloadKind = stringValue(event.payload_kind);
  if (payloadKind === "slock_shell_exec") return "shell exec";
  if (payloadKind === "slock_shell_result") return "shell result";

  const channelEventType = stringValue(event.channel_event_type);
  if (channelEventType) return channelEventType.replace(/_/g, " ");

  const opCode = stringValue(event.op_code);
  const action = stringValue(event.action);
  if (opCode && action) return `${opCode} ${action}`;
  if (opCode) return opCode;
  if (payloadKind) return payloadKind.replace(/^slock_/, "").replace(/_/g, " ");
  return eventType?.replace(/_/g, " ") ?? "trace event";
}

function traceEventDetail(event: Record<string, unknown>): string {
  const parts: string[] = [];
  const source = stringValue(event.source);
  const target = stringValue(event.target);
  if (source || target) parts.push(`${source ?? "unknown"} -> ${target ?? "unknown"}`);

  const channel = stringValue(event.channel);
  if (channel) parts.push(channel);

  const approvalTarget = stringValue(event.approval_target);
  const approvalAction = stringValue(event.approval_action);
  if (approvalTarget || approvalAction) parts.push(`approval ${approvalTarget ?? "target"} ${approvalAction ?? ""}`.trim());

  const risk = stringValue(event.approval_risk);
  if (risk) parts.push(`risk ${risk}`);

  const shellCommand = stringValue(event.shell_command);
  if (shellCommand) parts.push(`shell ${shellCommand}`);

  const shellExitCode = numberValue(event.shell_exit_code);
  if (shellExitCode !== undefined) parts.push(`exit ${shellExitCode}`);

  const route = stringValue(event.route_result);
  const reason = stringValue(event.error_reason);
  if (route) parts.push(reason ? `${route}: ${reason}` : route);

  const payloadSize = numberValue(event.payload_size);
  if (payloadSize !== undefined) parts.push(`${payloadSize} bytes`);

  return parts.join(" | ");
}

function searchableText(event: TraceViewerEvent): string {
  return Object.entries(event)
    .filter(([key]) => key !== "payload")
    .map(([, value]) => stringifySearchValue(value))
    .join("\n")
    .toLowerCase();
}

function traceDirection(event: Record<string, unknown>): TraceViewerDirection {
  const eventType = stringValue(event.event);
  if (eventType === "endpoint_registered" || eventType === "endpoint_unregistered") return "lifecycle";

  switch (stringValue(event.op_code)) {
    case "CALL":
      return "request";
    case "RESOLVE":
    case "REJECT":
      return "response";
    case "EMIT":
    case "END":
    case "CANCEL":
      return "stream";
    default:
      return "event";
  }
}

function traceEndpointFlow(event: Record<string, unknown>): string {
  const source = stringValue(event.source);
  const target = stringValue(event.target);
  if (source || target) return `${source ?? "unknown"} -> ${target ?? "unknown"}`;
  return stringValue(event.uri) ?? "";
}

function traceRelations(event: Record<string, unknown>): TraceViewerRelation[] {
  const relations: TraceViewerRelation[] = [];
  const seen = new Set<string>();

  function add(kind: TraceViewerRelationKind, value: string | undefined | null): void {
    if (!value) return;
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    relations.push({ kind, value, label: `${kind}:${compactRelationValue(value)}` });
  }

  add("thread", stringValue(event.thread_id) ?? stringValue(event.message_id));
  add("message", stringValue(event.message_id));
  add("correlation", stringValue(event.correlation_id) ?? stringValue(event.msg_id));
  add("approval", stringValue(event.approval_id));
  add("tool", stringValue(event.tool_call_id));
  add("grant", stringValue(event.grant_id));
  add("channel", stringValue(event.channel));
  add("reply", stringValue(event.reply_to));

  return relations;
}

function traceRelationSummary(relations: TraceViewerRelation[]): string {
  if (relations.length === 0) return "";
  const visible = relations.slice(0, 4).map((relation) => relation.label).join(" | ");
  return relations.length > 4 ? `${visible} | +${relations.length - 4}` : visible;
}

function compactRelationValue(value: string): string {
  if (value.length <= 28) return value;
  return `${value.slice(0, 12)}...${value.slice(-10)}`;
}

function stringifySearchValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringifySearchValue).join(" ");
  return "";
}

function isApprovalEvent(event: TraceViewerEvent): boolean {
  return typeof event.approval_id === "string"
    || typeof event.approval_action === "string"
    || typeof event.approval_decision === "boolean"
    || String(event.payload_kind ?? "").includes("approval");
}

function isShellEvent(event: TraceViewerEvent): boolean {
  return typeof event.shell_command === "string"
    || event.payload_kind === "slock_shell_exec"
    || event.payload_kind === "slock_shell_result";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
