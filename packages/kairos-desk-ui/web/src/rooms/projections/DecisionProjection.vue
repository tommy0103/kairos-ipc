<script setup lang="ts">
import type { DecisionProjection, Surface } from "@/api/types";

defineProps<{
  projection: DecisionProjection;
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId?: string, focusId?: string | null];
}>();
</script>

<template>
  <div class="projection decision-projection">
    <div class="projection-head">
      <div>
        <div class="projection-type">Needs decision</div>
        <div class="projection-title">{{ projection.title }}</div>
      </div>
    </div>
    <div class="projection-body">
      <div class="recommendation">
        <div class="field-label">Recommend</div>
        <div class="field-value">{{ projection.recommendation }}</div>
        <div class="field-label">Why</div>
        <div>{{ projection.rationale }}</div>
      </div>
      <div class="action-row">
        <button class="primary-button" type="button">{{ projection.primaryAction }}</button>
        <button class="secondary-button" type="button">Ask follow-up</button>
        <button class="secondary-button" type="button" @click="emit('navigate', 'work', projection.cardId)">Open card</button>
      </div>
    </div>
  </div>
</template>
