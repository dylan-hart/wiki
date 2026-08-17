<template>
  <w-page class="admin-comments">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <img class="admin-icon animated fadeInLeft" src="/_assets/icons/fluent-comments.svg" />
      </div>
      <div class="min-w-0 flex-1 pl-4">
        <div class="text-h5 text-primary animated fadeInLeft">{{ t('admin.comments.title') }}</div>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.comments.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <w-spinner class="mr-4" v-show="state.loading > 0" color="accent" size="sm" />
        <w-btn
          class="mr-2 acrylic-btn"
          icon="la:question-circle"
          flat
          color="grey"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/comments`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          unelevated
          icon="mdi:check"
          :label="t(`common.actions.apply`)"
          color="secondary"
          @click="save()"
          :disable="!selectedProvider"
          :loading="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <div class="flex flex-wrap p-4 gap-4">
      <!-- ----------------------- -->
      <!-- Provider picker -->
      <!-- ----------------------- -->
      <div class="flex-none">
        <w-card class="rounded bg-dark">
          <w-list style="min-width: 300px" padding dark>
            <w-item
              v-for="prov of state.providers"
              :key="prov.module"
              active-class="bg-primary text-white"
              :active="state.selectedModule === prov.module"
              :disabled="!prov.isAvailable"
              clickable
              @click="state.selectedModule = prov.module">
              <w-item-section side>
                <w-icon v-if="!prov.isAvailable" name="mdi:minus-box-outline" color="grey" />
                <w-icon
                  v-else-if="state.selectedModule === prov.module"
                  name="mdi:checkbox-marked-circle-outline"
                  color="primary" />
                <w-icon v-else name="mdi:checkbox-blank-circle-outline" color="grey" />
              </w-item-section>
              <w-item-section>
                <w-item-label
                  :class="
                    !prov.isAvailable
                      ? `text-grey`
                      : state.selectedModule === prov.module
                        ? `text-primary`
                        : ``
                  "
                  >{{ prov.title }}</w-item-label
                >
                <w-item-label caption>{{ prov.description }}</w-item-label>
              </w-item-section>
              <w-item-section side>
                <status-light
                  :color="prov.isEnabled ? `positive` : `grey`"
                  :pulse="prov.isEnabled" />
              </w-item-section>
            </w-item>
            <w-item v-if="state.providers.length < 1">
              <w-item-section>
                <w-item-label caption>{{ t('admin.comments.noProviders') }}</w-item-label>
              </w-item-section>
            </w-item>
          </w-list>
        </w-card>
      </div>
      <!-- ----------------------- -->
      <!-- Selected provider -->
      <!-- ----------------------- -->
      <div class="min-w-0 flex-1" v-if="selectedProvider">
        <w-banner
          class="mb-4"
          v-if="showEnabledNoProviderHint"
          inline-actions
          :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`">
          {{ t('admin.comments.enabledNoProviderHint') }}
          <template #action>
            <w-btn
              flat
              no-caps
              :label="t('admin.comments.goToGeneral')"
              :to="`/_admin/` + adminStore.currentSiteId + `/general`" />
          </template>
        </w-banner>
        <!-- ----------------------- -->
        <!-- Description -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mb-4">
          <w-card-header>{{ selectedProvider.title }}</w-card-header>
          <w-card-section>
            <div class="text-body2">{{ selectedProvider.description }}</div>
            <div class="text-caption mt-2" v-if="selectedProvider.website">
              <a :href="selectedProvider.website" target="_blank" rel="noreferrer">{{
                selectedProvider.website
              }}</a>
            </div>
          </w-card-section>
        </w-card>
        <!-- ----------------------- -->
        <!-- Configuration -->
        <!-- ----------------------- -->
        <w-card class="pb-2">
          <w-card-header>{{ t('admin.comments.providerConfig') }}</w-card-header>
          <w-card-section>
            <w-banner
              v-if="!selectedProvider.config || Object.keys(selectedProvider.config).length < 1"
              :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`"
              >{{ t('admin.comments.providerNoConfig') }}</w-banner
            >
          </w-card-section>
          <template v-for="(cfg, cfgKey, idx) in selectedProvider.config" :key="cfgKey">
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
                <w-item-section :style="cfg.type === `number` ? `flex: 0 0 150px;` : ``">
                  <w-select
                    v-if="cfg.enum"
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
        </w-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, watch } from 'vue'

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
  title: t('admin.comments.title')
})

// DATA

const state = reactive({
  loading: 0,
  selectedModule: '',
  providers: []
})

// COMPUTED

const selectedProvider = computed(
  () => state.providers.find((prov) => prov.module === state.selectedModule) ?? null
)

/**
 * Comments are on for this site (`AdminGeneral.vue`'s `features.comments` toggle) but nothing is
 * active yet -- the reader-facing side of the feature will render nothing until an administrator
 * picks a provider here.
 */
const showEnabledNoProviderHint = computed(() => {
  const site = adminStore.sites.find((s) => s.id === adminStore.currentSiteId)
  return Boolean(site?.features?.comments) && !state.providers.some((prov) => prov.isEnabled)
})

// WATCHERS

watch(
  () => adminStore.currentSiteId,
  () => load()
)

// METHODS

/**
 * Turn a module prop declaration and its stored value into the shape the config editor renders,
 * expanding `value|label` enum entries into options.
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
  return ifs.every((s) => selectedProvider.value.config[s.key]?.value === s.eq)
}

async function load() {
  state.loading++
  loading.show()
  try {
    const providers = await API_CLIENT.get(
      `sites/${adminStore.currentSiteId}/comments/providers`
    ).json()
    state.providers = (providers ?? []).map((prov) => ({
      ...prov,
      config: buildConfigEditor(prov.props, prov.config)
    }))
    if (!state.providers.some((prov) => prov.module === state.selectedModule)) {
      state.selectedModule =
        state.providers.find((prov) => prov.isEnabled)?.module ?? state.providers[0]?.module ?? ''
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.comments.loadFailed'),
      caption: apiErrorMessage(err),
      timeout: 20000
    })
  }
  loading.hide()
  state.loading--
}

/**
 * A provider as the API expects it. Read-only props are left out: the server keeps whatever is
 * stored for them, so sending them back would be pretending they can be set.
 */
function payloadFor(prov) {
  const config = {}
  for (const [key, cfg] of Object.entries(prov.config ?? {})) {
    if (cfg.readOnly) {
      continue
    }
    config[key] = cfg.type === 'number' ? Number(cfg.value) : cfg.value
  }
  return { module: prov.module, config }
}

/** Activates the selected provider and stores its config, then reloads to pick up the server truth. */
async function save() {
  if (!selectedProvider.value) {
    return
  }
  state.loading++
  loading.show()
  try {
    await API_CLIENT.put(`sites/${adminStore.currentSiteId}/comments/providers`, {
      json: payloadFor(selectedProvider.value)
    }).json()
    notify({
      type: 'positive',
      message: t('admin.comments.saveSuccess')
    })
    await load()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.comments.saveFailed'),
      caption: apiErrorMessage(err)
    })
  }
  loading.hide()
  state.loading--
}

// MOUNTED

onMounted(() => {
  load()
})
</script>
