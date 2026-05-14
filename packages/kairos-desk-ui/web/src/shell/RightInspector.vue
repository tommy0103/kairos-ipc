<script setup lang="ts">
import { computed } from "vue";
import { X } from "lucide-vue-next";
import type { DeskSnapshot, InspectorProjection, ProjectPhase, Surface, TraceEventProjection } from "@/api/types";

const props = defineProps<{
  snapshot: DeskSnapshot;
  activeSurface: Surface;
  activeTargetId: string;
  panelMode: InspectorProjection["mode"];
  panelId: string;
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId?: string, focusId?: string | null];
  close: [];
}>();

const phases: ProjectPhase[] = ["Decide", "Build", "Review", "Validate", "Done"];

const artifact = computed(() => props.snapshot.artifacts.find((candidate) => candidate.id === props.panelId || candidate.id === props.activeTargetId) ?? props.snapshot.artifacts[0]!);
const traceGroup = computed(() => props.snapshot.observe.traceGroups.find((candidate) => candidate.id === props.panelId || candidate.id === props.activeTargetId) ?? props.snapshot.observe.traceGroups[0]!);
const project = computed(() => {
  if (props.panelMode === "artifact") {
    return props.snapshot.projects.find((candidate) => candidate.id === artifact.value.projectId) ?? props.snapshot.projects[0]!;
  }
  if (props.panelMode === "trace") {
    return props.snapshot.projects.find((candidate) => candidate.id === traceGroup.value.linkedProjectId) ?? props.snapshot.projects[0]!;
  }
  return projectForTarget(props.snapshot, props.activeTargetId) ?? projectForTarget(props.snapshot, props.panelId) ?? props.snapshot.projects[0]!;
});
const decision = computed(() => {
  for (const room of props.snapshot.rooms) {
    for (const message of room.messages) {
      const found = message.projections.find((projection) => projection.kind === "decision" && (projection.id === props.panelId || projection.cardId === props.panelId));
      if (found?.kind === "decision") {
        return found;
      }
    }
  }
  return null;
});

const currentCard = computed(() => project.value.cards.find((card) => card.id === props.panelId || card.id === props.activeTargetId) ?? project.value.cards[0]!);
const visibleTraceEvents = computed<TraceEventProjection[]>(() => traceGroup.value.events.slice(0, 4));

const showDecision = computed(() => props.panelMode === "decision" && decision.value !== null);
const showWorkCard = computed(() => props.panelMode === "work-card");
const showProjectState = computed(() => props.panelMode === "artifact");
const showArtifact = computed(() => props.panelMode === "artifact");
const showTrace = computed(() => props.panelMode === "trace" || props.panelMode === "decision");

const title = computed(() => {
  if (props.panelMode === "artifact") {
    return "Artifact preview";
  }
  if (props.panelMode === "trace") {
    return "Trace evidence";
  }
  if (props.panelMode === "work-card") {
    return "Work card";
  }
  if (props.panelMode === "room-info") {
    return "Room info";
  }
  return "Human decision";
});

const subtitle = computed(() => {
  if (props.panelMode === "artifact") {
    return `Artifact from ${artifact.value.sourceRoomId}`;
  }
  if (props.panelMode === "trace") {
    return traceGroup.value.title;
  }
  if (props.panelMode === "work-card" || props.panelMode === "decision") {
    return `${currentCard.value.phase} card from ${project.value.title}`;
  }
  return props.snapshot.inspector.subtitle;
});

function projectForTarget(snapshot: DeskSnapshot, targetId: string) {
  return snapshot.projects.find((candidate) => candidate.id === targetId || candidate.cards.some((card) => card.id === targetId));
}
</script>

<template>
  <aside class="right-inspector" aria-label="Context inspector">
    <div class="rhs-header">
      <div>
        <div class="rhs-title">{{ title }}</div>
        <div class="rhs-subtitle">{{ subtitle }}</div>
      </div>
      <button class="icon-button" type="button" aria-label="Close inspector" @click="emit('close')">
        <X :size="16" aria-hidden="true" />
      </button>
    </div>
    <div class="rhs-body">
      <div v-if="showDecision && decision" class="inspector-card attention">
        <div class="kicker">Human action</div>
        <div class="inspector-title">{{ decision.title }}</div>
        <div class="inspector-text">
          Alice can start the build after this decision. The recommendation is {{ decision.recommendation }}
          {{ decision.rationale }}
        </div>
        <div class="action-row">
          <button class="primary-button" type="button">Accept recommendation</button>
          <button class="secondary-button" type="button">Reply in room</button>
        </div>
      </div>

      <div v-if="showProjectState" class="inspector-card">
        <div class="kicker">Project state</div>
        <div class="inspector-title">{{ project.title }}</div>
        <div class="lane-board" aria-label="Project phase">
          <div v-for="phase in phases" :key="phase" class="lane" :class="{ current: phase === project.phase }">{{ phase }}</div>
        </div>
        <div class="mini-grid">
          <div class="mini-cell">
            <div class="mini-label">Owner</div>
            <div class="mini-value">{{ project.owner }}</div>
          </div>
          <div class="mini-cell">
            <div class="mini-label">Agents</div>
            <div class="mini-value">{{ project.agentIds.length }} active</div>
          </div>
          <div class="mini-cell">
            <div class="mini-label">Artifact</div>
            <div class="mini-value">{{ project.artifactIds.length }} draft</div>
          </div>
          <div class="mini-cell">
            <div class="mini-label">Blocker</div>
            <div class="mini-value">{{ project.blocker ?? "none" }}</div>
          </div>
        </div>
      </div>

      <div v-if="showWorkCard" class="inspector-card">
        <div class="kicker">Work preview</div>
        <div class="inspector-title">{{ currentCard.title }}</div>
        <div class="inspector-text">{{ currentCard.summary }}</div>
        <div class="action-row">
          <span class="pill warn">{{ currentCard.status }}</span>
          <span class="pill">{{ currentCard.phase }}</span>
        </div>
        <div class="action-row">
          <button class="secondary-button" type="button" @click="emit('navigate', 'work', currentCard.id)">Open detail</button>
        </div>
      </div>

      <div v-if="showTrace" class="inspector-card">
        <div class="kicker">Evidence</div>
        <div v-for="event in visibleTraceEvents" :key="event.id" class="trace-line">
          <span class="trace-dot" />
          <code>{{ event.code }}</code>
          <span>{{ event.summary }}</span>
        </div>
      </div>

      <div v-if="showArtifact" class="inspector-card">
        <div class="kicker">Artifact preview</div>
        <div class="inspector-title">{{ artifact.title }}</div>
        <div class="inspector-text">
          Full Markdown stays out of the room timeline. This preview gives enough context, then opens the dedicated Artifact Reader for complete content and review actions.
        </div>
        <div class="action-row">
          <button class="secondary-button" type="button" @click="emit('navigate', 'artifact', artifact.id)">Open reader</button>
          <button class="secondary-button" type="button" @click="emit('navigate', 'observe', artifact.traceId)">Open trace</button>
        </div>
      </div>

      <div v-if="panelMode === 'room-info'" class="inspector-card">
        <div class="kicker">Room info</div>
        <div class="inspector-title">Linked work</div>
        <div class="inspector-text">This room is linked to {{ project.title }}. Messages can become project cards, source refs, or artifact evidence without making the room own Scrum state.</div>
      </div>
    </div>
  </aside>
</template>
