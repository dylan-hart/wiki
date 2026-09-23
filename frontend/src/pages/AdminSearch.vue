<template>
  <w-page class="admin-search">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:list-search" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.search.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.search.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <w-btn
          class="me-2 acrylic-btn"
          flat
          icon="tabler:database-cog"
          :label="t(`admin.searchRebuildIndex`)"
          color="purple"
          @click="rebuild"
          :loading="state.rebuildLoading" />
        <w-separator class="me-2" vertical />
        <w-btn
          class="me-2"
          icon="tabler:help-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/search`"
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
          @click="refresh">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <!--
      `calc(50% - 8px)` subtracts half of `gap-4`: flex-wrap measures each item's hypothetical size
      including the gap, so two plain `50%` bases wrap even with room to spare. `min-width: 260px` is
      where the row stacks rather than squeezing either side illegible. No viewport breakpoint on
      purpose -- the admin sidebar toggles at 1024px, so this row's width does not track viewport
      width monotonically.
    -->
    <div class="flex flex-wrap p-4 gap-4">
      <div class="min-w-0" style="flex: 1 1 calc(50% - 8px); min-width: 260px">
        <w-card class="rounded bg-dark">
          <w-list padding dark>
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
                <w-icon name="tabler:circle-check" size="sm" color="positive" />
              </w-item-section>
            </w-item>
          </w-list>
        </w-card>
      </div>
      <!-- -> `min-w-0`, or a long value inside the panel would push it wider than the row -->
      <div
        class="min-w-0"
        style="flex: 1 1 calc(50% - 8px); min-width: 260px"
        v-if="selectedEngine">
        <!--
          Card-local apply rather than a page-header one: this page is a picker plus a panel, not one
          settings form top to bottom.
        -->
        <w-settings-card :title="t('admin.search.engineConfig')">
          <template #hint>{{ selectedEngine.description }}</template>
          <template #action>
            <w-btn
              icon="tabler:check"
              :label="t(`common.actions.apply`)"
              color="slate"
              @click="save()"
              :loading="state.loading > 0" />
          </template>
          <w-card-section v-if="!hasConfigurableProps">
            <w-banner :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`">{{
              t('admin.search.engineNoConfig')
            }}</w-banner>
          </w-card-section>
          <module-config-form :config="selectedEngine.config" />
          <!--
            `dictOverrides` is an open-keyed locale -> dictionary map, which `parseModuleProps` cannot
            express as a generic prop, so it gets its own editor and its own validation against the
            dictionaries this database has installed. A 250px JSON editor does not fit at a row's
            trailing edge, hence the full-width `preview` slot.
          -->
          <w-settings-row
            v-if="selectedEngine.key === DB_ENGINE_KEY"
            control-width="auto"
            icon="tabler:search"
            :label="t('admin.search.dictOverrides')">
            <template #preview>
              <util-code-editor
                v-model="selectedEngine.dictOverridesText"
                language="json"
                :min-height="250"
                :aria-label="t('admin.search.dictOverrides')" />
              <div class="text-caption mt-2">
                <i18n-t keypath="admin.search.dictOverridesHint" tag="span">
                  <span>{ "en": "english" }</span>
                </i18n-t>
              </div>
            </template>
          </w-settings-row>
        </w-settings-card>
      </div>
    </div>
    <!--
      Semantic search is backed directly by Postgres/pgvector whichever full-text engine is selected,
      so it is its own card rather than part of the picker row above.
    -->
    <div class="p-4 pt-0">
      <w-settings-card :title="t('admin.search.semanticTitle')">
        <template #action>
          <div class="flex items-center gap-2">
            <w-btn
              flat
              icon="tabler:brain"
              :label="t('admin.search.rebuildEmbeddingsIndex')"
              color="purple"
              :disabled="!state.semanticAvailable"
              @click="rebuildEmbeddings"
              :loading="state.semanticRebuildLoading" />
            <w-btn
              icon="mdi:check"
              :label="t('common.actions.apply')"
              color="slate"
              @click="saveSemanticEnabled"
              :loading="state.semanticSaving" />
          </div>
        </template>
        <w-settings-row
          icon="tabler:sparkles"
          control-width="auto"
          :label="t('admin.search.semanticEnabled')"
          :hint="
            state.semanticAvailable
              ? t('admin.search.semanticEnabledHint')
              : t('admin.search.semanticUnavailableHint')
          "
          tag="label">
          <w-toggle
            v-model="state.semanticEnabled"
            :disabled="!state.semanticAvailable"
            :loading="state.loading > 0"
            :aria-label="t('admin.search.semanticEnabled')" />
        </w-settings-row>
        <w-settings-row
          icon="tabler:percentage"
          control-width="auto"
          :label="t('admin.search.semanticMinMatch')"
          :hint="t('admin.search.semanticMinMatchHint')">
          <div style="width: 120px">
            <w-input
              dense
              type="number"
              min="0"
              max="100"
              step="1"
              v-model.number="state.semanticMinMatch"
              :disabled="!state.semanticAvailable"
              hide-bottom-space
              suffix="%"
              :aria-label="t('admin.search.semanticMinMatch')" />
          </div>
        </w-settings-row>
      </w-settings-card>
    </div>
  </w-page>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useAdminSettings } from '@/composables/adminSettings'
import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { loading } from '@/composables/loading'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'

import UtilCodeEditor from '@/components/UtilCodeEditor.vue'
import ModuleConfigForm from '@/components/ModuleConfigForm.vue'
import { apiErrorMessage } from '@/helpers/apiError'
import { buildConfigEditor, buildConfigPayload } from '@/helpers/moduleConfig'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const DB_ENGINE_KEY = 'db'

const dark = useDark()

const adminStore = useAdminStore()
const siteStore = useSiteStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.search.title')
}))

let loadedSiteId = null

const { state, load } = useAdminSettings({
  i18nPrefix: 'admin.search',
  extraState: {
    rebuildLoading: false,
    engines: [],
    selectedEngineKey: '',
    semanticEnabled: false,
    semanticAvailable: false,
    semanticMinMatch: 0,
    semanticSaving: false,
    semanticRebuildLoading: false
  },
  fetch: async (siteId) => {
    const [engines, semantic] = await Promise.all([
      API_CLIENT.get(`sites/${siteId}/search/engines`).json(),
      API_CLIENT.get(`sites/${siteId}/search/semantic`).json()
    ])
    return { engines, semantic }
  },
  onLoaded: ({ engines, semantic }) => {
    applyEngines(engines, { resetSelection: adminStore.currentSiteId !== loadedSiteId })
    loadedSiteId = adminStore.currentSiteId
    state.semanticEnabled = semantic?.enabled ?? false
    state.semanticAvailable = semantic?.available ?? false
    state.semanticMinMatch = semantic?.minMatch ?? 0
  }
})

const selectedEngine = computed(
  () => state.engines.find((eng) => eng.key === state.selectedEngineKey) || null
)
const hasConfigurableProps = computed(
  () => Object.keys(selectedEngine.value?.props ?? {}).length > 0
)

/**
 * `resetSelection` forces the selection back onto the site's active engine -- what a site switch and
 * the first load need. Keeping the current key when it is still in the list is not enough: every
 * site has a `db` engine, so that would silently stay on it when the new site's active engine
 * differs.
 */
function applyEngines(engines, { resetSelection = false } = {}) {
  state.engines = (engines ?? []).map((eng) => ({
    ...eng,
    config: buildConfigEditor(eng.props, eng.config),
    dictOverridesText: JSON.stringify(eng.dictOverrides ?? {}, null, 2)
  }))
  if (resetSelection || !state.engines.some((eng) => eng.key === state.selectedEngineKey)) {
    state.selectedEngineKey =
      state.engines.find((eng) => eng.isSelected)?.key || state.engines[0]?.key || ''
  }
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

function payloadFor(engine) {
  return { config: buildConfigPayload(engine.config) }
}

/**
 * `PUT .../search/engines/:key` saves the config and selects the engine in one go -- unlike a
 * storage target, a search engine has no separate "select without save". `dictOverrides` is not a
 * declared prop that route accepts, so it goes through `PATCH .../search` afterwards, and only when
 * the editor actually changed: `db`'s other props save through this same button, and an untouched
 * mapping should not be re-validated or re-written. Validating client-side names the offending entry
 * while the operator is still looking at the editor.
 */
async function save() {
  if (!selectedEngine.value) {
    return
  }
  state.loading++
  loading.show()
  try {
    let dictOverrides
    if (
      selectedEngine.value.key === DB_ENGINE_KEY &&
      selectedEngine.value.dictOverridesText !==
        JSON.stringify(selectedEngine.value.dictOverrides ?? {}, null, 2)
    ) {
      try {
        dictOverrides = JSON.parse(selectedEngine.value.dictOverridesText || '{}')
      } catch (err) {
        throw new Error(t('admin.search.dictOverridesInvalidJSON', { reason: err.message }))
      }
      if (
        typeof dictOverrides !== 'object' ||
        Array.isArray(dictOverrides) ||
        dictOverrides === null
      ) {
        throw new Error(t('admin.search.dictOverridesNotAnObject'))
      }
      for (const [locale, dictionary] of Object.entries(dictOverrides)) {
        if (
          typeof dictionary !== 'string' ||
          !(selectedEngine.value.availableDictionaries ?? []).includes(dictionary)
        ) {
          throw new Error(t('admin.search.dictOverridesUnknown', { locale, dictionary }))
        }
      }
    }

    await API_CLIENT.put(
      `sites/${adminStore.currentSiteId}/search/engines/${selectedEngine.value.key}`,
      { json: payloadFor(selectedEngine.value) }
    ).json()

    if (dictOverrides !== undefined) {
      await API_CLIENT.patch(`sites/${adminStore.currentSiteId}/search`, {
        json: { dictOverrides }
      }).json()
    }

    notify({
      type: 'positive',
      message: t('admin.search.configSaveSuccess')
    })
    // -> Saving also selects this engine, leaving every other engine's `isSelected` flag stale.
    await load()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.search.saveFailed'),
      caption: apiErrorMessage(err)
    })
  }
  loading.hide()
  state.loading--
}

async function rebuild() {
  state.rebuildLoading = true
  try {
    await API_CLIENT.post(`sites/${adminStore.currentSiteId}/search/rebuild`).json()
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

/**
 * On failure, re-fetches the semantic setting rather than leaving the toggle showing what the reader
 * clicked: a stale `state.semanticAvailable` lets a click through that the server then refuses.
 */
function normalizeMinMatch(value) {
  const percent = Math.round(Number(value))
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
}

async function saveSemanticEnabled() {
  state.semanticSaving = true
  state.semanticMinMatch = normalizeMinMatch(state.semanticMinMatch)
  try {
    await API_CLIENT.patch(`sites/${adminStore.currentSiteId}/search`, {
      json: {
        semanticEnabled: state.semanticEnabled,
        semanticMinMatch: state.semanticMinMatch
      }
    }).json()
    notify({
      type: 'positive',
      message: t('admin.search.semanticSaveSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.search.semanticSaveFailed'),
      caption: apiErrorMessage(err)
    })
    try {
      const semantic = await API_CLIENT.get(
        `sites/${adminStore.currentSiteId}/search/semantic`
      ).json()
      state.semanticEnabled = semantic.enabled
      state.semanticAvailable = semantic.available
      state.semanticMinMatch = semantic.minMatch ?? 0
    } catch {
      // -> The failed-save toast above is enough; the re-fetch failing too isn't worth a second one.
    }
  }
  state.semanticSaving = false
}

/** Returns as soon as the job is queued; the scheduler view is where its progress shows. */
async function rebuildEmbeddings() {
  state.semanticRebuildLoading = true
  try {
    await API_CLIENT.post(`sites/${adminStore.currentSiteId}/search/rebuild-embeddings`).json()
    notify({
      type: 'positive',
      message: t('admin.search.rebuildEmbeddingsInitSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.search.rebuildEmbeddingsFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.semanticRebuildLoading = false
}
</script>

<style></style>
