<script setup lang="ts">
import { computed } from "vue";
import type { ProjectProjection, RoomProjection, Surface } from "@/api/types";
import AgentStatusLine from "./AgentStatusLine.vue";
import RoomComposer from "./RoomComposer.vue";
import RoomTimeline from "./RoomTimeline.vue";

const props = defineProps<{
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

const replyContext = computed(() => {
  if (!props.highlightedMessageId) {
    return null;
  }

  const message = props.room.messages.find((candidate) => candidate.id === props.highlightedMessageId);
  if (!message) {
    return null;
  }

  const workCard = message.projections.find((projection) => projection.kind === "work-card");
  if (workCard?.kind === "work-card") {
    return { label: "Replying to work", title: workCard.title, actorName: message.actorName };
  }

  const artifact = message.projections.find((projection) => projection.kind === "artifact");
  if (artifact?.kind === "artifact") {
    return { label: "Replying to artifact", title: artifact.title, actorName: message.actorName };
  }

  const decision = message.projections.find((projection) => projection.kind === "decision");
  if (decision?.kind === "decision") {
    return { label: "Replying to decision", title: decision.title, actorName: message.actorName };
  }

  return { label: "Replying to message", title: message.body, actorName: message.actorName };
});

function clearReplyContext(): void {
  emit("navigate", "rooms", props.room.id, null);
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
          <span>Needs review</span>
          <strong>{{ project.blocker }}</strong>
        </button>
        <button class="ghost-link room-board-link" type="button" @click="emit('navigate', 'projects', project.id)">Open board</button>
      </div>
    </div>
    <RoomTimeline :room="room" :highlighted-message-id="highlightedMessageId" @navigate="forwardNavigate" />
    <AgentStatusLine :action="room.latestIpcAction" />
    <RoomComposer :room-name="room.name" :reply-context="replyContext" @clear-reply="clearReplyContext" />
  </div>
</template>
