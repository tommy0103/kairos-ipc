<script setup lang="ts">
import type { ProjectProjection, RoomProjection, Surface } from "@/api/types";
import AgentStatusLine from "./AgentStatusLine.vue";
import RoomComposer from "./RoomComposer.vue";
import RoomTimeline from "./RoomTimeline.vue";

defineProps<{
  room: RoomProjection;
  project: ProjectProjection;
  highlightedMessageId?: string | null;
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId?: string, focusId?: string | null];
}>();

function forwardNavigate(surface: Surface, targetId?: string, focusId?: string | null): void {
  emit("navigate", surface, targetId, focusId);
}
</script>

<template>
  <div class="room-page">
    <div class="context-strip">
      <div class="context-left">
        <div class="room-work-summary">
          <strong>{{ project.title }}</strong>
          <span>{{ project.phase }} · {{ project.owner }} owner</span>
        </div>
      </div>
      <div class="context-right">
        <button v-if="project.blocker" class="room-work-decision" type="button" @click="emit('navigate', 'projects', project.id)">
          <span>Needs decision</span>
          <strong>{{ project.blocker }}</strong>
        </button>
        <button class="ghost-link room-board-link" type="button" @click="emit('navigate', 'projects', project.id)">Open board</button>
      </div>
    </div>
    <RoomTimeline :room="room" :highlighted-message-id="highlightedMessageId" @navigate="forwardNavigate" />
    <AgentStatusLine :action="room.latestIpcAction" />
    <RoomComposer :room-name="room.name" />
  </div>
</template>
