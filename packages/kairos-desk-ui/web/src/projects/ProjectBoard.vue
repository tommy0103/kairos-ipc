<script setup lang="ts">
import { computed } from "vue";
import type { ProjectPhase, ProjectProjection, WorkCardProjection } from "@/api/types";
import WorkCard from "./WorkCard.vue";

type BoardViewMode = "list" | "card";

const props = defineProps<{
  project: ProjectProjection;
  cards?: WorkCardProjection[];
  viewMode?: BoardViewMode;
  highlightedCardId?: string | null;
  workCardDomId?: (cardId: string) => string;
}>();

const emit = defineEmits<{
  openCard: [cardId: string];
}>();

const phases: ProjectPhase[] = ["Decide", "Build", "Review", "Validate", "Done"];
const boardCards = computed(() => props.cards ?? props.project.cards);

function cardsForPhase(phase: ProjectPhase) {
  return boardCards.value.filter((card) => card.phase === phase);
}

function phaseLabel(phase: ProjectPhase): string {
  return phase === "Build" ? "Building" : phase;
}

function cardDomId(cardId: string): string | undefined {
  return props.workCardDomId?.(cardId);
}

function statusLabel(status: WorkCardProjection["status"]): string {
  if (status === "failed") return "Failed";
  if (status === "info") return "Running";
  if (status === "done") return "Done";
  return "Waiting";
}
</script>

<template>
  <div v-if="!boardCards.length" class="board-empty" role="status">No tasks match this search.</div>
  <div v-else-if="viewMode === 'list'" class="board-list" aria-label="Project work list">
    <button
      v-for="card in boardCards"
      :id="cardDomId(card.id)"
      :key="card.id"
      class="board-list-row"
      :class="[card.status, { 'jump-cue': card.id === highlightedCardId }]"
      type="button"
      @click="emit('openCard', card.id)"
    >
      <span class="board-list-primary">
        <strong>{{ card.title }}</strong>
        <span>{{ card.summary }}</span>
      </span>
      <span class="board-list-meta">
        <span>{{ card.phase }}</span>
        <span>{{ statusLabel(card.status) }}</span>
        <span>{{ card.owner }}</span>
      </span>
    </button>
  </div>
  <div v-else class="board" aria-label="Project board">
    <section v-for="phase in phases" :key="phase" class="board-column">
      <div class="board-column-title">
        <span>{{ phaseLabel(phase) }}</span>
        <span class="pill">{{ cardsForPhase(phase).length }}</span>
      </div>
      <WorkCard
        v-for="card in cardsForPhase(phase)"
        :key="card.id"
        :card="card"
        :dom-id="cardDomId(card.id)"
        :highlighted="card.id === highlightedCardId"
        @open="emit('openCard', $event)"
      />
    </section>
  </div>
</template>
