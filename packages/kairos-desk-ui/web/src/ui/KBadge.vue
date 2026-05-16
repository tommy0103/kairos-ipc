<script setup lang="ts">
import { computed } from "vue";
import { cn } from "@/lib/cn";

const props = withDefaults(
  defineProps<{
    tone?: "default" | "warn" | "info" | "success" | "bad";
    compact?: boolean;
  }>(),
  {
    tone: "default",
    compact: false,
  },
);

const badgeClass = computed(() =>
  cn(
    "inline-flex min-h-6 items-center gap-[5px] whitespace-nowrap rounded-full border border-kd-border-strong bg-kd-panel px-[9px] font-sans text-xs font-semibold leading-[22px] text-kd-text",
    props.compact && "min-h-5 px-[7px] text-[11px] leading-[18px]",
    props.tone === "warn" && "border-kd-attention-line bg-[color-mix(in_oklch,var(--kd-attention-wash)_76%,var(--kd-panel))] text-[var(--kd-attention-text)]",
    props.tone === "info" && "border-[var(--kd-blue-200)] bg-kd-blue-soft text-kd-blue",
    props.tone === "success" && "border-[oklch(78%_0.07_151)] bg-kd-green-soft text-[oklch(38%_0.09_151)]",
    props.tone === "bad" && "border-[oklch(74%_0.09_28)] bg-kd-red-soft text-[oklch(42%_0.12_28)]",
  ),
);
</script>

<template>
  <span :class="badgeClass">
    <slot />
  </span>
</template>
