<script setup lang="ts">
import { ArrowRight, FileCode2, MessageSquareText } from "lucide-vue-next";
import { computed } from "vue";
import type { ArtifactDetailProjection, ObserveProjection, PatchSetProjection, ProjectPhase, ProjectProjection, RoomProjection, Surface, WorkCardProjection } from "@/api/types";

const props = defineProps<{
  project: ProjectProjection;
  card: WorkCardProjection;
  artifacts: ArtifactDetailProjection[];
  patchSets: PatchSetProjection[];
  rooms: RoomProjection[];
  observe: ObserveProjection;
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId?: string, focusId?: string | null];
}>();

const cardArtifacts = computed(() => props.artifacts.filter((artifact) => artifact.sourceCardId === props.card.id));
const cardPatchSets = computed(() => {
  const patchSetsById = new Map(props.patchSets.map((patchSet) => [patchSet.id, patchSet]));
  return props.card.patchSetIds.map((patchSetId) => patchSetsById.get(patchSetId)).filter((patchSet): patchSet is PatchSetProjection => Boolean(patchSet));
});
const changedFiles = computed(() => cardPatchSets.value.flatMap((patchSet) => patchSet.files.map((file) => ({ patchSet, file }))));
const cardEvidence = computed(() =>
  props.observe.evidence.filter((item) => item.linkedId === props.card.id || cardArtifacts.value.some((artifact) => artifact.id === item.linkedId)),
);
const needsHumanReview = computed(() => props.card.status === "needs-human");
const reviewArtifact = computed(() => cardArtifacts.value.find((artifact) => artifact.status === "ready") ?? cardArtifacts.value[0] ?? null);
const primaryPatchSet = computed(() => cardPatchSets.value[0] ?? null);
const phases: ProjectPhase[] = ["Decide", "Build", "Review", "Validate", "Done"];
const currentPhaseIndex = computed(() => Math.max(0, phases.indexOf(props.card.phase)));
const workMapSteps = computed(() => [
  {
    id: "phase",
    label: props.card.phase,
    value: currentPhaseIndex.value + 1,
    state: props.card.status === "failed" || props.card.status === "blocked" ? props.card.status : "current",
  },
  {
    id: "patch",
    label: "Patch",
    value: changedFiles.value.length,
    state: changedFiles.value.length ? "complete" : "quiet",
  },
  {
    id: "artifact",
    label: "Artifact",
    value: cardArtifacts.value.length,
    state: reviewArtifact.value ? "complete" : "quiet",
  },
  {
    id: "evidence",
    label: "Evidence",
    value: cardEvidence.value.length,
    state: cardEvidence.value.length ? "complete" : "quiet",
  },
  {
    id: "human",
    label: needsHumanReview.value ? "Needs you" : "Clear",
    value: needsHumanReview.value ? 1 : 0,
    state: needsHumanReview.value ? "needs-human" : props.card.status === "done" ? "complete" : "quiet",
  },
]);
const reviewCopy = computed(() => {
  if (primaryPatchSet.value) {
    return "The patch is written. Check the diff, then return to the room if you want another pass.";
  }
  if (reviewArtifact.value) {
    return "The artifact is ready to inspect. Use the room if you want clarification or follow-up work.";
  }
  return "This work needs human attention. Open its room context to continue the thread.";
});
const discussionTarget = computed(() => {
  const artifactIds = new Set(cardArtifacts.value.map((artifact) => artifact.id));

  for (const room of props.rooms) {
    for (const message of room.messages) {
      const hasSourceProjection = message.projections.some((projection) => {
        if (projection.kind === "work-card") return projection.id === props.card.id;
        if (projection.kind === "decision") return projection.cardId === props.card.id;
        if (projection.kind === "artifact") return artifactIds.has(projection.id);
        return false;
      });

      if (hasSourceProjection) {
        return { roomId: room.id, messageId: message.id };
      }
    }
  }

  const sourceArtifact = cardArtifacts.value[0];
  if (sourceArtifact) {
    return { roomId: sourceArtifact.sourceRoomId, messageId: null };
  }

  return { roomId: props.project.roomIds[0] ?? props.rooms[0]?.id ?? "", messageId: null };
});

function fileStatusLabel(status: (typeof changedFiles.value)[number]["file"]["status"]): string {
  if (status === "modified") return "M";
  if (status === "deleted") return "D";
  if (status === "added") return "A";
  return "R";
}

function changeBalanceStyle(kind: "added" | "removed"): Record<string, string> {
  const total = Math.max(1, (primaryPatchSet.value?.addedLines ?? 0) + (primaryPatchSet.value?.removedLines ?? 0));
  const value = kind === "added" ? primaryPatchSet.value?.addedLines ?? 0 : primaryPatchSet.value?.removedLines ?? 0;
  return { width: `${Math.max(value ? 8 : 0, (value / total) * 100)}%` };
}

function openDiff(patchSetId: string, fileId?: string): void {
  emit("navigate", "diff", patchSetId, fileId ?? null);
}

