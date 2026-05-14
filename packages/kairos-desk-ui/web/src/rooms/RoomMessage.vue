<script setup lang="ts">
import { Copy, Link2, MessageCircleReply, MoreHorizontal, Plus } from "lucide-vue-next";
import type { DurableProjection, RoomMessageProjection, Surface } from "@/api/types";
import ArtifactProjection from "./projections/ArtifactProjection.vue";
import DecisionProjection from "./projections/DecisionProjection.vue";

defineProps<{
  message: RoomMessageProjection;
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId?: string, focusId?: string | null];
}>();

function forwardNavigate(surface: Surface, targetId?: string, focusId?: string | null): void {
  emit("navigate", surface, targetId, focusId);
}

function avatarClass(kind: RoomMessageProjection["actorKind"]): string {
  if (kind === "agent") {
    return "agent";
  }
  if (kind === "service") {
    return "service";
  }
  if (kind === "system") {
    return "review";
  }
  return "";
}

function projectionKey(projection: DurableProjection): string {
  return `${projection.kind}:${projection.id}`;
}
</script>

<template>
  <article class="message">
    <div class="avatar" :class="avatarClass(message.actorKind)">{{ message.actorInitials }}</div>
    <div>
      <div class="msg-head">
        <span class="actor">{{ message.actorName }}</span>
        <span class="time">{{ message.sentAt }}</span>
      </div>
      <div class="msg-body">{{ message.body }}</div>

      <template v-for="projection in message.projections" :key="projectionKey(projection)">
        <DecisionProjection v-if="projection.kind === 'decision'" :projection="projection" @navigate="forwardNavigate" />
        <ArtifactProjection v-else-if="projection.kind === 'artifact'" :projection="projection" @navigate="forwardNavigate" />
      </template>
    </div>

    <div class="message-actions" aria-label="Message actions">
      <button class="message-action" type="button" title="Reply" aria-label="Reply">
        <MessageCircleReply :size="14" aria-hidden="true" />
      </button>
      <button class="message-action" type="button" title="Attach to project" aria-label="Attach to project">
        <Plus :size="14" aria-hidden="true" />
      </button>
      <button class="message-action" type="button" title="Open source" aria-label="Open source">
        <Link2 :size="14" aria-hidden="true" />
      </button>
      <button class="message-action" type="button" title="Copy link" aria-label="Copy link">
        <Copy :size="14" aria-hidden="true" />
      </button>
      <button class="message-action" type="button" title="More" aria-label="More">
        <MoreHorizontal :size="14" aria-hidden="true" />
      </button>
    </div>
  </article>
</template>
