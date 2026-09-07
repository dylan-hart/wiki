<template>
  <w-page class="admin-pageviews">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:eye" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.pageviews.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.pageviews.subtitle') }}
        </div>
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center">
          <template v-if="state.enabled">
            <w-signal class="me-2" color="green" size="md" />
            <div class="text-caption text-green">{{ t('admin.pageviews.enabled') }}</div>
          </template>
          <template v-else>
            <w-signal class="me-2" color="red" size="md" />
            <div class="text-caption text-red">{{ t('admin.pageviews.disabled') }}</div>
          </template>
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="acrylic-btn me-2"
          icon="tabler:refresh"
          flat
          color="slate"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="refresh">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2"
          icon="tabler:power"
          :label="!state.enabled ? t(`common.actions.activate`) : t(`common.actions.deactivate`)"
          :color="!state.enabled ? `positive` : `negative`"
          @click="globalSwitch"
          :loading="state.isToggleLoading"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12">
        <w-card
          class="rounded"
          :class="dark.isActive ? `bg-dark-5 text-white` : `bg-grey-3 text-dark`">
          <w-card-section class="items-center" horizontal>
            <w-card-section class="flex-none pe-0">
              <w-icon name="tabler:info-circle" size="sm" />
            </w-card-section>
            <w-card-section>
              {{ t('admin.pageviews.description') }}
            </w-card-section>
          </w-card-section>
        </w-card>
      </div>
      <div class="col-span-12" v-if="state.summary.totalViews === 0">
        <w-card class="rounded">
          <w-card-section class="items-center" horizontal>
            <w-card-section class="flex-none pe-0">
              <w-icon name="tabler:chart-area" size="sm" />
            </w-card-section>
            <w-card-section>
              {{ t('admin.pageviews.noViewsYet') }}
            </w-card-section>
          </w-card-section>
        </w-card>
      </div>
      <template v-else>
        <div class="col-span-6 sm:col-span-3">
          <w-card class="rounded pageviews-stat">
            <w-card-section>
              <div class="pageviews-stat-label">{{ t('admin.pageviews.totalViews') }}</div>
              <div class="pageviews-stat-figure">{{ state.summary.totalViews }}</div>
            </w-card-section>
          </w-card>
        </div>
        <div class="col-span-6 sm:col-span-3">
          <w-card class="rounded pageviews-stat">
            <w-card-section>
              <div class="pageviews-stat-label">{{ t('admin.pageviews.last24h') }}</div>
              <div class="pageviews-stat-figure">{{ state.summary.last24h }}</div>
            </w-card-section>
          </w-card>
        </div>
        <div class="col-span-6 sm:col-span-3">
          <w-card class="rounded pageviews-stat">
            <w-card-section>
              <div class="pageviews-stat-label">{{ t('admin.pageviews.last7d') }}</div>
              <div class="pageviews-stat-figure">{{ state.summary.last7d }}</div>
            </w-card-section>
          </w-card>
        </div>
        <div class="col-span-6 sm:col-span-3">
          <w-card class="rounded pageviews-stat">
            <w-card-section>
              <div class="pageviews-stat-label">{{ t('admin.pageviews.distinctPages') }}</div>
              <div class="pageviews-stat-figure">{{ state.summary.distinctPages }}</div>
            </w-card-section>
          </w-card>
        </div>
        <div class="col-span-12">
          <div class="pageviews-stat-label">
            {{ t('admin.pageviews.mostRecentView') }}:
            {{ relativeDate(state.summary.mostRecentAt) }}
          </div>
        </div>
        <div class="col-span-12">
          <w-card class="rounded">
            <w-table
              :rows="pageviewsTable.rows"
              :columns="pageviewsColumns"
              row-key="pageId"
              flat
              :loading="pageviewsTable.loading">
              <template #body-cell-title="props">
                <w-td :props="props">
                  <div>{{ props.row.title }}</div>
                  <div class="text-caption text-grey">/{{ props.row.path }}</div>
                </w-td>
              </template>
            </w-table>
          </w-card>
        </div>
      </template>
    </div>
  </w-page>
</template>

<script setup>
import { onMounted, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useAdminSettings } from '@/composables/adminSettings'
import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { relativeDate } from '@/helpers/datetime'

import { useAdminStore } from '@/stores/admin'
import { apiErrorMessage } from '@/helpers/apiError'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.pageviews.title')
}))

// DATA

