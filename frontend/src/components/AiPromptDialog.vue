<template>
  <w-dialog v-model="dialogVisible" :aria-label="title" @hide="onDialogHide">
    <w-card style="min-width: 450px">
      <w-card-section class="card-header">
        <w-icon name="tabler:sparkles" size="sm" class="me-2" />
        <span>{{ title }}</span>
      </w-card-section>
      <w-card-section class="pb-0">
        <div class="text-body2">{{ intro }}</div>
      </w-card-section>
      <w-form ref="formRef" class="pb-2" @submit="commit">
        <w-item>
          <w-item-section>
            <w-input
              ref="iptPrompt"
              v-model="state.prompt"
              type="textarea"
              dense
              :rows="3"
              :maxlength="AI_PROMPT_MAX"
              :required="required"
              :rules="rules"
              lazy-rules="ondemand"
              :label="t(`editor.aiCursor.promptLabel`)"
              :hint="t(`editor.aiCursor.promptHint`)"
              @keydown.enter.ctrl.exact.prevent="commit"
              @keydown.enter.meta.exact.prevent="commit" />
          </w-item-section>
        </w-item>
      </w-form>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`common.actions.cancel`)"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
        <w-btn
          :label="t(`editor.aiCursor.submit`)"
          color="primary"
          padding="xs md"
          @click="commit" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { AI_PROMPT_MAX } from '@/composables/aiAssistCursorActions'
import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'

const props = defineProps({
  action: {
    type: String,
    required: true
  },
  required: {
    type: Boolean,
    default: false
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptPrompt.value
})

const { t } = useI18n()

const state = reactive({
  prompt: ''
})

const formRef = ref(null)
const iptPrompt = ref(null)

const title = computed(() =>
  props.action === 'generate'
    ? t('editor.aiCursor.generateTitle')
    : t('editor.aiCursor.expandTitle')
)
const intro = computed(() =>
  props.action === 'generate'
    ? t('editor.aiCursor.generateIntro')
    : t('editor.aiCursor.expandIntro')
)

const rules = computed(() =>
  props.required ? [(value) => Boolean(value?.trim()) || t('editor.aiCursor.promptRequired')] : []
)

function commit() {
  if (formRef.value && !formRef.value.validate()) {
    return
  }
  onDialogOK({ prompt: state.prompt.trim().slice(0, AI_PROMPT_MAX) })
}
</script>
