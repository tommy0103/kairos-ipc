<script setup lang="ts">
import { ChevronLeft, ChevronRight, CircleAlert, FileText, ListChecks } from "lucide-vue-next";
import { computed } from "vue";
import type { ProjectProjection } from "@/api/types";

const props = defineProps<{
  project: ProjectProjection;
  collapsed: boolean;
}>();

const emit = defineEmits<{
  toggle: [];
}>();

const needsYouCount = computed(() => props.project.cards.filter((card) => card.status === "needs-human").length);
const changedFileCount = computed(() => props.project.cards.reduce((total, card) => total + (card.diffSummary?.filesChanged ?? 0), 0));
</script>

<template>
  <aside class="project-context-sidebar" :class="{ collapsed }" aria-label="Project context">
    <div class="project-context-head">
      <button
        class="project-context-toggle"
        type="button"
        :aria-label="collapsed ? 'Expand project context' : 'Collapse project context'"
        :title="collapsed ? 'Expand project context' : 'Collapse project context'"
        @click="emit('toggle')"
      >
        <ChevronLeft v-if="collapsed" :size="16" aria-hidden="true" />
        <ChevronRight v-else :size="16" aria-hidden="true" />
      </button>
      <div v-if="!collapsed" class="project-context-heading">
        <span>Brief</span>
        <strong>Project Info</strong>
      </div>
    </div>

    <div v-if="collapsed" class="project-context-collapsed-mark" aria-hidden="true">Brief</div>
    <div v-else class="project-context-scroll">
      <p class="project-context-summary">{{ project.summary }}</p>
      <div class="project-context-facts" aria-label="Project facts">
        <div class="project-context-fact">
          <ListChecks :size="15" aria-hidden="true" />
          <span>{{ project.cards.length }} tasks</span>
        </div>
        <div class="project-context-fact">
          <CircleAlert :size="15" aria-hidden="true" />
          <span>{{ needsYouCount }} needs you</span>
        </div>
        <div class="project-context-fact">
          <FileText :size="15" aria-hidden="true" />
          <span>{{ project.artifactIds.length }} artifacts</span>
        </div>
        <div v-if="changedFileCount" class="project-context-fact">
          <FileText :size="15" aria-hidden="true" />
          <span>{{ changedFileCount }} changed files</span>
        </div>
      </div>
    </div>
  </aside>
</template>
