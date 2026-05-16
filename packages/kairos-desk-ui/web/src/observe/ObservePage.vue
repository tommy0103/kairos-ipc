<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { ObserveProjection, ProjectProjection, Surface, TraceEventProjection, TraceGroupProjection } from "@/api/types";

const props = defineProps<{
  observe: ObserveProjection;
  project: ProjectProjection;
  activeTargetId?: string;
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId?: string];
}>();

const TRACE_EVENT_LIMIT = 10;
const CARD_ROW_LIMIT = 3;

const projectTraceGroups = computed(() => props.observe.traceGroups.filter((group) => group.linkedProjectId === props.project.id));
const selectedTraceId = ref(firstTraceId());
const copiedTraceId = ref(false);
const expandedTraceGroups = ref(false);
const expandedEvidence = ref(false);
const expandedEndpoints = ref(false);
let copyResetTimer: number | undefined;

const selectedTrace = computed(() => projectTraceGroups.value.find((group) => group.id === selectedTraceId.value) ?? projectTraceGroups.value[0] ?? null);
const selectedEvidence = computed(() => props.observe.evidence.filter((item) => item.traceId === selectedTrace.value?.id));
const visibleTraceGroups = computed(() => latestItems(projectTraceGroups.value, expandedTraceGroups.value));
const hiddenTraceGroupCount = computed(() => hiddenItemCount(projectTraceGroups.value, expandedTraceGroups.value));
const visibleEvidence = computed(() => latestItems(selectedEvidence.value, expandedEvidence.value));
const hiddenEvidenceCount = computed(() => hiddenItemCount(selectedEvidence.value, expandedEvidence.value));
const visibleEndpoints = computed(() => latestItems(props.observe.endpointHealth, expandedEndpoints.value));
const hiddenEndpointCount = computed(() => hiddenItemCount(props.observe.endpointHealth, expandedEndpoints.value));
const visibleTraceEvents = computed(() => selectedTrace.value?.events.slice(-TRACE_EVENT_LIMIT) ?? []);
const hiddenTraceEventCount = computed(() => Math.max((selectedTrace.value?.events.length ?? 0) - TRACE_EVENT_LIMIT, 0));
const issueCount = computed(() => projectTraceGroups.value.reduce((count, group) => count + group.events.filter((event) => event.severity === "error" || event.severity === "warning").length, 0));
const healthyEndpointCount = computed(() => props.observe.endpointHealth.filter((endpoint) => endpoint.status === "healthy").length);
const unhealthyEndpointCount = computed(() => props.observe.endpointHealth.length - healthyEndpointCount.value);
const latestSelectedEvent = computed(() => selectedTrace.value?.events.at(-1) ?? null);
const selectedIssueEvent = computed(() => selectedTrace.value?.events.slice().reverse().find((event) => event.severity === "error" || event.severity === "warning") ?? null);
const latestEventSummary = computed(() => latestSelectedEvent.value?.summary ?? "No trace event selected.");
const issueSummary = computed(() => selectedIssueEvent.value ? `${selectedIssueEvent.value.code}: ${selectedIssueEvent.value.summary}` : "No warning or failure recorded in this trace.");
const linkedSummary = computed(() => {
  const evidence = selectedEvidence.value.at(-1);
  if (evidence) return `${surfaceLabel(evidence.linkedSurface)}: ${evidence.title}`;
  if (selectedTrace.value) return `Room: ${selectedTrace.value.linkedRoomId}`;
  return "No linked object selected.";
});

watch(
  () => [props.activeTargetId, props.project.id, projectTraceGroups.value.map((group) => group.id).join(",")] as const,
  () => {
    selectedTraceId.value = firstTraceId();
  },
  { immediate: true },
);

watch(selectedTraceId, () => {
  expandedEvidence.value = false;
});

function latestItems<T>(items: T[], expanded: boolean): T[] {
  return expanded ? items : items.slice(-CARD_ROW_LIMIT);
}

function hiddenItemCount<T>(items: T[], expanded: boolean): number {
  return expanded ? 0 : Math.max(items.length - CARD_ROW_LIMIT, 0);
}

