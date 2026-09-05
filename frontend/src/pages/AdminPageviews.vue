<template>
  <w-page class="admin-pageviews">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-live.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.pageviews.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.pageviews.subtitle') }}
        </div>
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center">
          <template v-if="state.enabled">
            <w-signal class="me-2" color="green" size="md" />
            <div class="text-caption text-green">{{ t('admin.pageviews.enabled') }}</div>
          </template>
          <template v-else>
            <w-signal class="me-2" color="red" size="md" />
            <div class="text-caption text-red">{{ t('admin.pageviews.disabled') }}</div>
          </template>
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="acrylic-btn me-2"
          icon="la:redo-alt"
          flat
          color="secondary"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="refresh">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2"
          icon="la:power-off"
          :label="!state.enabled ? t(`common.actions.activate`) : t(`common.actions.deactivate`)"
          :color="!state.enabled ? `positive` : `negative`"
          @click="globalSwitch"
          :loading="state.isToggleLoading"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12">
        <w-card
          class="rounded"
          :class="dark.isActive ? `bg-dark-5 text-white` : `bg-grey-3 text-dark`">
          <w-card-section class="items-center" horizontal>
            <w-card-section class="flex-none pe-0">
              <w-icon name="la:info-circle" size="sm" />
            </w-card-section>
            <w-card-section>
              {{ t('admin.pageviews.description') }}
            </w-card-section>
          </w-card-section>
        </w-card>
      </div>
      <div class="col-span-12" v-if="state.summary.totalViews === 0">
        <w-card class="rounded">
          <w-card-section class="items-center" horizontal>
            <w-card-section class="flex-none pe-0">
              <w-icon name="la:chart-area" size="sm" />
            </w-card-section>
            <w-card-section>
              {{ t('admin.pageviews.noViewsYet') }}
            </w-card-section>
          </w-card-section>
        </w-card>
      </div>
      <template v-else>
        <div class="col-span-6 sm:col-span-3">
          <w-card class="rounded pageviews-stat">
            <w-card-section>
              <div class="pageviews-stat-label">{{ t('admin.pageviews.totalViews') }}</div>
              <div class="pageviews-stat-figure">{{ state.summary.totalViews }}</div>
            </w-card-section>
          </w-card>
        </div>
        <div class="col-span-6 sm:col-span-3">
          <w-card class="rounded pageviews-stat">
            <w-card-section>
              <div class="pageviews-stat-label">{{ t('admin.pageviews.last24h') }}</div>
              <div class="pageviews-stat-figure">{{ state.summary.last24h }}</div>
            </w-card-section>
          </w-card>
        </div>
        <div class="col-span-6 sm:col-span-3">
          <w-card class="rounded pageviews-stat">
            <w-card-section>
              <div class="pageviews-stat-label">{{ t('admin.pageviews.last7d') }}</div>
              <div class="pageviews-stat-figure">{{ state.summary.last7d }}</div>
            </w-card-section>
          </w-card>
        </div>
        <div class="col-span-6 sm:col-span-3">
          <w-card class="rounded pageviews-stat">
            <w-card-section>
              <div class="pageviews-stat-label">{{ t('admin.pageviews.distinctPages') }}</div>
              <div class="pageviews-stat-figure">{{ state.summary.distinctPages }}</div>
            </w-card-section>
          </w-card>
        </div>
        <div class="col-span-12">
          <div class="pageviews-stat-label">
            {{ t('admin.pageviews.mostRecentView') }}:
            {{ relativeDate(state.summary.mostRecentAt) }}
          </div>
        </div>
      </template>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { useAdminSettings } from '@/composables/adminSettings'
import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { relativeDate } from '@/helpers/datetime'

import { useAdminStore } from '@/stores/admin'
import { apiErrorMessage } from '@/helpers/apiError'

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.pageviews.title')
}))

// DATA

const { state, load, refresh } = useAdminSettings({
  i18nPrefix: 'admin.pageviews',
  // -> Instance-wide, not one site's: no site picker, no reload on switching site
  siteScoped: false,
  extraState: {
    enabled: false,
    isToggleLoading: false,
    // -> Instance-wide evidence that tracking is actually recording something (OpenProject #2335),
    //    not just the on/off state above -- see `admin.pageviews.*` template block.
    summary: {
      totalViews: 0,
      last24h: 0,
      last7d: 0,
      distinctPages: 0,
      mostRecentAt: null
    }
  },
  fetch: () => API_CLIENT.get('system/pageviews').json(),
  onLoaded: (resp) => {
    state.enabled = resp?.isEnabled === true
    // -> Keeps the sidebar status light in step without another round trip
    adminStore.info.isPageviewsEnabled = state.enabled
    state.summary = {
      totalViews: resp?.summary?.totalViews ?? 0,
      last24h: resp?.summary?.last24h ?? 0,
      last7d: resp?.summary?.last7d ?? 0,
      distinctPages: resp?.summary?.distinctPages ?? 0,
      mostRecentAt: resp?.summary?.mostRecentAt ?? null
    }
  }
})

// METHODS

async function globalSwitch() {
  state.isToggleLoading = true
  const wanted = !state.enabled
  try {
    await API_CLIENT.put('system/pageviews', {
      json: { isEnabled: wanted }
    }).json()
    notify({
      type: 'positive',
      message: wanted
        ? t('admin.pageviews.toggleStateEnabledSuccess')
        : t('admin.pageviews.toggleStateDisabledSuccess')
    })
    await load()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.pageviews.toggleStateFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.isToggleLoading = false
}
</script>

<style scoped>
/*
  A counter card's label and figure. `text-caption`/`text-h5` before -- and `text-h5` is what the
  heading-hierarchy scan (`pageTitleHeadings.test.js`) looks for, correctly: these are numbers, not
  headings, and sizing them with a heading class is exactly the pseudo-heading that scan exists to
  catch. Cardinal sets a figure in Barlow Condensed in the accent, as the dashboard's own counter
  cards do.
*/
.pageviews-stat-label {
  font-size: 12px;
  letter-spacing: 0.03333em;
  color: var(--color-text-caption);
}

:global(body.body--dark) .pageviews-stat-label {
  color: var(--color-text-caption-dark);
}

.pageviews-stat-figure {
  font-family: var(--font-display);
  font-size: 30px;
  font-weight: 700;
  line-height: 1.1;
  color: var(--color-accent);
}
</style>
