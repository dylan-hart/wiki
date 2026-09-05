<template>
  <w-layout container>
    <w-header class="card-header px-4 py-2">
      <w-icon name="tabler:markdown" left size="md" />
      <span>{{ t('editor.settings.markdown') }}</span>
      <w-space />
      <w-btn
        class="me-2"
        flat
        rounded
        color="white"
        :aria-label="t(`common.actions.refresh`)"
        icon="la:question-circle"
        :href="siteStore.docsBase + `/guide/editors/markdown`"
        target="_blank"
        type="a" />
      <w-btn-group>
        <w-btn
          color="grey-6"
          text-color="white"
          :aria-label="t(`common.actions.refresh`)"
          icon="la:redo-alt"
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
          icon="la:times"
          @click="close" />
        <w-btn
          color="positive"
          text-color="white"
          :label="t(`common.actions.apply`)"
          :aria-label="t(`common.actions.apply`)"
          icon="la:check"
          @click="save"
          :disabled="state.loading > 0" />
      </w-btn-group>
    </w-header>
    <w-page-container>
      <w-page class="p-4" style="max-width: 1200px; margin: 0 auto">
        <w-card class="shadow-1 py-2">
          <w-item tag="label">
            <blueprint-icon icon="enter-key" />
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
            <blueprint-icon icon="width" />
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

// PROPS

/**
 * `MainOverlayDialog.vue` forwards `siteStore.overlayOpts` to every overlay it mounts as this prop
 * (OpenProject #2530). Declared here even though this overlay opens with no initial state to read --
 * without a declared prop, the value would fall through onto this component's DOM root instead.
 */
defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

// STORES

const editorStore = useEditorStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  config: {
    previewShown: false,
    fontSize: 16,
    /*
      No control here for this one -- the resize divider in `EditorMarkdown.vue` is what sets it, on
      drag. Carried through `load()`/`save()` regardless: `save()` PUTs a full replacement of this
      user's Markdown settings (see its own comment below), so leaving this out would silently erase
      a saved preview width the next time this overlay's Apply button is used for the two fields it
      DOES expose.
    */
    previewWidth: null
  },
  loading: 0
})

// METHODS

function close() {
  siteStore.$patch({ overlay: '' })
}

async function load() {
  state.loading++
  loading.show()
  try {
    // -> An empty object is the correct answer for a user who has never saved any settings, so the
    //    defaults live here rather than being treated as a failure
    const conf = (await API_CLIENT.get('users/profile/editor-settings/markdown').json()) ?? {}
    state.config.previewShown = conf.previewShown ?? true
    state.config.fontSize = conf.fontSize ?? 16
    state.config.previewWidth = conf.previewWidth ?? null
    editorStore.$patch({ userSettings: { ...editorStore.userSettings, markdown: conf } })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('editor.settings.fetchFailed'),
      caption: err.message
    })
  }
  loading.hide()
  state.loading--
}

async function save() {
  state.loading++
  try {
    // -> Replaces the whole settings object server-side (see the route's own doc comment), so
    //    `previewWidth` rides along unchanged even though nothing on this screen edits it -- see the
    //    comment on `state.config` above.
    const payload = {
      previewShown: state.config.previewShown,
      // -> A number input hands back a string; the editor reads this as a pixel size
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
    // -> ky throws above 400, with the reason in the body
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
