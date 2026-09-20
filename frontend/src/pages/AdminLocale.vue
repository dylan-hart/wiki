<template>
  <w-page class="admin-locale">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:language" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.locale.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.locale.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <w-btn
          class="me-2"
          icon="tabler:help-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/localisation`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2"
          icon="tabler:refresh"
          outline
          color="slate-soft"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          icon="tabler:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12 lg:col-span-7">
        <w-settings-card :title="t('admin.locale.settings')">
          <w-settings-row
            icon="tabler:language"
            :label="t(`admin.locale.primary`)"
            :hint="t(`admin.locale.primaryHint`)">
            <w-select
              v-model="state.primary"
              :options="state.locales"
              option-value="code"
              option-label="name"
              emit-value
              map-options
              dense
              :aria-label="t(`admin.locale.primary`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:layout-sidebar-right-collapse"
            :label="t(`admin.locale.forcePrefix`)"
            :hint="t(`admin.locale.forcePrefixHint`)">
            <w-toggle v-model="state.forcePrefix" :aria-label="t(`admin.locale.forcePrefixHint`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:map"
            :label="t(`admin.locale.showMenu`)"
            :hint="t(`admin.locale.showMenuHint`)">
            <w-toggle v-model="state.showMenu" :aria-label="t(`admin.locale.showMenuHint`)" />
          </w-settings-row>
        </w-settings-card>
        <w-settings-card class="mt-4" :title="t('admin.locale.active')">
          <template #hint>Select the locales that can be used on this site.</template>
          <!-- The row's control is the toggle, so the completeness bar travels beside it rather
               than claiming a section of its own. -->
          <w-settings-row
            v-for="lc of state.locales"
            :key="lc.code"
            control-width="auto"
            :tag="lc.code !== state.selectedLocale ? `label` : `div`"
            :text="lc.language"
            :label="lc.nativeName"
            :hint="rowHint(lc)">
            <div class="flex items-center gap-4">
              <w-input
                v-if="state.active.includes(lc.code)"
                v-model="state.aliases[lc.code]"
                class="locale-alias-input w-32"
                dense
                prefix="/"
                :placeholder="lc.code"
                :aria-label="`${lc.name} ${t('admin.locale.alias')}`"
                :data-locale="lc.code" />
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
              <w-toggle
                :disabled="lc.code === state.primary"
                v-model="state.active"
                :val="lc.code"
                :aria-label="lc.name" />
            </div>
          </w-settings-row>
        </w-settings-card>
        <w-settings-card class="mt-4" v-if="canSideload" :title="t('admin.locale.sideload')">
          <w-settings-row control-width="auto" icon="tabler:upload">
            <template #hint>{{ t('admin.locale.sideloadHelp') }}</template>
            <w-btn
              outline
              icon="tabler:upload"
              color="slate"
              :label="t('admin.locale.sideload')"
              :loading="state.sideloading"
              @click="sideload" />
          </w-settings-row>
        </w-settings-card>
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
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const dark = useDark()
useSiteAdminAccess('site:locale')

const adminStore = useAdminStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.locale.title')
}))

const { state, load } = useAdminSettings({
  i18nPrefix: 'admin.locale',
  extraState: {
    locales: [],
    primary: 'en',
    forcePrefix: false,
    showMenu: true,
    active: [],
    aliases: {},
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
    state.aliases = { ...site?.locales?.aliases }
    // -> The primary locale is always active, and its toggle is disabled to keep it that way
    if (!state.active.includes(state.primary)) {
      state.active.push(state.primary)
    }
  }
})

// -> `POST locales/sideload` is `manage:system`-only, stricter than this page's own `site:locale`
//    gate, so a site-scoped admin gets the control hidden rather than a 403 from a disabled-looking
//    button
const canSideload = computed(() => userStore.can('manage:system'))

// -> A primary locale's own toggle is disabled, so switching to an inactive one has to activate it
watch(
  () => state.primary,
  (newValue) => {
    if (newValue && !state.active.includes(newValue)) {
      state.active.push(newValue)
    }
  }
)

/**
 * Below this a locale is under-translated enough to call out at a glance -- muted bar colour and
 * greyed percentage label, rather than every locale's number carrying equal visual weight.
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

function rowHint(lc) {
  const alias = state.aliases[lc.code]?.trim()
  const base = `${lc.name} (${lc.code})`
  return alias && state.active.includes(lc.code)
    ? `${base} · ${t('admin.locale.aliasPreview', { alias, code: lc.code })}`
    : base
}

async function save() {
  if (state.loading > 0) {
    return
  }

  state.loading++
  try {
    const active = [...new Set(state.active)]
    if (!active.includes(state.primary)) {
      active.push(state.primary)
    }
    const aliases = {}
    for (const code of active) {
      const alias = state.aliases[code]?.trim()
      if (alias) {
        aliases[code] = alias
      }
    }
    await API_CLIENT.put(`sites/${adminStore.currentSiteId}`, {
      json: {
        locales: {
          primary: state.primary,
          active,
          forcePrefix: state.forcePrefix,
          showMenu: state.showMenu,
          aliases
        }
      }
    }).json()
    state.active = active
    state.aliases = aliases
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
 * The air-gapped path: the server rescans `<dataPath>/locales/` for packs an operator placed there
 * out-of-band, so there is no body to send -- the files are already on its volume. `loaded` and
 * `skipped` can both be non-empty at once, so each is reported on its own rather than as a verdict.
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
