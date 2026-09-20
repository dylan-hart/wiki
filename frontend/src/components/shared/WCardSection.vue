<template>
  <div
    :id="id"
    class="w-card-section"
    :class="horizontal ? 'flex flex-nowrap items-center' : 'p-4'">
    <slot />
  </div>
</template>

<script setup>
defineProps({
  id: {
    type: String,
    default: null
  },
  /**
   * Row layout, for sections that sit side by side. It carries no padding of its own: it wraps
   * other sections, which already pad themselves, so any padding here adds to theirs instead of
   * replacing it. Zero is also what lets a horizontal card put an image flush against its edge.
   */
  horizontal: {
    type: Boolean,
    default: false
  }
})
</script>
