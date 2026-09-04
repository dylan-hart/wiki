<template>
  <!--
    `h-full` so the card fills the side panel, matching `PagePropertiesDialog` -- an auto-height card
    against the scroll area's `calc(100% - 50px)` would otherwise resolve to `auto` and let the card
    grow past the panel instead of scrolling inside it.
  -->
  <w-card class="page-backlinks-dialog h-full relative">
    <w-toolbar class="bg-primary text-white flex">
      <div class="text-subtitle2">{{ t('editor.backlinks.title') }}</div>
      <w-space />
      <w-btn
        icon="la:times"
        dense
        flat
        :aria-label="t(`common.actions.close`)"
        @click="siteStore.sideDialogShown = false" />
    </w-toolbar>
    <w-scroll-area style="height: calc(100% - 50px)">
      <div v-if="!state.isLoading && state.backlinks.length < 1" class="text-center py-6">
        <w-icon name="la:info-circle" size="sm" class="me-1" />
        <span class="text-caption">{{ t('editor.backlinks.empty') }}</span>
      </div>
      <w-list v-else separator>
        <w-item
          v-for="item of state.backlinks"
          :key="item.id ?? item.path"
          clickable
          :to="localizedPagePath(item.path, item.locale, siteStore.localeRouting)">
          <w-item-section avatar>
            <w-icon :name="item.icon || DEFAULT_PAGE_ICON" />
          </w-item-section>
          <w-item-section>
            <w-item-label lines="1">{{ item.title }}</w-item-label>
            <w-item-label class="text-grey" caption lines="1">/{{ item.path }}</w-item-label>
          </w-item-section>
        </w-item>
      </w-list>
    </w-scroll-area>
    <w-inner-loading :showing="state.isLoading" size="38px" spinner-class="text-accent" />
  </w-card>
</template>

<script setup>
import { onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'

import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { localizedPagePath } from '@/helpers/pagePaths'

import { DEFAULT_PAGE_ICON, usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

/** The pages that link to the page currently open, plus whether that list is still loading. */
const state = reactive({
  isLoading: false,
  backlinks: []
})

// METHODS

/**
 * Fetches every page linking to the one currently open (`GET
 * sites/:siteId/pages/:pageId/backlinks`, OpenProject #1914) -- already filtered server-side through
 * `read:pages` per source row, so every entry here is safe to link to directly.
 */
async function load() {
  state.isLoading = true
  try {
    state.backlinks = await API_CLIENT.get(
      `sites/${siteStore.id}/pages/${pageStore.id}/backlinks`
    ).json()
  } catch (err) {
    notify({ type: 'negative', message: apiErrorMessage(err) })
  }
  state.isLoading = false
}

// MOUNTED

onMounted(() => {
  load()
})
</script>
