<template>
  <w-page class="admin-flags">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:flag" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.flags.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.flags.subtitle') }}
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
          @click="load">
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
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12 lg:col-span-7">
        <!-- A callout about the whole card, not a setting in it, so it is not a settings row -->
        <w-card class="bg-negative text-white rounded mb-4">
          <w-card-section class="items-center" horizontal>
            <w-card-section class="flex-none pe-0">
              <w-icon name="tabler:alert-triangle" size="lg" />
            </w-card-section>
            <w-card-section>
              <span>{{ t('admin.flags.warn.label') }}</span>
              <div class="text-caption text-red-1">{{ t('admin.flags.warn.hint') }}</div>
            </w-card-section>
          </w-card-section>
        </w-card>
        <w-settings-card :title="t('admin.flags.title')">
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:flask"
            :label="t(`admin.flags.experimental.label`)"
            :hint="t(`admin.flags.experimental.hint`)">
            <w-toggle
              v-model="state.flags.experimental"
              :aria-label="t(`admin.flags.experimental.label`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:bug"
            :label="t(`admin.flags.authDebug.label`)"
            :hint="t(`admin.flags.authDebug.hint`)">
            <w-toggle
              v-model="state.flags.authDebug"
              :aria-label="t(`admin.flags.authDebug.label`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:database-search"
            :label="t(`admin.flags.sqlLog.label`)"
            :hint="t(`admin.flags.sqlLog.hint`)">
            <w-toggle v-model="state.flags.sqlLog" :aria-label="t(`admin.flags.sqlLog.label`)" />
          </w-settings-row>
          <!-- A note about the flags above it, not a setting: hint slot only, so it reads at
               caption weight and stays attached to what it explains -->
          <w-settings-row
            control-width="auto"
            icon="tabler:info-circle"
            :hint="t(`admin.flags.serverLogNotice`)" />
        </w-settings-card>
        <w-settings-card class="mt-4" :title="t('admin.flags.advanced.label')">
          <!-- No `label` on the row: the card's own strip already names this setting, and
               repeating it immediately under would read as two different things -->
          <w-settings-row control-width="auto" icon="tabler:tool">
            <!-- TODO: the editor is unbuilt and nothing reads custom keys; the button stays
                 disabled behind the notImplemented hint until it is -->
            <template #hint>
              <div>{{ t(`admin.flags.advanced.hint`) }}</div>
              <div class="text-orange">{{ t(`admin.flags.advanced.notImplemented`) }}</div>
            </template>
            <w-btn
              :label="t(`common.actions.edit`)"
              icon="tabler:code"
              color="primary"
              text-color="white"
              disabled />
          </w-settings-row>
        </w-settings-card>
      </div>
      <div class="col-span-12 max-lg:hidden lg:col-span-5">
        <div class="p-4 text-center">
          <img src="/_assets/illustrations/undraw_settings.svg" style="width: 80%" alt="" />
        </div>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { useAdminSettings } from '@/composables/adminSettings'
import { useMeta } from '@/composables/meta'

import { useFlagsStore } from '@/stores/flags'

import { omit } from 'es-toolkit/object'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const flagsStore = useFlagsStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.flags.title')
}))

const {
  state,
  load,
  save: commitFlags
} = useAdminSettings({
  i18nPrefix: 'admin.flags',
  siteScoped: false,
  extraState: {
    flags: {
      experimental: false,
      authDebug: false,
      sqlLog: false
    }
  },
  // -> Through the store on both load and save, so the whole app sees the flags this page holds
  fetch: async () => {
    await flagsStore.load()
    return omit(flagsStore.$state, ['loaded'])
  },
  onLoaded: (flags) => {
    state.flags = flags
  },
  commit: () => API_CLIENT.put('system/flags', { json: state.flags }).json(),
  onSaved: () => load()
})

async function save() {
  if (state.loading > 0) {
    return
  }
  await commitFlags()
}
</script>

<style></style>
