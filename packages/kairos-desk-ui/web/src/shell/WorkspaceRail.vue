<script setup lang="ts">
import { FolderKanban, MessageSquareText, Settings } from "lucide-vue-next";
import type { Surface } from "@/api/types";

defineProps<{
  activeSurface: Surface;
}>();

const emit = defineEmits<{
  navigate: [surface: Surface];
}>();

const primaryItems: ReadonlyArray<{ surface: Surface; label: string; icon: typeof FolderKanban }> = [
  { surface: "projects", label: "Projects", icon: FolderKanban },
  { surface: "rooms", label: "Rooms", icon: MessageSquareText },
];

function isProjectScopedSurface(surface: Surface): boolean {
  return surface === "projects" || surface === "work" || surface === "artifact" || surface === "diff" || surface === "agents" || surface === "observe";
}

function isActive(item: { surface: Surface }, activeSurface: Surface): boolean {
  if (item.surface === "projects") return isProjectScopedSurface(activeSurface);
  return item.surface === activeSurface;
}
</script>

<template>
  <nav class="workspace-rail" aria-label="Primary">
    <button
      v-for="item in primaryItems"
      :key="item.surface"
      class="rail-item"
      :class="{ active: isActive(item, activeSurface) }"
      type="button"
      :aria-label="item.label"
      :title="item.label"
      @click="emit('navigate', item.surface)"
    >
      <component :is="item.icon" :size="19" aria-hidden="true" />
    </button>
    <div class="rail-spacer" />
    <button
      class="rail-item"
      :class="{ active: activeSurface === 'settings' }"
      type="button"
      aria-label="Settings"
      title="Settings"
      @click="emit('navigate', 'settings')"
    >
      <Settings :size="19" aria-hidden="true" />
    </button>
  </nav>
</template>
