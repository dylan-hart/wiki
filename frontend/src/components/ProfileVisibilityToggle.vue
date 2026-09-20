<template>
  <div class="profile-visibility-toggle mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
    <w-toggle
      dense
      :model-value="isOn"
      :disabled="disabled || forced"
      :aria-label="ariaLabel"
      :aria-describedby="forced ? describedBy : undefined"
      :data-testid="`profile-public-toggle-${field}`"
      @update:model-value="emit('update:modelValue', $event)" />
    <span class="text-caption" aria-hidden="true">{{ t('profile.publicToggle') }}</span>
    <span
      v-if="forced"
      :id="describedBy"
      class="text-caption"
      :data-testid="`profile-public-forced-${field}`">
      {{ t('profile.publicToggleForced') }}
    </span>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  field: {
    type: String,
    required: true
  },
  fieldLabel: {
    type: String,
    required: true
  },
  modelValue: {
    type: Boolean,
    default: false
  },
  forced: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:modelValue'])

const { t } = useI18n()

const isOn = computed(() => props.forced || props.modelValue)
const describedBy = computed(() => `profile-public-forced-${props.field}`)
const ariaLabel = computed(() =>
  t('profile.publicToggleAria', { visibility: t('profile.publicToggle'), field: props.fieldLabel })
)
</script>