function firstTraceId(): string {
  return projectTraceGroups.value.find((group) => group.id === props.activeTargetId)?.id ?? projectTraceGroups.value.at(-1)?.id ?? "";
}

function selectTrace(group: TraceGroupProjection): void {
  selectedTraceId.value = group.id;
  copiedTraceId.value = false;
}

function statusTone(status: string): string {
  if (status === "failed" || status === "offline") return "bad";
  if (status === "needs-human" || status === "degraded" || status === "warning") return "warn";
  if (status === "complete" || status === "healthy" || status === "success") return "success";
  return "";
}

function eventTone(severity: string): string {
  if (severity === "error") return "bad";
  if (severity === "warning") return "warn";
  if (severity === "success") return "success";
  return "";
}

function eventSeverityCode(severity: string): string {
  if (severity === "error") return "ERR";
  if (severity === "warning") return "WRN";
  if (severity === "success") return "OK";
  return "INF";
}

function endpointStatusCode(status: string): string {
  if (status === "healthy") return "OK";
  if (status === "degraded") return "DEG";
  if (status === "offline") return "OFF";
  return status.slice(0, 3).toUpperCase();
}

function evidenceKindCode(kind: string): string {
  if (kind === "tool-call") return "TC";
  if (kind === "approval") return "AP";
  if (kind === "message") return "MSG";
  if (kind === "artifact") return "ART";
  if (kind === "driver-record") return "DRV";
  return kind.slice(0, 3).toUpperCase();
}

function traceGroupSeverityEvents(group: TraceGroupProjection): TraceEventProjection[] {
  return group.events.slice(-6);
}

function tracePointLabel(event: TraceEventProjection, index: number, total: number): string {
  return `Event ${index + 1} of ${total}: ${event.timestamp}, ${formatStatus(event.severity)}, ${event.code}, ${event.actor}. ${event.summary}`;
}

function surfaceLabel(surface: Surface): string {
  if (surface === "projects") return "Board";
  if (surface === "work") return "Work card";
  if (surface === "artifact") return "Artifact";
  if (surface === "rooms") return "Room";
  if (surface === "observe") return "Trace";
  if (surface === "agents") return "Agent";
  return "Settings";
}

function formatStatus(value: string): string {
  return value.replaceAll("-", " ");
}

function evidenceMeta(kind: string, attention: string, surface: Surface): string {
  const parts = [formatStatus(kind), surfaceLabel(surface)];
  if (attention !== "none" && attention !== "info") parts.push(formatStatus(attention));
  return parts.join(" · ");
}

async function copySelectedTraceId(): Promise<void> {
  if (!selectedTrace.value?.id) return;
  await navigator.clipboard?.writeText(selectedTrace.value.id);
  copiedTraceId.value = true;
  if (copyResetTimer) window.clearTimeout(copyResetTimer);
  copyResetTimer = window.setTimeout(() => {
    copiedTraceId.value = false;
  }, 1400);
}

onBeforeUnmount(() => {
  if (copyResetTimer) window.clearTimeout(copyResetTimer);
});
</script>

