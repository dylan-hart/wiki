<template>
  <w-page class="admin-storage">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-ssd-animated.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
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
          icon="la:question-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/storage`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          icon="mdi:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save()"
          :loading="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <!-- ========================================== -->
    <!-- TARGETS -->
    <!-- ========================================== -->
    <div class="flex flex-wrap p-4 gap-4" v-if="state.displayMode === `targets`">
      <div class="flex-none">
        <w-card class="rounded bg-dark">
          <w-list style="min-width: 300px" padding dark>
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
      <div class="min-w-0 flex-1" v-if="state.target">
        <!--
          The settings and the infobox beside them, the same shape as the list and this panel above:
          the infobox is 300px wide and the settings take what is left, both dropping onto their own
          row when there is no room. A 12-column grid could not say that -- `col-span-12` on the
          settings took a whole row of it, which is what put the infobox underneath.
        -->
        <div class="flex flex-wrap gap-4">
          <div class="min-w-0 flex-1">
            <!-- ----------------------- -->
            <!-- Content Types -->
            <!-- ----------------------- -->
            <w-card class="pb-2">
              <w-card-header>
                {{ t('admin.storage.contentTypes') }}
                <template #hint>{{ t('admin.storage.contentTypesHint') }}</template>
              </w-card-header>
              <w-item tag="label">
                <w-item-section avatar>
                  <w-checkbox
                    v-model="state.target.contentTypes.activeTypes"
                    :color="state.target.module === `db` ? `grey` : `primary`"
                    val="pages"
                    :aria-label="t(`admin.storage.contentTypePages`)"
                    :disabled="state.target.module === `db`" />
                </w-item-section>
                <w-item-section>
                  <w-item-label>{{ t(`admin.storage.contentTypePages`) }}</w-item-label>
                  <w-item-label caption>{{ t(`admin.storage.contentTypePagesHint`) }}</w-item-label>
                </w-item-section>
              </w-item>
              <w-item tag="label">
                <w-item-section avatar>
                  <w-checkbox
                    v-model="state.target.contentTypes.activeTypes"
                    color="primary"
                    val="images"
                    :aria-label="t(`admin.storage.contentTypeImages`)" />
                </w-item-section>
                <w-item-section>
                  <w-item-label>{{ t(`admin.storage.contentTypeImages`) }}</w-item-label>
                  <w-item-label caption>{{
                    t(`admin.storage.contentTypeImagesHint`)
                  }}</w-item-label>
                </w-item-section>
              </w-item>
              <w-item tag="label">
                <w-item-section avatar>
                  <w-checkbox
                    v-model="state.target.contentTypes.activeTypes"
                    color="primary"
                    val="documents"
                    :aria-label="t(`admin.storage.contentTypeDocuments`)" />
                </w-item-section>
                <w-item-section>
                  <w-item-label>{{ t(`admin.storage.contentTypeDocuments`) }}</w-item-label>
                  <w-item-label caption>{{
                    t(`admin.storage.contentTypeDocumentsHint`)
                  }}</w-item-label>
                </w-item-section>
              </w-item>
              <w-item tag="label">
                <w-item-section avatar>
                  <w-checkbox
                    v-model="state.target.contentTypes.activeTypes"
                    color="primary"
                    val="others"
                    :aria-label="t(`admin.storage.contentTypeOthers`)" />
                </w-item-section>
                <w-item-section>
                  <w-item-label>{{ t(`admin.storage.contentTypeOthers`) }}</w-item-label>
                  <w-item-label caption>{{
                    t(`admin.storage.contentTypeOthersHint`)
                  }}</w-item-label>
                </w-item-section>
              </w-item>
              <w-item tag="label">
                <w-item-section avatar>
                  <w-checkbox
                    v-model="state.target.contentTypes.activeTypes"
                    color="primary"
                    val="large"
                    :aria-label="t(`admin.storage.contentTypeLargeFiles`)" />
                </w-item-section>
                <w-item-section>
                  <w-item-label>{{ t(`admin.storage.contentTypeLargeFiles`) }}</w-item-label>
                  <w-item-label caption>{{
                    t(`admin.storage.contentTypeLargeFilesHint`)
                  }}</w-item-label>
                  <w-item-label
                    class="text-deep-orange"
                    v-if="state.target.module === `db`"
                    caption
                    >{{ t(`admin.storage.contentTypeLargeFilesDBWarn`) }}</w-item-label
                  >
                </w-item-section>
                <w-item-section side>
                  <w-input
                    :label="t(`admin.storage.contentTypeLargeFilesThreshold`)"
                    v-model="state.target.contentTypes.largeThreshold"
                    style="min-width: 150px"
                    dense />
                </w-item-section>
              </w-item>
            </w-card>
            <!-- ----------------------- -->
            <!-- Content Delivery -->
            <!-- ----------------------- -->
            <w-card class="pb-2 mt-4">
              <w-card-header>
                {{ t('admin.storage.assetDelivery') }}
                <template #hint>{{ t('admin.storage.assetDeliveryHint') }}</template>
              </w-card-header>
              <w-item :tag="state.target.assetDelivery.isStreamingSupported ? `label` : null">
                <w-item-section avatar>
                  <w-checkbox
                    v-model="state.target.assetDelivery.streaming"
                    :color="
                      state.target.module === `db` ||
                      !state.target.assetDelivery.isStreamingSupported
                        ? `grey`
                        : `primary`
                    "
                    :aria-label="t(`admin.storage.contentTypePages`)"
                    :disabled="
                      state.target.module === `db` ||
                      !state.target.assetDelivery.isStreamingSupported
                    " />
                </w-item-section>
                <w-item-section>
                  <w-item-label>{{ t(`admin.storage.assetStreaming`) }}</w-item-label>
                  <w-item-label caption>{{ t(`admin.storage.assetStreamingHint`) }}</w-item-label>
                  <w-item-label
                    class="text-deep-orange"
                    v-if="!state.target.assetDelivery.isStreamingSupported"
                    caption
                    >{{ t(`admin.storage.assetStreamingNotSupported`) }}</w-item-label
                  >
                </w-item-section>
              </w-item>
              <w-item :tag="state.target.assetDelivery.isDirectAccessSupported ? `label` : null">
                <w-item-section avatar>
                  <w-checkbox
                    v-model="state.target.assetDelivery.directAccess"
                    :color="
                      !state.target.assetDelivery.isDirectAccessSupported ? `grey` : `primary`
                    "
                    :aria-label="t(`admin.storage.contentTypePages`)"
                    :disabled="!state.target.assetDelivery.isDirectAccessSupported" />
                </w-item-section>
                <w-item-section>
                  <w-item-label>{{ t(`admin.storage.assetDirectAccess`) }}</w-item-label>
                  <w-item-label caption>{{
                    t(`admin.storage.assetDirectAccessHint`)
                  }}</w-item-label>
                  <w-item-label
                    class="text-deep-orange"
                    v-if="!state.target.assetDelivery.isDirectAccessSupported"
                    caption
                    >{{ t(`admin.storage.assetDirectAccessNotSupported`) }}</w-item-label
                  >
                </w-item-section>
              </w-item>
            </w-card>
            <!-- ----------------------- -->
            <!-- Configuration -->
            <!-- ----------------------- -->
            <w-card class="pb-2 mt-4">
              <w-card-header>{{ t('admin.storage.config') }}</w-card-header>
              <w-card-section>
                <w-banner
                  class="mt-4"
                  v-if="!state.target.config || Object.keys(state.target.config).length < 1"
                  :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`"
                  >{{ t('admin.storage.noConfigOption') }}</w-banner
                >
              </w-card-section>
              <!--
                Generic per-prop config form, shared with `AdminSearch.vue`'s engine config editor
                (task #556) -- see `ModuleConfigForm.vue`. `state.target.config` is the
                `buildConfigEditor()`-built editable structure `load()` below produces, not the raw
                stored values -- mutating a field's `.value` there, which this component does in
                place, is what `buildConfigPayload()` in `payloadFor()` below reads back.
              -->
              <module-config-form :config="state.target.config" />
            </w-card>
            <!-- ----------------------- -->
            <!-- Sync -->
            <!-- ----------------------- -->
            <!--
              Hidden entirely for a module with nothing to schedule (`sync.schedule === false`, e.g.
              disk/s3/db): a push-only target already syncs on every write via the dispatch hook, so
              there is no mode to pick and no interval to override.
            -->
            <w-card
              class="pb-2 mt-4"
              v-if="state.target.sync && state.target.sync.schedule !== false">
              <w-card-header>
                {{ t('admin.storage.sync') }}
                <template #hint>{{ t('admin.storage.syncDirectionSubtitle') }}</template>
              </w-card-header>
              <w-item>
                <w-item-section>
                  <w-item-label class="text-grey">{{ t('admin.storage.status') }}</w-item-label>
                  <w-item-label v-if="syncStatus === `error`" class="text-negative">
                    {{ t('admin.storage.errorMsg') }}: {{ state.syncStatus.lastError }}
                  </w-item-label>
                  <w-item-label v-else-if="syncStatus === `never`" class="text-grey-7">
                    {{ t('admin.storage.neverSynced') }}
                  </w-item-label>
                  <w-item-label v-else-if="syncStatus === `outOfDate`" class="text-deep-orange">
                    {{ t('admin.storage.outOfDate') }}
                  </w-item-label>
                  <w-item-label v-else class="text-positive">
                    {{
                      t('admin.storage.lastSync', {
                        time: relativeDate(state.syncStatus?.lastSyncedAt)
                      })
                    }}
                  </w-item-label>
                  <w-item-label
                    caption
                    v-if="syncStatus === `outOfDate` && state.syncStatus?.lastSyncedAt">
                    {{
                      t('admin.storage.lastSync', {
                        time: relativeDate(state.syncStatus.lastSyncedAt)
                      })
                    }}
                  </w-item-label>
                  <w-item-label
                    caption
                    v-else-if="syncStatus === `error` && state.syncStatus?.lastAttemptAt">
                    {{
                      t('admin.storage.lastSyncAttempt', {
                        time: relativeDate(state.syncStatus.lastAttemptAt)
                      })
                    }}
                  </w-item-label>
                </w-item-section>
              </w-item>
              <w-separator class="my-2" inset />
              <w-item>
                <w-item-section>
                  <w-item-label>{{ t('admin.storage.syncDirection') }}</w-item-label>
                  <w-item-label
                    class="text-deep-orange"
                    v-if="state.target.sync.supportedModes.length <= 1"
                    caption
                    >{{ t('admin.storage.syncModeNotSupported') }}</w-item-label
                  >
                  <w-item-label v-else caption>{{ syncModeHint }}</w-item-label>
                </w-item-section>
                <w-item-section side>
                  <w-btn-toggle
                    v-model="state.target.sync.mode"
                    toggle-color="primary"
                    :options="syncModeOptions"
                    :aria-label="t(`admin.storage.syncDirection`)"
                    :disabled="state.target.sync.supportedModes.length <= 1" />
                </w-item-section>
              </w-item>
              <w-separator class="my-2" inset />
              <w-item>
                <w-item-section>
                  <w-item-label>{{ t('admin.storage.syncSchedule') }}</w-item-label>
                  <w-item-label caption>{{ t('admin.storage.syncScheduleHint') }}</w-item-label>
                  <w-item-label caption v-if="state.target.sync.scheduleOverride">{{
                    t('admin.storage.syncScheduleCurrent', {
                      schedule: humanizeIsoDuration(state.target.sync.scheduleOverride)
                    })
                  }}</w-item-label>
                  <w-item-label caption>{{
                    t('admin.storage.syncScheduleDefault', {
                      schedule: humanizeIsoDuration(state.target.sync.schedule)
                    })
                  }}</w-item-label>
                </w-item-section>
                <w-item-section side>
                  <w-input
                    v-model="state.target.sync.scheduleOverride"
                    :placeholder="state.target.sync.schedule || ``"
                    style="min-width: 150px"
                    dense
                    :aria-label="t(`admin.storage.syncSchedule`)" />
                </w-item-section>
              </w-item>
            </w-card>
            <!-- ----------------------- -->
            <!-- Actions -->
            <!-- ----------------------- -->
            <w-card class="pb-2 mt-4">
              <w-card-header>{{ t('admin.storage.actions') }}</w-card-header>
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
                  <w-item>
                    <blueprint-icon class="self-start" :icon="act.icon" :hue-rotate="45" />
                    <w-item-section>
                      <w-item-label>{{ act.label }}</w-item-label>
                      <w-item-label caption>{{ act.hint }}</w-item-label>
                      <w-item-label class="text-red" v-if="act.warn" caption>
                        <strong>{{ act.warn }}</strong>
                      </w-item-label>
                    </w-item-section>
                    <w-item-section side>
                      <w-btn
                        class="acrylic-btn"
                        flat
                        icon="la:arrow-circle-right"
                        color="primary"
                        @click="executeAction(act)"
                        :label="t(`common.actions.proceed`)"
                        :disabled="state.runningAction"
                        :loading="state.runningActionHandler === act.handler" />
                    </w-item-section>
                  </w-item>
                </template>
              </template>
            </w-card>
          </div>
          <div class="flex-none">
            <!-- ----------------------- -->
            <!-- Infobox -->
            <!-- ----------------------- -->
            <w-card class="rounded pb-4" style="width: 300px">
              <w-card-header>{{ state.target.title }}</w-card-header>
              <w-card-section>
                <img
                  class="w-full object-cover rounded"
                  :src="state.target.banner"
                  :alt="state.target.title" />
                <div class="text-body2 mt-4">{{ state.target.description }}</div>
              </w-card-section>
              <w-separator class="mb-2" inset />
              <w-item>
                <w-item-section>
                  <w-item-label class="text-grey">{{ t(`admin.storage.vendor`) }}</w-item-label>
                  <w-item-label>{{ state.target.vendor }}</w-item-label>
                </w-item-section>
              </w-item>
              <w-separator class="my-2" inset />
              <w-item>
                <w-item-section>
                  <w-item-label class="text-grey">{{
                    t(`admin.storage.vendorWebsite`)
                  }}</w-item-label>
                  <w-item-label>
                    <a :href="state.target.website" target="_blank" rel="noreferrer">{{
                      state.target.website
                    }}</a>
                  </w-item-label>
                </w-item-section>
              </w-item>
            </w-card>
            <!-- ----------------------- -->
            <!-- Status -->
            <!-- ----------------------- -->
            <w-card class="rounded pb-4 mt-4" style="width: 300px">
              <w-card-header>{{ t('admin.storage.status') }}</w-card-header>
              <template v-if="state.target.module !== `db`">
                <w-item tag="label">
                  <w-item-section>
                    <w-item-label>{{ t(`admin.storage.enabled`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.storage.enabledHint`) }}</w-item-label>
                    <w-item-label
                      class="text-deep-orange"
                      v-if="state.target.module === `db`"
                      caption
                      >{{ t(`admin.storage.enabledForced`) }}</w-item-label
                    >
                  </w-item-section>
                  <w-item-section avatar>
                    <w-toggle
                      v-model="state.target.isEnabled"
                      :disabled="state.target.module === `db`"
                      :aria-label="t(`admin.storage.enabled`)" />
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
              </template>
              <w-item>
                <w-item-section>
                  <w-item-label class="text-grey">{{
                    t(`admin.storage.currentState`)
                  }}</w-item-label>
                  <w-item-label class="text-positive">{{
                    t('admin.storage.noIssues')
                  }}</w-item-label>
                </w-item-section>
              </w-item>
            </w-card>
            <!-- ----------------------- -->
            <!-- Versioning -->
            <!-- ----------------------- -->
            <w-card class="rounded pb-4 mt-4" style="width: 300px">
              <w-card-header>
                {{ t(`admin.storage.versioning`) }}
                <template #hint>{{ t(`admin.storage.versioningHint`) }}</template>
              </w-card-header>
              <w-item :tag="state.target.versioning.isSupported ? `label` : null">
                <w-item-section>
                  <w-item-label>{{ t(`admin.storage.useVersioning`) }}</w-item-label>
                  <w-item-label caption>{{ t(`admin.storage.useVersioningHint`) }}</w-item-label>
                  <w-item-label
                    class="text-deep-orange"
                    v-if="!state.target.versioning.isSupported"
                    caption
                    >{{ t(`admin.storage.versioningNotSupported`) }}</w-item-label
                  >
                  <w-item-label
                    class="text-deep-orange"
                    v-if="state.target.versioning.isForceEnabled"
                    caption
                    >{{ t(`admin.storage.versioningForceEnabled`) }}</w-item-label
                  >
                </w-item-section>
                <w-item-section avatar>
                  <w-toggle
                    v-model="state.target.versioning.enabled"
                    :disabled="
                      !state.target.versioning.isSupported || state.target.versioning.isForceEnabled
                    "
                    :aria-label="t(`admin.storage.useVersioning`)" />
                </w-item-section>
              </w-item>
            </w-card>
          </div>
        </div>
      </div>
    </div>
    <!-- ========================================== -->
    <!-- DELIVERY PATHS -->
    <!-- ========================================== -->
    <div class="flex flex-wrap p-4 gap-4" v-if="state.displayMode === `delivery`">
      <div class="min-w-0 flex-1">
        <w-card class="rounded">
          <w-card-section class="flex items-center">
            <div class="text-caption me-2">{{ t('admin.storage.deliveryPathsLegend') }}</div>
            <w-chip dense color="blue-1" text-color="blue-8">
              <w-avatar icon="la:ellipsis-h" color="blue" text-color="white" />
              <span class="text-caption px-2">{{
                t('admin.storage.deliveryPathsUserRequest')
              }}</span>
            </w-chip>
            <w-chip dense color="teal-1" text-color="teal-8">
              <w-avatar icon="la:ellipsis-h" color="positive" text-color="white" />
              <span class="text-caption px-2">{{
                t('admin.storage.deliveryPathsPushToOrigin')
              }}</span>
            </w-chip>
            <w-chip dense color="red-1" text-color="red-8">
              <w-avatar icon="la:minus" color="negative" text-color="white" />
              <span class="text-caption px-2">{{ t('admin.storage.missingOrigin') }}</span>
            </w-chip>
          </w-card-section>
          <w-separator />
          <v-network-graph
            :zoom-level="2"
            :configs="state.deliveryConfig"
            :nodes="state.deliveryNodes"
            :edges="state.deliveryEdges"
            :paths="state.deliveryPaths"
            :layouts="state.deliveryLayouts"
            :style="deliveryGraphStyle">
            <template #override-node="{ nodeId, scale, config, ...slotProps }">
              <rect
                :rx="config.borderRadius * scale"
                :x="-config.radius * scale"
                :y="-config.radius * scale"
                :width="config.radius * scale * 2"
                :height="config.radius * scale * 2"
                :fill="config.color"
                v-bind="slotProps" />
              <image
                v-if="
                  state.deliveryNodes[nodeId].icon &&
                  state.deliveryNodes[nodeId].icon.endsWith(`.svg`)
                "
                :x="(-config.radius + 5) * scale"
                :y="(-config.radius + 5) * scale"
                :width="(config.radius - 5) * scale * 2"
                :height="(config.radius - 5) * scale * 2"
                :xlink:href="state.deliveryNodes[nodeId].icon" />
            </template>
          </v-network-graph>
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

