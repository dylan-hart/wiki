<template>
  <w-page class="admin-search">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <img
          class="admin-icon animated fadeInLeft"
          src="/_assets/icons/fluent-find-and-replace-animated.svg" />
      </div>
      <div class="min-w-0 flex-1 pl-4">
        <div class="text-h5 text-primary animated fadeInLeft">{{ t('admin.search.title') }}</div>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.search.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <w-btn
          class="mr-2 acrylic-btn"
          flat
          icon="mdi:database-refresh"
          :label="t(`admin.searchRebuildIndex`)"
          color="purple"
          @click="rebuild"
          :loading="state.rebuildLoading" />
        <w-separator class="mr-2" vertical />
        <w-btn
          class="mr-2 acrylic-btn"
          icon="la:question-circle"
          flat
          color="grey"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/search`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="mr-2 acrylic-btn"
          icon="la:redo-alt"
          flat
          color="secondary"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="refresh">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <w-separator inset />
    <!--
      Same list-beside-panel shape as `AdminStorage.vue`'s targets and `AdminAuth.vue`'s strategies:
      the list is only as wide as it needs to be and the panel takes what is left, wrapping onto its
      own row when there is no room for both.
    -->
    <div class="flex flex-wrap p-4 gap-4">
      <div class="flex-none">
        <w-card class="rounded bg-dark">
          <w-list style="min-width: 300px" padding dark>
            <w-item
              v-for="eng of state.engines"
              :key="eng.key"
              active-class="bg-primary text-white"
              :active="state.selectedEngineKey === eng.key"
              :disabled="!eng.hasImplementation"
              clickable
              @click="state.selectedEngineKey = eng.key">
              <w-item-section side><w-icon :name="`img:` + eng.icon" /></w-item-section>
              <w-item-section>
                <w-item-label>{{ eng.title }}</w-item-label>
                <w-item-label caption>{{ eng.description }}</w-item-label>
              </w-item-section>
              <w-item-section side v-if="eng.isSelected">
                <w-icon name="mdi:check-circle" size="sm" color="positive" />
              </w-item-section>
            </w-item>
          </w-list>
        </w-card>
      </div>
      <!-- -> `min-w-0`, or a long value inside the panel would push it wider than the row -->
      <div class="min-w-0 flex-1" v-if="selectedEngine">
        <w-card class="pb-2">
          <w-card-header>
            {{ t('admin.search.engineConfig') }}
            <template #hint>{{ selectedEngine.description }}</template>
          </w-card-header>
          <w-card-section v-if="!hasConfigurableProps">
            <w-banner :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`">{{
              t('admin.search.engineNoConfig')
            }}</w-banner>
          </w-card-section>
          <!--
            Placeholder read-out of what the selected engine's `definition.yml` declares, until the
            dynamic config form (boolean -> toggle, `enum` -> select/buttons, sensitive -> password,
            `readOnly` -> disabled, `if` -> conditional visibility -- `AdminStorage.vue`'s
            `buildConfigEditor()` establishes the pattern) lands in its own task. `selectedEngine.props`
            (the schema) and `.config` (the stored values, already merged with defaults by the list
            endpoint) are both loaded here, ready for that component to render in place of this.
          -->
          <template v-else v-for="(prop, key, idx) in selectedEngine.props" :key="key">
            <w-separator class="my-2" inset v-if="idx > 0" />
            <w-item>
              <w-item-section>
                <w-item-label>{{ prop.title }}</w-item-label>
                <w-item-label caption>{{ prop.hint }}</w-item-label>
              </w-item-section>
              <w-item-section side>
                <span class="text-grey">{{ selectedEngine.config[key] }}</span>
              </w-item-section>
            </w-item>
          </template>
        </w-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { computed, onMounted, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { loading } from '@/composables/loading'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'

import { apiErrorMessage } from '@/helpers/apiError'

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta({
  title: t('admin.search.title')
})

// DATA

const state = reactive({
  loading: 0,
  rebuildLoading: false,
  engines: [],
  selectedEngineKey: ''
})

// COMPUTED

const selectedEngine = computed(
  () => state.engines.find((eng) => eng.key === state.selectedEngineKey) || null
)
const hasConfigurableProps = computed(
  () => Object.keys(selectedEngine.value?.props ?? {}).length > 0
)

// WATCHERS

// -> Switching sites in the admin header must not leave this page pinned to the previous site's
//    engine list/selection: `resetSelection` forces the picker back onto whichever engine the NEW
//    site actually has active, rather than merely keeping the old key if it happens to also exist
//    there (every site has a `db` engine, so a naive "keep if still present" check would silently
//    stay on it even when the new site's active engine is something else).
watch(
  () => adminStore.currentSiteId,
  () => {
    loading.show()
    load({ resetSelection: true })
  }
)

// METHODS

/**
 * Apply a freshly-fetched engine list, choosing what stays selected.
 *
 * @param resetSelection Force the selection back onto the site's active engine (a site switch),
 *   rather than keeping the currently viewed one when it is still in the list (an ordinary reload).
 */
function applyEngines(engines, { resetSelection = false } = {}) {
  state.engines = engines ?? []
  if (resetSelection || !state.engines.some((eng) => eng.key === state.selectedEngineKey)) {
    state.selectedEngineKey =
      state.engines.find((eng) => eng.isSelected)?.key || state.engines[0]?.key || ''
  }
}

async function load({ resetSelection = false } = {}) {
  state.loading++
  loading.show()
  try {
    const resp = await API_CLIENT.get(`sites/${adminStore.currentSiteId}/search/engines`).json()
    applyEngines(resp, { resetSelection })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.search.loadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  loading.hide()
  state.loading--
}

async function refresh() {
  state.loading++
  try {
    const resp = await API_CLIENT.post(`sites/${adminStore.currentSiteId}/search/refresh`).json()
    applyEngines(resp)
    notify({
      type: 'positive',
      message: t('admin.search.listRefreshSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.search.loadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
}

async function rebuild() {
  state.rebuildLoading = true
  try {
    const resp = await API_CLIENT.post(`sites/${adminStore.currentSiteId}/search/rebuild`).json()
    if (!resp?.ok) {
      throw new Error(resp?.message || 'An unexpected error occured.')
    }
    notify({
      type: 'positive',
      message: t('admin.search.rebuildInitSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.search.rebuildFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.rebuildLoading = false
}

// MOUNTED

onMounted(async () => {
  if (adminStore.currentSiteId) {
    await load({ resetSelection: true })
  }
})
</script>

<style lang="scss"></style>
