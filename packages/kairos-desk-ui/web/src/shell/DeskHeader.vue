<script setup lang="ts">
import { Bot, FileText, FolderKanban, Radar } from "lucide-vue-next";
import type { ProjectProjection, RoomProjection, Surface, WorkCardProjection } from "@/api/types";
import KBadge from "@/ui/KBadge.vue";
import KHeaderAction from "@/ui/KHeaderAction.vue";

const props = defineProps<{
  activeSurface: Surface;
  room: RoomProjection;
  project: ProjectProjection;
  workCard: WorkCardProjection | null;
  artifactTargetId: string;
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId?: string];
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
        <KBadge v-if="activeSurface === 'rooms'">{{ room.agentIds.length }} agents</KBadge>
        <KBadge v-if="activeSurface === 'projects'" tone="warn">Phase: {{ project.phase }}</KBadge>
        <KBadge v-if="activeSurface === 'work' && workCard" tone="warn">{{ workCard.status }}</KBadge>
      </div>
      <div class="surface-topic">{{ topic() }}</div>
    </div>
    <div class="header-actions" aria-label="Context shortcuts">
      <KHeaderAction :active="activeSurface === 'projects' || activeSurface === 'work' || activeSurface === 'diff'" @click="emit('navigate', 'projects')">
        <FolderKanban :size="15" aria-hidden="true" />
        Project
      </KHeaderAction>
      <KHeaderAction :active="activeSurface === 'artifact'" @click="emit('navigate', 'artifact', props.artifactTargetId)">
        <FileText :size="15" aria-hidden="true" />
        Artifacts
      </KHeaderAction>
      <KHeaderAction :active="activeSurface === 'observe'" @click="emit('navigate', 'observe')">
        <Radar :size="15" aria-hidden="true" />
        Trace
      </KHeaderAction>
      <KHeaderAction :active="activeSurface === 'agents'" @click="emit('navigate', 'agents')">
        <Bot :size="15" aria-hidden="true" />
        Agents
      </KHeaderAction>
    </div>
  </header>
</template>
