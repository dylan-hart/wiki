<template>
  <div v-if="fields.length < 1" class="text-caption text-black/60 dark:text-white/70">
    {{ t('editor.blockPicker.noProps') }}
  </div>
  <w-form v-else class="gap-4">
    <template v-for="field of fields" :key="field.name">
      <w-select
        v-if="field.type === `select`"
        v-model="values[field.name]"
        :options="field.options ?? []"
        dense
        options-dense
        :label="fieldLabel(field)"
        :required="field.required"
        :hint="fieldHint(field)" />
      <w-toggle
        v-else-if="field.type === `boolean`"
        v-model="values[field.name]"
        dense
        :label="fieldLabel(field)" />
      <w-input
        v-else
        v-model="values[field.name]"
        dense
        :type="field.type === `number` ? `number` : `text`"
        :label="fieldLabel(field)"
        :required="field.required"
        :hint="fieldHint(field)" />
    </template>
  </w-form>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { useBlockLocale } from '@/composables/blockLocale'

/**
 * Shared by the block picker and the parameters dialog the editor's lens opens over a block already
 * in the page: the two ask an author the same thing, so the fields are described once here. Padding
 * is the caller's, since this sits in a panel in one and a card in the other.
 *
 * It writes into the `values` object it is given rather than emitting: what a caller wants back is
 * "what is in the form now", and both already keep that object as their own state.
 */

const props = defineProps({
  /**
   * What a field's `blocks.<tag>.props.<name>.label` / `.hint` key is resolved against. Optional: a
   * caller with no tag handy (or a custom block with no `blocks.*` namespace minted for it) simply
   * gets every field's raw `label` / `hint` back unresolved.
   */
  block: {
    type: String,
    default: ''
  },
  fields: {
    type: Array,
    required: true
  },
  values: {
    type: Object,
    required: true
  }
})

const { t } = useI18n()
const { blockText } = useBlockLocale()

function fieldLabel(field) {
  return blockText(props.block, `props.${field.name}.label`, field.label ?? field.name)
}

function fieldHint(field) {
  return blockText(props.block, `props.${field.name}.hint`, field.hint)
}
</script>
