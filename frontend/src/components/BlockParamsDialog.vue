<template>
  <w-dialog
    v-model="dialogVisible"
    :aria-label="t('editor.blockParams.title', { name: definition.name })"
    @hide="onDialogHide">
    <w-card style="width: 550px">
      <w-card-section class="card-header">
        <w-icon
          :name="definition.isCustom ? 'tabler:puzzle' : definition.icon"
          size="sm"
          class="me-2" />
        <span>{{ t('editor.blockParams.title', { name: definition.name }) }}</span>
      </w-card-section>
      <w-card-section>
        <block-props-form
          :block="definition.block"
          :fields="definition.props ?? []"
          :values="state.values" />
      </w-card-section>
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
          :label="t(`common.actions.apply`)"
          color="primary"
          padding="xs md"
          :disabled="!canApply"
          @click="apply" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { computed, reactive } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { blockPropsFilled } from '@/helpers/blocks'

import BlockPropsForm from '@/components/BlockPropsForm.vue'

/** Values are copied on the way in, so closing without applying leaves the page as it was. */

const props = defineProps({
  definition: {
    type: Object,
    required: true
  },
  values: {
    type: Object,
    required: true
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const { t } = useI18n()

const state = reactive({
  values: { ...props.values }
})

// -> A required prop emptied out would leave a block that cannot draw anything
const canApply = computed(() => blockPropsFilled(props.definition, state.values))

function apply() {
  onDialogOK({ ...state.values })
}
</script>
