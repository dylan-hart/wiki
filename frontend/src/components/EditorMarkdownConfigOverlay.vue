<template>
  <w-layout container>
    <w-header class="card-header px-4 py-2">
      <w-icon name="img:/_assets/icons/ultraviolet-markdown.svg" left size="md" />
      <span>{{ t(`admin.editors.markdownName`) }}</span>
      <w-space />
      <w-btn
        class="me-2"
        flat
        rounded
        color="white"
        :aria-label="t(`common.actions.refresh`)"
        icon="la:question-circle"
        :href="siteStore.docsBase + `/admin/editors/markdown`"
        target="_blank"
        type="a" />
      <w-btn-group>
        <w-btn
          push
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
          push
          color="white"
          text-color="grey-7"
          :label="t(`common.actions.cancel`)"
          :aria-label="t(`common.actions.cancel`)"
          icon="la:times"
          @click="close" />
        <w-btn
          push
          color="positive"
          text-color="white"
          :label="t(`common.actions.save`)"
          :aria-label="t(`common.actions.save`)"
          icon="la:check"
          @click="save"
          :disabled="state.loading > 0" />
      </w-btn-group>
    </w-header>
    <w-page-container>
      <w-page class="p-4" style="max-width: 1200px; margin: 0 auto">
        <w-card class="shadow-1 pb-2">
          <w-card-section>
            <div class="text-subtitle1">{{ t('admin.editors.markdown.general') }}</div>
          </w-card-section>
          <w-item tag="label">
            <blueprint-icon icon="html" />
            <w-item-section>
              <w-item-label>{{ t(`admin.editors.markdown.allowHTML`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.editors.markdown.allowHTMLHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.allowHTML"
                :aria-label="t(`admin.editors.markdown.allowHTML`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="link" />
            <w-item-section>
              <w-item-label>{{ t(`admin.editors.markdown.linkify`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.editors.markdown.linkifyHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.linkify"
                :aria-label="t(`admin.editors.markdown.linkify`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="enter-key" />
            <w-item-section>
              <w-item-label>{{ t(`admin.editors.markdown.lineBreaks`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.editors.markdown.lineBreaksHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.lineBreaks"
                :aria-label="t(`admin.editors.markdown.lineBreaks`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="width" />
            <w-item-section>
              <w-item-label>{{ t(`admin.editors.markdown.tabWidth`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.editors.markdown.tabWidthHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-input
                ref="tabWidthInput"
                type="number"
                min="1"
                max="8"
                style="width: 100px"
                outlined
                v-model.number="state.config.tabWidth"
                dense
                :rules="tabWidthRules"
                lazy-rules="ondemand"
                :aria-label="t(`admin.editors.markdown.tabWidth`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="data-sheet" />
            <w-item-section>
              <w-item-label>{{ t(`admin.editors.markdown.multimdTable`) }}</w-item-label>
              <w-item-label caption>{{
                t(`admin.editors.markdown.multimdTableHint`)
              }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.multimdTable"
                :aria-label="t(`admin.editors.markdown.multimdTable`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="asterisk" />
            <w-item-section>
              <w-item-label>{{ t(`admin.editors.markdown.typographer`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.editors.markdown.typographerHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.typographer"
                :aria-label="t(`admin.editors.markdown.typographer`)" />
            </w-item-section>
          </w-item>
          <template v-if="state.config.typographer">
            <w-separator class="my-2" inset />
            <w-item tag="label">
              <blueprint-icon icon="quote-left" />
              <w-item-section>
                <w-item-label>{{ t(`admin.editors.markdown.quotes`) }}</w-item-label>
                <w-item-label caption>{{ t(`admin.editors.markdown.quotesHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section avatar>
                <w-select
                  style="width: 200px"
                  outlined
                  v-model="state.config.quotes"
                  :options="quoteStyles"
                  emit-value
                  map-options
                  dense
                  options-dense
                  :aria-label="t(`admin.editors.markdown.quotes`)" />
              </w-item-section>
            </w-item>
          </template>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="underline" />
            <w-item-section>
              <w-item-label>{{ t(`admin.editors.markdown.underline`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.editors.markdown.underlineHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.underline"
                :aria-label="t(`admin.editors.markdown.underline`)" />
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
import { onMounted, reactive, ref } from 'vue'

import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

import { useAdminStore } from '@/stores/admin'
import { useEditorStore } from '@/stores/editor'
import { useSiteStore } from '@/stores/site'

import { toMerged } from 'es-toolkit/object'

// STORES

const adminStore = useAdminStore()
const editorStore = useEditorStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

/**
 * Fallbacks for options a site may not have stored yet, so that every control renders with a
 * defined value. Must mirror the markdown defaults used by the backend when creating a site.
 */
function defaultConfig() {
  return {
    allowHTML: true,
    linkify: true,
    lineBreaks: true,
    typographer: false,
    quotes: 'english',
    underline: true,
    tabWidth: 2,
    multimdTable: true
  }
}

const state = reactive({
  config: defaultConfig(),
  loading: 0
})

const quoteStyles = [
  { value: 'chinese', label: 'Chinese' },
  { value: 'english', label: 'English' },
  { value: 'french', label: 'French' },
  { value: 'german', label: 'German' },
  { value: 'greek', label: 'Greek' },
  { value: 'japanese', label: 'Japanese' },
  { value: 'hungarian', label: 'Hungarian' },
  { value: 'polish', label: 'Polish' },
  { value: 'portuguese', label: 'Portuguese' },
  { value: 'russian', label: 'Russian' },
  { value: 'spanish', label: 'Spanish' },
  { value: 'swedish', label: 'Swedish' }
]

const tabWidthInput = ref(null)

/**
 * `min`/`max` on the native control stop the spinner, not a pasted value -- and, unlike most numeric
 * settings in this app, tab width is also stored with nothing enforcing its shape server-side:
 * `backend/api/schemas/site.ts` types `editors.markdown.config` as `additionalProperties: true`, so
 * a `0` or a pasted-in string genuinely persists.
 */
const tabWidthRules = [
  (val) =>
    (Number.isInteger(val) && val >= 1 && val <= 8) || t('admin.editors.markdown.tabWidthInvalid')
]

// METHODS

function close() {
  adminStore.$patch({ overlay: '' })
}

async function load() {
  state.loading++
  loading.show()
  try {
    const resp = await API_CLIENT.get(`sites/${adminStore.currentSiteId}?strict=true`).json()
    if (!resp?.editors?.markdown?.config) {
      throw new Error(t('admin.editors.markdown.fetchFailed'))
    }
    state.config = toMerged(defaultConfig(), resp.editors.markdown.config)
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.editors.markdown.fetchFailed')
    })
  }
  loading.hide()
  state.loading--
}

async function save() {
  if (tabWidthInput.value && !tabWidthInput.value.validate()) {
    return
  }
  state.loading++
  try {
    // -> Only `config` is sent, so the editor's active state is left untouched by the merge
    const resp = await API_CLIENT.put(`sites/${adminStore.currentSiteId}`, {
      json: {
        editors: {
          markdown: { config: state.config }
        }
      }
    }).json()
    notify({
      type: 'positive',
      message: t('admin.editors.markdown.saveSuccess')
    })
    editorStore.$patch({ configIsLoaded: false })
    close()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.editors.markdown.saveFailed'),
      caption: t(
        `admin.editors.markdown.${err.data?.error}`,
        apiErrorMessage(err, t('common.error.unexpected'))
      )
    })
  }
  state.loading--
}

onMounted(() => {
  load()
})
</script>