<template>
  <div class="content-scroll">
    <div class="observe-page">
      <div class="observe-summary-strip" aria-label="Runtime audit summary">
        <div class="observe-summary-item">
          <span>Trace groups</span>
          <strong>{{ projectTraceGroups.length }}</strong>
        </div>
        <div class="observe-summary-item">
          <span>Issues</span>
          <strong>{{ issueCount }}</strong>
        </div>
        <div class="observe-summary-item">
          <span>Endpoints</span>
          <strong>{{ healthyEndpointCount }}/{{ observe.endpointHealth.length }} healthy</strong>
        </div>
        <div class="observe-summary-item wide">
          <span>Latest selected event</span>
          <strong>{{ latestEventSummary }}</strong>
        </div>
      </div>

      <div class="observe-workspace">
        <aside class="observe-panel trace-index" aria-label="Trace groups">
          <div class="observe-panel-head">
            <div>
              <div class="kicker">Trace groups</div>
              <strong>Runtime threads</strong>
            </div>
          </div>
          <button
            v-for="group in visibleTraceGroups"
            :key="group.id"
            class="trace-group-row"
            :class="{ active: selectedTrace?.id === group.id }"
            type="button"
            @click="selectTrace(group)"
          >
            <span class="trace-status-dot" :class="statusTone(group.status)" aria-hidden="true" />
            <span class="trace-group-copy">
              <strong>{{ group.title }}</strong>
              <span>{{ formatStatus(group.status) }} · {{ group.events.length }} events · {{ group.startedAt }}</span>
              <span class="trace-row-beads" role="img" :aria-label="`Latest ${traceGroupSeverityEvents(group).length} event severities`">
                <span
                  v-for="event in traceGroupSeverityEvents(group)"
                  :key="event.id"
                  class="trace-row-bead"
                  :class="eventTone(event.severity)"
                  :title="`${event.timestamp} ${formatStatus(event.severity)}`"
                  aria-hidden="true"
                />
              </span>
            </span>
          </button>
          <button v-if="projectTraceGroups.length > CARD_ROW_LIMIT" class="audit-disclosure" type="button" @click="expandedTraceGroups = !expandedTraceGroups">
            {{ expandedTraceGroups ? 'Show latest 3 trace groups' : `Show ${hiddenTraceGroupCount} older trace groups` }}
          </button>
        </aside>

        <section v-if="selectedTrace" class="observe-audit-stage" aria-label="Selected trace audit">
          <header class="audit-brief">
            <div class="trace-title-line">
              <span class="trace-status-dot" :class="statusTone(selectedTrace.status)" aria-hidden="true" />
              <strong>{{ selectedTrace.title }}</strong>
              <code>{{ selectedTrace.id }}</code>
              <span>{{ formatStatus(selectedTrace.status) }} · {{ selectedTrace.events.length }} events · started {{ selectedTrace.startedAt }}</span>
            </div>
            <div class="trace-detail-actions">
              <button class="secondary-button" type="button" @click="emit('navigate', 'rooms', selectedTrace.linkedRoomId)">Open room</button>
              <button class="secondary-button" type="button" @click="copySelectedTraceId">{{ copiedTraceId ? 'Copied' : 'Copy trace id' }}</button>
            </div>
          </header>

          <section class="observe-panel trace-signal-card" aria-label="Selected trace recency and severity">
            <div class="audit-section-head compact">
              <div>
                <div class="kicker">Trace signal</div>
                <strong>Latest {{ visibleTraceEvents.length }} events</strong>
              </div>
              <span class="audit-head-meta">{{ hiddenTraceEventCount ? `${hiddenTraceEventCount} older hidden` : 'Full event window' }}</span>
            </div>
            <div v-if="visibleTraceEvents.length" class="trace-event-sequence" role="list" aria-label="Latest trace events by recency and severity">
              <div
                v-for="(event, index) in visibleTraceEvents"
                :key="event.id"
                class="trace-event-point"
                :class="[eventTone(event.severity), { latest: index === visibleTraceEvents.length - 1 }]"
                role="listitem"
                :aria-label="tracePointLabel(event, index, visibleTraceEvents.length)"
              >
                <time>{{ event.timestamp }}</time>
                <span class="trace-event-dot" aria-hidden="true" />
                <span class="trace-event-severity">{{ eventSeverityCode(event.severity) }}</span>
                <code>{{ event.code }}</code>
                <span>{{ event.actor }}</span>
              </div>
            </div>
            <p v-else class="observe-empty-copy">No trace events have been recorded for this trace group.</p>
            <div class="trace-signal-readouts" aria-label="Selected trace facts">
              <div :class="selectedIssueEvent ? eventTone(selectedIssueEvent.severity) : ''">
                <span>Issue</span>
                <strong>{{ issueSummary }}</strong>
              </div>
              <div>
                <span>Latest</span>
                <strong>{{ latestSelectedEvent ? `${latestSelectedEvent.code}: ${latestSelectedEvent.summary}` : 'No events yet.' }}</strong>
              </div>
              <div>
                <span>Linked</span>
                <strong>{{ linkedSummary }}</strong>
              </div>
            </div>
          </section>

          <div class="observe-audit-grid">
            <section class="observe-panel evidence-board" aria-label="Linked evidence">
              <div class="audit-section-head">
                <div>
                  <div class="kicker">Linked evidence</div>
                  <strong>{{ selectedEvidence.length }} reviewable refs</strong>
                </div>
              </div>
              <div v-if="selectedEvidence.length" class="evidence-trail" aria-label="Linked evidence trail">
                <button v-for="item in visibleEvidence" :key="item.id" class="evidence-trail-row" :class="statusTone(item.attention)" type="button" @click="emit('navigate', item.linkedSurface, item.linkedId)">
                  <span class="evidence-trail-rail" aria-hidden="true">
                    <span class="evidence-trail-node" :class="statusTone(item.attention)">{{ evidenceKindCode(item.kind) }}</span>
                  </span>
                  <span class="evidence-audit-copy">
                    <span class="audit-row-meta" :class="statusTone(item.attention)">{{ evidenceMeta(item.kind, item.attention, item.linkedSurface) }}</span>
                    <strong>{{ item.title }}</strong>
                    <span>{{ item.summary }}</span>
                  </span>
                  <span class="evidence-target">Open {{ surfaceLabel(item.linkedSurface) }}</span>
                </button>
              </div>
              <button v-if="selectedEvidence.length > CARD_ROW_LIMIT" class="audit-disclosure" type="button" @click="expandedEvidence = !expandedEvidence">
                {{ expandedEvidence ? 'Show latest 3 refs' : `Show ${hiddenEvidenceCount} older refs` }}
              </button>
              <p v-if="!selectedEvidence.length" class="observe-empty-copy">No evidence objects are linked to this trace group yet.</p>
            </section>

            <section class="observe-panel endpoint-board" aria-label="Endpoint health">
              <div class="audit-section-head">
                <div>
                  <div class="kicker">Endpoint health</div>
                  <strong>{{ healthyEndpointCount }}/{{ observe.endpointHealth.length }} healthy</strong>
                </div>
              </div>
              <div class="endpoint-health-matrix" aria-label="Endpoint health status matrix">
                <article v-for="endpoint in visibleEndpoints" :key="endpoint.id" class="endpoint-health-row" :class="statusTone(endpoint.status)">
                  <span class="endpoint-status-cell" :class="statusTone(endpoint.status)" aria-hidden="true">{{ endpointStatusCode(endpoint.status) }}</span>
                  <div class="endpoint-health-copy">
                    <strong>{{ endpoint.label }}</strong>
                    <span class="endpoint-audit-meta" :class="statusTone(endpoint.status)">{{ endpoint.latencyMs }}ms · {{ formatStatus(endpoint.status) }}</span>
                    <span class="endpoint-audit-detail">{{ endpoint.detail }}</span>
                  </div>
                </article>
              </div>
              <button v-if="observe.endpointHealth.length > CARD_ROW_LIMIT" class="audit-disclosure" type="button" @click="expandedEndpoints = !expandedEndpoints">
                {{ expandedEndpoints ? 'Show latest 3 endpoints' : `Show ${hiddenEndpointCount} more endpoints` }}
              </button>
            </section>
          </div>

          <section class="observe-panel trace-detail" aria-label="Selected trace event ledger">
            <div class="audit-section-head">
              <div>
                <div class="kicker">Event ledger</div>
                <strong>Latest {{ visibleTraceEvents.length }} of {{ selectedTrace.events.length }} events</strong>
              </div>
              <span class="audit-head-meta">{{ latestSelectedEvent ? `Latest at ${latestSelectedEvent.timestamp}` : 'No events yet' }}</span>
            </div>
            <p v-if="hiddenTraceEventCount" class="trace-event-window-copy">{{ hiddenTraceEventCount }} older events are hidden from this timeline.</p>
            <ol class="observe-event-list">
              <li v-for="event in visibleTraceEvents" :key="event.id" class="observe-event-row" :class="eventTone(event.severity)">
                <span class="trace-event-status-cell" :class="eventTone(event.severity)">{{ eventSeverityCode(event.severity) }}</span>
                <time>{{ event.timestamp }}</time>
                <div>
                  <div class="observe-event-code"><code>{{ event.code }}</code><span>{{ event.actor }}</span></div>
                  <p>{{ event.summary }}</p>
                </div>
              </li>
            </ol>
          </section>
        </section>
      </div>
    </div>
  </div>
</template>
