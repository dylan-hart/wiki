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
 * Picks which editor a new page should open in.
 *
 * Lists whichever of `PICKABLE_EDITORS` this site currently has active (`siteStore.editors`,
 * populated from `GET sites/:siteId`'s `editors.<id>.isActive`), each with the same name/description
 * copy `AdminEditors.vue` shows for it -- reusing the very same `admin.editors.*Name` /
 * `admin.editors.*Description` locale keys rather than duplicating the wording, so the two can never
 * drift apart.
 *
 * Opened via `pickEditor()` (`helpers/editorPicker.js`), which is also what decides whether to open
 * this at all -- a single active editor skips it entirely. This component only has to render
 * whatever list it is handed and answer with one of them:
 *
 *   dialog({ component: EditorPickerDialog }).onOk(({ editor }) => ...)
 */

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// COMPUTED

/** Icon per editor id, matching `AdminEditors.vue`'s own `editors` array. */
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

// METHODS

function select(editor) {
  onDialogOK({ editor })
}
</script>
