<template>
  <w-page class="admin-search">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon name="tabler:list-search" size="64px" class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.search.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.search.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <w-btn
          class="me-2 acrylic-btn"
          flat
          icon="mdi:database-refresh"
          :label="t(`admin.searchRebuildIndex`)"
          color="purple"
          @click="rebuild"
          :loading="state.rebuildLoading" />
        <w-separator class="me-2" vertical />
        <w-btn
          class="me-2"
          icon="la:question-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/search`"
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
          @click="refresh">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <w-separator inset />
    <!--
      List-beside-panel shape like `AdminStorage.vue`'s targets and `AdminAuth.vue`'s strategies, but
      the sizing below is deliberately NOT the same (OpenProject #857 fixed only this page; those two
      keep their own hard `min-width: 300px` list under a separate, filed-but-not-yet-worked audit --
      don't "restore consistency" by reverting this).

      Straight 50/50: both sides are `flex: 1 1 calc(50% - 8px)`, so they always split the row evenly
      and shrink together, with `min-width: 260px` on each as the point past which the row wraps to
      stacked instead of squeezing either side's content (an icon + title + description per list row,
      or the config form's own inputs) illegible. The `- 8px` is half of `gap-4`'s 16px: two plain `50%`
      bases plus the gap between them sum to MORE than the row's width, which is what was forcing an
      unwanted wrap even with room to spare -- flex-wrap goes by each item's hypothetical size including
      the gap, not by what's left over after subtracting it. Earlier attempts at this (a rigid
      `min-width: 300px` list beside a `flex-1` panel, then a `clamp()`-based list width) both left the
      list far narrower than its original share of the row, which used to be the vast majority of the
      width -- there is no viewport-width breakpoint here on purpose: the admin sidebar column itself
      toggles at 1024px (see `AdminLayout.vue`'s `isWideViewport`), so the CONTENT area's width does not
      track viewport width monotonically, and a breakpoint on this row would be reasoning about the
      wrong box.
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
                <w-icon name="mdi:check-circle" size="sm" color="positive" />
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
        <w-card class="pb-2">
          <w-card-header>
            {{ t('admin.search.engineConfig') }}
            <template #hint>{{ selectedEngine.description }}</template>
            <template #action>
              <w-btn
                icon="mdi:check"
                :label="t(`common.actions.apply`)"
                color="slate"
                @click="save()"
                :loading="state.loading > 0" />
            </template>
          </w-card-header>
          <w-card-section v-if="!hasConfigurableProps">
            <w-banner :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`">{{
              t('admin.search.engineNoConfig')
            }}</w-banner>
          </w-card-section>
          <!--
            Generic per-prop config form, shared with `AdminStorage.vue`'s own module config editor
            (task #556) -- see `ModuleConfigForm.vue`. `selectedEngine.config` is the
            `buildConfigEditor()`-built editable structure (see below), not the raw stored values --
            mutating a field's `.value` there, which this component does in place, is what
            `buildConfigPayload()` in `save()` below reads back.
          -->
          <module-config-form :config="selectedEngine.config" />
          <!--
            Postgres-specific override, task #574: `dictOverrides` is a locale -> text search
            dictionary map with no fixed set of keys, so `parseModuleProps` cannot express it as a
            generic prop the way `termHighlighting` above is one -- it needs its own JSON editor and
            its own validation against what this database actually has installed. Gated on the engine
            key exactly like `AdminStorage.vue` special-cases `state.target.setup.handler === 'github'`
            for GitHub's OAuth setup flow: a generic per-engine surface with one engine's panel adding
            something the generic form cannot.
          -->
          <template v-if="selectedEngine.key === DB_ENGINE_KEY">
            <w-separator class="my-2" inset />
            <w-item>
              <blueprint-icon class="self-start" icon="search" />
              <w-item-section>
                <w-item-label>{{ t('admin.search.dictOverrides') }}</w-item-label>
                <util-code-editor
                  class="my-2"
                  v-model="selectedEngine.dictOverridesText"
                  language="json"
                  :min-height="250"
                  :aria-label="t('admin.search.dictOverrides')" />
                <w-item-label caption>
                  <i18n-t keypath="admin.search.dictOverridesHint" tag="span">
                    <span>{ "en": "english" }</span>
                  </i18n-t>
                </w-item-label>
              </w-item-section>
            </w-item>
          </template>
        </w-card>
      </div>
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

// CONSTANTS

/** The one engine whose panel has a dictionary override editor, task #574. */
const DB_ENGINE_KEY = 'db'

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.search.title')
}))

// DATA

/**
 * The site the engine list on screen was last loaded for. What tells an ordinary reload (a save, the
 * refresh button) apart from a site switch, which has to force the picker back onto the new site's
 * own active engine -- see `applyEngines`'s `resetSelection`.
 */
let loadedSiteId = null

const { state, load } = useAdminSettings({
  i18nPrefix: 'admin.search',
  extraState: {
    rebuildLoading: false,
    engines: [],
    selectedEngineKey: ''
  },
  fetch: (siteId) => API_CLIENT.get(`sites/${siteId}/search/engines`).json(),
  onLoaded: (engines) => {
    applyEngines(engines, { resetSelection: adminStore.currentSiteId !== loadedSiteId })
    loadedSiteId = adminStore.currentSiteId
  }
})

// COMPUTED

const selectedEngine = computed(
  () => state.engines.find((eng) => eng.key === state.selectedEngineKey) || null
)
const hasConfigurableProps = computed(
  () => Object.keys(selectedEngine.value?.props ?? {}).length > 0
)

// METHODS

/**
 * Apply a freshly-fetched engine list, choosing what stays selected. Each engine's raw `config`
 * (stored values) is turned into the editable `buildConfigEditor()` structure the form above binds
 * to, same as `AdminStorage.vue` does once per target at load time.
 *
 * `dictOverridesText` is seeded the same way, for the `db`-only editor below: the API returns
 * `dictOverrides` as an object (`api/search.ts`'s `withDbSearchExtras`), but `util-code-editor` works
 * on text, so it is stringified once per load exactly like `AdminStorage.vue`'s config values are
 * turned into editable state once per load. Harmless on every other engine, whose `dictOverrides` is
 * always absent -- it just seeds `'{}'`, never rendered since the template gates on the engine key.
 *
 * @param resetSelection Force the selection back onto the site's active engine -- what a site
 *   switch (and the first load of all) asks for, rather than keeping the currently viewed one when
 *   it is still in the list, which is what an ordinary reload wants. Switching sites in the admin
 *   header must not leave this page pinned to the previous site's selection, and merely keeping the
 *   old key when it happens to also exist there is not enough: every site has a `db` engine, so a
 *   naive "keep if still present" check would silently stay on it even when the new site's active
 *   engine is something else.
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

/**
 * A search engine's editable config, as the API expects it. Thin wrapper over the shared
 * `buildConfigPayload()` (`@/helpers/moduleConfig.js`) -- `AdminStorage.vue`'s own payload for a
 * target wraps the same reduction alongside target-only fields, which is why the shared helper stops
 * at the plain config object rather than this `{ config }` shape.
 */
function payloadFor(engine) {
  return { config: buildConfigPayload(engine.config) }
}

/**
 * Save the currently viewed engine's config and, since the route makes no distinction, select it as
 * the site's active engine -- unlike a storage target's `isEnabled`, a search engine has no
 * independent "select without save": `PUT .../search/engines/:key` always does both (`api/search.ts`).
 *
 * For `db`, also validates and saves `dictOverrides` when its editor was actually touched -- ported
 * from the pre-#571 `AdminSearch.vue`'s own `save()`, same error messages and the same order of checks
 * (parse, then shape, then every mapped dictionary against `state.availableDictionaries`, now
 * `selectedEngine.value.availableDictionaries` off the engine list response). Client-side, so the
 * offending entry can be named while the operator is still looking at the editor rather than after a
 * round trip. `dictOverrides` cannot travel through `PUT .../engines/:key` -- it isn't a declared prop
 * `validateEngineConfig` would accept -- so it goes through the same `PATCH .../search` route that
 * route always used, after the generic save succeeds. Compared against the pristine value the editor
 * was loaded with (same stringify `applyEngines()` seeded it from) rather than sent unconditionally on
 * every save: `db`'s other props (`termHighlighting`, ...) are saved through this same Apply button, and
 * a dictionary mapping nobody touched should not be re-validated -- or re-written -- just because one of
 * those changed.
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
    // -> Reload the list: saving may have changed which engine is selected, and other engines'
    //    `isSelected` flags need to reflect that.
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
</script>

<style lang="scss"></style>
