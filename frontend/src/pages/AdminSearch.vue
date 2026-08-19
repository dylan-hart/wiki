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
            <template #action>
              <w-btn
                unelevated
                icon="mdi:check"
                :label="t(`common.actions.apply`)"
                color="secondary"
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
            Ported from `AdminStorage.vue`'s config editor block (lines ~407-461 there): boolean ->
            toggle, `enum` -> select or button-group (per `enumDisplay`), `sensitive` -> password
            input, `readOnly` -> disabled, `if` -> conditional visibility against sibling values.
            `selectedEngine.config` is the `buildConfigEditor()`-built editable structure (see below),
            not the raw stored values -- mutating `cfg.value` here is what `payloadFor()` reads back.

            Follow-up, out of this task's scope: this block plus `buildConfigEditor()` /
            `inputTypeFor()` / `configIfCheck()` / `payloadFor()` below are a close port of
            `AdminStorage.vue`'s copies, not a shared implementation -- worth factoring into a
            `frontend/src/components/` component so the two admin pages don't carry two copies that
            can drift. Deferred here because `AdminStorage.vue` has no test coverage to refactor it
            against safely within this task's time box; kept behavior-identical for the field types
            both pages share in the meantime.
          -->
          <template v-for="(cfg, cfgKey, idx) in selectedEngine.config" :key="cfgKey">
            <template v-if="configIfCheck(cfg.if)">
              <w-separator class="my-2" inset v-if="idx > 0" />
              <w-item v-if="cfg.type === `boolean`" tag="label">
                <blueprint-icon :icon="cfg.icon" :hue-rotate="cfg.readOnly ? -45 : 0" />
                <w-item-section>
                  <w-item-label>{{ cfg.title }}</w-item-label>
                  <w-item-label caption>{{ cfg.hint }}</w-item-label>
                </w-item-section>
                <w-item-section avatar>
                  <w-toggle v-model="cfg.value" :aria-label="cfg.title" :disable="cfg.readOnly" />
                </w-item-section>
              </w-item>
              <w-item v-else>
                <blueprint-icon :icon="cfg.icon" :hue-rotate="cfg.readOnly ? -45 : 0" />
                <w-item-section>
                  <w-item-label>{{ cfg.title }}</w-item-label>
                  <w-item-label caption>{{ cfg.hint }}</w-item-label>
                </w-item-section>
                <w-item-section
                  :style="cfg.type === `number` ? `flex: 0 0 150px;` : ``"
                  :class="{ 'col-auto': cfg.enum && cfg.enumDisplay === `buttons` }">
                  <w-btn-toggle
                    v-if="cfg.enum && cfg.enumDisplay === `buttons`"
                    v-model="cfg.value"
                    push
                    glossy
                    no-caps
                    toggle-color="primary"
                    :options="cfg.enum"
                    :disable="cfg.readOnly" />
                  <w-select
                    v-else-if="cfg.enum"
                    outlined
                    v-model="cfg.value"
                    :options="cfg.enum"
                    emit-value
                    map-options
                    dense
                    options-dense
                    :aria-label="cfg.title"
                    :disable="cfg.readOnly" />
                  <w-input
                    v-else
                    outlined
                    v-model="cfg.value"
                    dense
                    :type="inputTypeFor(cfg)"
                    :aria-label="cfg.title"
                    :disable="cfg.readOnly" />
                </w-item-section>
              </w-item>
            </template>
          </template>
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
import { computed, onMounted, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { loading } from '@/composables/loading'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'

import UtilCodeEditor from '@/components/UtilCodeEditor.vue'
import { apiErrorMessage } from '@/helpers/apiError'

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
 * Turn an engine's declared props and stored config into the shape the config form renders,
 * expanding `value|label` enum entries into options. Ported from `AdminStorage.vue`'s
 * `buildConfigEditor()` -- see the follow-up note in the template above.
 */
function buildConfigEditor(props, values) {
  const config = {}
  for (const [key, prop] of Object.entries(props ?? {})) {
    config[key] = {
      ...prop,
      value: values?.[key] ?? prop.default,
      ...(prop.enum && {
        enum: prop.enum.map((entry) => {
          const [value, label] = entry.split('|')
          return { value, label: label ?? value }
        })
      })
    }
  }
  return config
}

function inputTypeFor(cfg) {
  if (cfg.multiline) {
    return 'textarea'
  }
  if (cfg.sensitive) {
    return 'password'
  }
  return cfg.type === 'number' ? 'number' : 'text'
}

function configIfCheck(ifs) {
  if (!ifs || ifs.length < 1) {
    return true
  }
  return ifs.every((s) => selectedEngine.value?.config[s.key]?.value === s.eq)
}

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
 * @param resetSelection Force the selection back onto the site's active engine (a site switch),
 *   rather than keeping the currently viewed one when it is still in the list (an ordinary reload).
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

/**
 * A search engine's editable config, as the API expects it -- read-only props are left out, since the
 * server keeps whatever is stored for them and sending them back would be pretending they can be set.
 * Mirrors `AdminStorage.vue`'s `payloadFor()`.
 */
function payloadFor(engine) {
  const config = {}
  for (const [key, cfg] of Object.entries(engine.config ?? {})) {
    if (cfg.readOnly) {
      continue
    }
    config[key] = cfg.type === 'number' ? Number(cfg.value) : cfg.value
  }
  return { config }
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

    const resp = await API_CLIENT.put(
      `sites/${adminStore.currentSiteId}/search/engines/${selectedEngine.value.key}`,
      { json: payloadFor(selectedEngine.value) }
    ).json()
    if (!resp?.ok) {
      throw new Error(resp?.message || 'An unexpected error occured.')
    }

    if (dictOverrides !== undefined) {
      const dictResp = await API_CLIENT.patch(`sites/${adminStore.currentSiteId}/search`, {
        json: { dictOverrides }
      }).json()
      if (!dictResp?.ok) {
        throw new Error(dictResp?.message || 'An unexpected error occured.')
      }
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
