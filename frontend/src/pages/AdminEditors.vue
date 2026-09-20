<template>
  <w-page class="admin-flags">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:writing" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.editors.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.editors.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="me-2"
          icon="tabler:help-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/editors`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2"
          icon="tabler:refresh"
          outline
          color="slate-soft"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          icon="tabler:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <div class="p-4 gap-4">
      <w-settings-card :title="t('admin.editors.title')">
        <template v-for="editor of editors" :key="editor.id">
          <w-settings-row
            v-if="flagsStore.experimental || !editor.isDisabled"
            control-width="auto"
            :icon="editor.icon"
            :label="t(`admin.editors.` + editor.id + `Name`)">
            <template #hint>
              <div>{{ t(`admin.editors.` + editor.id + `Description`) }}</div>
              <em v-if="editor.useRendering" class="text-purple">{{
                t('admin.editors.useRenderingPipeline')
              }}</em>
            </template>
            <div class="flex items-center gap-3">
              <w-btn
                v-if="editor.hasConfig"
                icon="tabler:settings"
                :label="t(`admin.editors.configuration`)"
                :color="dark.isActive ? `blue-grey-3` : `blue-grey-8`"
                outline
                padding="xs md"
                @click="openConfig(editor.id)" />
              <w-toggle
                v-model="state.config[editor.id]"
                :label="t(`admin.sites.isActive`)"
                :aria-label="t(`admin.sites.isActive`)"
                :loading="state.loading > 0"
                :disabled="editor.isDisabled" />
            </div>
          </w-settings-row>
        </template>
      </w-settings-card>
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
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const dark = useDark()
useSiteAdminAccess('site:editors')

const adminStore = useAdminStore()
const flagsStore = useFlagsStore()
const siteStore = useSiteStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.editors.title')
}))

function defaultConfig() {
  return {
    asciidoc: false,
    code: false,
    markdown: false,
    redirect: true,
    wysiwyg: false
  }
}

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
  // -> This page's load-failure string does not follow the `loadFailed` convention
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

/*
  Each `icon` is a literal Iconify reference so `scripts/generate-icons.mjs` can see it and inline
  the glyph: a name built by concatenation is invisible to that scanner, and `WIcon` draws nothing
  at all for a name carrying no set prefix.
*/
const editors = reactive([
  {
    id: 'asciidoc',
    icon: 'tabler:file-text',
    useRendering: true
  },
  {
    id: 'code',
    icon: 'tabler:code',
    useRendering: true
  },
  {
    id: 'markdown',
    icon: 'tabler:markdown',
    hasConfig: true,
    useRendering: true
  },
  {
    id: 'redirect',
    icon: 'tabler:arrow-ramp-right',
    isDisabled: true,
    useRendering: false
  },
  {
    id: 'wysiwyg',
    icon: 'tabler:forms',
    isDisabled: true,
    useRendering: true
  }
])

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

<style></style>
