<template>
  <w-page class="admin-ai">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:sparkles" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.ai.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.ai.subtitle') }}
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
          icon="mdi:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save"
          :loading="state.loading > 0" />
      </div>
    </div>
    <div class="p-4">
      <w-settings-card :title="t('admin.ai.providerSection')">
        <w-settings-row
          icon="tabler:sparkles"
          :label="t('admin.ai.provider')"
          :hint="t('admin.ai.providerHint')">
          <w-select
            v-model="state.selectedProvider"
            :options="providerOptions"
            option-value="value"
            option-label="label"
            option-disable="disable"
            emit-value
            map-options
            dense
            options-dense
            :aria-label="t('admin.ai.provider')" />
        </w-settings-row>
      </w-settings-card>
      <w-settings-card class="mt-4" :title="t('admin.ai.assistSection')">
        <w-settings-row
          tag="label"
          control-width="auto"
          icon="tabler:sparkles"
          :label="t('admin.ai.allowAssist')"
          :hint="t('admin.ai.allowAssistHint')">
          <w-toggle
            v-model="state.assist"
            :loading="state.loading > 0"
            :aria-label="t('admin.ai.allowAssist')" />
        </w-settings-row>
        <w-settings-row
          v-if="state.assist"
          control-width="fixed"
          icon="tabler:gauge"
          :label="t('admin.ai.assistDailyCap')"
          :hint="t('admin.ai.assistDailyCapHint')">
          <w-input
            v-model.number="state.assistDailyCap"
            type="number"
            min="1"
            max="100000"
            dense
            :suffix="t('admin.ai.assistDailyCapSuffix')"
            :aria-label="t('admin.ai.assistDailyCap')" />
        </w-settings-row>
      </w-settings-card>
      <w-settings-card
        v-if="provider"
        class="mt-4"
        :title="t('admin.ai.providerConfiguration', { provider: provider.title })">
        <template #hint>{{ provider.description }}</template>
        <module-config-form :config="provider.config" />
        <w-card-section v-if="provider.website" class="text-caption">
          <a :href="provider.website" target="_blank" rel="noreferrer">{{ provider.website }}</a>
        </w-card-section>
      </w-settings-card>
      <w-card v-else class="mt-4 admin-ai-off">
        <w-card-section>
          <w-banner :class="dark.isActive ? `bg-dark-4 text-grey-5` : `bg-grey-2 text-grey-7`">
            <em>{{
              state.providers.length > 0 ? t('admin.ai.disabledNotice') : t('admin.ai.noModules')
            }}</em>
          </w-banner>
        </w-card-section>
      </w-card>
    </div>
  </w-page>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useAdminSettings } from '@/composables/adminSettings'
import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { buildConfigEditor, buildConfigPayload } from '@/helpers/moduleConfig'

import ModuleConfigForm from '@/components/ModuleConfigForm.vue'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const AI_ASSIST_DEFAULT_DAILY_CAP = 50
const AI_ASSIST_MAX_DAILY_CAP = 100000

const dark = useDark()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.ai.title')
}))

const { state, load, refresh, save } = useAdminSettings({
  i18nPrefix: 'admin.ai',
  extraState: {
    providers: [],
    selectedProvider: '',
    assist: false,
    assistDailyCap: AI_ASSIST_DEFAULT_DAILY_CAP
  },
  fetch: async (siteId) => {
    const [providers, settings] = await Promise.all([
      API_CLIENT.get(`sites/${siteId}/ai/providers`).json(),
      API_CLIENT.get(`sites/${siteId}/ai`).json()
    ])
    return { providers, settings }
  },
  onLoaded: ({ providers, settings }) => {
    state.providers = (providers ?? []).map((prov) => ({
      key: prov.key,
      title: prov.title,
      description: prov.description,
      website: prov.website,
      hasImplementation: prov.hasImplementation,
      isSelected: prov.isSelected,
      config: buildConfigEditor(prov.props, prov.config)
    }))
    state.selectedProvider = state.providers.find((prov) => prov.isSelected)?.key ?? ''
    state.assist = settings?.assist === true
    state.assistDailyCap = parseAssistDailyCap(settings?.assistDailyCap)
  },
  commit: (siteId) => {
    const assist = {
      assist: state.assist,
      assistDailyCap: parseAssistDailyCap(state.assistDailyCap)
    }
    const json = provider.value
      ? {
          provider: provider.value.key,
          config: buildConfigPayload(provider.value.config),
          ...assist
        }
      : { provider: '', ...assist }
    return API_CLIENT.put(`sites/${siteId}/ai`, { json }).json()
  },
  onSaved: () => load()
})

const providerOptions = computed(() => [
  { value: '', label: t('admin.ai.providerNone'), disable: false },
  ...state.providers.map((prov) => ({
    value: prov.key,
    label: prov.hasImplementation
      ? prov.title
      : t('admin.ai.providerUnavailable', { provider: prov.title }),
    disable: !prov.hasImplementation
  }))
])

const provider = computed(
  () => state.providers.find((prov) => prov.key === state.selectedProvider) ?? null
)

function parseAssistDailyCap(value) {
  const cap = Math.floor(Number(value))
  if (!Number.isFinite(cap) || cap < 1) {
    return AI_ASSIST_DEFAULT_DAILY_CAP
  }
  return Math.min(cap, AI_ASSIST_MAX_DAILY_CAP)
}
</script>
