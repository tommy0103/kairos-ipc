<script setup lang="ts">
import type { WorkCardProjection } from "@/api/types";
import { formatPatchSetSummary } from "@/diff/diffFormatting";

defineProps<{
  card: WorkCardProjection;
}>();

const emit = defineEmits<{
  open: [cardId: string];
}>();
</script>

<template>
  <button class="work-card" :class="card.status" type="button" @click="emit('open', card.id)">
    <div class="work-card-head">
      <h3>{{ card.title }}</h3>
      <span class="status-dot" :class="card.status" aria-hidden="true"></span>
    </div>
    <p>{{ card.summary }}</p>
    <div class="work-card-meta">
      <span class="pill compact">{{ card.owner }}</span>
      <span class="pill compact" :class="{ warn: card.status === 'needs-human' || card.status === 'blocked' || card.status === 'failed' }">{{ card.status }}</span>
    </div>
    <div v-if="card.diffSummary" class="work-card-diff" aria-label="Patch summary">{{ formatPatchSetSummary(card.diffSummary) }}</div>
  </button>
</template>
