<script setup lang="ts">
import { computed } from "vue";
import type { WorkCardProjection } from "@/api/types";

const props = defineProps<{
  card: WorkCardProjection;
  domId?: string;
  highlighted?: boolean;
}>();

const emit = defineEmits<{
  open: [cardId: string];
}>();

const diffTotal = computed(() => Math.max(1, (props.card.diffSummary?.addedLines ?? 0) + (props.card.diffSummary?.removedLines ?? 0)));
const ownerInitials = computed(() => {
  const normalized = props.card.owner.replace(/^@/, "").trim();
  if (!normalized) return "?";
  const parts = normalized.split(/[\s._-]+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || normalized.slice(0, 2).toUpperCase();
});
const ownerAvatarClass = computed(() => (props.card.owner.replace(/^@/, "").trim().toLowerCase() === "human" ? "human" : "agent"));

const needsAttention = computed(() => props.card.status === "needs-human" || props.card.status === "blocked" || props.card.status === "failed");
const statusLabel = computed(() => {
  if (props.card.status === "failed") return "Failed";
  if (props.card.status === "info") return "Running";
  if (props.card.status === "done") return "Done";
  return "Waiting";
});

function diffSegmentStyle(kind: "added" | "removed"): Record<string, string> {
  const value = kind === "added" ? props.card.diffSummary?.addedLines ?? 0 : props.card.diffSummary?.removedLines ?? 0;
  return { width: `${Math.max(value ? 8 : 0, (value / diffTotal.value) * 100)}%` };
}
</script>

<template>
  <button :id="domId" class="work-card" :class="[card.status, { 'jump-cue': highlighted }]" type="button" @click="emit('open', card.id)">
    <div class="work-card-head">
      <span class="work-card-phase-label">{{ card.phase }}</span>
    </div>
    <h3>{{ card.title }}</h3>
    <p>{{ card.summary }}</p>
    <div class="work-card-owner" :class="{ attention: needsAttention }" aria-label="Work owner">
      <span class="work-card-owner-avatar" :class="ownerAvatarClass" aria-hidden="true">
        {{ ownerInitials }}
        <span v-if="ownerAvatarClass === 'agent'" class="work-card-owner-dot"></span>
      </span>
      <span class="work-card-owner-name">{{ card.owner }}</span>
      <span class="work-card-status" :class="{ failed: card.status === 'failed', done: card.status === 'done', running: card.status === 'info' }">{{ statusLabel }}</span>
    </div>
    <div v-if="card.diffSummary" class="work-card-diff-visual" aria-label="Patch summary">
      <div class="work-card-diff-meter" aria-hidden="true">
        <span class="added" :style="diffSegmentStyle('added')"></span>
        <span class="removed" :style="diffSegmentStyle('removed')"></span>
      </div>
      <div class="work-card-diff-copy">
        <span class="work-card-diff-files" :aria-label="`${card.diffSummary.filesChanged} changed files`">
          {{ card.diffSummary.filesChanged }} files changed
        </span>
        <span class="work-card-diff-stats">
          <span class="work-card-diff-stat added">+ {{ card.diffSummary.addedLines }}</span>
          <span class="work-card-diff-stat removed">- {{ card.diffSummary.removedLines }}</span>
        </span>
      </div>
    </div>
  </button>
</template>
