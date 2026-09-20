<template>
  <w-page class="admin-pages-deleted">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:trash" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">
          {{ t('history.recovery.title') }}
        </h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('history.recovery.subtitle') }}
        </div>
      </div>
      <div class="flex flex-none">
        <w-btn
          class="acrylic-btn"
          icon="tabler:refresh"
          flat
          color="slate"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <div class="p-4">
      <w-card>
        <w-table
          :rows="state.rows"
          :columns="headers"
          row-key="id"
          flat
          hide-header
          :loading="state.loading > 0">
          <template #no-data>
            <!--
              An empty list is the normal starting state: a deletion also drops off this list once it
              has been recovered, or once an unrelated new page takes its path.
            -->
            <w-banner :class="dark.isActive ? `bg-dark-3 text-grey-4` : `bg-grey-2 text-grey-8`">
              {{ t('history.recovery.none') }}
            </w-banner>
          </template>
          <template #body-cell-title="props">
            <w-td :props="props">
              <strong>{{ props.value }}</strong>
              <div class="text-caption text-grey font-robotomono">/{{ props.row.path }}</div>
            </w-td>
          </template>
          <template #body-cell-locale="props">
            <w-td :props="props">
              <w-badge outline color="grey-6" :label="props.value" />
            </w-td>
          </template>
          <template #body-cell-deletedAt="props">
            <w-td :props="props">
              <div>{{ humanizeDate(t, props.value) }}</div>
              <div class="text-caption text-grey">{{ relativeDate(props.value) }}</div>
            </w-td>
          </template>
          <template #body-cell-deletedBy="props">
            <w-td :props="props">{{ authorLabel(props.row) }}</w-td>
          </template>
          <template #body-cell-actions="props">
            <w-td :props="props">
              <w-btn
                class="acrylic-btn"
                flat
                icon="tabler:arrow-back-up"
                :color="dark.isActive ? `indigo-4` : `indigo`"
                :label="t(`history.recovery.recover`)"
                :disabled="state.loading > 0"
                @click="confirmRecover(props.row)" />
            </w-td>
          </template>
        </w-table>
      </w-card>
    </div>
  </w-page>
</template>

<script setup>
import { defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import { useAdminSettings } from '@/composables/adminSettings'
import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { confirm, dialog } from '@/composables/dialog'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'

import { humanizeDate, relativeDate } from '@/helpers/datetime'
import { apiErrorMessage } from '@/helpers/apiError'
import { localizedPagePath } from '@/helpers/pagePaths'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

/**
 * The server hands back only the rows this admin may read the history of, so there is no
 * partial-access state to explain here: an empty list and a list this admin has no rows in look
 * identical on purpose.
 *
 * `GET .../pages/deleted` is keyset-paginated on `versionDate`, and `fetchAllRecoverable` pages
 * through it to show the whole list at once. Stop on `nextCursor === null`, never on a short page --
 * that permission filter can shrink one page below the requested limit while rows remain.
 */

const dark = useDark()

const adminStore = useAdminStore()
const siteStore = useSiteStore()

const router = useRouter()

const { t } = useI18n()

useMeta(() => ({
  title: t('history.recovery.title')
}))

const { state, load } = useAdminSettings({
  i18nPrefix: 'history.recovery',
  // -> A listing, not a settings form: the header's refresh button carries the progress, so reading
  //    the rows does not raise the full-screen overlay.
  overlay: false,
  extraState: {
    rows: [],
    activeLocales: []
  },
  // -> The locale picker has to offer what the site accepts now, not what the deleted page carried.
  fetch: (siteId) =>
    Promise.all([fetchAllRecoverable(), API_CLIENT.get(`sites/${siteId}?strict=true`).json()]),
  onLoaded: ([rows, site]) => {
    state.rows = rows ?? []
    state.activeLocales = site?.locales?.active ?? []
  }
})

const headers = [
  {
    label: t('history.recovery.colTitle'),
    align: 'left',
    field: 'title',
    name: 'title',
    sortable: true
  },
  {
    label: t('history.recovery.colLocale'),
    align: 'left',
    field: 'locale',
    name: 'locale',
    sortable: true,
    style: 'width: 90px'
  },
  {
    label: t('history.recovery.colDeletedAt'),
    align: 'left',
    field: 'versionDate',
    name: 'deletedAt',
    sortable: true,
    style: 'width: 220px'
  },
  {
    label: t('history.recovery.colDeletedBy'),
    align: 'left',
    field: 'author',
    name: 'deletedBy',
    sortable: false,
    style: 'width: 200px'
  },
  {
    label: '',
    align: 'right',
    field: 'actions',
    name: 'actions',
    sortable: false,
    style: 'width: 160px'
  }
]

function authorLabel(row) {
  return row.author?.name || row.author?.email || t('history.unknownAuthor')
}

async function fetchAllRecoverable() {
  const rows = []
  let cursor
  for (;;) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    const page = await API_CLIENT.get(
      `sites/${adminStore.currentSiteId}/pages/deleted${query}`
    ).json()
    rows.push(...(page?.items ?? []))
    cursor = page?.nextCursor ?? null
    if (!cursor) {
      return rows
    }
  }
}

