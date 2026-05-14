<script setup lang="ts">
import { Bot, FileText, FolderKanban, Info, PanelRight, Radar } from "lucide-vue-next";
import type { ProjectProjection, RoomProjection, Surface, WorkCardProjection } from "@/api/types";

const props = defineProps<{
  activeSurface: Surface;
  room: RoomProjection;
  project: ProjectProjection;
  workCard: WorkCardProjection | null;
  artifactTargetId: string;
  inspectorOpen: boolean;
  inspectorAvailable: boolean;
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId?: string];
  toggleInspector: [];
}>();

function title(): string {
  if (props.activeSurface === "projects") {
    return props.project.title;
  }
  if (props.activeSurface === "work") {
    return props.workCard?.title ?? "Work detail";
  }
  if (props.activeSurface === "artifact") {
    return "Artifact Reader";
  }
  if (props.activeSurface === "diff") {
    return "Diff Reader";
  }
  if (props.activeSurface === "agents") {
    return "Agents";
  }
  if (props.activeSurface === "observe") {
    return "Observe";
  }
  if (props.activeSurface === "settings") {
    return "Settings";
  }
  return `# ${props.room.name}`;
}

function topic(): string {
  if (props.activeSurface === "projects") {
    return "Project owns work. Rooms show the conversation, artifacts and traces stay addressable.";
  }
  if (props.activeSurface === "work") {
    return `Work detail from ${props.project.title}. Artifacts, evidence, and decisions stay outside the board.`;
  }
  if (props.activeSurface === "artifact") {
    return "Focused Markdown review with source refs, trace evidence, and revision actions.";
  }
  if (props.activeSurface === "diff") {
    return "Patch evidence stays here: changed files, hunks, additions, deletions, and collapsed context.";
  }
  if (props.activeSurface === "agents") {
    return "Actor lens for current responsibility, reports, capabilities, and blockers.";
  }
  if (props.activeSurface === "observe") {
    return "Evidence lens for trace groups, endpoint health, tool calls, and approval records.";
  }
  if (props.activeSurface === "settings") {
    return "Local workspace and runtime preferences for the Kairos Desk surface.";
  }
  return props.room.topic;
}
</script>

<template>
  <header class="surface-header">
    <div>
      <div class="surface-title">
        <span>{{ title() }}</span>
        <span v-if="activeSurface === 'rooms'" class="pill">{{ room.agentIds.length }} agents</span>
        <span v-if="activeSurface === 'projects'" class="pill warn">Phase: {{ project.phase }}</span>
        <span v-if="activeSurface === 'work' && workCard" class="pill warn">{{ workCard.status }}</span>
      </div>
      <div class="surface-topic">{{ topic() }}</div>
    </div>
    <div class="header-actions" aria-label="Context shortcuts">
      <button class="icon-button" :class="{ active: activeSurface === 'projects' || activeSurface === 'work' || activeSurface === 'diff' }" type="button" @click="emit('navigate', 'projects')">
        <FolderKanban :size="15" aria-hidden="true" />
        Project
      </button>
      <button class="icon-button" :class="{ active: activeSurface === 'artifact' }" type="button" @click="emit('navigate', 'artifact', props.artifactTargetId)">
        <FileText :size="15" aria-hidden="true" />
        Artifacts
      </button>
      <button class="icon-button" :class="{ active: activeSurface === 'observe' }" type="button" @click="emit('navigate', 'observe')">
        <Radar :size="15" aria-hidden="true" />
        Trace
      </button>
      <button class="icon-button" :class="{ active: activeSurface === 'agents' }" type="button" @click="emit('navigate', 'agents')">
        <Bot :size="15" aria-hidden="true" />
        Agents
      </button>
      <button class="icon-button" type="button" title="Room info" aria-label="Room info">
        <Info :size="15" aria-hidden="true" />
      </button>
      <button
        class="icon-button"
        :class="{ active: inspectorOpen }"
        type="button"
        :title="inspectorOpen ? 'Collapse context inspector' : 'Open context inspector'"
        :aria-label="inspectorOpen ? 'Collapse context inspector' : 'Open context inspector'"
        :aria-pressed="inspectorOpen"
        :disabled="!inspectorAvailable"
        @click="emit('toggleInspector')"
      >
        <PanelRight :size="15" aria-hidden="true" />
      </button>
    </div>
  </header>
</template>
