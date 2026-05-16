<script setup lang="ts">
import { computed } from "vue";
import { cn } from "@/lib/cn";

const props = withDefaults(
  defineProps<{
    active?: boolean;
    disabled?: boolean;
  }>(),
  {
    active: false,
    disabled: false,
  },
);

const actionClass = computed(() =>
  cn(
    "inline-flex min-h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] border-0 bg-transparent px-[7px] font-sans text-xs font-semibold text-kd-muted transition-colors duration-150 ease-out hover:bg-kd-blue-soft hover:text-kd-blue focus-visible:outline-none focus-visible:shadow-kd-focus active:bg-kd-blue-soft active:text-kd-blue disabled:cursor-default disabled:bg-transparent disabled:text-kd-muted disabled:opacity-[0.42]",
    props.active && "bg-kd-blue-soft text-kd-blue",
  ),
);
</script>

<template>
  <button :class="actionClass" :disabled="disabled" type="button">
    <slot />
  </button>
</template>