import * as VNG from 'v-network-graph'
import ModuleConfigForm from '@/components/ModuleConfigForm.vue'
import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeIsoDuration, relativeDate } from '@/helpers/datetime'
import { buildConfigEditor, buildConfigPayload } from '@/helpers/moduleConfig'
import { generateGraph as buildDeliveryGraph } from '@/helpers/storageDeliveryGraph'
import { isQueuedAction, syncPayloadFor, syncStatusKind } from '@/helpers/storageSync'

// COMPOSABLES

const dark = useDark()

// COMPONENTS
//
// Task #1888: this is the sole consumer of v-network-graph, so it's registered locally off the
// namespace import above rather than globally in boot/components.js. `<script setup>` auto-exposes
// this top-level binding to the template, resolving the `<v-network-graph>` tag -- a property access
// on `VNG` directly in the template would not resolve the same way.
const VNetworkGraph = VNG.VNetworkGraph

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()
const route = useRoute()

// ACCESS

/*
  Task #684: storage credentials are deliberately NOT delegable (see
  `docs/decisions/delegated-per-site-administration.md` §4) -- `api/storage.ts` has always required
  `manage:system` alone, not `manage:sites`, so this matches the backend exactly rather than the
  looser `manage:sites` the sidebar link used to gate on. `userStore.permissions` is already loaded
  by the time this mounts (same reasoning as `AdminLayout.vue`'s own `access:admin` watcher), so
  there is no fetch to await here.
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

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.storage.title')
}))

// DATA

const state = reactive({
  loading: 0,
  displayMode: 'targets',
  runningAction: false,
  runningActionHandler: '',
  selectedTarget: '',
  desiredTarget: '',
  target: null,
  targets: [],
  // -> Per-target, refetched on selection change -- see `loadSyncStatus()`. Null while loading or for
  //    a target whose module has nothing to schedule (the Synchronization section is hidden then).
  syncStatus: null,
  deliveryNodes: {},
  deliveryEdges: {},
  deliveryLayouts: {
    nodes: {}
  },
  deliveryPaths: [],
  deliveryConfig: VNG.defineConfigs({
    view: {
      layoutHandler: new VNG.GridLayout({ grid: 15 }),
      fit: true,
      mouseWheelZoomEnabled: false,
      grid: {
        visible: true,
        interval: 2.5,
        thickIncrements: 0
      }
    },
    node: {
      draggable: false,
      selectable: true,
      normal: {
        type: 'rect',
        color: (node) => node.color || '#1976D2',
        borderRadius: (node) => node.borderRadius || 5
      },
      label: {
        margin: 8,
        // OpenProject #2500: the library's own default label color is a literal `#000000`, which
        // is only readable against the hardcoded white background `deliveryGraphStyle` above used
        // to draw. Read reactively (v-network-graph calls this per node, so `dark.isActive` is
        // tracked as a normal Vue dependency the same way `node.normal.color` already is above) so
        // a dark-mode toggle repaints existing labels instead of freezing them at whichever mode
        // was active when the graph first mounted.
        color: () => (dark.isActive ? '#e8eaed' : '#000000')
      }
    },
    edge: {
      normal: {
        width: 3,
        dasharray: (edge) => (edge.animate === false ? 20 : 3),
        animate: (edge) => !(edge.animate === false),
        animationSpeed: (edge) => edge.animationSpeed || 50,
        color: (edge) => edge.color || '#1976D2'
      },
      type: 'straight',
      gap: 7,
      margin: 4,
      marker: {
        source: {
          type: 'none'
        },
        target: {
          type: 'none'
        }
      }
    },
    path: {
      visible: true,
      end: 'edgeOfNode',
      margin: 4,
      path: {
        width: 7,
        color: (p) => p.color,
        linecap: 'square'
      }
    }
  })
})

// COMPUTED

// -> Same duplication note as `SYNC_SHAPED_ACTIONS` in helpers/storageSync.js: mirrors the three sync
//    modes `backend/models/storage.ts` knows about, with no shared source to import them from.
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

/** Toggle options restricted to what this target's module actually supports. */
const syncModeOptions = computed(() =>
  (state.target?.sync?.supportedModes ?? []).map((mode) => ({
    label: t(SYNC_MODE_LABEL_KEYS[mode] ?? mode),
    value: mode
  }))
)