const { state, load, refresh } = useAdminSettings({
  i18nPrefix: 'admin.pageviews',
  // -> Instance-wide, not one site's: no site picker, no reload on switching site
  siteScoped: false,
  extraState: {
    enabled: false,
    isToggleLoading: false,
    // -> Instance-wide evidence that tracking is actually recording something (OpenProject #2335),
    //    not just the on/off state above -- see `admin.pageviews.*` template block.
    summary: {
      totalViews: 0,
      last24h: 0,
      last7d: 0,
      distinctPages: 0,
      mostRecentAt: null
    }
  },
  fetch: () => API_CLIENT.get('system/pageviews').json(),
  onLoaded: (resp) => {
    state.enabled = resp?.isEnabled === true
    // -> Keeps the sidebar status light in step without another round trip
    adminStore.info.isPageviewsEnabled = state.enabled
    state.summary = {
      totalViews: resp?.summary?.totalViews ?? 0,
      last24h: resp?.summary?.last24h ?? 0,
      last7d: resp?.summary?.last7d ?? 0,
      distinctPages: resp?.summary?.distinctPages ?? 0,
      mostRecentAt: resp?.summary?.mostRecentAt ?? null
    }
  }
})

// PER-PAGE TABLE
//
// Kept independent of `useAdminSettings` above: the toggle/summary panel is instance-wide
// (`siteScoped: false`), but a per-page breakdown only makes sense for one site's own pages, so
// this fetches and reloads off `adminStore.currentSiteId` -- the admin-wide site switcher every
// admin page shares -- without pulling the toggle/summary into a reload on every site switch too.

const pageviewsColumns = [
  {
    label: t('admin.pageviews.columnPage'),
    align: 'left',
    field: 'title',
    name: 'title',
    sortable: true
  },
  {
    label: t('admin.pageviews.columnTotal'),
    align: 'right',
    field: 'total',
    name: 'total',
    sortable: true
  },
  {
    label: t('admin.pageviews.columnBrowser'),
    align: 'right',
    field: 'browser',
    name: 'browser',
    sortable: true
  },
  {
    label: t('admin.pageviews.columnMcp'),
    align: 'right',
    field: 'mcp',
    name: 'mcp',
    sortable: true
  },
  {
    label: t('admin.pageviews.columnApi'),
    align: 'right',
    field: 'api',
    name: 'api',
    sortable: true
  }
]

const pageviewsTable = reactive({
  rows: [],
  loading: false
})

async function loadPageviewsTable() {
  // -> Same "no site chosen, nothing to address a request to" guard `useAdminSettings` applies to
  //    a site-scoped page's own load.
  if (!adminStore.currentSiteId) {
    return
  }
  pageviewsTable.loading = true
  try {
    pageviewsTable.rows = await API_CLIENT.get(`sites/${adminStore.currentSiteId}/pageviews`).json()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.pageviews.tableLoadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  pageviewsTable.loading = false
}

watch(() => adminStore.currentSiteId, loadPageviewsTable)
onMounted(loadPageviewsTable)

// METHODS

async function globalSwitch() {
  state.isToggleLoading = true
  const wanted = !state.enabled
  try {
    await API_CLIENT.put('system/pageviews', {
      json: { isEnabled: wanted }
    }).json()
    notify({
      type: 'positive',
      message: wanted
        ? t('admin.pageviews.toggleStateEnabledSuccess')
        : t('admin.pageviews.toggleStateDisabledSuccess')
    })
    await load()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.pageviews.toggleStateFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.isToggleLoading = false
}
</script>

<style scoped>
/*
  A counter card's label and figure. `text-caption`/`text-h5` before -- and `text-h5` is what the
  heading-hierarchy scan (`pageTitleHeadings.test.js`) looks for, correctly: these are numbers, not
  headings, and sizing them with a heading class is exactly the pseudo-heading that scan exists to
  catch. Cardinal sets a figure in Barlow Condensed in the accent, as the dashboard's own counter
  cards do.
*/
.pageviews-stat-label {
  font-size: 12px;
  letter-spacing: 0.03333em;
  color: var(--color-text-caption);
}

:global(body.body--dark .pageviews-stat-label) {
  color: var(--color-text-caption-dark);
}

.pageviews-stat-figure {
  font-family: var(--font-display);
  font-size: 30px;
  font-weight: 700;
  line-height: 1.1;
  color: var(--color-accent);
}
</style>
