<template>
  <w-page class="admin-flags">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-cashbook.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.editors.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.editors.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="me-2"
          icon="la:question-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/editors`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2"
          icon="la:redo-alt"
          outline
          color="slate-soft"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          unelevated
          icon="mdi:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <div class="p-4 gap-4">
      <w-card>
        <w-list separator>
          <template v-for="editor of editors" :key="editor.id">
            <w-item v-if="flagsStore.experimental || !editor.isDisabled">
              <blueprint-icon :icon="editor.icon" />
              <w-item-section>
                <w-item-label>
                  <strong>{{ t(`admin.editors.` + editor.id + `Name`) }}</strong>
                </w-item-label>
                <w-item-label caption>
                  <span>{{ t(`admin.editors.` + editor.id + `Description`) }}</span>
                </w-item-label>
                <w-item-label caption v-if="editor.useRendering">
                  <em class="text-purple">{{ t('admin.editors.useRenderingPipeline') }}</em>
                </w-item-label>
              </w-item-section>
              <template v-if="editor.hasConfig">
                <w-item-section side>
                  <w-btn
                    icon="la:cog"
                    :label="t(`admin.editors.configuration`)"
                    :color="dark.isActive ? `blue-grey-3` : `blue-grey-8`"
                    outline
                    no-caps
                    padding="xs md"
                    @click="openConfig(editor.id)" />
                </w-item-section>
                <w-separator class="ms-4" vertical />
              </template>
              <w-item-section side>
                <w-toggle
                  class="pe-2"
                  v-model="state.config[editor.id]"
                  :label="t(`admin.sites.isActive`)"
                  :aria-label="t(`admin.sites.isActive`)"
                  :loading="state.loading > 0"
                  :disabled="editor.isDisabled" />
              </w-item-section>
            </w-item>
          </template>
        </w-list>
      </w-card>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { reactive } from 'vue'

import { useAdminSettings } from '@/composables/adminSettings'
import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { useSiteAdminAccess } from '@/composables/siteAdminAccess'

import { useAdminStore } from '@/stores/admin'
import { useFlagsStore } from '@/stores/flags'
import { useSiteStore } from '@/stores/site'

// COMPOSABLES

const dark = useDark()
// -> Task #684: gates this page behind `site:editors` (or `manage:sites`), redirecting away from a
//    site the caller may not administer. See `composables/siteAdminAccess.js`.
useSiteAdminAccess('site:editors')

// STORES

const adminStore = useAdminStore()
const flagsStore = useFlagsStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.editors.title')
}))

// -> Task 492: `api`/`blog`/`channel` rows removed. None had a backing `EDITOR_CONTENT_TYPES` entry
//    (backend/models/pages.ts), schema property (backend/api/schemas/site.ts), or reachable
//    `editorComponents` registration (Index.vue) -- they were unbacked speculation, visible under the
//    experimental flag but non-functional even when toggled on. `channel`'s only artifact,
//    `EditorChannel.vue` (79 lines of Options-API mock data, never imported anywhere reachable), has
//    been deleted outright. `channel`-style real-time discussion channels are filed as stretch-goal
//    Feature #786 under the Comments epic (OpenProject #335) for a future cycle to pick up if it
//    wants to; `api` (API-docs editor) and `blog` (a series-of-posts editor) had no plausible
//    near-term epic home identified and are dropped with no follow-up.
function defaultConfig() {
  return {
    asciidoc: false,
    code: false,
    markdown: false,
    redirect: true,
    wysiwyg: false
  }
}

/** The editors as the API expects them, and as `siteStore` holds them. */
function activeFlags(config) {
  return {
    asciidoc: config.asciidoc,
    code: config.code,
    markdown: config.markdown,
    wysiwyg: config.wysiwyg
  }
}

const { state, load, save } = useAdminSettings({
  i18nPrefix: 'admin.editors',
  // -> This page's own stem for the load failure, from before `loadFailed` was the convention
  keys: { loadFailed: 'admin.editors.fetchFailed' },
  defaults: defaultConfig,
  fetch: (siteId) => API_CLIENT.get(`sites/${siteId}?strict=true`).json(),
  pick: (site) => ({
    asciidoc: site?.editors?.asciidoc?.isActive ?? false,
    code: site?.editors?.code?.isActive ?? false,
    markdown: site?.editors?.markdown?.isActive ?? false,
    wysiwyg: site?.editors?.wysiwyg?.isActive ?? false
  }),
  // -> Only `isActive` is sent, so each editor's own `config` is left untouched by the merge
  commit: (siteId, config) => {
    const flags = activeFlags(config)
    return API_CLIENT.put(`sites/${siteId}`, {
      json: {
        editors: {
          asciidoc: { isActive: flags.asciidoc },
          code: { isActive: flags.code },
          markdown: { isActive: flags.markdown },
          wysiwyg: { isActive: flags.wysiwyg }
        }
      }
    }).json()
  },
  onSavedCurrentSite: (config) => {
    siteStore.$patch({ editors: activeFlags(config) })
  }
})

const editors = reactive([
  {
    id: 'asciidoc',
    icon: 'asciidoc',
    // -> Task 491: a real, if minimal, editor exists (`EditorAsciidoc.vue`) storing raw AsciiDoc
    //    source with a matching `contentType` -- see `base.yml`/`models/pages.ts`. OpenProject #988
    //    added the AsciiDoc-to-HTML render pipeline (`renderers/asciidoc.js`), so `useRendering` is on
    //    like `markdown`'s and `code`'s. No `hasConfig`: it has no configuration overlay, matching the
    //    equally no-frills `code` row -- and unlike `markdown`, still no live preview pane; the
    //    description below says so.
    useRendering: true
  },
  {
    id: 'code',
    icon: 'html',
    useRendering: true
  },
  {
    id: 'markdown',
    icon: 'markdown',
    hasConfig: true,
    useRendering: true
  },
  {
    id: 'redirect',
    icon: 'advance',
    isDisabled: true,
    useRendering: false
  },
  {
    id: 'wysiwyg',
    icon: 'google-presentation',
    isDisabled: true,
    useRendering: true
  }
])

// METHODS

function openConfig(editorId) {
  switch (editorId) {
    case 'markdown': {
      adminStore.$patch({
        overlayOpts: {},
        overlay: 'EditorMarkdownConfig'
      })
      break
    }
    default: {
      notify({
        type: 'negative',
        message: t('admin.editors.invalidConfigCall')
      })
    }
  }
}
</script>

<style lang="scss"></style>
