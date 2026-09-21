<template>
  <w-page class="admin-storage">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:database" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.storage.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.storage.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <w-spinner class="me-4" v-show="state.loading > 0" color="accent" size="sm" />
        <w-btn-toggle
          class="me-4"
          v-model="state.displayMode"
          :toggle-color="dark.isActive ? `white` : `black`"
          :toggle-text-color="dark.isActive ? `black` : `white`"
          :text-color="dark.isActive ? `white` : `black`"
          :color="dark.isActive ? `dark-1` : `white`"
          :aria-label="t(`admin.storage.title`)"
          :options="[
            { label: t('admin.storage.targets'), value: 'targets' },
            { label: t('admin.storage.deliveryPaths'), value: 'delivery' }
          ]" />
        <w-separator class="me-4" vertical />
        <w-btn
          class="me-2"
          icon="tabler:help-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/storage`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          icon="tabler:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save()"
          :loading="state.loading > 0" />
      </div>
    </div>
    <div class="flex flex-wrap p-4 gap-4" v-if="state.displayMode === `targets`">
      <div class="w-[300px] max-w-full flex-none">
        <w-card class="rounded bg-dark">
          <w-list padding dark>
            <w-item
              v-for="tgt of state.targets"
              :key="tgt.id"
              active-class="bg-primary text-white"
              :active="state.selectedTarget === tgt.id"
              :to="`/_admin/` + adminStore.currentSiteId + `/storage/` + tgt.id"
              clickable>
              <w-item-section side><w-icon :name="`img:` + tgt.icon" /></w-item-section>
              <w-item-section>
                <w-item-label>{{ tgt.title }}</w-item-label>
                <w-item-label caption :class="getTargetSubtitleColor(tgt)">{{
                  getTargetSubtitle(tgt)
                }}</w-item-label>
              </w-item-section>
              <w-item-section side>
                <status-light
                  :color="tgt.isEnabled ? `positive` : `negative`"
                  :pulse="tgt.isEnabled" />
              </w-item-section>
            </w-item>
          </w-list>
        </w-card>
      </div>
      <div class="min-w-0 shrink grow basis-80" v-if="state.target">
        <!--
          Flex rather than the 12-column grid: `col-span-12` on the settings would take a whole grid
          row and push the infobox underneath. The settings column's `basis-80` (not `flex-1`, whose
          zero basis never wraps) is what makes the infobox drop below it when there is no room.
        -->
        <div class="flex flex-wrap gap-4">
          <div class="min-w-0 shrink grow basis-80">
            <w-settings-card :title="t('admin.storage.contentTypes')">
              <template #hint>
                <div>{{ t('admin.storage.contentTypesHint') }}</div>
                <div v-if="!state.target.sync?.supportsContentSync">
                  {{ t('admin.storage.contentTypesNoLiveSyncHint') }}
                </div>
              </template>
              <w-settings-row
                v-if="supportsContentType(`pages`)"
                tag="label"
                control-width="auto"
                icon="tabler:file-text"
                :label="t(`admin.storage.contentTypePages`)"
                :hint="t(`admin.storage.contentTypePagesHint`)">
                <w-checkbox
                  v-model="state.target.contentTypes.activeTypes"
                  :color="state.target.module === `db` ? `grey` : `primary`"
                  val="pages"
                  :aria-label="t(`admin.storage.contentTypePages`)"
                  :disabled="state.target.module === `db`" />
              </w-settings-row>
              <w-settings-row
                v-if="supportsContentType(`images`)"
                tag="label"
                control-width="auto"
                icon="tabler:photo"
                :label="t(`admin.storage.contentTypeImages`)"
                :hint="t(`admin.storage.contentTypeImagesHint`)">
                <w-checkbox
                  v-model="state.target.contentTypes.activeTypes"
                  color="primary"
                  val="images"
                  :aria-label="t(`admin.storage.contentTypeImages`)" />
              </w-settings-row>
              <w-settings-row
                v-if="supportsContentType(`documents`)"
                tag="label"
                control-width="auto"
                icon="tabler:file-typography"
                :label="t(`admin.storage.contentTypeDocuments`)"
                :hint="t(`admin.storage.contentTypeDocumentsHint`)">
                <w-checkbox
                  v-model="state.target.contentTypes.activeTypes"
                  color="primary"
                  val="documents"
                  :aria-label="t(`admin.storage.contentTypeDocuments`)" />
              </w-settings-row>
              <w-settings-row
                v-if="supportsContentType(`others`)"
                tag="label"
                control-width="auto"
                icon="tabler:files"
                :label="t(`admin.storage.contentTypeOthers`)"
                :hint="t(`admin.storage.contentTypeOthersHint`)">
                <w-checkbox
                  v-model="state.target.contentTypes.activeTypes"
                  color="primary"
                  val="others"
                  :aria-label="t(`admin.storage.contentTypeOthers`)" />
              </w-settings-row>
              <w-settings-row
                v-if="supportsContentType(`large`)"
                tag="label"
                control-width="auto"
                icon="tabler:database-import"
                :label="t(`admin.storage.contentTypeLargeFiles`)">
                <template #hint>
                  <div>{{ t(`admin.storage.contentTypeLargeFilesHint`) }}</div>
                  <div class="text-deep-orange" v-if="state.target.module === `db`">
                    {{ t(`admin.storage.contentTypeLargeFilesDBWarn`) }}
                  </div>
                </template>
                <div class="flex items-center gap-3">
                  <w-input
                    :label="t(`admin.storage.contentTypeLargeFilesThreshold`)"
                    v-model="state.target.contentTypes.largeThreshold"
                    style="min-width: 150px"
                    dense />
                  <w-checkbox
                    v-model="state.target.contentTypes.activeTypes"
                    color="primary"
                    val="large"
                    :aria-label="t(`admin.storage.contentTypeLargeFiles`)" />
                </div>
              </w-settings-row>
            </w-settings-card>
            <w-settings-card class="mt-4" :title="t('admin.storage.assetDelivery')">
              <template #hint>{{ t('admin.storage.assetDeliveryHint') }}</template>
              <w-settings-row
                :tag="state.target.assetDelivery.isStreamingSupported ? `label` : `div`"
                control-width="auto"
                icon="tabler:player-play"
                :label="t(`admin.storage.assetStreaming`)">
                <template #hint>
                  <div>{{ t(`admin.storage.assetStreamingHint`) }}</div>
                  <div
                    class="text-deep-orange"
                    v-if="!state.target.assetDelivery.isStreamingSupported">
                    {{ t(`admin.storage.assetStreamingNotSupported`) }}
                  </div>
                </template>
                <w-checkbox
                  v-model="state.target.assetDelivery.streaming"
                  :color="
                    state.target.module === `db` || !state.target.assetDelivery.isStreamingSupported
                      ? `grey`
                      : `primary`
                  "
                  :aria-label="t(`admin.storage.assetStreaming`)"
                  :disabled="
                    state.target.module === `db` || !state.target.assetDelivery.isStreamingSupported
                  " />
              </w-settings-row>
              <w-settings-row
                :tag="state.target.assetDelivery.isDirectAccessSupported ? `label` : `div`"
                control-width="auto"
                icon="tabler:external-link"
                :label="t(`admin.storage.assetDirectAccess`)">
                <template #hint>
                  <div>{{ t(`admin.storage.assetDirectAccessHint`) }}</div>
                  <div
                    class="text-deep-orange"
                    v-if="!state.target.assetDelivery.isDirectAccessSupported">
                    {{ t(`admin.storage.assetDirectAccessNotSupported`) }}
                  </div>
                </template>
                <w-checkbox
                  v-model="state.target.assetDelivery.directAccess"
                  :color="!state.target.assetDelivery.isDirectAccessSupported ? `grey` : `primary`"
                  :aria-label="t(`admin.storage.assetDirectAccess`)"
                  :disabled="!state.target.assetDelivery.isDirectAccessSupported" />
              </w-settings-row>
              <w-settings-row
                :tag="state.target.assetDelivery.isReadThroughSupported ? `label` : `div`"
                control-width="auto"
                icon="tabler:cloud-download"
                :label="t(`admin.storage.assetReadThrough`)">
                <template #hint>
                  <div>{{ t(`admin.storage.assetReadThroughHint`) }}</div>
                  <div
                    class="text-deep-orange"
                    v-if="!state.target.assetDelivery.isReadThroughSupported">
                    {{ t(`admin.storage.assetReadThroughNotSupported`) }}
                  </div>
                </template>
                <w-checkbox
                  v-model="state.target.assetDelivery.readThrough"
                  :color="!state.target.assetDelivery.isReadThroughSupported ? `grey` : `primary`"
                  :aria-label="t(`admin.storage.assetReadThrough`)"
                  :disabled="!state.target.assetDelivery.isReadThroughSupported" />
              </w-settings-row>
            </w-settings-card>
            <w-settings-card class="mt-4" :title="t('admin.storage.config')">
              <w-card-section>
                <w-banner
                  class="mt-4"
                  v-if="!state.target.config || Object.keys(state.target.config).length < 1"
                  :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`"
                  >{{ t('admin.storage.noConfigOption') }}</w-banner
                >
              </w-card-section>
              <module-config-form :config="state.target.config" />
            </w-settings-card>
            <!--
              Hidden entirely for a module with nothing to schedule (`sync.schedule === false`, e.g.
              disk/s3/db): a push-only target already syncs on every write via the dispatch hook, so
              there is no mode to pick and no interval to override.
            -->
            <w-settings-card
              class="mt-4"
              v-if="state.target.sync && state.target.sync.schedule !== false"
              :title="t('admin.storage.sync')">
              <template #hint>{{ t('admin.storage.syncDirectionSubtitle') }}</template>
              <!-- A status readout rather than a setting: the row carries no control at all. -->
              <w-settings-row
                control-width="auto"
                icon="tabler:refresh"
                :label="t('admin.storage.status')">
                <template #hint>
                  <div v-if="syncStatus === `outOfDate` && state.syncStatus?.lastSyncedAt">
                    {{
                      t('admin.storage.lastSync', {
                        time: relativeDate(state.syncStatus.lastSyncedAt)
                      })
                    }}
                  </div>
                  <div v-else-if="syncStatus === `error` && state.syncStatus?.lastAttemptAt">
                    {{
                      t('admin.storage.lastSyncAttempt', {
                        time: relativeDate(state.syncStatus.lastAttemptAt)
                      })
                    }}
                  </div>
                </template>
                <div v-if="syncStatus === `error`" class="text-negative">
                  {{ t('admin.storage.errorMsg') }}: {{ state.syncStatus.lastError }}
                </div>
                <div v-else-if="syncStatus === `never`" class="text-grey-7">
                  {{ t('admin.storage.neverSynced') }}
                </div>
                <div v-else-if="syncStatus === `outOfDate`" class="text-deep-orange">
                  {{ t('admin.storage.outOfDate') }}
                </div>
                <div v-else class="text-positive">
                  {{
                    t('admin.storage.lastSync', {
                      time: relativeDate(state.syncStatus?.lastSyncedAt)
                    })
                  }}
                </div>
              </w-settings-row>
              <w-settings-row
                control-width="auto"
                icon="tabler:arrows-exchange"
                :label="t('admin.storage.syncDirection')">
                <template #hint>
                  <span
                    class="text-deep-orange"
                    v-if="state.target.sync.supportedModes.length <= 1">
                    {{ t('admin.storage.syncModeNotSupported') }}
                  </span>
                  <span v-else>{{ syncModeHint }}</span>
                </template>
                <w-btn-toggle
                  v-model="state.target.sync.mode"
                  :options="syncModeOptions"
                  :aria-label="t(`admin.storage.syncDirection`)"
                  :disabled="state.target.sync.supportedModes.length <= 1" />
              </w-settings-row>
              <w-settings-row
                control-width="auto"
                icon="tabler:clock"
                :label="t('admin.storage.syncSchedule')">
                <template #hint>
                  <div>{{ t('admin.storage.syncScheduleHint') }}</div>
                  <div v-if="state.target.sync.scheduleOverride">
                    {{
                      t('admin.storage.syncScheduleCurrent', {
                        schedule: humanizeIsoDuration(state.target.sync.scheduleOverride)
                      })
                    }}
                  </div>
                  <div>
                    {{
                      t('admin.storage.syncScheduleDefault', {
                        schedule: humanizeIsoDuration(state.target.sync.schedule)
                      })
                    }}
                  </div>
                </template>

                <w-input
                  v-model="state.target.sync.scheduleOverride"
                  :placeholder="state.target.sync.schedule || ``"
                  style="min-width: 150px"
                  dense
                  :aria-label="t(`admin.storage.syncSchedule`)" />
              </w-settings-row>
            </w-settings-card>
            <w-settings-card class="mt-4" :title="t('admin.storage.actions')">
              <w-card-section>
                <w-banner
                  class="mt-4"
                  v-if="!state.target.actions || state.target.actions.length < 1"
                  :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`"
                  >{{ t('admin.storage.noActions') }}</w-banner
                >
                <w-banner
                  class="mt-4"
                  v-else-if="!state.target.isEnabled"
                  :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`"
                  >{{ t('admin.storage.actionsInactiveWarn') }}</w-banner
                >
                <!--
                  A module such as disk/sftp declares `push` mode but implements none of the write-path
                  content handlers (see `StorageDefinition.supportsContentSync`) — enabling it does not
                  make it sync on every page/asset change, only the actions below actually write
                  anything. Shown whenever there IS at least one action, so it doesn't pile onto
                  noActions above for a module with neither.
                -->
                <w-banner
                  class="mt-4"
                  v-else-if="!state.target.sync?.supportsContentSync"
                  :class="
                    dark.isActive ? `bg-deep-orange text-white` : `bg-orange-1 text-deep-orange`
                  "
                  >{{ t('admin.storage.noLiveSync') }}</w-banner
                >
              </w-card-section>
              <template v-if="state.target.isEnabled">
                <template v-for="(act, idx) in state.target.actions" :key="act.handler">
                  <w-separator class="my-2" inset v-if="idx > 0" />
                  <w-settings-row control-width="auto" :icon="act.icon" :label="act.label">
                    <template #hint>
                      <div>{{ act.hint }}</div>
                      <div class="text-red" v-if="act.warn">
                        <strong>{{ act.warn }}</strong>
                      </div>
                    </template>

                    <w-btn
                      class="acrylic-btn"
                      flat
                      icon="tabler:circle-arrow-right"
                      color="primary"
                      @click="executeAction(act)"
                      :label="t(`common.actions.proceed`)"
                      :disabled="state.runningAction"
                      :loading="state.runningActionHandler === act.handler" />
                  </w-settings-row>
                </template>
              </template>
            </w-settings-card>
          </div>
          <div class="w-[300px] max-w-full flex-none">
            <w-settings-card class="rounded" :title="state.target.title">
              <w-card-section>
                <img
                  class="w-full object-cover rounded"
                  :src="state.target.banner"
                  :alt="state.target.title" />
                <div class="text-body2 mt-4">{{ state.target.description }}</div>
              </w-card-section>
              <!-- Two facts the module reports, not two settings: neither row takes a control. -->
              <w-settings-row
                control-width="auto"
                icon="tabler:building-store"
                :label="t(`admin.storage.vendor`)">
                <div class="text-caption">{{ state.target.vendor }}</div>
              </w-settings-row>
              <w-settings-row
                control-width="auto"
                icon="tabler:world-www"
                :label="t(`admin.storage.vendorWebsite`)">
                <div class="text-caption">
                  <a :href="state.target.website" target="_blank" rel="noreferrer">{{
                    state.target.website
                  }}</a>
                </div>
              </w-settings-row>
            </w-settings-card>
            <w-settings-card class="rounded mt-4" :title="t('admin.storage.status')">
              <w-settings-row
                v-if="state.target.module !== `db`"
                tag="label"
                control-width="auto"
                icon="tabler:power"
                :label="t(`admin.storage.enabled`)"
                :hint="t(`admin.storage.enabledHint`)">
                <w-toggle
                  v-model="state.target.isEnabled"
                  :aria-label="t(`admin.storage.enabled`)" />
              </w-settings-row>
              <w-settings-row
                control-width="auto"
                icon="tabler:heart"
                :label="t(`admin.storage.currentState`)">
                <div class="text-positive text-caption">{{ t('admin.storage.noIssues') }}</div>
              </w-settings-row>
            </w-settings-card>
            <w-settings-card class="rounded mt-4" :title="t(`admin.storage.versioning`)">
              <template #hint>{{ t(`admin.storage.versioningHint`) }}</template>
              <w-settings-row
                :tag="state.target.versioning.isSupported ? `label` : `div`"
                control-width="auto"
                icon="tabler:history"
                :label="t(`admin.storage.useVersioning`)">
                <template #hint>
                  <div>{{ t(`admin.storage.useVersioningHint`) }}</div>
                  <div class="text-deep-orange" v-if="!state.target.versioning.isSupported">
                    {{ t(`admin.storage.versioningNotSupported`) }}
                  </div>
                  <div class="text-deep-orange" v-if="state.target.versioning.isForceEnabled">
                    {{ t(`admin.storage.versioningForceEnabled`) }}
                  </div>
                </template>
                <w-toggle
                  v-model="state.target.versioning.enabled"
                  :disabled="
                    !state.target.versioning.isSupported || state.target.versioning.isForceEnabled
                  "
                  :aria-label="t(`admin.storage.useVersioning`)" />
              </w-settings-row>
            </w-settings-card>
          </div>
        </div>
      </div>
    </div>
    <div class="flex flex-wrap p-4 gap-4" v-if="state.displayMode === `delivery`">
      <div class="min-w-0 flex-1">
        <w-card class="rounded">
          <w-card-section class="flex items-center">
            <div class="text-caption me-2">{{ t('admin.storage.deliveryPathsLegend') }}</div>
            <w-chip dense color="blue-1" text-color="blue-8">
              <w-avatar icon="tabler:dots" color="blue" text-color="white" />
              <span class="text-caption px-2">{{
                t('admin.storage.deliveryPathsUserRequest')
              }}</span>
            </w-chip>
            <w-chip dense color="teal-1" text-color="teal-8">
              <w-avatar icon="tabler:dots" color="positive" text-color="white" />
              <span class="text-caption px-2">{{
                t('admin.storage.deliveryPathsPushToOrigin')
              }}</span>
            </w-chip>
            <w-chip dense color="red-1" text-color="red-8">
              <w-avatar icon="tabler:minus" color="negative" text-color="white" />
              <span class="text-caption px-2">{{ t('admin.storage.missingOrigin') }}</span>
            </w-chip>
          </w-card-section>
          <w-separator />
          <storage-delivery-graph
            :nodes="state.deliveryNodes"
            :edges="state.deliveryEdges"
            :paths="state.deliveryPaths"
            :layouts="state.deliveryLayouts"
            :dark="dark.isActive"
            :aria-label="t('admin.storage.deliveryPaths')" />
        </w-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onMounted, reactive, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { loading } from '@/composables/loading'
import { confirm } from '@/composables/dialog'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import ModuleConfigForm from '@/components/ModuleConfigForm.vue'
import StorageDeliveryGraph from '@/components/StorageDeliveryGraph.vue'
import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeIsoDuration, relativeDate } from '@/helpers/datetime'
import { buildConfigEditor, buildConfigPayload } from '@/helpers/moduleConfig'
import { generateGraph as buildDeliveryGraph } from '@/helpers/storageDeliveryGraph'
import { isQueuedAction, syncPayloadFor, syncStatusKind } from '@/helpers/storageSync'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const dark = useDark()

const adminStore = useAdminStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const router = useRouter()
const route = useRoute()

/*
  Storage credentials are deliberately not delegable: `api/storage.ts` requires `manage:system`
  alone, never `manage:sites`, so this gate matches it. `userStore.permissions` is loaded by the time
  this mounts, so there is nothing to await.
*/
watch(
  () => route.path,
  () => {
    if (!userStore.can('manage:system')) {
      router.replace('/_error/unauthorized')
    }
  },
  { immediate: true }
)

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.storage.title')
}))

const state = reactive({
  loading: 0,
  displayMode: 'targets',
  runningAction: false,
  runningActionHandler: '',
  selectedTarget: '',
  desiredTarget: '',
  target: null,
  targets: [],
  syncStatus: null,
  deliveryNodes: {},
  deliveryEdges: {},
  deliveryLayouts: {
    nodes: {}
  },
  deliveryPaths: []
})

// -> Mirrors the sync modes `backend/models/storage.ts` knows about; there is no shared source to
//    import them from.
const SYNC_MODE_LABEL_KEYS = {
  sync: 'admin.storage.syncDirBi',
  push: 'admin.storage.syncDirPush',
  pull: 'admin.storage.syncDirPull'
}
const SYNC_MODE_HINT_KEYS = {
  sync: 'admin.storage.syncDirBiHint',
  push: 'admin.storage.syncDirPushHint',
  pull: 'admin.storage.syncDirPullHint'
}

const syncModeOptions = computed(() =>
  (state.target?.sync?.supportedModes ?? []).map((mode) => ({
    label: t(SYNC_MODE_LABEL_KEYS[mode] ?? mode),
    value: mode
  }))
)

const syncModeHint = computed(() => {
  const mode = state.target?.sync?.mode
  return SYNC_MODE_HINT_KEYS[mode] ? t(SYNC_MODE_HINT_KEYS[mode]) : ''
})

const syncStatus = computed(() => syncStatusKind(state.syncStatus))

watch(
  () => adminStore.currentSiteId,
  async (newValue) => {
    await load()
    nextTick(() => {
      router.replace(`/_admin/${newValue}/storage/${state.selectedTarget}`)
    })
  }
)
watch(
  () => state.displayMode,
  (newValue) => {
    if (newValue === 'delivery') {
      generateGraph()
    }
  }
)
watch(
  () => state.selectedTarget,
  (newValue) => {
    state.target = state.targets.find((tgt) => tgt.id === newValue) || null
    loadSyncStatus()
  }
)
watch(
  () => state.targets,
  (newValue) => {
    if (newValue && newValue.length > 0) {
      if (state.desiredTarget) {
        state.selectedTarget = state.desiredTarget
        state.desiredTarget = ''
      } else if (newValue.some((tgt) => tgt.id === state.selectedTarget)) {
        // -> Keep the current selection across a reload, since saving reloads the targets
        state.target = newValue.find((tgt) => tgt.id === state.selectedTarget)
      } else {
        state.selectedTarget = newValue.find((tgt) => tgt.module === 'db')?.id || null
        if (!route.params.id) {
          router.replace(`/_admin/${adminStore.currentSiteId}/storage/${state.selectedTarget}`)
        }
      }
    }
  }
)
watch(
  () => route.params.id,
  (to, from) => {
    if (!to) {
      return
    }
    if (state.targets.length < 1) {
      state.desiredTarget = to
    } else {
      state.selectedTarget = to
    }
  }
)

async function load() {
  state.loading++
  loading.show()
  try {
    const targets = await API_CLIENT.get(`sites/${adminStore.currentSiteId}/storage/targets`).json()
    state.targets = (targets ?? []).map((tgt) => ({
      ...tgt,
      config: buildConfigEditor(tgt.props, tgt.config)
    }))
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.storage.loadFailed'),
      caption: apiErrorMessage(err),
      timeout: 20000
    })
  }
  loading.hide()
  state.loading--
}

/**
 * Skipped for a module with nothing to schedule (`sync.schedule === false`): the Synchronization
 * section that would show it is hidden then. A failure leaves the status card empty rather than
 * blocking the rest of the page.
 */
async function loadSyncStatus() {
  state.syncStatus = null
  if (!state.target || state.target.sync?.schedule === false) {
    return
  }
  try {
    state.syncStatus = await API_CLIENT.get(
      `sites/${adminStore.currentSiteId}/storage/targets/${state.target.id}/sync-status`
    ).json()
  } catch {
    state.syncStatus = null
  }
}

/**
 * Read-only props are deliberately left out: the server keeps whatever is stored for them, so
 * sending them back would pretend they can be set.
 */
function payloadFor(tgt) {
  const sync = syncPayloadFor(tgt)
  return {
    id: tgt.id,
    isEnabled: tgt.isEnabled,
    contentTypes: {
      activeTypes: tgt.contentTypes.activeTypes,
      largeThreshold: tgt.contentTypes.largeThreshold
    },
    assetDelivery: {
      streaming: tgt.assetDelivery.streaming,
      directAccess: tgt.assetDelivery.directAccess,
      readThrough: tgt.assetDelivery.readThrough
    },
    versioning: {
      enabled: tgt.versioning.enabled
    },
    ...(sync && { sync }),
    config: buildConfigPayload(tgt.config)
  }
}

/**
 * Every target is sent at once, the way the API takes them: which of them holds a given content type
 * is only meaningful across the whole set.
 */
async function save({ silent = false } = {}) {
  let saveSuccess = false
  state.loading++
  if (!silent) {
    loading.show()
  }
  try {
    await API_CLIENT.put(`sites/${adminStore.currentSiteId}/storage/targets`, {
      json: { targets: state.targets.map(payloadFor) }
    }).json()
    saveSuccess = true
    if (!silent) {
      notify({
        type: 'positive',
        message: t('admin.storage.saveSuccess')
      })
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.storage.saveFailed'),
      caption: apiErrorMessage(err)
    })
  }
  if (!silent) {
    loading.hide()
  }
  state.loading--
  return saveSuccess
}

function supportsContentType(type) {
  return state.target?.contentTypes?.supportedTypes?.includes(type) ?? true
}

function getTargetSubtitle(target) {
  if (!target.isEnabled) {
    return t('admin.storage.inactiveTarget')
  }
  const hasPages = target.contentTypes?.activeTypes?.includes('pages')
  const hasAssets = target.contentTypes?.activeTypes?.filter((c) => c !== 'pages')?.length > 0
  if (hasPages && hasAssets) {
    return t('admin.storage.pagesAndAssets')
  } else if (hasPages) {
    return t('admin.storage.pagesOnly')
  } else if (hasAssets) {
    return t('admin.storage.assetsOnly')
  } else {
    return t('admin.storage.notConfigured')
  }
}

function getTargetSubtitleColor(target) {
  if (state.selectedTarget === target.id) {
    return 'text-blue-2'
  } else if (target.isEnabled) {
    return 'text-positive'
  } else {
    return 'text-grey-7'
  }
}

async function executeAction(act) {
  const run = async () => {
    state.runningAction = true
    state.runningActionHandler = act.handler
    try {
      const res = await API_CLIENT.post(
        `sites/${adminStore.currentSiteId}/storage/targets/${state.selectedTarget}/actions/${act.handler}`
      ).json()
      // -> A sync-shaped action is queued on the scheduler rather than run inline, so this response
      //    confirms only that it was queued, never that it finished. A synchronous one's `message`
      //    reports what it did, which is why it becomes the caption.
      notify({
        type: 'positive',
        message: isQueuedAction(act.handler)
          ? t('admin.storage.actionQueued', { action: act.label })
          : t('admin.storage.actionSuccess', { action: act.label }),
        caption: isQueuedAction(act.handler) ? undefined : res?.message
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.storage.actionFailed', { action: act.label }),
        caption: apiErrorMessage(err)
      })
    }
    state.runningAction = false
    state.runningActionHandler = ''
  }

  // -> An action that declares a warning destroys something, so it is never run on a single click
  if (act.warn) {
    confirm({
      title: act.label,
      message: act.warn,
      persistent: true,
      cancel: true,
      color: 'negative',
      okLabel: t('common.actions.proceed')
    }).onOk(run)
  } else {
    await run()
  }
}

function generateGraph() {
  const graph = buildDeliveryGraph(state.targets, t)
  state.deliveryNodes = graph.nodes
  state.deliveryEdges = graph.edges
  state.deliveryLayouts.nodes = graph.layouts.nodes
  state.deliveryPaths = graph.paths
}

onMounted(() => {
  if (!state.selectedTarget && route.params.id) {
    if (state.targets.length < 1) {
      state.desiredTarget = route.params.id
    } else {
      state.selectedTarget = route.params.id
    }
  }
  if (adminStore.currentSiteId) {
    load()
  }
})
</script>

<style scoped>
.admin-storage-logo {
}
</style>
