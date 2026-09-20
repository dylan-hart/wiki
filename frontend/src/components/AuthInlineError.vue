<template>
  <w-banner class="auth-inline-error bg-negative text-white" role="alert">
    <template #avatar>
      <w-icon name="tabler:alert-triangle" size="sm" />
    </template>
    <div class="break-words">{{ message }}</div>
    <div v-if="caption" class="break-words opacity-80">{{ caption }}</div>
  </w-banner>
</template>

<script setup>
defineProps({
  message: {
    type: String,
    required: true
  },
  caption: {
    type: String,
    default: null
  }
})
</script>
