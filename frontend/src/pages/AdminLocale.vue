<template>
  <w-page class="admin-locale">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon name="tabler:language" size="64px" class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.locale.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.locale.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <w-btn
          class="me-2"
          icon="la:question-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/localisation`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2"
          icon="la:redo-alt"
          outline
          color="slate-soft"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          icon="mdi:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12 lg:col-span-7">
        <!-- ----------------------- -->
        <!-- Locale Options -->
        <!-- ----------------------- -->
        <w-card class="pb-2">
          <w-card-header>{{ t('admin.locale.settings') }}</w-card-header>
          <w-item>
            <blueprint-icon icon="tabler:language" />
            <w-item-section>
              <w-item-label>{{ t(`admin.locale.primary`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.locale.primaryHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-select
                v-model="state.primary"
                :options="state.locales"
                option-value="code"
                option-label="name"
                emit-value
                map-options
                dense
                :aria-label="t(`admin.locale.primary`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="tabler:layout-sidebar-right-collapse" />
            <w-item-section>
              <w-item-label>{{ t(`admin.locale.forcePrefix`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.locale.forcePrefixHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.forcePrefix"
                :aria-label="t(`admin.locale.forcePrefixHint`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="tabler:map" />
            <w-item-section>
              <w-item-label>{{ t(`admin.locale.showMenu`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.locale.showMenuHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle v-model="state.showMenu" :aria-label="t(`admin.locale.showMenuHint`)" />
            </w-item-section>
          </w-item>
        </w-card>
        <!-- ----------------------- -->
        <!-- Active Locales -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4">
          <w-card-header>
            {{ t('admin.locale.active') }}
            <template #hint>Select the locales that can be used on this site.</template>
          </w-card-header>
          <w-item
            v-for="lc of state.locales"
            :key="lc.code"
            :tag="lc.code !== state.selectedLocale ? `label` : null">
            <blueprint-icon :text="lc.language" />
            <w-item-section>
              <w-item-label>{{ lc.nativeName }}</w-item-label>
              <w-item-label caption>{{ lc.name }} ({{ lc.code }})</w-item-label>
            </w-item-section>
            <w-item-section side>
              <div
                class="locale-completeness flex items-center gap-2"
                :title="t('admin.locale.completeness', { percent: lc.completeness ?? 0 })">
                <w-linear-progress
                  class="w-20"
                  size="sm"
                  rounded
                  :value="(lc.completeness ?? 0) / 100"
                  :color="completenessColor(lc.completeness)" />
                <span
                  class="text-caption locale-completeness-label"
                  :class="completenessLow(lc.completeness) ? 'text-grey' : ''">
                  {{ lc.completeness ?? 0 }}%
                </span>
              </div>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                :disabled="lc.code === state.primary"
                v-model="state.active"
                :val="lc.code"
                :aria-label="lc.name" />
            </w-item-section>
          </w-item>
        </w-card>
        <!-- ----------------------- -->
        <!-- Offline Sideload -->
        <!-- ----------------------- -->
        <w-card class="pb-4 mt-4" v-if="canSideload">
          <w-card-header>{{ t('admin.locale.sideload') }}</w-card-header>
          <div class="px-4 text-caption text-grey">{{ t('admin.locale.sideloadHelp') }}</div>
          <div class="px-4 pt-3">
            <w-btn
              outline
              icon="la:upload"
              color="secondary"
              :label="t('admin.locale.sideload')"
              :loading="state.sideloading"
              @click="sideload" />
          </div>
        </w-card>
      </div>
      <div class="col-span-12 lg:col-span-5">
        <div class="p-4 text-center">
          <img src="/_assets/illustrations/undraw_world.svg" style="width: 80%" alt="" />
        </div>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, watch } from 'vue'

import { useAdminSettings } from '@/composables/adminSettings'
import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { useSiteAdminAccess } from '@/composables/siteAdminAccess'
import { apiErrorMessage } from '@/helpers/apiError'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { sortBy } from 'es-toolkit/array'

// COMPOSABLES

const dark = useDark()
// -> Task #684: gates this page behind `site:locale` (or `manage:sites`), redirecting away from a
//    site the caller may not administer. See `composables/siteAdminAccess.js`.
useSiteAdminAccess('site:locale')

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.locale.title')
}))

// DATA

const { state, load } = useAdminSettings({
  i18nPrefix: 'admin.locale',
  extraState: {
    locales: [],
    primary: 'en',
    forcePrefix: false,
    showMenu: true,
    active: [],
    sideloading: false
  },
  fetch: (siteId) =>
    Promise.all([
      API_CLIENT.get('locales').json(),
      API_CLIENT.get(`sites/${siteId}?strict=true`).json()
    ]),
  onLoaded: ([locales, site]) => {
    state.locales = sortBy(locales ?? [], ['nativeName', 'name'])
    state.primary = site?.locales?.primary ?? 'en'
    state.forcePrefix = site?.locales?.forcePrefix ?? false
    state.showMenu = site?.locales?.showMenu ?? true
    state.active = [...(site?.locales?.active ?? [])]
    // -> The primary locale is always active, and its toggle is disabled to keep it that way
    if (!state.active.includes(state.primary)) {
      state.active.push(state.primary)
    }
  }
})

// -> `POST locales/sideload` (backend/api/locales.ts) is `manage:system`-only, stricter than this
//    page's own `site:locale` gate (see useSiteAdminAccess above) -- a site-scoped-only admin who
//    lacks manage:system would just get a 403, so the control is hidden rather than shown disabled.
const canSideload = computed(() => userStore.can('manage:system'))

// WATCHERS

// -> Selecting a primary locale that isn't active yet activates it, since its toggle is disabled
watch(
  () => state.primary,
  (newValue) => {
    if (newValue && !state.active.includes(newValue)) {
      state.active.push(newValue)
    }
  }
)

// COMPLETENESS

/**
 * Below this, a locale is under-translated enough to call out at a glance -- muted progress bar
 * colour and greyed-out percentage label, matching how 2.5.x's admin language screen dimmed
 * incomplete languages rather than presenting every language's number with equal visual weight.
 */
const COMPLETENESS_LOW_THRESHOLD = 50

function completenessLow(value) {
  return (value ?? 0) < COMPLETENESS_LOW_THRESHOLD
}

function completenessColor(value) {
  if (completenessLow(value)) {
    return 'grey'
  }
  return (value ?? 0) >= 90 ? 'positive' : 'primary'
}

// METHODS

async function save() {
  if (state.loading > 0) {
    return
  }

  state.loading++
  try {
    // -> The primary locale is always active, even if the user just switched to an inactive one
    const active = [...new Set(state.active)]
    if (!active.includes(state.primary)) {
      active.push(state.primary)
    }
    await API_CLIENT.put(`sites/${adminStore.currentSiteId}`, {
      json: {
        locales: {
          primary: state.primary,
          active,
          forcePrefix: state.forcePrefix,
          showMenu: state.showMenu
        }
      }
    }).json()
    state.active = active
    notify({
      type: 'positive',
      message: t('admin.locale.saveSuccess')
    })
    await adminStore.fetchSites()
    if (adminStore.currentSiteId === siteStore.id) {
      siteStore.loadSite(window.location.hostname)
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: t(
        `admin.locale.${err.data?.error}`,
        apiErrorMessage(err, t('common.error.unexpected'))
      )
    })
  }
  state.loading--
}

/**
 * The air-gapped deployment path (OpenProject #820): `POST locales/sideload` rescans
 * `<dataPath>/locales/` on the server's own data volume for JSON locale-pack files an operator
 * placed there out-of-band (no request body -- there is nothing to upload over HTTP, the file
 * already has to be on the volume) and force-reloads whatever it finds there. `loaded` and
 * `skipped` can both be non-empty at once (a partial run), so success/failure isn't a strict
 * either/or -- each is reported on its own.
 */
async function sideload() {
  if (state.sideloading) {
    return
  }
  state.sideloading = true
  try {
    const resp = await API_CLIENT.post('locales/sideload').json()
    const loadedCodes = resp?.loaded ?? []
    const skippedFiles = resp?.skipped ?? []
    if (loadedCodes.length > 0) {
      notify({
        type: 'positive',
        message: t('admin.locale.sideloadSuccess', { count: loadedCodes.length }),
        caption: loadedCodes.join(', ')
      })
    } else if (skippedFiles.length === 0) {
      notify({
        type: 'info',
        message: t('admin.locale.sideloadNone')
      })
    }
    if (skippedFiles.length > 0) {
      notify({
        type: 'negative',
        message: t('admin.locale.sideloadFailed'),
        caption: skippedFiles.map((s) => `${s.code}: ${s.error}`).join('; ')
      })
    }
    if (loadedCodes.length > 0) {
      await load()
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.locale.sideloadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.sideloading = false
}
</script>
