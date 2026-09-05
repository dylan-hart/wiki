<template>
  <w-page class="admin-navigation">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-tree-structure.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="text-h5 text-primary animated fadeInLeft">
          {{ t('admin.navigation.title') }}
        </h1>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.navigation.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex items-center">
        <w-input
          class="denser me-2"
          outlined
          v-model="state.search"
          dense
          :placeholder="t('admin.navigation.searchPlaceholder')"
          :aria-label="t('admin.navigation.searchPlaceholder')"
          :class="dark.isActive ? `bg-dark text-white` : `bg-white`">
          <template #prepend><w-icon class="opacity-50" name="la:search" size="20px" /></template>
        </w-input>
        <w-select
          class="me-2"
          style="min-width: 180px"
          outlined
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
          icon="mdi:playlist-edit"
          flat
          color="deep-orange-9"
          :label="t(`admin.navigation.editDefaultMenu`)"
          @click="openDefaultMenu" />
        <w-btn
          class="acrylic-btn me-2"
          icon="la:question-circle"
          flat
          color="grey"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/navigation`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="acrylic-btn"
          icon="la:redo-alt"
          flat
          color="secondary"
          :aria-label="t(`common.actions.refresh`)"
          @click="load"
          :loading="state.loading > 0">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <w-separator inset />
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
                    name="la:external-link-alt"
                    size="14px" />
                </div>
              </w-td>
            </template>
            <template v-slot:body-cell-locale="props">
              <w-td :props="props" class="cursor-pointer" @click="openEntry(props.row)">
                <w-chip
                  class="text-caption"
                  square
                  dense
                  :color="dark.isActive ? `dark-6` : `grey-2`"
                  :text-color="dark.isActive ? `white` : `grey-8`"
                  >{{ props.value }}</w-chip
                >
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
        Card-local save, not a page-header Apply, per `docs/decisions/embedded-setting-save-
        affordance.md`: this page is a viewer (the overrides table above), not a settings form top
        to bottom, so this embedded setting commits from its own card -- the same shape as
        `AdminAuditLog.vue`'s retention card (OpenProject #2089/#2574).
      -->
      <div class="col-span-12">
        <w-card class="rounded" flat :class="dark.isActive ? `bg-dark-5` : `bg-grey-2`">
          <w-card-section>
            <div class="text-subtitle1">{{ t('admin.navigation.pathDisplayTitle') }}</div>
            <div class="text-caption text-grey mb-2">
              {{ t('admin.navigation.pathDisplaySubtitle') }}
            </div>
            <div class="flex items-center gap-3">
              <div style="width: 220px">
                <w-select
                  outlined
                  dense
                  v-model="state.pathDisplayCase"
                  :options="pathDisplayCaseOptions"
                  option-value="value"
                  option-label="label"
                  emit-value
                  map-options
                  :aria-label="t('admin.navigation.pathDisplayLabel')" />
              </div>
              <w-btn
                class="acrylic-btn"
                flat
                color="primary"
                :label="t('common.actions.save')"
                :loading="state.savingPathDisplay"
                @click="savePathDisplay" />
            </div>
          </w-card-section>
        </w-card>
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

/**
 * The site-wide half of navigation editing. This screen answers "where, across the whole site, has
 * someone already deviated from the default menu" — it lists every tree entry whose
 * `navigationMode` is not `inherit` (via `GET sites/:siteId/navigation/overrides`, one flat,
 * searchable, locale-filterable table) and gives a launch point for the site-wide default menu
 * itself ("Edit Default Menu", its row id resolved per-locale via
 * `GET sites/:siteId/navigation/default`) plus each override row's own menu.
 *
 * It does not resolve or apply navigation for a single page in context, and it does not walk a page
 * tree — that is `NavEditMenu.vue` (the mode picker) and `NavEditOverlay.vue` (the item editor),
 * opened FROM a page, editing that page's own `navigationMode` and menu, with the ancestor it
 * inherits from resolved for it. See `NavEditOverlay.vue`'s own header comment for that half of the
 * split.
 *
 * Both halves ultimately edit the same shape of thing — a menu's ordered list of header/link/
 * separator items — and since Task 433 they share the actual editing UI: this screen's launched
 * dialog (`AdminNavEditDialog.vue`) and `NavEditOverlay.vue` both host `NavItemEditor.vue`, giving it
 * only a `siteId` + `navId` and letting each host resolve what those mean and how to save. A
 * capability added to the item model — a new item type, a new visibility rule, anything
 * `NavItemEditor.vue` itself needs to know how to render or persist — therefore lands once and is
 * available from both surfaces automatically. What does NOT come for free is anything about WHICH
 * menu is being edited or how the save is framed: this screen's per-entry save is mode-agnostic
 * (`PUT sites/:siteId/navigation/:navId`, via `Navigation.setNavItems` — it just replaces a menu's
 * items) where the per-page save is mode-aware (`PUT sites/:siteId/navigation/pages/:pageId`, which
 * also decides whose menu the items belong to based on `navigationMode`). A change to that framing on
 * one side — e.g. a new mode value, a new way of addressing "which menu" — needs the equivalent
 * decision made deliberately on the other side too, not assumed to follow along.
 */

// COMPOSABLES

const dark = useDark()

// ACCESS
// -> Task #684: gates this page behind `site:navigation` (or `manage:navigation`), redirecting away
//    from a site the caller may not administer. See `composables/siteAdminAccess.js`.
useSiteAdminAccess('site:navigation')

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.navigation.title')
}))

// DATA

const { state, load } = useAdminSettings({
  i18nPrefix: 'admin.navigation',
  extraState: {
    search: '',
    /** `null` means every locale -- the "All Locales" option in `localeOptions`. */
    locale: null,
    overrides: [],
    /**
     * The administered site's own active locales and primary locale, fetched fresh per
     * `loadSiteLocales()` -- deliberately NOT `siteStore.locales`, which is the site currently serving
     * this browser tab and can differ from `adminStore.currentSiteId`, the site actually being
     * administered here (OpenProject #948). Read by `localeOptions` and `openDefaultMenu()` below.
     *
     * `loadSiteLocales()` also loads `pathDisplayCase` (below) off the same site payload -- the two
     * are unrelated settings that happen to share one fetch, not a hint they should be combined.
     */
    siteLocales: [],
    sitePrimaryLocale: 'en',
    /**
     * The administered site's own `pathDisplayCase` (Feature #2574/WP #2577), read off the same
     * `GET sites/:siteId?strict=true` call `loadSiteLocales()` already makes. `'off'` (show the raw
     * lowercase path unchanged) until that load resolves.
     */
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

// HELPERS

/**
 * The slash path a tree entry's `folderPath` + `fileName` combine into -- the same join
 * `TreeBrowserDialog.vue` and `LinkPickerDialog.vue` use, so this reads identically to how the rest
 * of the app addresses a page.
 */
function entryPath(row) {
  return row.folderPath ? `${row.folderPath}/${row.fileName}` : row.fileName
}

function typeIcon(type) {
  return fileTypes[type]?.icon ?? fileTypes.page.icon
}

/** Wording lifted from `NavEditMenu.vue`'s radio labels for the same five modes. */
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

/**
 * Opens the shared menu-item editor (`NavItemEditor`, via `AdminNavEditDialog`) against a resolved
 * `navId`, refreshing the list once the dialog confirms -- items can't change a row's mode or path,
 * but re-fetching keeps this honest about what the server actually holds rather than assuming the
 * save succeeded exactly as sent.
 */
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
 * Edits the site-wide default menu -- the one the home page's `override` mode points at, and every
 * other page inherits by default -- directly, without navigating to the live home page first.
 *
 * The default menu is locale-scoped and identified by `(siteId, locale)`, not by an id equal to the
 * site's own, so its row id has to be resolved from the server rather than assumed: the locale filter
 * when one is picked, or the site's primary locale for "All Locales" -- there is no single default
 * menu spanning every locale to fall back to instead.
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
 * Opens the row's own menu items in the shared editor when it has one (`override` / `overrideExact`
 * modes, whose `navigationId` names the row holding them). A `hide` mode has no items to edit -- its
 * `navigationId` is null -- so those, and assets (which have no page at all), fall back to opening
 * the entry's own page in a new tab instead, where the existing `NavEditMenu` / `NavEditOverlay` path
 * still reaches it.
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

// COMPUTED

const localeOptions = computed(() => [
  { code: null, name: t('admin.navigation.allLocales') },
  ...state.siteLocales
])

/**
 * The `pathDisplayCase` picker's options (Feature #2574) -- values match the backend's
 * `pathDisplayCaseStyles` enum (`backend/models/sites.ts`) exactly; do not add, remove or rename a
 * value here without updating that list too.
 */
const pathDisplayCaseOptions = computed(() => [
  { value: 'off', label: t('admin.navigation.pathDisplayCaseOff') },
  { value: 'lower', label: t('admin.navigation.pathDisplayCaseLower') },
  { value: 'upper', label: t('admin.navigation.pathDisplayCaseUpper') },
  { value: 'camel', label: t('admin.navigation.pathDisplayCaseCamel') },
  { value: 'pascal', label: t('admin.navigation.pathDisplayCasePascal') },
  { value: 'title', label: t('admin.navigation.pathDisplayCaseTitle') }
])

/** Path-only, per the task: the locale and mode columns are informational, not filterable here. */
const filteredOverrides = computed(() => {
  const needle = state.search.trim().toLowerCase()
  if (!needle) {
    return state.overrides
  }
  return state.overrides.filter((row) => entryPath(row).toLowerCase().includes(needle))
})

// COLUMNS

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

// WATCHERS

/*
  Every sibling site-scoped admin page (`AdminGeneral.vue`, `AdminApprovals.vue`,
  `AdminPagesDeleted.vue`, `AdminLocale.vue`) watches `adminStore.currentSiteId` and refetches --
  this one did not, so switching sites with the sidebar picker while on this screen left the
  overrides table showing the previous site's rows while "Edit Default Menu" (reading
  `adminStore.currentSiteId` at call time) silently edited the NEW site's menu (OpenProject #948).
*/
watch(() => adminStore.currentSiteId, loadSiteLocales)
// -> The locale filter itself: re-runs `load()` alone, not `loadSiteLocales()` -- the OPTIONS in the
//    dropdown do not depend on which one is currently picked, only on which site is administered.
watch(() => state.locale, load)

// METHODS

/**
 * The administered site's own active/primary locales -- see `state.siteLocales`'s doc comment for
 * why this is not read off `siteStore` directly. Kept as its own request (not folded into `load()`)
 * so filtering the overrides table by locale does not also re-fetch the site's locale list on every
 * change; only a site switch needs this to run again.
 *
 * Also refreshes `state.pathDisplayCase` off the same response -- an unrelated setting that happens
 * to live on the same site payload, not a reason to fetch it twice.
 */
async function loadSiteLocales() {
  try {
    const site = await API_CLIENT.get(`sites/${adminStore.currentSiteId}?strict=true`).json()
    state.siteLocales = site?.locales?.active ?? []
    state.sitePrimaryLocale = site?.locales?.primary ?? 'en'
    state.pathDisplayCase = site?.pathDisplayCase ?? 'off'
  } catch (err) {
    // -> Non-fatal: the locale filter falling back to "All Locales" only is a degraded control, not
    //    a broken page -- `load()`'s own error handling above covers the data this screen exists to
    //    show. `state.pathDisplayCase` is deliberately left as it was rather than reset to `off`,
    //    same reasoning.
    state.siteLocales = []
  }
}

/**
 * Card-local save for the `pathDisplayCase` setting (Feature #2574/WP #2577) -- writes through the
 * dedicated `PUT sites/:siteId/navigation/pathDisplay` route (`site:navigation`), not the general
 * site-update route: see that route's own comment for why `site:navigation` needs a route of its
 * own rather than a key on `PUT /:siteId`.
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

// MOUNTED

// -> The overrides table itself is loaded by `useAdminSettings` above; only this page's second,
//    site-switch-only request is its own.
onMounted(loadSiteLocales)
</script>

<style lang="scss"></style>
