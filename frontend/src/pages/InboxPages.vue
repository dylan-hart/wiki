<template>
  <w-page>
    <div class="w-section-header">{{ t('inbox.pages') }}</div>
    <div class="px-4 pb-4">
      <div class="text-body2">{{ t('inbox.pagesInfo') }}</div>

      <w-banner
        v-if="state.failed"
        class="mt-6"
        :class="dark.isActive ? `bg-dark-4 text-grey-4` : `bg-grey-2 text-grey-8`"
        data-test="pages-error">
        <div>{{ t('inbox.pagesLoadFailed') }}</div>
        <template #action>
          <w-btn
            flat
            :label="t('common.actions.refresh')"
            :disabled="state.loading"
            @click="load" />
        </template>
      </w-banner>

      <div v-else-if="!state.loaded" class="mt-6 text-caption" data-test="pages-loading">
        {{ t('common.loading') }}
      </div>

      <template v-else>
        <w-list v-if="continueEntry" class="mt-6" bordered data-test="pages-continue">
          <w-item clickable @click="openPage(continueEntry)">
            <w-item-section avatar>
              <w-avatar
                identity="plate"
                :color="dark.isActive ? `accent-dark` : `accent-fill`"
                text-color="white">
                <w-icon name="tabler:player-play" />
              </w-avatar>
            </w-item-section>
            <w-item-section>
              <w-item-label>
                <strong>{{ t('inbox.pagesContinue') }}</strong>
              </w-item-label>
              <w-item-label caption>{{ continueEntry.title }}</w-item-label>
            </w-item-section>
          </w-item>
        </w-list>

        <w-banner
          v-if="sections.length < 1"
          class="mt-6"
          :class="dark.isActive ? `bg-dark-4 text-grey-4` : `bg-grey-2 text-grey-8`"
          data-test="pages-empty">
          <div>{{ t('inbox.pagesNone') }}</div>
          <div class="text-caption mt-1 opacity-70">{{ t('inbox.pagesHint') }}</div>
        </w-banner>

        <section
          v-for="section of sections"
          :key="section.kind"
          class="mt-6"
          :data-test="`pages-${section.kind}`">
          <div class="text-subtitle2 mb-2 flex items-center gap-2">
            <w-icon :name="section.icon" size="16px" />
            <span>{{ section.title }}</span>
          </div>
          <w-list bordered separator>
            <w-item
              v-for="entry of section.entries"
              :key="`${section.kind}:${entry.pageId}`"
              clickable
              @click="openPage(entry)">
              <w-item-section avatar>
                <w-avatar identity="plate" color="slate" text-color="white">
                  <w-icon :name="entry.icon || DEFAULT_PAGE_ICON" />
                </w-avatar>
              </w-item-section>
              <w-item-section>
                <w-item-label>
                  <strong>{{ entry.title }}</strong>
                </w-item-label>
                <w-item-label caption>{{
                  localizedPagePath(entry.path, entry.locale, siteStore.localeRouting)
                }}</w-item-label>
                <w-item-label v-if="section.kind === 'recent'" caption>{{
                  t('inbox.pagesVisited', { date: humanizeDate(t, entry.touchedAt) })
                }}</w-item-label>
              </w-item-section>
            </w-item>
          </w-list>
        </section>
      </template>
    </div>
  </w-page>
</template>

<script setup>
import { computed, onMounted, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'

import { DEFAULT_PAGE_ICON, usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { humanizeDate } from '@/helpers/datetime'
import { localizedPagePath } from '@/helpers/pagePaths'

const dark = useDark()
const router = useRouter()

const pageStore = usePageStore()
const siteStore = useSiteStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('inbox.pages')
}))

const state = reactive({
  loading: false,
  loaded: false,
  failed: false,
  pinned: [],
  favorites: [],
  recent: []
})

let latestRequest = 0

const sections = computed(() =>
  [
    { kind: 'pinned', title: t('inbox.pagesPinned'), icon: 'tabler:pin', entries: state.pinned },
    {
      kind: 'favorite',
      title: t('inbox.pagesFavorites'),
      icon: 'tabler:star',
      entries: state.favorites
    },
    { kind: 'recent', title: t('inbox.pagesRecent'), icon: 'tabler:history', entries: state.recent }
  ].filter((section) => section.entries.length > 0)
)

const continueEntry = computed(() => state.recent.find((entry) => entry.pageId !== pageStore.id))

onMounted(load)

async function load() {
  const request = ++latestRequest
  state.loading = true
  state.failed = false
  try {
    const resp = await API_CLIENT.get(`sites/${siteStore.id}/user-pages`).json()
    if (request !== latestRequest) {
      return
    }
    state.pinned = resp?.pinned ?? []
    state.favorites = resp?.favorites ?? []
    state.recent = resp?.recent ?? []
    state.loaded = true
  } catch {
    if (request !== latestRequest) {
      return
    }
    state.failed = true
  }
  state.loading = false
}

function openPage(entry) {
  siteStore.$patch({ overlay: '' })
  router.push(localizedPagePath(entry.path, entry.locale, siteStore.localeRouting))
}
</script>
