<template>
  <w-page class="admin-replication">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon name="tabler:refresh" size="64px" class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.replication.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.replication.subtitle') }}
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
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          icon="mdi:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12 lg:col-span-7">
        <!-- ----------------------- -->
        <!-- Warning -->
        <!-- ----------------------- -->
        <w-card class="py-2 mb-4">
          <w-item>
            <w-item-section>
              <w-card class="bg-negative text-white rounded">
                <w-card-section class="items-center" horizontal>
                  <w-card-section class="flex-none pe-0">
                    <w-icon name="la:exclamation-triangle" size="lg" />
                  </w-card-section>
                  <w-card-section class="text-caption">{{
                    t('admin.replication.warning')
                  }}</w-card-section>
                </w-card-section>
              </w-card>
            </w-item-section>
          </w-item>
        </w-card>
        <!-- ----------------------- -->
        <!-- Configuration -->
        <!-- ----------------------- -->
        <w-card class="pb-2">
          <w-card-header>{{ t('admin.replication.title') }}</w-card-header>
          <w-item>
            <blueprint-icon icon="link" />
            <w-item-section>
              <w-item-label>{{ t(`admin.replication.sourceUrl`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.replication.sourceUrlHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-input
                v-model="state.config.sourceUrl"
                dense
                hide-bottom-space
                placeholder="https://prod.example.com"
                :aria-label="t(`admin.replication.sourceUrl`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="key" />
            <w-item-section>
              <w-item-label>{{ t(`admin.replication.bearerToken`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.replication.bearerTokenHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-input
                v-model="state.config.bearerToken"
                dense
                hide-bottom-space
                type="password"
                autocomplete="new-password"
                :aria-label="t(`admin.replication.bearerToken`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="schedule" />
            <w-item-section>
              <w-item-label>{{ t(`admin.replication.cronSchedule`) }}</w-item-label>
              <w-item-label caption>{{
                t('admin.replication.cronScheduleHint', { example: '0 0 * * 0' })
              }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-input
                v-model="state.config.cronSchedule"
                dense
                :rules="rulesCronSchedule"
                hide-bottom-space
                placeholder="0 0 * * 0"
                :aria-label="t(`admin.replication.cronSchedule`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="access" />
            <w-item-section>
              <w-item-label>{{ t(`admin.replication.enabled`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.replication.enabledHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.isEnabled"
                :aria-label="t(`admin.replication.enabled`)" />
            </w-item-section>
          </w-item>
        </w-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { CronExpressionParser } from 'cron-parser'
import { useI18n } from 'vue-i18n'

import { useAdminSettings } from '@/composables/adminSettings'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

import { useAdminStore } from '@/stores/admin'

// STORES

const adminStore = useAdminStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.replication.title')
}))

// DATA

/**
 * Fallbacks for config keys the API may not return yet, so that every control renders with a
 * defined value. Must mirror the `replication` defaults seeded by the backend (`base.yml`).
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
  // -> Instance-wide settings, not one site's: no site picker, no reload on switching site
  siteScoped: false,
  // -> This form has never raised the full-screen overlay to read its own values
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

// VALIDATION

/**
 * Mirrors `backend/api/replication.ts#validateCronSchedule()`'s minimum-interval floor as immediate
 * client-side feedback -- the server remains the authority (config can be set via the API directly),
 * this only saves an admin the round trip to discover the same rejection. Replication is a
 * wipe-and-replace pull of the entire instance, which is why the floor is generous but non-zero: see
 * the backend's own comment for the full reasoning (OpenProject #2509).
 */
const MIN_CRON_INTERVAL_MINUTES = 60

const rulesCronSchedule = [
  (val) => {
    if (!val) {
      return true
    }
    let expression
    try {
      expression = CronExpressionParser.parse(val, { tz: 'UTC' })
    } catch {
      return t('admin.replication.cronScheduleInvalid')
    }
    const firstFire = expression.next().toDate().getTime()
    const secondFire = expression.next().toDate().getTime()
    if (secondFire - firstFire < MIN_CRON_INTERVAL_MINUTES * 60 * 1000) {
      return t('admin.replication.cronScheduleTooFrequent')
    }
    return true
  }
]

// METHODS

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

<style lang="scss"></style>
