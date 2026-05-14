<script setup lang="ts">
import { Plus, Search } from "lucide-vue-next";
import type { DeskNavigationProjection, NavigationItemProjection, Surface } from "@/api/types";

defineProps<{
  activeSurface: Surface;
  activeTargetId: string;
  activeProjectId: string;
  nav: DeskNavigationProjection;
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId: string];
}>();

interface SidebarSection {
  id: string;
  title: string;
  items: NavigationItemProjection[];
  countLabel: string | null;
}

function sections(nav: DeskNavigationProjection, activeSurface: Surface): SidebarSection[] {
  const roomTitle = activeSurface === "rooms" ? "Project Rooms" : "Rooms";
  return [
    { id: "needs", title: "Needs You", items: nav.needsYou, countLabel: String(nav.needsYou.length) },
    { id: "rooms", title: roomTitle, items: nav.rooms, countLabel: "+" },
    { id: "projects", title: "Projects", items: nav.projects, countLabel: null },
  ];
}

function isProjectScopedSurface(surface: Surface): boolean {
  return surface === "projects" || surface === "work" || surface === "artifact" || surface === "diff" || surface === "agents" || surface === "observe";
}

function isActive(item: NavigationItemProjection, activeSurface: Surface, activeTargetId: string, activeProjectId: string): boolean {
  if (item.surface === "projects" && isProjectScopedSurface(activeSurface)) {
    return item.targetId === activeProjectId;
  }
  return item.surface === activeSurface && item.targetId === activeTargetId;
}

function sidebarTitle(activeSurface: Surface): string {
  if (activeSurface === "rooms") {
    return "Rooms";
  }
  if (isProjectScopedSurface(activeSurface)) {
    return "Projects";
  }
  return "Settings";
}
</script>

<template>
  <aside class="desk-sidebar">
    <div class="sidebar-head">
      <div class="sidebar-title">
        <span>{{ sidebarTitle(activeSurface) }}</span>
        <button class="sidebar-action" type="button" aria-label="Create">
          <Plus :size="17" aria-hidden="true" />
        </button>
      </div>
      <div class="jump-box" role="search">
        <Search :size="14" aria-hidden="true" />
        <span>/ Jump to room, project, artifact</span>
      </div>
    </div>

    <div class="sidebar-scroll">
      <template v-for="section in sections(nav, activeSurface)" :key="section.id">
        <div class="section-label">
          <span>{{ section.title }}</span>
          <span v-if="section.countLabel" class="badge" :class="{ hot: section.id === 'needs' }">{{ section.countLabel }}</span>
        </div>
        <button
          v-for="item in section.items"
          :key="item.id"
          class="nav-row"
          :class="{
            active: isActive(item, activeSurface, activeTargetId, activeProjectId),
            attention: item.attention === 'needs-human' || item.attention === 'blocked' || item.attention === 'failed',
            quiet: item.quiet,
          }"
          type="button"
          @click="emit('navigate', item.surface, item.targetId)"
        >
          <span>{{ item.icon }}</span>
          <span class="nav-label">{{ item.label }}</span>
          <span v-if="item.badge" class="badge" :class="{ hot: item.attention === 'needs-human' }">{{ item.badge }}</span>
          <span v-else />
        </button>
      </template>
    </div>
  </aside>
</template>
