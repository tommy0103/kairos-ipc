<script setup lang="ts">
import type { ArtifactProjection, Surface } from "@/api/types";

defineProps<{
  projection: ArtifactProjection;
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId?: string, focusId?: string | null];
}>();
</script>

<template>
  <div class="artifact-notice">
    <div class="artifact-notice-copy">
      <div class="artifact-notice-title">Artifact added: {{ projection.title }}</div>
      <div class="artifact-notice-meta">{{ projection.summary }}</div>
      <div class="artifact-notice-source">{{ projection.status }} · source #{{ projection.roomId }} · trace {{ projection.traceId }}</div>
    </div>
    <button class="ghost-link artifact-notice-action" type="button" @click="emit('navigate', 'artifact', projection.id)">Open artifact</button>
  </div>
</template>
