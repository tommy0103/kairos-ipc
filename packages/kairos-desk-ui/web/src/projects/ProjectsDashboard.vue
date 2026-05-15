<script setup lang="ts">
import { computed } from "vue";
import type { ArtifactDetailProjection, ProjectProjection, Surface } from "@/api/types";
import ProjectBoard from "./ProjectBoard.vue";

const props = defineProps<{
  projects: ProjectProjection[];
  activeProject: ProjectProjection;
  artifacts: ArtifactDetailProjection[];
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId?: string];
}>();

const project = computed(() => props.activeProject);
const attentionCards = computed(() =>
  project.value.cards.filter((item) => item.status === "needs-human" || item.status === "blocked" || item.status === "failed"),
);
const projectArtifacts = computed(() => props.artifacts.filter((artifact) => artifact.projectId === project.value.id));
const primaryAttentionCard = computed(() => attentionCards.value[0] ?? null);
</script>

<template>
  <div class="content-scroll">
    <div class="dashboard projects-dashboard">
      <header class="project-canvas-header" aria-label="Current project">
        <div class="project-title-block">
          <span class="project-kicker">Project</span>
          <h1>{{ project.title }}</h1>
          <p>{{ project.summary }}</p>
        </div>
      </header>

      <section v-if="primaryAttentionCard" class="attention-strip" aria-label="Needs you">
        <div class="attention-strip-marker" aria-hidden="true">!</div>
        <div class="attention-strip-copy">
          <span>Needs you</span>
          <strong>{{ primaryAttentionCard.title }}</strong>
          <p>{{ primaryAttentionCard.summary }}</p>
        </div>
        <div class="attention-strip-actions">
          <span v-if="attentionCards.length > 1" class="attention-count">{{ attentionCards.length }} pending</span>
          <button class="secondary-button compact-action" type="button" @click="emit('navigate', 'work', primaryAttentionCard.id)">Open card</button>
        </div>
      </section>

      <section class="project-board-stage">
        <div class="project-section-heading">
          <h2>Board</h2>
          <div class="section-heading-meta">
            <span>{{ project.cards.length }} cards</span>
            <span v-if="project.blocker">Blocked by {{ project.blocker }}</span>
          </div>
        </div>
        <ProjectBoard :project="project" @open-card="emit('navigate', 'work', $event)" />
      </section>

      <section class="project-artifact-runway">
        <div class="project-section-heading">
          <h2>Artifacts</h2>
          <span>{{ projectArtifacts.length }} linked</span>
        </div>
        <div v-if="projectArtifacts.length" class="artifact-compact-list">
          <button v-for="artifact in projectArtifacts" :key="artifact.id" class="artifact-compact-row" type="button" @click="emit('navigate', 'artifact', artifact.id)">
            <div>
              <div class="artifact-compact-title">{{ artifact.title }}</div>
              <div class="artifact-compact-meta">@{{ artifact.authorName }} · {{ artifact.status }} · {{ artifact.sourceRoomId }}</div>
            </div>
            <span class="artifact-row-action">Open</span>
          </button>
        </div>
        <div v-else class="artifact-empty-row">No artifacts yet.</div>
      </section>
    </div>
  </div>
</template>
