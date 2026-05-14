<script setup lang="ts">
import type { Surface, WorkCardProjection } from "@/api/types";

defineProps<{
  projection: WorkCardProjection;
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId?: string, focusId?: string | null];
}>();
</script>

<template>
  <div class="projection">
    <div class="projection-head">
      <div>
        <div class="projection-type">Work card projection</div>
        <div class="projection-title">{{ projection.title }}</div>
      </div>
      <span class="pill" :class="{ warn: projection.status === 'blocked' || projection.status === 'needs-human' }">{{ projection.phase }}</span>
    </div>
    <div class="projection-body">
      <div>{{ projection.summary }}</div>
      <div class="action-row">
        <span class="pill">Owner: {{ projection.owner }}</span>
        <span class="pill">{{ projection.status }}</span>
        <button class="secondary-button" type="button" @click="emit('navigate', 'work', projection.id)">Open card</button>
      </div>
    </div>
  </div>
</template>
