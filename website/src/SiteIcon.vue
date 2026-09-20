<script setup lang="ts">
import { iconPath } from './material-icons';
defineProps<{ name: string; filled?: boolean }>();
</script>

<template>
  <svg class="material-symbols-outlined" :data-icon="name" viewBox="0 0 960 960" fill="currentColor" aria-hidden="true" focusable="false">
    <path transform="translate(0 960) scale(1 -1)" :d="iconPath(name, filled)" />
  </svg>
</template>
