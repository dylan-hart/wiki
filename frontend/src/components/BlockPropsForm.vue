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
 * The form a block's props make: one field per prop, in the order the block declares them.
 *
 * Shared by the block picker, which fills it in for a block about to be inserted, and the parameters
 * dialog the editor's lens opens over one already in the page. The two ask the same thing of an
 * author and must offer the same controls, so the fields are described once here.
 *
 * A block with nothing to fill in is not a broken form: it is inserted, or left, as it stands. A
 * custom block reports no props at all, since only the compiled manifest carries them.
 *
 * It writes into the `values` object it is given rather than emitting: what a caller wants back is
 * "what is in the form now", and both of them already keep that object as their own state — a
 * `v-model` per field would be the same object, one indirection further away.
 *
 * Padding is the caller's: this sits in a panel in one and a card in the other.
 *
 * Labels and hints resolve through i18n before falling back to the raw string the block definition
 * carries, at the `blocks.<tag>.props.<name>.label` / `.hint` keys minted for the 223 block metadata
 * strings (see `backend/locales/en.json`). `tag` is optional: a caller with no block tag to give —
 * the admin "Configure" form, whose fields are a block's site-wide config schema rather than its
 * author-facing props, and so were never minted under this convention — gets the raw string exactly
 * as before.
 */

// PROPS

const props = defineProps({
  /**
   * The block's own tag (`SiteBlock.block` / `BlockDefinition.block`, e.g. `openapi`) -- what a
   * field's `blocks.<tag>.props.<name>.label` / `.hint` key is resolved against. Optional: a caller
   * with no tag handy (or a custom block with no `blocks.*` namespace minted for it) simply gets
   * every field's raw `label` / `hint` back unresolved.
   */
  block: {
    type: String,
    default: ''
  },
  /** The props the block declares, as the API describes them. */
  fields: {
    type: Array,
    required: true
  },
  /** Values by prop name, written into as the author types. */
  values: {
    type: Object,
    required: true
  }
})

// I18N

const { t } = useI18n()
const { blockText } = useBlockLocale()

function fieldLabel(field) {
  return blockText(props.block, `props.${field.name}.label`, field.label ?? field.name)
}

function fieldHint(field) {
  return blockText(props.block, `props.${field.name}.hint`, field.hint)
}
</script>
