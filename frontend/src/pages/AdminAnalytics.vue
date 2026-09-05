<template>
  <w-page class="admin-analytics">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-bar-chart.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.analytics.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.analytics.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
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
        <w-btn
          unelevated
          icon="mdi:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save"
          :loading="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <!--
      Same list-beside-a-panel shape AdminAuth uses: a fixed-width list of providers and a panel that
      takes what is left, wrapping onto its own row rather than squeezing into a 12-column grid.
    -->
    <div class="flex flex-wrap p-4 gap-4">
      <div class="flex-none">
        <w-card class="rounded bg-dark">
          <w-list style="min-width: 350px" padding dark>
            <w-item v-if="state.providers.length < 1">
              <w-item-section>
                <w-item-label caption>{{ t('admin.analytics.noModules') }}</w-item-label>
              </w-item-section>
            </w-item>
            <w-item
              v-for="prov of state.providers"
              :key="prov.key"
              active-class="bg-primary text-white"
              :active="state.selectedProvider === prov.key"
              @click="state.selectedProvider = prov.key"
              clickable>
              <w-item-section side
                ><w-icon class="provider-logo-icon" :name="`img:` + prov.logo"
              /></w-item-section>
              <w-item-section>
                <w-item-label>{{ prov.title }}</w-item-label>
                <w-item-label caption lines="1">{{ prov.description }}</w-item-label>
              </w-item-section>
              <w-item-section side>
                <status-light
                  :color="prov.isEnabled ? `positive` : `negative`"
                  :pulse="prov.isEnabled" />
              </w-item-section>
            </w-item>
          </w-list>
        </w-card>
      </div>
      <!-- -> `min-w-0`, or a long value inside a field would push the panel wider than the row -->
      <div class="min-w-0 flex-1" v-if="provider">
        <w-card class="pb-2">
          <w-card-header>{{ t('admin.analytics.info') }}</w-card-header>
          <w-item tag="label">
            <blueprint-icon icon="shutdown" />
            <w-item-section>
              <w-item-label>{{ t(`admin.analytics.enabled`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.analytics.enabledHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle v-model="provider.isEnabled" :aria-label="t(`admin.analytics.enabled`)" />
            </w-item-section>
          </w-item>
        </w-card>
        <!-- ----------------------- -->
        <!-- Configuration -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4">
          <w-card-header>{{ t('admin.analytics.providerConfiguration') }}</w-card-header>
          <w-card-section>
            <w-banner
              class="mt-4"
              v-if="!provider.config || Object.keys(provider.config).length < 1"
              :class="dark.isActive ? `bg-dark-4 text-grey-5` : `bg-grey-2 text-grey-7`">
              <em>{{ t('admin.analytics.providerNoConfiguration') }}</em>
            </w-banner>
          </w-card-section>
          <!--
            Generic per-prop config form, shared with `AdminAuth.vue`, `AdminComments.vue`,
            `AdminSearch.vue` and `AdminStorage.vue` -- see `ModuleConfigForm.vue`. `provider.config`
            is the `buildConfigEditor()`-built editable structure, not the raw stored values;
            mutating a field's `.value` there, which this component does in place, is what
            `buildConfigPayload()` in `save()` below reads back.
          -->
          <module-config-form v-if="provider.config" :config="provider.config" />
        </w-card>
        <!-- ----------------------- -->
        <!-- Infobox -->
        <!-- ----------------------- -->
        <w-card class="mt-4">
          <w-card-section class="text-center">
            <!-- -> `mx-auto`: `text-center` on the section does nothing for a block-level image,
                 which sat against the left edge of every card wider than its 300px cap -->
            <img
              class="w-full mx-auto object-contain rounded"
              :src="provider.logo"
              :alt="provider.title"
              style="height: 100px; max-width: 300px" />
            <div class="text-subtitle2 mt-2">{{ provider.title }}</div>
            <div class="text-caption mt-2">{{ provider.description }}</div>
            <div class="text-caption">
              <a :href="provider.website" target="_blank" rel="noreferrer">{{
                provider.website
              }}</a>
            </div>
          </w-card-section>
        </w-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'

import { useAdminSettings } from '@/composables/adminSettings'
import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { buildConfigEditor, buildConfigPayload } from '@/helpers/moduleConfig'

import ModuleConfigForm from '@/components/ModuleConfigForm.vue'

// COMPOSABLES

const dark = useDark()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.analytics.title')
}))

// DATA

const { state, refresh, save } = useAdminSettings({
  i18nPrefix: 'admin.analytics',
  extraState: {
    providers: [],
    selectedProvider: ''
  },
  fetch: (siteId) =>
    Promise.all([
      API_CLIENT.get('analytics/modules').json(),
      API_CLIENT.get(`sites/${siteId}?strict=true`).json()
    ]),
  onLoaded: ([modules, site]) => {
    const storedProviders = site?.analytics?.providers ?? {}
    const providers = (modules ?? []).map((mod) => {
      const stored = storedProviders[mod.key] ?? {}
      return {
        key: mod.key,
        title: mod.title,
        description: mod.description,
        logo: mod.logo,
        website: mod.website,
        isEnabled: stored.isEnabled ?? false,
        config: buildConfigEditor(mod.props, stored.config)
      }
    })
    state.providers = providers
    // -> Keep the current selection across a reload, falling back to the first provider
    state.selectedProvider = providers.some((prov) => prov.key === state.selectedProvider)
      ? state.selectedProvider
      : (providers[0]?.key ?? '')
  },
  commit: (siteId) => {
    const providers = {}
    for (const prov of state.providers) {
      providers[prov.key] = {
        isEnabled: prov.isEnabled ?? false,
        config: buildConfigPayload(prov.config)
      }
    }
    return API_CLIENT.put(`sites/${siteId}`, { json: { analytics: { providers } } }).json()
  }
})

// COMPUTED

const provider = computed(() => {
  return state.providers.find((prov) => prov.key === state.selectedProvider) ?? null
})
</script>

<style scoped>
/*
  Provider logos aren't all square (Matomo's is a 341.82x58.32 wordmark) but the list renders them
  through `w-icon`'s 1em-square box, which stretches a non-square `img:` source to fill it with no
  `object-fit` of its own (see WIcon.vue). Scoped here rather than fixed in WIcon.vue: this is the
  only `img:`-kind icon in the app rendering a raw external logo at icon size, so cropping to fill
  the square (`cover`) beats distorting the wordmark, without changing every other `w-icon` use.

  `object-position: left` alongside it: `cover`'s default center-crop lands on the middle of
  Matomo's wordmark (its actual icon mark sits in roughly the left quarter of the image), showing
  two unrecognizable letterforms instead of the mark. Anchoring to the left edge fixes Matomo and
  is a no-op for Google Analytics and Google Tag Manager's logos, both already square (OpenProject
  #855).
*/
.provider-logo-icon :deep(img) {
  object-fit: cover;
  object-position: left;
}
</style>
