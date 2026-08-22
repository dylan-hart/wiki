<template>
  <w-page>
    <div class="flex flex-wrap items-center p-4">
      <div class="flex-none">
        <img
          class="admin-icon animated fadeInLeft"
          src="/_assets/icons/fluent-find-and-replace-animated.svg" />
      </div>
      <div class="min-w-0 flex-1 pl-4">
        <div class="text-h5 text-primary animated fadeInLeft">{{ t('admin.glossary.title') }}</div>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.glossary.subtitle') }}
        </div>
      </div>
      <div class="flex flex-none">
        <w-btn
          class="mr-2 acrylic-btn"
          icon="la:question-circle"
          flat
          color="grey"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/glossary`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="acrylic-btn mr-2"
          icon="la:redo-alt"
          flat
          color="secondary"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          unelevated
          icon="la:plus"
          :label="t(`admin.glossary.newTerm`)"
          color="primary"
          @click="createTerm" />
      </div>
    </div>
    <w-separator inset />
    <div class="p-4">
      <w-banner
        v-if="state.terms.length < 1 && state.loading < 1"
        rounded
        :class="dark.isActive ? `bg-dark-3 text-grey-4` : `bg-grey-2 text-grey-8`">
        {{ t('admin.glossary.noTerms') }}
      </w-banner>
      <w-card v-else>
        <w-list separator>
          <w-item v-for="term of state.terms" :key="term.id">
            <blueprint-icon icon="quote-left" />
            <w-item-section>
              <w-item-label>
                <strong>{{ term.term }}</strong>
              </w-item-label>
              <w-item-label caption>{{ term.definition }}</w-item-label>
              <div v-if="term.aliases?.length" class="flex flex-wrap gap-1 mt-1">
                <w-chip v-for="alias of term.aliases" :key="alias" square dense>{{ alias }}</w-chip>
              </div>
              <w-item-label v-if="term.pageId" caption>
                <w-icon name="la:link" size="12px" class="mr-1" />
                {{ pageLabel(term.pageId) }}
              </w-item-label>
            </w-item-section>
            <w-separator class="ml-4" vertical />
            <w-item-section side style="flex-direction: row; align-items: center">
              <w-btn
                class="acrylic-btn mr-2"
                flat
                @click="editTerm(term)"
                icon="la:pen"
                :color="dark.isActive ? `indigo-4` : `indigo`"
                :label="t(`common.actions.edit`)"
                no-caps />
              <w-btn
                class="acrylic-btn"
                flat
                icon="la:trash"
                color="negative"
                @click="deleteTerm(term)"
                :aria-label="t(`common.actions.delete`)" />
            </w-item-section>
          </w-item>
        </w-list>
      </w-card>
    </div>
    <w-inner-loading :showing="state.loading > 0" />
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { onMounted, reactive, watch } from 'vue'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { confirm, dialog } from '@/composables/dialog'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'

import GlossaryTermDialog from '@/components/GlossaryTermDialog.vue'
import { apiErrorMessage } from '@/helpers/apiError'

/*
  No `useSiteAdminAccess()` here: that composable exists for the nine surfaces
  `composables/siteAdminAccess.js`'s `GLOBAL_FALLBACKS` names, none of which is this one. Glossary is
  gated the same way `AdminComments.vue` / `AdminAnalytics.vue` are -- the sidebar entry checks
  `manage:sites` (see `AdminLayout.vue`), and the API route enforces the same permission server-side;
  there is no client-side redirect to add on top for a page that carries no additional site-admin
  delegation of its own.
*/

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta({
  title: t('admin.glossary.title')
})

// DATA

const state = reactive({
  loading: 0,
  terms: [],
  /** Candidates for the canonical-page picker, and what a term row's own `pageId` is resolved
   *  against for display -- see `load()`'s own note on why this is capped. */
  pages: []
})

// WATCHERS

watch(() => adminStore.currentSiteId, load)

// METHODS

/** A term's canonical page, by title -- falling back to the raw id when it isn't one of the
 *  candidates `load()` fetched (a wiki with more pages than that cap holds). */
function pageLabel(pageId) {
  return state.pages.find((p) => p.id === pageId)?.title ?? pageId
}

async function load() {
  if (!adminStore.currentSiteId) {
    return
  }
  state.loading++
  try {
    // -> The page picker has no live search (see `GlossaryTermDialog.vue`'s own note on `w-select`'s
    //    scope), so this is a fixed, alphabetical top slice rather than every page on the site.
    const [terms, pageResults] = await Promise.all([
      API_CLIENT.get(`sites/${adminStore.currentSiteId}/glossary`).json(),
      API_CLIENT.get(`sites/${adminStore.currentSiteId}/pages/search`, {
        searchParams: { orderBy: 'title', orderByDirection: 'asc', limit: 100 }
      }).json()
    ])
    state.terms = terms ?? []
    state.pages = pageResults?.results ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.glossary.loadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
}

function createTerm() {
  dialog({
    component: GlossaryTermDialog,
    componentProps: {
      siteId: adminStore.currentSiteId,
      pages: state.pages
    }
  }).onOk(load)
}

function editTerm(term) {
  dialog({
    component: GlossaryTermDialog,
    componentProps: {
      siteId: adminStore.currentSiteId,
      pages: state.pages,
      term
    }
  }).onOk(load)
}

function deleteTerm(term) {
  confirm({
    title: t('admin.glossary.deleteTerm'),
    message: t('admin.glossary.deleteTermConfirm', { term: term.term }),
    cancel: true,
    color: 'negative',
    okLabel: t('common.actions.delete')
  }).onOk(async () => {
    state.loading++
    try {
      await API_CLIENT.delete(`sites/${adminStore.currentSiteId}/glossary/${term.id}`).json()
      notify({
        type: 'positive',
        message: t('admin.glossary.deleteSuccess')
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.glossary.deleteFailed'),
        caption: apiErrorMessage(err)
      })
    }
    state.loading--
    await load()
  })
}

// MOUNTED

onMounted(load)
</script>