/** What the currently selected mode does, shown as the picker's caption. */
const syncModeHint = computed(() => {
  const mode = state.target?.sync?.mode
  return SYNC_MODE_HINT_KEYS[mode] ? t(SYNC_MODE_HINT_KEYS[mode]) : ''
})

/** 'error' | 'never' | 'outOfDate' | 'synced' -- see `syncStatusKind` for the priority order. */
const syncStatus = computed(() => syncStatusKind(state.syncStatus))

/** OpenProject #2500: `<v-network-graph>` draws a transparent SVG, so the delivery-paths panel
 *  needs an explicit background of its own -- this used to be a hardcoded `#fff`, a stark white box
 *  inside an otherwise dark-themed admin page. Bound to `dark.isActive` the same way OpenProject
 *  #2412 rebound the knowledge graph canvas's own hardcoded colors. The dark value is `.w-card`'s
 *  own dark surface (`--color-dark-3` in `css/tailwind.css`) rather than a second hardcoded hex, so
 *  the graph blends into the card it sits inside instead of reading as a mismatched panel of its
 *  own. */
const deliveryGraphStyle = computed(() => ({
  height: '600px',
  backgroundColor: dark.isActive ? 'var(--color-dark-3)' : '#fff'
}))

// WATCHERS

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

// METHODS

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
 * Sync status for the currently selected target -- skipped for a module with nothing to schedule
 * (`sync.schedule === false`), since the Synchronization section that would show it is hidden then.
 * Non-fatal on failure: the status card just stays empty rather than blocking the rest of the page.
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
 * A target as the API expects it. Read-only props are left out: the server keeps whatever is stored
 * for them, so sending them back would be pretending they can be set. The `config` reduction itself
 * is the shared `buildConfigPayload()` (`@/helpers/moduleConfig.js`) -- everything around it here is
 * target-only, which is why the shared helper stops at the plain config object.
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
      directAccess: tgt.assetDelivery.directAccess
    },
    versioning: {
      enabled: tgt.versioning.enabled
    },
    ...(sync && { sync }),
    config: buildConfigPayload(tgt.config)
  }
}

