<template>
  <w-page class="admin-navigation">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <img
          class="admin-icon animated fadeInLeft"
          src="/_assets/icons/fluent-tree-structure.svg" />
      </div>
      <div class="min-w-0 flex-1 pl-4">
        <div class="text-h5 text-primary animated fadeInLeft">
          {{ t('admin.navigation.title') }}
        </div>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.navigation.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex items-center">
        <w-input
          class="denser mr-2"
          outlined
          v-model="state.search"
          dense
          :placeholder="t('admin.navigation.searchPlaceholder')"
          :aria-label="t('admin.navigation.searchPlaceholder')"
          :class="dark.isActive ? `bg-dark text-white` : `bg-white`">
          <template #prepend><w-icon class="opacity-50" name="la:search" size="20px" /></template>
        </w-input>
        <w-select
          class="mr-2"
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
          class="acrylic-btn mr-2"
          icon="mdi:playlist-edit"
          flat
          color="deep-orange-9"
          :label="t(`admin.navigation.editDefaultMenu`)"
          @click="openDefaultMenu" />
        <w-btn
          class="acrylic-btn mr-2"
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
                  <w-icon class="mr-2 flex-none" :name="typeIcon(props.row.type)" size="sm" />
                  <span class="font-robotomono">/{{ props.value }}</span>
                  <w-icon
                    v-if="props.row.type !== `asset`"
                    class="ml-2 opacity-50 flex-none"
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
          </w-table>
          <div
            class="p-4 text-center text-grey"
            v-if="state.loading < 1 && filteredOverrides.length < 1">
            {{
              state.overrides.length < 1
                ? t('admin.navigation.emptyText')
                : t('admin.navigation.noMatchesText')
            }}
          </div>
        </w-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, watch } from 'vue'

import { useDark } from '@/composables/dark'
import { dialog } from '@/composables/dialog'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { loading } from '@/composables/loading'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'

import fileTypes from '@/helpers/fileTypes'
import { apiErrorMessage } from '@/helpers/apiError'
import AdminNavEditDialog from '@/components/AdminNavEditDialog.vue'

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta({
  title: t('admin.navigation.title')
})

// DATA

const state = reactive({
  loading: 0,
  search: '',
  /** `null` means every locale -- the "All Locales" option in `localeOptions`. */
  locale: null,
  overrides: []
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

/** Edits the site-wide default menu -- the one the home page's `override` mode points at, and every
 * other page inherits by default -- directly, without navigating to the live home page first. */
function openDefaultMenu() {
  openNavEditor(adminStore.currentSiteId, t('admin.navigation.defaultMenuTitle'))
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
  ...siteStore.locales.active
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

watch(() => state.locale, load)

// METHODS

async function load() {
  state.loading++
  loading.show()
  try {
    state.overrides = await API_CLIENT.get(
      `sites/${adminStore.currentSiteId}/navigation/overrides`,
      {
        ...(state.locale && { searchParams: { locale: state.locale } })
      }
    ).json()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.navigation.loadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  loading.hide()
  state.loading--
}

// MOUNTED

onMounted(load)
</script>

<style lang="scss"></style>
