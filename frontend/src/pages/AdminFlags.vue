<template>
  <w-page class="admin-flags">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-windsock-animated.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 pl-4">
        <h1 class="text-h5 text-primary animated fadeInLeft">{{ t('admin.flags.title') }}</h1>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.flags.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="mr-2 acrylic-btn"
          icon="la:redo-alt"
          flat
          color="secondary"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          unelevated
          icon="mdi:check"
          :label="t(`common.actions.apply`)"
          color="secondary"
          @click="save"
          :loading="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12 lg:col-span-7">
        <w-card class="py-2">
          <w-item>
            <w-item-section>
              <w-card class="bg-negative text-white rounded" flat>
                <w-card-section class="items-center" horizontal>
                  <w-card-section class="flex-none pr-0">
                    <w-icon name="la:exclamation-triangle" size="lg" />
                  </w-card-section>
                  <w-card-section>
                    <span>{{ t('admin.flags.warn.label') }}</span>
                    <div class="text-caption text-red-1">{{ t('admin.flags.warn.hint') }}</div>
                  </w-card-section>
                </w-card-section>
              </w-card>
            </w-item-section>
          </w-item>
          <w-item tag="label">
            <blueprint-icon icon="flag-filled" />
            <w-item-section>
              <w-item-label>{{ t(`admin.flags.experimental.label`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.flags.experimental.hint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.flags.experimental"
                :aria-label="t(`admin.flags.experimental.label`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="flag-filled" />
            <w-item-section>
              <w-item-label>{{ t(`admin.flags.authDebug.label`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.flags.authDebug.hint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.flags.authDebug"
                :aria-label="t(`admin.flags.authDebug.label`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="flag-filled" />
            <w-item-section>
              <w-item-label>{{ t(`admin.flags.sqlLog.label`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.flags.sqlLog.hint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle v-model="state.flags.sqlLog" :aria-label="t(`admin.flags.sqlLog.label`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item>
            <w-item-section avatar>
              <w-icon name="la:info-circle" color="grey" />
            </w-item-section>
            <w-item-section>
              <w-item-label caption>{{ t(`admin.flags.serverLogNotice`) }}</w-item-label>
            </w-item-section>
          </w-item>
        </w-card>
        <w-card class="py-2 mt-4">
          <w-item>
            <blueprint-icon icon="administrative-tools" />
            <w-item-section>
              <w-item-label>{{ t(`admin.flags.advanced.label`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.flags.advanced.hint`) }}</w-item-label>
              <!-- The editor was never built, and nothing reads custom keys — say so rather than leave -->
              <!-- a disabled button with no explanation -->
              <w-item-label class="text-orange" caption>{{
                t(`admin.flags.advanced.notImplemented`)
              }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-btn
                :label="t(`common.actions.edit`)"
                unelevated
                icon="la:code"
                color="primary"
                text-color="white"
                disabled />
            </w-item-section>
          </w-item>
        </w-card>
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

// STORES

const flagsStore = useFlagsStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.flags.title')
}))

// DATA

const {
  state,
  load,
  save: commitFlags
} = useAdminSettings({
  i18nPrefix: 'admin.flags',
  // -> Instance-wide, not one site's: no site picker, no reload on switching site
  siteScoped: false,
  extraState: {
    flags: {
      experimental: false,
      authDebug: false,
      sqlLog: false
    }
  },
  // -> Through the store, so that `experimental` is refreshed for the whole app at the same time
  fetch: async () => {
    await flagsStore.load()
    return omit(flagsStore.$state, ['loaded'])
  },
  onLoaded: (flags) => {
    state.flags = flags
  },
  commit: () => API_CLIENT.put('system/flags', { json: state.flags }).json(),
  // -> Re-read through the store, so the whole app sees the flags it just stored
  onSaved: () => load()
})

// METHODS

/** Refuses a second submit while a load or an earlier save is still in flight. */
async function save() {
  if (state.loading > 0) {
    return
  }
  await commitFlags()
}
</script>

<style lang="scss"></style>