/**
 * Save every target at once, the way the API takes them — a target is only meaningful next to the
 * others, e.g. which of them holds a given content type.
 *
 * @param silent Skip the loading overlay and the success notification, for a save made on the way to
 *   something else, such as the GitHub setup flow.
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
      await API_CLIENT.post(
        `sites/${adminStore.currentSiteId}/storage/targets/${state.selectedTarget}/actions/${act.handler}`
      ).json()
      // -> A sync-shaped action (sync / syncUntracked / importAll) is queued on the scheduler by
      //    `api/storage.ts` rather than run inline -- this response confirms it was queued, not that
      //    it finished, so the notification says so rather than claiming completion.
      notify({
        type: 'positive',
        message: isQueuedAction(act.handler)
          ? t('admin.storage.actionQueued', { action: act.label })
          : t('admin.storage.actionSuccess', { action: act.label })
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

/**
 * Rebuild the Delivery Paths diagram from the current targets. The graph itself is built by
 * `helpers/storageDeliveryGraph.js`, which is a pure function of them; this only hands the result to
 * the four props `v-network-graph` reads.
 */
function generateGraph() {
  const graph = buildDeliveryGraph(state.targets, t)
  state.deliveryNodes = graph.nodes
  state.deliveryEdges = graph.edges
  state.deliveryLayouts.nodes = graph.layouts.nodes
  state.deliveryPaths = graph.paths
}

// MOUNTED

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

<style lang="scss" scoped>
.admin-storage-logo {
  border-radius: 5px;
}
</style>

<style>
/*
  Task #1888: kept in its own unscoped block, not folded into the `scoped` block above -- Vue's
  scoped-CSS rewriting only reaches this component's own template output and each child component's
  root element, not the deeply-nested `.v-ng-*` elements v-network-graph renders inside its own
  render tree. A scoped `@import` here would compile to attribute selectors those elements never
  carry, silently breaking the diagram's styling.
*/
@import 'v-network-graph/lib/style.css';
</style>
