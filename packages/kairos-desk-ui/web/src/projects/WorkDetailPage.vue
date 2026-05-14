<script setup lang="ts">
import { computed } from "vue";
import type { ArtifactDetailProjection, ObserveProjection, PatchSetProjection, ProjectProjection, Surface, WorkCardProjection } from "@/api/types";
import { formatPatchSetSummary } from "@/diff/diffFormatting";

const props = defineProps<{
  project: ProjectProjection;
  card: WorkCardProjection;
  artifacts: ArtifactDetailProjection[];
  patchSets: PatchSetProjection[];
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
const projectTrace = computed(() => props.observe.traceGroups.find((trace) => trace.linkedProjectId === props.project.id) ?? props.observe.traceGroups[0]);
const cardEvidence = computed(() =>
  props.observe.evidence.filter((item) => item.linkedId === props.card.id || cardArtifacts.value.some((artifact) => artifact.id === item.linkedId)),
);
const actionLabel = computed(() => (props.card.status === "needs-human" ? "Decision needed before build" : props.card.status));

function openDiff(patchSetId: string, fileId?: string): void {
  emit("navigate", "diff", patchSetId, fileId ?? null);
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
          <div class="work-detail-statusline" aria-label="Work state">
            <span class="pill warn">{{ actionLabel }}</span>
            <span class="pill">Owner: {{ card.owner }}</span>
            <span class="pill">Trace: {{ projectTrace?.id ?? "none" }}</span>
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
            <button v-if="cardPatchSets[0]" class="ghost-link" type="button" @click="openDiff(cardPatchSets[0].id)">{{ formatPatchSetSummary(cardPatchSets[0]) }}</button>
            <span v-else>0</span>
          </div>
          <div v-if="changedFiles.length" class="changed-file-list">
            <button v-for="entry in changedFiles" :key="`${entry.patchSet.id}:${entry.file.id}`" class="changed-file-row" type="button" @click="openDiff(entry.patchSet.id, entry.file.id)">
              <span class="changed-file-path">{{ entry.file.path }}</span>
              <span class="changed-file-status">{{ entry.file.status }}</span>
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
