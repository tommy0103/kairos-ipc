<script setup lang="ts">
import { loadDeskSnapshot } from "./api/client";
import DeskShell from "./shell/DeskShell.vue";

const snapshot = loadDeskSnapshot();
</script>

<template>
  <DeskShell :snapshot="snapshot" />
</template>