function reviewChanges(): void {
  if (primaryPatchSet.value) {
    emit("navigate", "diff", primaryPatchSet.value.id);
    return;
  }

  if (reviewArtifact.value) {
    emit("navigate", "artifact", reviewArtifact.value.id);
    return;
  }

  emit("navigate", "projects", props.project.id);
}

function discussInRoom(): void {
  if (!discussionTarget.value.roomId) {
    return;
  }

  emit("navigate", "rooms", discussionTarget.value.roomId, discussionTarget.value.messageId);
}
</script>

<template>
  <div class="content-scroll">
    <div class="work-detail-page">
      <div class="work-detail-topline">
        <button class="ghost-link" type="button" @click="emit('navigate', 'projects', project.id)">Back to board</button>
        <span>{{ project.title }}</span>
      </div>

      <div class="work-detail-grid">
        <section class="work-detail-panel primary-panel" aria-label="Current work">
          <div class="panel-kicker-row">
            <span class="kicker">Current work</span>
            <span>{{ card.phase }}</span>
          </div>
          <div class="work-detail-copy">
            <p>{{ card.summary }}</p>
          </div>
          <div class="work-execution-map" aria-label="Work execution map">
            <div v-for="step in workMapSteps" :key="step.id" class="work-map-step" :class="step.state">
              <span class="work-map-node" aria-hidden="true">{{ step.value }}</span>
              <span class="work-map-label">{{ step.label }}</span>
            </div>
          </div>
          <div v-if="needsHumanReview" class="work-review-action" aria-label="Work ready for review">
            <div class="work-review-copy">
              <div class="work-review-title">Ready for review</div>
              <p>{{ reviewCopy }}</p>
            </div>
            <div class="work-review-actions">
              <button class="primary-button work-review-button" type="button" @click="reviewChanges">
                <span>Review changes</span>
                <ArrowRight :size="14" aria-hidden="true" />
              </button>
              <button class="secondary-button work-review-button" type="button" @click="discussInRoom">
                <MessageSquareText :size="14" aria-hidden="true" />
                <span>Discuss in room</span>
              </button>
            </div>
          </div>
        </section>

        <section class="work-detail-panel">
          <div class="panel-kicker-row">
            <span class="kicker">Artifacts</span>
            <span>{{ cardArtifacts.length }}</span>
          </div>
          <div v-if="cardArtifacts.length" class="work-artifact-list">
            <button v-for="artifact in cardArtifacts" :key="artifact.id" class="work-artifact-row" type="button" @click="emit('navigate', 'artifact', artifact.id)">
              <div>
                <strong>{{ artifact.title }}</strong>
                <span>@{{ artifact.authorName }} · {{ artifact.status }} · {{ artifact.sourceRoomId }}</span>
              </div>
              <span class="ghost-link">Open</span>
            </button>
          </div>
          <div v-else class="empty-state compact-empty">No artifact has been submitted for this card yet.</div>
        </section>

        <section class="work-detail-panel changed-files-panel">
          <div class="panel-kicker-row">
            <span class="kicker">Changed files</span>
            <div v-if="cardPatchSets[0]" class="diff-entry-summary">
              <button class="ghost-link diff-entry-action" type="button" @click="openDiff(cardPatchSets[0].id)">Open diff</button>
              <span>{{ cardPatchSets[0].filesChanged }} files</span>
              <span class="changed-file-stat added">+{{ cardPatchSets[0].addedLines }}</span>
              <span class="changed-file-stat removed">-{{ cardPatchSets[0].removedLines }}</span>
            </div>
            <span v-else>0</span>
          </div>
          <div v-if="changedFiles.length" class="changed-file-list">
            <div v-if="primaryPatchSet" class="changed-file-balance" aria-label="Patch line balance">
              <span class="added" :style="changeBalanceStyle('added')"></span>
              <span class="removed" :style="changeBalanceStyle('removed')"></span>
            </div>
            <button v-for="entry in changedFiles" :key="`${entry.patchSet.id}:${entry.file.id}`" class="changed-file-row" type="button" @click="openDiff(entry.patchSet.id, entry.file.id)">
              <FileCode2 :size="14" aria-hidden="true" />
              <span class="changed-file-path">{{ entry.file.path }}</span>
              <span class="changed-file-status" :class="`is-${entry.file.status}`">{{ fileStatusLabel(entry.file.status) }}</span>
              <span class="changed-file-stat added">+{{ entry.file.addedLines }}</span>
              <span class="changed-file-stat removed">-{{ entry.file.removedLines }}</span>
            </button>
          </div>
          <div v-else class="empty-state compact-empty">No patch evidence has been attached to this card yet.</div>
        </section>

        <section class="work-detail-panel evidence-panel">
          <div class="panel-kicker-row">
            <span class="kicker">Evidence</span>
            <span>{{ cardEvidence.length }}</span>
          </div>
          <div class="work-evidence-list">
            <div v-for="item in cardEvidence" :key="item.id" class="work-evidence-row">
              <span class="trace-dot" />
              <div>
                <strong>{{ item.title }}</strong>
                <p>{{ item.summary }}</p>
              </div>
            </div>
            <div v-if="!cardEvidence.length" class="empty-state compact-empty">No card-specific evidence has been attached yet.</div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