function confirmRecover(row) {
  confirm({
    title: t('history.recovery.recoverConfirmTitle'),
    message: t('history.recovery.recoverConfirmText', { title: row.title, path: row.path }),
    caption: t('history.versionId', { id: row.id }),
    cancel: true,
    okLabel: t('history.recovery.recover')
  }).onOk(() => recover(row))
}

/** `overrides` accumulates: a path conflict adds `path`, a locale conflict adds `locale`. */
async function recover(row, overrides = {}) {
  state.loading++
  try {
    const resp = await API_CLIENT.post(
      `sites/${adminStore.currentSiteId}/pages/deleted/${row.id}/recover`,
      { json: overrides }
    ).json()
    notify({ type: 'positive', message: t('history.recovery.recoverSuccess') })
    router.push(localizedPagePath(resp.page.path, resp.page.locale, siteStore.localeRouting))
  } catch (err) {
    // -> ky throws for both refusals: a path taken since answers 409, a locale the site no longer
    //    serves answers 400 with `error: 'pageInvalidLocale'` in the body.
    if (err.response?.status === 409) {
      notify({
        type: 'negative',
        message: t('history.recovery.pathConflictTitle'),
        caption: t('history.recovery.pathConflictText', { path: overrides.path ?? row.path })
      })
      promptPath(row, overrides)
    } else if (err.data?.error === 'pageInvalidLocale') {
      promptLocale(row, overrides)
    } else {
      notify({
        type: 'negative',
        message: t('history.recovery.recoverFailed'),
        caption: apiErrorMessage(err)
      })
    }
  } finally {
    state.loading--
  }
}

/** `duplicatePage` mode: picking a new home for a page whose original path is now occupied. */
function promptPath(row, overrides) {
  dialog({
    component: defineAsyncComponent(() => import('@/components/TreeBrowserDialog.vue')),
    componentProps: {
      mode: 'duplicatePage',
      siteId: adminStore.currentSiteId,
      folderPath: '',
      itemTitle: row.title,
      itemFileName: row.path,
      locale: overrides.locale ?? row.locale
    }
  }).onOk((target) => {
    recover(row, { ...overrides, path: target.path })
  })
}

function promptLocale(row, overrides) {
  const items = state.activeLocales.map((code) => {
    const known = adminStore.locales.find((lc) => lc.code === code)
    return { label: known ? `${known.nativeName} (${code})` : code, value: code }
  })
  confirm({
    title: t('history.recovery.localeConflictTitle'),
    message: t('history.recovery.localeConflictText', { locale: overrides.locale ?? row.locale }),
    cancel: true,
    okLabel: t('history.recovery.recover'),
    options: {
      model: state.activeLocales[0] ?? '',
      items
    }
  }).onOk((locale) => {
    recover(row, { ...overrides, locale })
  })
}
</script>
