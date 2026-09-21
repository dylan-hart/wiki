<template>
  <w-page class="page-version flex flex-col h-full min-h-0">
    <div v-if="state.error" class="page-version-placeholder" role="alert">
      <w-icon class="page-version-placeholder-icon" name="tabler:history" />
      <div class="text-h6">{{ errorMessage }}</div>
    </div>
    <template v-else-if="state.version">
      <div class="page-version-bar flex flex-wrap items-center gap-2 px-4">
        <w-icon name="tabler:history" />
        <span class="page-version-snapshot font-bold">
          {{ t('history.versionLink.snapshot', { date: versionDate }) }}
        </span>
        <span v-if="state.version.author?.name" class="page-version-author">
          {{ t('history.versionLink.author', { name: state.version.author.name }) }}
        </span>
        <w-space />
        <w-btn
          flat
          dense
          icon="tabler:arrow-right"
          color="primary"
          :label="t('history.versionLink.viewCurrent')"
          :to="currentPagePath" />
      </div>
      <h1 class="page-version-title px-4 pt-4">{{ state.version.title }}</h1>
      <w-scroll-area class="page-version-scroller" style="flex: 1 1 100%">
        <div class="page-container-body">
          <pre v-if="isPlainSource" class="page-version-source" v-text="state.version.content" />
          <div v-else class="page-contents" v-html="state.renderedHtml" />
        </div>
      </w-scroll-area>
    </template>
  </w-page>
</template>

<script setup>
import { computed, onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import DOMPurify from 'dompurify'

import { useMeta } from '@/composables/meta'
import { MarkdownRenderer } from '@/renderers/markdown'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { apiErrorBody } from '@/helpers/apiError'
import { humanizeDate } from '@/helpers/datetime'
import { localizedPagePath } from '@/helpers/pagePaths'
import { log } from '@/helpers/log'

const { t } = useI18n()
const route = useRoute()
const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()

const state = reactive({
  version: null,
  renderedHtml: '',
  error: ''
})

useMeta(() => ({ title: state.version?.title || t('history.title') }))

const versionDate = computed(() => humanizeDate(t, state.version?.versionDate))

const isPlainSource = computed(() => !['markdown', 'html'].includes(state.version?.contentType))

const currentPagePath = computed(() =>
  state.version?.page
    ? localizedPagePath(state.version.page.path, state.version.page.locale, siteStore.localeRouting)
    : '/'
)

const errorMessage = computed(() => t(`history.versionLink.${state.error}`))

async function renderVersion(version) {
  if (version.contentType === 'html') {
    return DOMPurify.sanitize(version.content)
  }
  if (version.contentType !== 'markdown') {
    return ''
  }
  await editorStore.ensureConfigs()
  const html = new MarkdownRenderer(editorStore.editors.markdown ?? {}).render(version.content, {
    pagePath: version.page.path
  })
  return DOMPurify.sanitize(html)
}

function errorKeyFor(err) {
  const status = err?.response?.status
  if (status === 404) {
    return 'notFound'
  }
  if (status === 403) {
    return /password protected/i.test(apiErrorBody(err)?.message ?? '') ? 'locked' : 'forbidden'
  }
  return 'loadFailed'
}

onMounted(async () => {
  try {
    const version = await pageStore.pageVersionById(route.params.id)
    state.renderedHtml = await renderVersion(version)
    state.version = version
  } catch (err) {
    state.error = errorKeyFor(err)
    if (state.error === 'loadFailed') {
      log.warn('page', 'could not load the page version', err)
    }
  }
})
</script>

<style>
.page-version-bar {
  min-height: 41px;
  border-bottom: 1px solid var(--color-hairline, rgba(0, 0, 0, 0.12));
}
.page-version-author {
  opacity: 0.7;
}
.page-version-title {
  font-size: 1.75rem;
  font-weight: 500;
}
.page-version-source {
  white-space: pre-wrap;
  font-family: 'Roboto Mono', monospace;
  font-size: 0.85rem;
}
.page-version-placeholder {
  display: flex;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 24px 10vh;
  text-align: center;
}
.page-version-placeholder-icon {
  margin-bottom: 24px;
  font-size: 96px;
  opacity: 0.12;
}
</style>
