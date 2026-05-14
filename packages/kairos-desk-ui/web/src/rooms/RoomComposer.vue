<script setup lang="ts">
import { AtSign, Paperclip, Plus } from "lucide-vue-next";

defineProps<{
  roomName: string;
}>();
</script>

<template>
  <div class="composer-wrap">
    <div class="composer">
      <textarea
        class="composer-input"
        rows="2"
        :placeholder="`Message #${roomName}, mention @agents, or attach this discussion to a project...`"
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
