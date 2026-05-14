<script setup lang="ts">
import type { IpcActionProjection } from "@/api/types";

defineProps<{
  action: IpcActionProjection;
}>();
</script>

<template>
  <div class="status-line">
    <strong>@{{ action.actorName }}</strong>
    <span>current IPC action</span>
    <code>{{ action.endpoint }} {{ action.action }} {{ action.argsPreview }}</code>
  </div>
</template>
