<template>
  <w-dialog
    v-model="dialogVisible"
    :aria-label="t('pages.templatePicker.title')"
    @hide="onDialogHide">
    <w-card class="page-template-picker" style="width: 520px; max-width: 94vw">
      <w-card-section class="card-header">
        <w-icon name="tabler:template" size="sm" class="me-2" />
        <span>{{ t('pages.templatePicker.title') }}</span>
      </w-card-section>
      <w-separator />
      <w-card-section v-if="state.loading" class="page-template-picker__status">
        {{ t('common.loading') }}
      </w-card-section>
      <w-card-section v-else-if="state.failed" class="page-template-picker__status">
        {{ t('pages.templatePicker.loadFailed') }}
      </w-card-section>
      <w-card-section v-else-if="offered.length === 0" class="page-template-picker__status">
        {{ t('pages.templatePicker.empty') }}
      </w-card-section>
      <w-list v-else separator class="page-template-picker__list">
        <w-item
          v-for="template of offered"
          :key="template.id"
          clickable
          class="page-template-picker__item"
          @click="select(template)">
          <blueprint-icon :icon="EDITOR_ICONS[template.editor]" />
          <w-item-section>
            <w-item-label>
              <strong>{{ template.name }}</strong>
            </w-item-label>
            <w-item-label v-if="template.description" caption>
              {{ template.description }}
            </w-item-label>
            <w-item-label caption>
              {{ t(`admin.editors.${template.editor}Name`) }}
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
import { computed, onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { EDITOR_ICONS } from '@/helpers/editorIcons'
import { log } from '@/helpers/log'

import { useFlagsStore } from '@/stores/flags'
import { useSiteStore } from '@/stores/site'

const props = defineProps({
  basePath: {
    type: String,
    default: ''
  },
  locale: {
    type: String,
    default: null
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const flagsStore = useFlagsStore()
const siteStore = useSiteStore()

const { t } = useI18n()

const state = reactive({
  loading: true,
  failed: false,
  templates: []
})

function editorIsOffered(editor) {
  if (!siteStore.editors?.[editor]) {
    return false
  }
  return editor !== 'wysiwyg' || flagsStore.experimental
}

const offered = computed(() => state.templates.filter((tpl) => editorIsOffered(tpl.editor)))

onMounted(async () => {
  try {
    const searchParams = { basePath: props.basePath ?? '' }
    if (props.locale) {
      searchParams.locale = props.locale
    }
    state.templates =
      (await API_CLIENT.get(`sites/${siteStore.id}/page-templates`, { searchParams }).json()) ?? []
  } catch (err) {
    log.warn('page', 'could not load the page templates', err)
    state.failed = true
  }
  state.loading = false
})

function select(template) {
  onDialogOK({ template })
}
</script>
