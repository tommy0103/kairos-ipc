<script setup lang="ts">
import type { ProjectPhase, ProjectProjection } from "@/api/types";
import WorkCard from "./WorkCard.vue";

const props = defineProps<{
  project: ProjectProjection;
}>();

const emit = defineEmits<{
  openCard: [cardId: string];
}>();

const phases: ProjectPhase[] = ["Decide", "Build", "Review", "Validate", "Done"];

function cardsForPhase(phase: ProjectPhase) {
  return props.project.cards.filter((card) => card.phase === phase);
}

function phaseLabel(phase: ProjectPhase): string {
  return phase === "Build" ? "Building" : phase;
}
</script>

<template>
  <div class="board" aria-label="Project board">
    <section v-for="phase in phases" :key="phase" class="board-column">
      <div class="board-column-title">
        <span>{{ phaseLabel(phase) }}</span>
        <span class="pill">{{ cardsForPhase(phase).length }}</span>
      </div>
      <WorkCard v-for="card in cardsForPhase(phase)" :key="card.id" :card="card" @open="emit('openCard', $event)" />
    </section>
  </div>
</template>
