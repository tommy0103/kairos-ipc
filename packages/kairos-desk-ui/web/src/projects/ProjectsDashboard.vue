<script setup lang="ts">
import { ArrowUp, LayoutGrid, List as ListIcon, Search } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { ArtifactDetailProjection, ProjectProjection, Surface } from "@/api/types";
import ProjectBoard from "./ProjectBoard.vue";

type BoardViewMode = "list" | "card";

const props = defineProps<{
  projects: ProjectProjection[];
  activeProject: ProjectProjection;
  artifacts: ArtifactDetailProjection[];
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId?: string];
}>();

const project = computed(() => props.activeProject);
const expandedAttention = ref(false);
const highlightedBoardCardId = ref<string | null>(null);
const contentScroll = ref<HTMLElement | null>(null);
const showScrollTop = ref(false);
const boardSearch = ref("");
const boardViewMode = ref<BoardViewMode>("card");
let highlightTimer: number | null = null;
const needsYouCards = computed(() => project.value.cards.filter((item) => item.status === "needs-human"));
const projectArtifacts = computed(() => props.artifacts.filter((artifact) => artifact.projectId === project.value.id));
const visibleNeedsYouCards = computed(() => (expandedAttention.value ? needsYouCards.value : needsYouCards.value.slice(0, 3)));
const hiddenAttentionCount = computed(() => Math.max(0, needsYouCards.value.length - 3));
const needsYouSummary = computed(() => `${needsYouCards.value.length} ${needsYouCards.value.length === 1 ? "task" : "tasks"} need you`);
const hiddenAttentionLabel = computed(() => `${hiddenAttentionCount.value} more ${hiddenAttentionCount.value === 1 ? "task" : "tasks"}`);
const boardTaskSummary = computed(
  () => `${project.value.cards.length} ${project.value.cards.length === 1 ? "task" : "tasks"}, ${needsYouCards.value.length} ${needsYouCards.value.length === 1 ? "task" : "tasks"} needs you`,
);
const filteredBoardCards = computed(() => {
  const query = boardSearch.value.trim().toLowerCase();
  if (!query) return project.value.cards;

  return project.value.cards.filter((card) =>
    [card.title, card.summary, card.owner, card.phase, card.status].some((value) => value.toLowerCase().includes(query)),
  );
});

function workCardDomId(cardId: string): string {
  return `project-work-card-${cardId}`;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function clearHighlightTimer(): void {
  if (highlightTimer !== null) {
    window.clearTimeout(highlightTimer);
    highlightTimer = null;
  }
}

async function revealBoardCard(cardId: string): Promise<void> {
  clearHighlightTimer();
  boardSearch.value = "";
  highlightedBoardCardId.value = null;
  await nextTick();

  highlightedBoardCardId.value = cardId;
  await nextTick();

  document.getElementById(workCardDomId(cardId))?.scrollIntoView({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "center",
    inline: "center",
  });

  highlightTimer = window.setTimeout(() => {
    highlightedBoardCardId.value = null;
    highlightTimer = null;
  }, 1900);
}

function handleProjectScroll(): void {
  showScrollTop.value = (contentScroll.value?.scrollTop ?? 0) > 420;
}

function scrollProjectTop(): void {
  contentScroll.value?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

watch(
  () => project.value.id,
  () => {
    expandedAttention.value = false;
    highlightedBoardCardId.value = null;
    showScrollTop.value = false;
    boardSearch.value = "";
    clearHighlightTimer();
  },
);

onBeforeUnmount(clearHighlightTimer);

</script>

<template>
  <div ref="contentScroll" class="content-scroll projects-content-scroll" @scroll.passive="handleProjectScroll">
    <div class="dashboard projects-dashboard">
      <section v-if="needsYouCards.length" class="attention-queue" aria-label="Needs you">
        <div class="attention-queue-head">
          <div class="attention-strip-marker" aria-hidden="true">!</div>
          <div class="attention-strip-copy">
            <span>Needs you</span>
            <strong>{{ needsYouSummary }}</strong>
          </div>
        </div>
        <div class="attention-task-stack">
          <div v-for="card in visibleNeedsYouCards" :key="card.id" class="attention-task-row">
            <button class="attention-task-target" type="button" @click="revealBoardCard(card.id)">
              <span class="attention-task-copy">
                <strong>{{ card.title }}</strong>
                <span>{{ card.summary }}</span>
              </span>
            </button>
            <button class="attention-task-action" type="button" @click="emit('navigate', 'work', card.id)">Open card</button>
          </div>
        </div>
        <button v-if="hiddenAttentionCount" class="attention-disclosure" type="button" @click="expandedAttention = !expandedAttention">
          {{ expandedAttention ? 'Show first 3 tasks' : `Show ${hiddenAttentionLabel}` }}
        </button>
      </section>

      <section class="project-board-stage">
        <div class="project-board-toolbar" aria-label="Task board controls">
          <label class="project-board-search">
            <Search :size="14" aria-hidden="true" />
            <input v-model="boardSearch" type="search" placeholder="Search tasks" aria-label="Search tasks" />
          </label>
          <div class="project-board-toolbar-actions">
            <span>{{ boardTaskSummary }}</span>
            <div class="board-view-toggle" aria-label="Task view mode">
              <button type="button" :class="{ active: boardViewMode === 'list' }" aria-label="Show as list" title="List view" @click="boardViewMode = 'list'">
                <ListIcon :size="15" aria-hidden="true" />
              </button>
              <button type="button" :class="{ active: boardViewMode === 'card' }" aria-label="Show as cards" title="Card view" @click="boardViewMode = 'card'">
                <LayoutGrid :size="15" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
        <ProjectBoard
          :project="project"
          :cards="filteredBoardCards"
          :view-mode="boardViewMode"
          :highlighted-card-id="highlightedBoardCardId"
          :work-card-dom-id="workCardDomId"
          @open-card="emit('navigate', 'work', $event)"
        />
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
    <button v-if="showScrollTop" class="project-scroll-top" type="button" aria-label="Back to top" @click="scrollProjectTop">
      <ArrowUp :size="17" :stroke-width="2.2" aria-hidden="true" />
    </button>
  </div>
</template>
