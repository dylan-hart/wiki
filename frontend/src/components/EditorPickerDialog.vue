<template>
  <w-dialog v-model="dialogVisible" :aria-label="t('editor.picker.title')" @hide="onDialogHide">
    <w-card class="editor-picker" style="width: 460px; max-width: 90vw">
      <w-card-section class="card-header">
        <w-icon name="tabler:edit" size="sm" class="me-2" />
        <span>{{ t('editor.picker.title') }}</span>
      </w-card-section>
      <w-separator />
      <w-list separator>
        <w-item
          v-for="editor of activeEditors"
          :key="editor.id"
          clickable
          @click="select(editor.id)">
          <blueprint-icon :icon="editor.icon" />
          <w-item-section>
            <w-item-label>
              <strong>{{ t(`admin.editors.${editor.id}Name`) }}</strong>
            </w-item-label>
            <w-item-label caption>
              {{ t(`admin.editors.${editor.id}Description`) }}
            </w-item-label>
          </w-item-section>
        </w-item>
      </w-list>
      <w-separator />
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          icon="tabler:x"
          :label="t(`common.actions.cancel`)"
          color="grey-7"
          padding="xs md"
          @click="onDialogCancel" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'

import { useSiteStore } from '@/stores/site'

import { PICKABLE_EDITORS } from '@/helpers/editorPicker'

/**
 * Reuses `AdminEditors.vue`'s own `admin.editors.*Name` / `*Description` locale keys rather than
 * duplicating the wording, so the two listings cannot drift apart.
 *
 * `pickEditor()` (`helpers/editorPicker.js`) decides whether to open this at all -- a site with a
 * single active editor never sees it.
 */

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const siteStore = useSiteStore()

const { t } = useI18n()

/*
  FIXME: these are leftover 2.x asset names, not Iconify references -- `WIcon` resolves anything
  without a `<prefix>:` to `kind: 'none'`, so every plate in this list draws empty. Use the
  `tabler:*` names `AdminEditors.vue` already lists for the same editors.
*/
const EDITOR_ICONS = {
  asciidoc: 'asciidoc',
  code: 'html',
  markdown: 'markdown',
  wysiwyg: 'google-presentation'
}

const activeEditors = computed(() =>
  PICKABLE_EDITORS.filter((id) => siteStore.editors?.[id]).map((id) => ({
    id,
    icon: EDITOR_ICONS[id]
  }))
)

function select(editor) {
  onDialogOK({ editor })
}
</script>
