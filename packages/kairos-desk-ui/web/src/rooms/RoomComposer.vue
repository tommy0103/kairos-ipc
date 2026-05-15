<script setup lang="ts">
import { AtSign, MessageSquareReply, Paperclip, Plus, X } from "lucide-vue-next";

interface ReplyContext {
  label: string;
  title: string;
  actorName: string;
}

defineProps<{
  roomName: string;
  replyContext?: ReplyContext | null;
}>();

const emit = defineEmits<{
  clearReply: [];
}>();
</script>

<template>
  <div class="composer-wrap">
    <div class="composer">
      <div v-if="replyContext" class="composer-reply-context" aria-label="Reply context">
        <MessageSquareReply :size="15" aria-hidden="true" />
        <div class="composer-reply-copy">
          <span>{{ replyContext.label }} from @{{ replyContext.actorName }}</span>
          <strong>{{ replyContext.title }}</strong>
        </div>
        <button class="icon-button" type="button" aria-label="Clear reply context" title="Clear reply context" @click="emit('clearReply')">
          <X :size="14" aria-hidden="true" />
        </button>
      </div>
      <textarea
        class="composer-input"
        rows="2"
        :placeholder="replyContext ? `Reply in #${roomName}, mention @agents, or ask for another pass...` : `Message #${roomName}, mention @agents, or attach this discussion to a project...`"
      />
      <div class="composer-tools">
        <div class="tool-group">
          <button class="icon-button" type="button" aria-label="Add attachment" title="Add attachment">
            <Plus :size="15" aria-hidden="true" />
          </button>
          <button class="icon-button" type="button" aria-label="Mention agent" title="Mention agent">
            <AtSign :size="15" aria-hidden="true" />
          </button>
          <button class="secondary-button" type="button">
            <Paperclip :size="14" aria-hidden="true" />
            Attach project
          </button>
        </div>
        <button class="primary-button" type="button">Send</button>
      </div>
    </div>
  </div>
</template>
