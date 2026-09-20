<template>
  <w-page class="admin-replication">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:refresh" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.replication.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.replication.subtitle') }}
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
          :disabled="state.loading > 0" />
      </div>
    </div>
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12 lg:col-span-7">
        <!--
          The warning is about the whole page, not a setting in it, so it is its own banner above the
          card rather than a settings row with nothing at its trailing edge.
        -->
        <w-card class="bg-negative text-white rounded mb-4">
          <w-card-section class="items-center" horizontal>
            <w-card-section class="flex-none pe-0">
              <w-icon name="tabler:alert-triangle" size="lg" />
            </w-card-section>
            <w-card-section class="text-caption">{{
              t('admin.replication.warning')
            }}</w-card-section>
          </w-card-section>
        </w-card>
        <w-settings-card :title="t('admin.replication.title')">
          <w-settings-row
            icon="tabler:link"
            :label="t(`admin.replication.sourceUrl`)"
            :hint="t(`admin.replication.sourceUrlHint`)">
            <w-input
              v-model="state.config.sourceUrl"
              dense
              hide-bottom-space
              placeholder="https://prod.example.com"
              :aria-label="t(`admin.replication.sourceUrl`)" />
          </w-settings-row>
          <w-settings-row
            icon="tabler:key"
            :label="t(`admin.replication.bearerToken`)"
            :hint="t(`admin.replication.bearerTokenHint`)">
            <w-input
              v-model="state.config.bearerToken"
              dense
              hide-bottom-space
              type="password"
              autocomplete="new-password"
              :aria-label="t(`admin.replication.bearerToken`)" />
          </w-settings-row>
          <w-settings-row
            icon="tabler:calendar-time"
            :label="t(`admin.replication.cronSchedule`)"
            :hint="t('admin.replication.cronScheduleHint', { example: '0 0 * * 0' })">
            <w-input
              v-model="state.config.cronSchedule"
              dense
              :rules="rulesCronSchedule"
              hide-bottom-space
              placeholder="0 0 * * 0"
              :aria-label="t(`admin.replication.cronSchedule`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:shield-lock"
            :label="t(`admin.replication.enabled`)"
            :hint="t(`admin.replication.enabledHint`)">
            <w-toggle
              v-model="state.config.isEnabled"
              :aria-label="t(`admin.replication.enabled`)" />
          </w-settings-row>
        </w-settings-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { Cron } from 'croner'
import { useI18n } from 'vue-i18n'

import { useAdminSettings } from '@/composables/adminSettings'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

import { useAdminStore } from '@/stores/admin'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const adminStore = useAdminStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.replication.title')
}))

/**
 * Every control needs a defined value even for a key the API does not answer with. Mirrors the
 * `replication` defaults the backend seeds (`base.yml`).
 */
function defaultConfig() {
  return {
    isEnabled: false,
    sourceUrl: '',
    bearerToken: '',
    cronSchedule: ''
  }
}

const { state, load } = useAdminSettings({
  i18nPrefix: 'admin.replication',
  siteScoped: false,
  overlay: false,
  defaults: defaultConfig,
  fetch: () => API_CLIENT.get('replication/config').json(),
  pick: (resp) => {
    if (!resp) {
      throw new Error(t('admin.replication.loadFailed'))
    }
    return resp
  },
  onLoaded: () => {
    adminStore.info.isReplicationEnabled = state.config?.isEnabled === true
  }
})

/**
 * Mirrors `backend/api/replication.ts#validateCronSchedule()`'s floor as immediate feedback -- the
 * config is also settable through the API, so the server stays the authority. The floor exists
 * because each run is a wipe-and-replace pull of the whole instance.
 */
const MIN_CRON_INTERVAL_MINUTES = 60

const rulesCronSchedule = [
  (val) => {
    if (!val) {
      return true
    }
    let job
    try {
      job = new Cron(val, { timezone: 'UTC', paused: true })
    } catch {
      return t('admin.replication.cronScheduleInvalid')
    }
    const firstFire = job.nextRun()
    const secondFire = firstFire ? job.nextRun(firstFire) : null
    if (!firstFire || !secondFire) {
      return t('admin.replication.cronScheduleInvalid')
    }
    if (secondFire.getTime() - firstFire.getTime() < MIN_CRON_INTERVAL_MINUTES * 60 * 1000) {
      return t('admin.replication.cronScheduleTooFrequent')
    }
    return true
  }
]

async function save() {
  if (state.loading > 0) {
    return
  }

  state.loading++
  try {
    await API_CLIENT.put('replication/config', {
      json: {
        isEnabled: state.config.isEnabled ?? false,
        sourceUrl: state.config.sourceUrl || '',
        bearerToken: state.config.bearerToken || '',
        cronSchedule: state.config.cronSchedule || ''
      }
    }).json()
    notify({
      type: 'positive',
      message: t('admin.replication.saveSuccess')
    })
    adminStore.info.isReplicationEnabled = state.config?.isEnabled === true
  } catch (err) {
    notify({
      type: 'negative',
      message: t(
        `admin.replication.${err.data?.error}`,
        apiErrorMessage(err, t('common.error.unexpected'))
      )
    })
  }
  state.loading--
}
</script>

<style></style>
