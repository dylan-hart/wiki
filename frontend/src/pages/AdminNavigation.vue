<template>
  <w-page class="admin-navigation">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:sitemap" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">
          {{ t('admin.navigation.title') }}
        </h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.navigation.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex items-center">
        <w-input
          class="denser me-2"
          v-model="state.search"
          dense
          :placeholder="t('admin.navigation.searchPlaceholder')"
          :aria-label="t('admin.navigation.searchPlaceholder')"
          :class="dark.isActive ? `bg-dark text-white` : `bg-white`">
          <template #prepend
            ><w-icon class="opacity-50" name="tabler:search" size="20px"
          /></template>
        </w-input>
        <w-select
          class="me-2"
          style="min-width: 180px"
          dense
          v-model="state.locale"
          :options="localeOptions"
          option-value="code"
          option-label="name"
          emit-value
          map-options
          :aria-label="t(`admin.navigation.localeFilterLabel`)" />
        <w-btn
          class="acrylic-btn me-2"
          icon="tabler:list-details"
          flat
          color="accent"
          :label="t(`admin.navigation.editDefaultMenu`)"
          @click="openDefaultMenu" />
        <w-btn
          class="acrylic-btn me-2"
          icon="tabler:help-circle"
          flat
          color="grey"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/navigation`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="acrylic-btn"
          icon="tabler:refresh"
          flat
          color="slate"
          :aria-label="t(`common.actions.refresh`)"
          @click="load"
          :loading="state.loading > 0">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12">
        <w-card>
          <w-table
            :rows="filteredOverrides"
            :columns="columns"
            row-key="id"
            flat
            :loading="state.loading > 0">
            <template v-slot:body-cell-path="props">
              <w-td :props="props" class="cursor-pointer" @click="openEntry(props.row)">
                <div class="flex items-center">
                  <w-icon class="me-2 flex-none" :name="typeIcon(props.row.type)" size="sm" />
                  <span class="font-robotomono">/{{ props.value }}</span>
                  <w-icon
                    v-if="props.row.type !== `asset`"
                    class="ms-2 opacity-50 flex-none"
                    name="tabler:external-link"
                    size="14px" />
                </div>
              </w-td>
            </template>
            <template v-slot:body-cell-locale="props">
              <w-td :props="props" class="cursor-pointer" @click="openEntry(props.row)">
                <!-- -> Uncoloured: a plain chip draws as a hairline outline -->
                <w-chip class="text-caption" dense>{{ props.value }}</w-chip>
              </w-td>
            </template>
            <template v-slot:body-cell-mode="props">
              <w-td :props="props" class="cursor-pointer" @click="openEntry(props.row)">
                {{ props.value }}
              </w-td>
            </template>
            <template #no-data>
              <div class="p-4 text-center text-grey">
                {{
                  state.overrides.length < 1
                    ? t('admin.navigation.emptyText')
                    : t('admin.navigation.noMatchesText')
                }}
              </div>
            </template>
          </w-table>
        </w-card>
      </div>
      <!--
        Card-local save, not a page-header Apply: this page is a viewer, not a settings form top to
        bottom, so an embedded setting commits from its own card.
      -->
      <div class="col-span-12">
        <w-settings-card :title="t('admin.navigation.pathDisplayTitle')">
          <template #hint>{{ t('admin.navigation.pathDisplaySubtitle') }}</template>
          <template #action>
            <w-btn
              class="acrylic-btn"
              flat
              color="primary"
              :label="t('common.actions.save')"
              :loading="state.savingPathDisplay"
              @click="savePathDisplay" />
          </template>
          <w-settings-row
            control-width="fixed"
            icon="tabler:letter-case"
            :label="t('admin.navigation.pathDisplayLabel')">
            <w-select
              dense
              v-model="state.pathDisplayCase"
              :options="pathDisplayCaseOptions"
              option-value="value"
              option-label="label"
              emit-value
              map-options
              :aria-label="t('admin.navigation.pathDisplayLabel')" />
          </w-settings-row>
        </w-settings-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, watch } from 'vue'

import { useAdminSettings } from '@/composables/adminSettings'
import { useDark } from '@/composables/dark'
import { dialog } from '@/composables/dialog'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { useSiteAdminAccess } from '@/composables/siteAdminAccess'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'

import fileTypes from '@/helpers/fileTypes'
import { apiErrorMessage } from '@/helpers/apiError'
import AdminNavEditDialog from '@/components/AdminNavEditDialog.vue'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

/**
 * The site-wide half of navigation editing: every tree entry whose `navigationMode` is not
 * `inherit`, plus a launch point for the site-wide default menu. Editing one page's navigation in
 * context is the other half — `NavEditMenu.vue` and `NavEditOverlay.vue`, opened from the page.
 *
 * Both halves host the same `NavItemEditor.vue`, so a capability added to the item model lands once.
 * The framing does not carry across: the save here is mode-agnostic (it replaces a named menu's
 * items) where the per-page save also decides, from `navigationMode`, whose menu those items belong
 * to. A new mode value, or a new way of addressing which menu is meant, needs the equivalent
 * decision made deliberately on the other side rather than assumed to follow.
 */

const dark = useDark()

useSiteAdminAccess('site:navigation')

const adminStore = useAdminStore()
const siteStore = useSiteStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.navigation.title')
}))

const { state, load } = useAdminSettings({
  i18nPrefix: 'admin.navigation',
  extraState: {
    search: '',
    /** `null` means every locale. */
    locale: null,
    overrides: [],
    /**
     * Deliberately not `siteStore.locales`, which belongs to the site serving this browser tab and
     * can differ from `adminStore.currentSiteId`, the site actually being administered here.
     */
    siteLocales: [],
    sitePrimaryLocale: 'en',
    pathDisplayCase: 'off',
    savingPathDisplay: false
  },
  fetch: (siteId) =>
    API_CLIENT.get(`sites/${siteId}/navigation/overrides`, {
      ...(state.locale && { searchParams: { locale: state.locale } })
    }).json(),
  onLoaded: (overrides) => {
    state.overrides = overrides
  }
})

function entryPath(row) {
  return row.folderPath ? `${row.folderPath}/${row.fileName}` : row.fileName
}

function typeIcon(type) {
  return fileTypes[type]?.icon ?? fileTypes.page.icon
}

function modeLabel(mode) {
  switch (mode) {
    case 'inherit':
      return t('admin.navigation.modeLabelInherit')
    case 'override':
      return t('admin.navigation.modeLabelOverride')
    case 'overrideExact':
      return t('admin.navigation.modeLabelOverrideExact')
    case 'hide':
      return t('admin.navigation.modeLabelHide')
    case 'hideExact':
      return t('admin.navigation.modeLabelHideExact')
    default:
      return mode
  }
}

/** Re-fetches on confirm rather than assuming the save landed exactly as it was sent. */
function openNavEditor(navId, title) {
  dialog({
    component: AdminNavEditDialog,
    componentProps: {
      siteId: adminStore.currentSiteId,
      navId,
      title
    }
  }).onOk(load)
}

/**
 * The default menu is identified by `(siteId, locale)`, not by an id equal to the site's own, so its
 * row id is resolved from the server rather than assumed. There is no locale-spanning default menu
 * to fall back to, hence the primary locale when the filter is on "All Locales".
 */
async function openDefaultMenu() {
  const locale = state.locale ?? state.sitePrimaryLocale
  let navigationId
  try {
    ;({ navigationId } = await API_CLIENT.get(
      `sites/${adminStore.currentSiteId}/navigation/default`,
      { searchParams: { locale } }
    ).json())
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.navigation.loadFailed'),
      caption: apiErrorMessage(err)
    })
    return
  }
  openNavEditor(navigationId, t('admin.navigation.defaultMenuTitle'))
}

/**
 * A `hide` mode has no items to edit -- its `navigationId` is null -- so it, and an asset (which has
 * no page at all), open the entry itself instead, where the per-page editor still reaches it.
 */
function openEntry(row) {
  if (row.navigationId) {
    openNavEditor(row.navigationId, `/${entryPath(row)}`)
    return
  }
  if (row.type === 'asset') {
    return
  }
  window.open(`/${entryPath(row)}`, '_blank', 'noopener')
}

const localeOptions = computed(() => [
  { code: null, name: t('admin.navigation.allLocales') },
  ...state.siteLocales
])

/**
 * Values match the backend's `pathDisplayCaseStyles` enum exactly; adding, removing or renaming one
 * here means changing that list too.
 */
const pathDisplayCaseOptions = computed(() => [
  { value: 'off', label: t('admin.navigation.pathDisplayCaseOff') },
  { value: 'lower', label: t('admin.navigation.pathDisplayCaseLower') },
  { value: 'upper', label: t('admin.navigation.pathDisplayCaseUpper') },
  { value: 'camel', label: t('admin.navigation.pathDisplayCaseCamel') },
  { value: 'pascal', label: t('admin.navigation.pathDisplayCasePascal') },
  { value: 'title', label: t('admin.navigation.pathDisplayCaseTitle') }
])

/** Path-only: the locale and mode columns are informational, not filterable. */
const filteredOverrides = computed(() => {
  const needle = state.search.trim().toLowerCase()
  if (!needle) {
    return state.overrides
  }
  return state.overrides.filter((row) => entryPath(row).toLowerCase().includes(needle))
})

const columns = [
  {
    label: t('admin.navigation.columnPath'),
    align: 'left',
    field: entryPath,
    name: 'path',
    sortable: true
  },
  {
    label: t('admin.navigation.columnLocale'),
    align: 'left',
    field: 'locale',
    name: 'locale',
    sortable: true,
    style: 'width: 120px'
  },
  {
    label: t('admin.navigation.columnMode'),
    align: 'left',
    field: (row) => modeLabel(row.navigationMode),
    name: 'mode',
    sortable: true,
    style: 'width: 260px'
  }
]

/*
  Must refetch on a site switch: "Edit Default Menu" reads `adminStore.currentSiteId` at call time,
  so a stale table would leave it editing the new site's menu from the old site's rows.
*/
watch(() => adminStore.currentSiteId, loadSiteLocales)
// -> `load()` alone: the dropdown's options depend on which site is administered, not on which
//    locale is currently picked
watch(() => state.locale, load)

/**
 * Its own request rather than part of `load()`, so filtering the table by locale does not re-fetch
 * the site's locale list; only a site switch needs it again. `pathDisplayCase` rides along because
 * it lives on the same site payload, not because the two settings are related.
 */
async function loadSiteLocales() {
  try {
    const site = await API_CLIENT.get(`sites/${adminStore.currentSiteId}?strict=true`).json()
    state.siteLocales = site?.locales?.active ?? []
    state.sitePrimaryLocale = site?.locales?.primary ?? 'en'
    state.pathDisplayCase = site?.pathDisplayCase ?? 'off'
  } catch (err) {
    // -> Non-fatal: the locale filter falling back to "All Locales" is a degraded control, not a
    //    broken page, and `state.pathDisplayCase` keeps its value rather than reverting to `off`
    state.siteLocales = []
  }
}

/**
 * Writes through the dedicated navigation route, which is `site:navigation`-gated; the general
 * site-update route does not take this key at all.
 */
async function savePathDisplay() {
  state.savingPathDisplay = true
  try {
    await API_CLIENT.put(`sites/${adminStore.currentSiteId}/navigation/pathDisplay`, {
      json: { caseStyle: state.pathDisplayCase }
    }).json()
    notify({
      type: 'positive',
      message: t('admin.navigation.pathDisplaySaveSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.navigation.pathDisplaySaveFailed'),
      caption: apiErrorMessage(err)
    })
  } finally {
    state.savingPathDisplay = false
  }
}

// -> `useAdminSettings` already loads the overrides table; only this second request is this page's
onMounted(loadSiteLocales)
</script>

<style></style>
