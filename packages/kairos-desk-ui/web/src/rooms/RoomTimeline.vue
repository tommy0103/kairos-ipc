<script setup lang="ts">
import { nextTick, watch } from "vue";
import type { RoomProjection, Surface } from "@/api/types";
import RoomMessage from "./RoomMessage.vue";

const props = defineProps<{
  room: RoomProjection;
  highlightedMessageId?: string | null;
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId?: string, focusId?: string | null];
}>();

function forwardNavigate(surface: Surface, targetId?: string, focusId?: string | null): void {
  emit("navigate", surface, targetId, focusId);
}

watch(
  () => [props.room.id, props.highlightedMessageId] as const,
  async () => {
    if (!props.highlightedMessageId) {
      return;
    }

    await nextTick();
    document.getElementById(props.highlightedMessageId)?.scrollIntoView({ behavior: "smooth", block: "center" });
  },
  { immediate: true },
);
</script>

<template>
  <section class="timeline" aria-label="Room timeline">
    <div class="day-line">Today</div>
    <RoomMessage v-for="message in room.messages" :id="message.id" :key="message.id" :message="message" :class="{ 'message-highlighted': highlightedMessageId === message.id }" @navigate="forwardNavigate" />
  </section>
</template>
