<template>
  <w-page class="admin-analytics">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:chart-line" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.analytics.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.analytics.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
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
        <w-btn
          icon="tabler:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save"
          :loading="state.loading > 0" />
      </div>
    </div>
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
        <w-settings-card :title="t('admin.analytics.info')">
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:power"
            :label="t(`admin.analytics.enabled`)"
            :hint="t(`admin.analytics.enabledHint`)">
            <w-toggle v-model="provider.isEnabled" :aria-label="t(`admin.analytics.enabled`)" />
          </w-settings-row>
        </w-settings-card>
        <w-settings-card class="mt-4" :title="t('admin.analytics.providerConfiguration')">
          <w-card-section v-if="!provider.config || Object.keys(provider.config).length < 1">
            <w-banner :class="dark.isActive ? `bg-dark-4 text-grey-5` : `bg-grey-2 text-grey-7`">
              <em>{{ t('admin.analytics.providerNoConfiguration') }}</em>
            </w-banner>
          </w-card-section>
          <!--
            The form mutates each field's `.value` inside `provider.config` in place, which is what
            `buildConfigPayload()` reads back on save -- there is no model binding to carry it.
          -->
          <module-config-form v-if="provider.config" :config="provider.config" />
        </w-settings-card>
        <w-card class="mt-4">
          <w-card-section class="text-center">
            <!-- -> `mx-auto`: `text-center` on the section does not centre a block-level image -->
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
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const dark = useDark()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.analytics.title')
}))

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

const provider = computed(() => {
  return state.providers.find((prov) => prov.key === state.selectedProvider) ?? null
})
</script>

<style scoped>
/*
  `w-icon` renders an `img:` source in a 1em-square box with no `object-fit` of its own, stretching
  a non-square provider logo (Matomo's is a wordmark). Cropping to fill beats distorting it, and
  `left` anchors the crop on the mark -- `cover`'s default centre crop lands mid-wordmark. Scoped
  here rather than fixed in WIcon.vue: this is the only icon-sized raw external logo in the app.
*/
.provider-logo-icon :deep(img) {
  object-fit: cover;
  object-position: left;
}
</style>
