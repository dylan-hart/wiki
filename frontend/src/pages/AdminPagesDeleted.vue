<template>
  <w-page class="admin-pages-deleted">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <img
          class="admin-icon animated fadeInLeft"
          src="/_assets/icons/fluent-delete-bin.svg"
          alt="" />
      </div>
      <div class="min-w-0 flex-1 pl-4">
        <div class="text-h5 text-primary animated fadeInLeft">
          {{ t('history.recovery.title') }}
        </div>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('history.recovery.subtitle') }}
        </div>
      </div>
      <div class="flex flex-none">
        <w-btn
          class="acrylic-btn"
          icon="la:redo-alt"
          flat
          color="secondary"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <w-separator inset />
    <div class="p-4">
      <!--
        An empty list is the normal starting state -- either nothing has ever been deleted, or every
        deletion has already been recovered or written over by an unrelated new page at the same
        path, which is what quietly drops a row off this list on its own.
      -->
      <w-banner
        v-if="state.rows.length < 1 && state.loading < 1"
        rounded
        :class="dark.isActive ? `bg-dark-3 text-grey-4` : `bg-grey-2 text-grey-8`">
        {{ t('history.recovery.none') }}
      </w-banner>
      <w-card v-else>
        <w-table
          :rows="state.rows"
          :columns="headers"
          row-key="id"
          flat
          hide-header
          :loading="state.loading > 0">
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
              <div>{{ formattedDate(props.value) }}</div>
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
                no-caps
                icon="la:undo"
                :color="dark.isActive ? `indigo-4` : `indigo`"
                :label="t(`history.recovery.recover`)"
                :disable="state.loading > 0"
                @click="confirmRecover(props.row)" />
            </w-td>
          </template>
        </w-table>
      </w-card>
    </div>
  </w-page>
</template>

<script setup>
import { defineAsyncComponent, onMounted, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { confirm, dialog } from '@/composables/dialog'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { relativeDate } from '@/helpers/datetime'
import { apiErrorMessage } from '@/helpers/apiError'
import { localizedPagePath } from '@/helpers/pagePaths'

/**
 * Recoverable deletions across the whole site, and the one action there is to take on any of them.
 *
 * The list itself never has to reason about permissions: the server already filtered it down to rows
 * this admin could read the history of (see `GET .../pages/deleted`), so an empty list and a list this
 * admin genuinely has no rows in look identical here, which is the point -- there is no partial-access
 * state to explain.
 *
 * Recovering can answer back in three shapes, and each gets its own handling rather than one generic
 * failure notice:
 *   - success, which routes straight to the page that now exists again;
 *   - `pageDuplicatePath` (409) -- something has since taken the original path -- which reopens the
 *     same tree browser `branchFrom` in `PageHistoryOverlay` uses, so the admin can pick another one;
 *   - `pageInvalidLocale` (400) -- the site no longer serves the locale this page was deleted in --
 *     which offers the locales it currently does instead of dead-ending on the message.
 */

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('history.recovery.title')
}))

// DATA

const state = reactive({
  loading: 0,
  rows: [],
  /** Bare locale codes, from the site's own config -- what the locale picker offers on a 400. */
  activeLocales: []
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

// WATCHERS

watch(() => adminStore.currentSiteId, load)

// METHODS

function formattedDate(val) {
  return userStore.formatDateTime(t, val)
}

function authorLabel(row) {
  return row.author?.name || row.author?.email || t('history.unknownAuthor')
}

async function load() {
  if (!adminStore.currentSiteId) {
    return
  }
  state.loading++
  try {
    // -> The active locale list travels with the site, not with any one deletion: it is what the
    //    site accepts NOW, which is the whole reason a stale locale needs a picker at all
    const [rows, site] = await Promise.all([
      API_CLIENT.get(`sites/${adminStore.currentSiteId}/pages/deleted`).json(),
      API_CLIENT.get(`sites/${adminStore.currentSiteId}?strict=true`).json()
    ])
    state.rows = rows ?? []
    state.activeLocales = site?.locales?.active ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('history.recovery.loadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
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

/**
 * Recover one row, with whichever path/locale override a previous conflict picked.
 *
 * `overrides` starts empty -- the plain restore, at the path and locale the page was deleted from --
 * and only ever grows: a path conflict adds `path`, a locale conflict adds `locale`, and either can
 * happen on the very first attempt as well as on a retry.
 */
async function recover(row, overrides = {}) {
  state.loading++
  try {
    const resp = await API_CLIENT.post(
      `sites/${adminStore.currentSiteId}/pages/deleted/${row.id}/recover`,
      { json: overrides }
    ).json()
    // -> The API client does not throw on 400, so an invalid locale comes back as a parsed error
    //    rather than reaching the catch below
    if (resp?.ok === false) {
      if (resp.error === 'pageInvalidLocale') {
        promptLocale(row, overrides)
      } else {
        notify({
          type: 'negative',
          message: t('history.recovery.recoverFailed'),
          caption: resp.message
        })
      }
      return
    }
    notify({ type: 'positive', message: t('history.recovery.recoverSuccess') })
    router.push(localizedPagePath(resp.page.path, resp.page.locale, siteStore.localeRouting))
  } catch (err) {
    // -> ky throws above 400 -- a path a newer page has since taken answers 409
    if (err.response?.status === 409) {
      notify({
        type: 'negative',
        message: t('history.recovery.pathConflictTitle'),
        caption: t('history.recovery.pathConflictText', { path: overrides.path ?? row.path })
      })
      promptPath(row, overrides)
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

/**
 * Let the admin pick a path the recreated page can actually land on.
 *
 * The same tree browser `branchFrom` opens in `PageHistoryOverlay`, in the same mode: choosing a new
 * home for a page that already exists elsewhere is exactly what this is, one history entry over.
 */
function promptPath(row, overrides) {
  dialog({
    component: defineAsyncComponent(() => import('@/components/TreeBrowserDialog.vue')),
    componentProps: {
      mode: 'duplicatePage',
      siteId: adminStore.currentSiteId,
      folderPath: '',
      itemTitle: row.title,
      itemFileName: row.path,
      // -> The locale the recovery itself will actually use -- an override from a prior locale
      //    conflict (see `promptLocale`) if one exists, otherwise the locale this page was deleted
      //    in. Same fallback `recover`'s own conflict message uses just above.
      locale: overrides.locale ?? row.locale
    }
  }).onOk((target) => {
    recover(row, { ...overrides, path: target.path })
  })
}

/**
 * Let the admin pick one of the locales this site currently serves, in place of the one this page was
 * deleted in -- which the site no longer does, or the recover call would not have answered 400.
 */
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

// MOUNTED

onMounted(load)
</script>
