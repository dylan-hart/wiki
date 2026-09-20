<template>
  <w-layout container>
    <w-header class="card-header">
      <w-icon name="tabler:markdown" left size="md" />
      <span>{{ t('editor.settings.markdown') }}</span>
      <w-space />
      <w-btn
        class="me-2"
        flat
        rounded
        color="white"
        :aria-label="t(`common.actions.refresh`)"
        icon="tabler:help-circle"
        :href="siteStore.docsBase + `/guide/editors/markdown`"
        target="_blank"
        type="a" />
      <w-btn-group>
        <w-btn
          color="grey-6"
          text-color="white"
          :aria-label="t(`common.actions.refresh`)"
          icon="tabler:refresh"
          @click="load"
          :loading="state.loading > 0">
          <w-tooltip anchor="center left" self="center right">{{
            t(`common.actions.refresh`)
          }}</w-tooltip>
        </w-btn>
        <w-btn
          color="white"
          text-color="grey-7"
          :label="t(`common.actions.cancel`)"
          :aria-label="t(`common.actions.cancel`)"
          icon="tabler:x"
          @click="close" />
        <w-btn
          color="positive"
          text-color="white"
          :label="t(`common.actions.apply`)"
          :aria-label="t(`common.actions.apply`)"
          icon="tabler:check"
          @click="save"
          :disabled="state.loading > 0" />
      </w-btn-group>
    </w-header>
    <w-page-container>
      <w-page class="p-4" style="max-width: 1200px; margin: 0 auto">
        <w-card class="shadow-1 py-2">
          <w-item tag="label">
            <blueprint-icon icon="tabler:corner-down-left" />
            <w-item-section>
              <w-item-label>{{ t(`editor.settings.markdownPreviewShown`) }}</w-item-label>
              <w-item-label caption>{{
                t(`editor.settings.markdownPreviewShownHint`)
              }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.previewShown"
                :aria-label="t(`editor.settings.markdownPreviewShown`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="tabler:arrows-horizontal" />
            <w-item-section>
              <w-item-label>{{ t(`editor.settings.markdownFontSize`) }}</w-item-label>
              <w-item-label caption>{{ t(`editor.settings.markdownFontSizeHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-input
                type="number"
                min="10"
                max="32"
                style="width: 100px"
                v-model="state.config.fontSize"
                dense
                :aria-label="t(`editor.settings.markdownFontSize`)" />
            </w-item-section>
          </w-item>
        </w-card>
        <w-inner-loading :showing="state.loading > 0">
          <w-spinner color="accent" size="lg" />
        </w-inner-loading>
      </w-page>
    </w-page-container>
  </w-layout>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { onMounted, reactive } from 'vue'

import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'

import { useEditorStore } from '@/stores/editor'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { apiErrorMessage } from '@/helpers/apiError'

/**
 * `MainOverlayDialog.vue` forwards `siteStore.overlayOpts` to every overlay it mounts as this prop.
 * Declared although unused here: an undeclared prop falls through onto this component's DOM root.
 */
defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

const editorStore = useEditorStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

const state = reactive({
  config: {
    previewShown: false,
    fontSize: 16,
    /*
      Set only by `EditorMarkdown.vue`'s resize divider, never by this overlay, but still carried
      through `load()`/`save()`: `save()` PUTs a full replacement of the user's Markdown settings,
      so omitting it would silently erase a dragged preview width.
    */
    previewWidth: null
  },
  loading: 0
})

function close() {
  siteStore.$patch({ overlay: '' })
}

async function load() {
  state.loading++
  loading.show()
  try {
    // -> An empty response is a user who has never saved settings, not a failure
    const conf = (await API_CLIENT.get('users/profile/editor-settings/markdown').json()) ?? {}
    state.config.previewShown = conf.previewShown ?? true
    state.config.fontSize = conf.fontSize ?? 16
    state.config.previewWidth = conf.previewWidth ?? null
    editorStore.$patch({ userSettings: { ...editorStore.userSettings, markdown: conf } })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('editor.settings.fetchFailed'),
      caption: apiErrorMessage(err)
    })
  }
  loading.hide()
  state.loading--
}

async function save() {
  state.loading++
  try {
    const payload = {
      previewShown: state.config.previewShown,
      // -> A number input hands back a string
      fontSize: Number.parseInt(state.config.fontSize, 10),
      previewWidth: state.config.previewWidth
    }
    await API_CLIENT.put('users/profile/editor-settings/markdown', {
      json: payload
    }).json()
    editorStore.$patch({ userSettings: { ...editorStore.userSettings, markdown: payload } })
    notify({
      type: 'positive',
      message: t('editor.settings.saveSuccess')
    })
    close()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('editor.settings.saveFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
}

onMounted(() => {
  load()
})
</script>
