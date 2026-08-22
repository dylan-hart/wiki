<template>
  <w-page class="admin-storage">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <img class="admin-icon animated fadeInLeft" src="/_assets/icons/fluent-ssd-animated.svg" />
      </div>
      <div class="min-w-0 flex-1 pl-4">
        <div class="text-h5 text-primary animated fadeInLeft">{{ t('admin.storage.title') }}</div>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.storage.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <w-spinner class="mr-4" v-show="state.loading > 0" color="accent" size="sm" />
        <w-btn-toggle
          class="mr-4"
          v-model="state.displayMode"
          push
          no-caps
          :toggle-color="dark.isActive ? `white` : `black`"
          :toggle-text-color="dark.isActive ? `black` : `white`"
          :text-color="dark.isActive ? `white` : `black`"
          :color="dark.isActive ? `dark-1` : `white`"
          :options="[
            { label: t('admin.storage.targets'), value: 'targets' },
            { label: t('admin.storage.deliveryPaths'), value: 'delivery' }
          ]" />
        <w-separator class="mr-4" vertical />
        <w-btn
          class="mr-2 acrylic-btn"
          icon="la:question-circle"
          flat
          color="grey"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/storage`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          unelevated
          icon="mdi:check"
          :label="t(`common.actions.apply`)"
          color="secondary"
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
            <!-- Setup -->
            <!-- ----------------------- -->
            <w-card
              class="pb-2 mb-4"
              v-if="
                state.target.setup &&
                state.target.setup.handler &&
                state.target.setup.state === `configured`
              ">
              <w-card-header>
                {{ t('admin.storage.setup') }}
                <template #hint>{{ t('admin.storage.setupConfiguredHint') }}</template>
              </w-card-header>
              <w-item>
                <blueprint-icon class="self-start" icon="matches" :hue-rotate="140" />
                <w-item-section>
                  <w-item-label>Uninstall</w-item-label>
                  <w-item-label caption
                    >Delete the active configuration and start over the setup process.</w-item-label
                  >
                  <w-item-label class="text-red" caption>
                    <strong>This action cannot be undone!</strong>
                  </w-item-label>
                </w-item-section>
                <w-item-section side>
                  <w-btn
                    class="acrylic-btn"
                    flat
                    icon="la:arrow-circle-right"
                    color="negative"
                    @click="setupDestroy"
                    :label="t(`admin.storage.uninstall`)" />
                </w-item-section>
              </w-item>
            </w-card>
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
                    :disable="state.target.module === `db`" />
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
                    outlined
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
                    :disable="
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
                    :disable="!state.target.assetDelivery.isDirectAccessSupported" />
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
                    push
                    no-caps
                    toggle-color="primary"
                    :options="syncModeOptions"
                    :aria-label="t(`admin.storage.syncDirection`)"
                    :disable="state.target.sync.supportedModes.length <= 1" />
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
                    outlined
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
              <template v-if="state.target.isEnabled" v-for="(act, idx) in state.target.actions">
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
                      :disable="state.runningAction"
                      :loading="state.runningActionHandler === act.handler" />
                  </w-item-section>
                </w-item>
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
                <img class="w-full object-cover rounded" :src="state.target.banner" />
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
                      :disable="state.target.module === `db` || isSetupNeeded"
                      :aria-label="t(`admin.storage.enabled`)" />
                  </w-item-section>
                  <w-inner-loading :showing="isSetupNeeded">
                    <w-icon name="la:exclamation-triangle" size="sm" color="negative" />
                    <div class="text-body2 text-negative">
                      {{ t('admin.storage.setupRequired') }}
                    </div>
                  </w-inner-loading>
                </w-item>
                <w-separator class="my-2" inset />
              </template>
              <w-item>
                <w-item-section>
                  <w-item-label class="text-grey">{{
                    t(`admin.storage.currentState`)
                  }}</w-item-label>
                  <w-item-label class="text-positive">No issues detected.</w-item-label>
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
                    :disable="
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
            <div class="text-caption mr-2">{{ t('admin.storage.deliveryPathsLegend') }}</div>
            <w-chip square dense color="blue-1" text-color="blue-8">
              <w-avatar icon="la:ellipsis-h" color="blue" text-color="white" />
              <span class="text-caption px-2">{{
                t('admin.storage.deliveryPathsUserRequest')
              }}</span>
            </w-chip>
            <w-chip square dense color="teal-1" text-color="teal-8">
              <w-avatar icon="la:ellipsis-h" color="positive" text-color="white" />
              <span class="text-caption px-2">{{
                t('admin.storage.deliveryPathsPushToOrigin')
              }}</span>
            </w-chip>
            <w-chip square dense color="red-1" text-color="red-8">
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
            style="height: 600px; background-color: #fff">
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
              <text
                v-if="state.deliveryNodes[nodeId].icon && state.deliveryNodes[nodeId].iconText"
                :class="state.deliveryNodes[nodeId].icon"
                :font-size="22 * scale"
                fill="#ffffff"
                text-anchor="middle"
                dominant-baseline="central"
                v-html="state.deliveryNodes[nodeId].iconText" />
            </template>
          </v-network-graph>
        </w-card>
      </div>
    </div>
    <!-- .overline.my-5 {{t('admin.storage.syncDirection')}} -->
    <!-- .body-2.ml-3 {{t('admin.storage.syncDirectionSubtitle')}} -->
    <!-- .pr-3.pt-3 -->
    <!-- v-radio-group.ml-3.py-0(v-model='target.mode') -->
    <!-- v-radio( -->
    <!-- :label='t(`admin.storage.syncDirBi`)' -->
    <!-- color='primary' -->
    <!-- value='sync' -->
    <!-- :disabled='target.supportedModes.indexOf(`sync`) < 0' -->
    <!-- ) -->
    <!-- v-radio( -->
    <!-- :label='t(`admin.storage.syncDirPush`)' -->
    <!-- color='primary' -->
    <!-- value='push' -->
    <!-- :disabled='target.supportedModes.indexOf(`push`) < 0' -->
    <!-- ) -->
    <!-- v-radio( -->
    <!-- :label='t(`admin.storage.syncDirPull`)' -->
    <!-- color='primary' -->
    <!-- value='pull' -->
    <!-- :disabled='target.supportedModes.indexOf(`pull`) < 0' -->
    <!-- ) -->
    <!-- .body-2.ml-3 -->
    <!-- strong {{t('admin.storage.syncDirBi')}} #[em.red--text.text--lighten-2(v-if='target.supportedModes.indexOf(`sync`) < 0') {{t('admin.storage.unsupported')}}] -->
    <!-- .pb-3 {{t('admin.storage.syncDirBiHint')}} -->
    <!-- strong {{t('admin.storage.syncDirPush')}} #[em.red--text.text--lighten-2(v-if='target.supportedModes.indexOf(`push`) < 0') {{t('admin.storage.unsupported')}}] -->
    <!-- .pb-3 {{t('admin.storage.syncDirPushHint')}} -->
    <!-- strong {{t('admin.storage.syncDirPull')}} #[em.red--text.text--lighten-2(v-if='target.supportedModes.indexOf(`pull`) < 0') {{t('admin.storage.unsupported')}}] -->
    <!-- .pb-3 {{t('admin.storage.syncDirPullHint')}} -->
    <!-- template(v-if='target.hasSchedule') -->
    <!-- v-divider.mt-3 -->
    <!-- .overline.my-5 {{t('admin.storage.syncSchedule')}} -->
    <!-- .body-2.ml-3 {{t('admin.storage.syncScheduleHint')}} -->
    <!-- .pa-3 -->
    <!-- duration-picker(v-model='target.syncInterval') -->
    <!-- i18next.caption.mt-3(path='admin.storage.syncScheduleCurrent', tag='div') -->
    <!-- strong(place='schedule') {{getDefaultSchedule(target.syncInterval)}} -->
    <!-- i18next.caption(path='admin.storage.syncScheduleDefault', tag='div') -->
    <!-- strong(place='schedule') {{getDefaultSchedule(target.syncIntervalDefault)}} -->
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
import { isQueuedAction, syncPayloadFor, syncStatusKind } from '@/helpers/storageSync'

// COMPOSABLES

const dark = useDark()

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

useMeta({
  title: t('admin.storage.title')
})

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
  setupCfg: {
    action: '',
    manifest: '',
    loading: false
  },
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
        margin: 8
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

const isSetupNeeded = computed(() => {
  return state.target?.setup?.handler && state.target.setup.state !== 'configured'
})

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
  const key = SYNC_MODE_HINT_KEYS[state.target?.sync?.mode]
  return key ? t(key) : ''
})

/** 'error' | 'never' | 'outOfDate' | 'synced' -- see `syncStatusKind` for the priority order. */
const syncStatus = computed(() => syncStatusKind(state.syncStatus))

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

function configIfCheck(ifs) {
  if (!ifs || ifs.length < 1) {
    return true
  }
  return ifs.every((s) => state.target.config[s.key]?.value === s.eq)
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
    const resp = await API_CLIENT.put(`sites/${adminStore.currentSiteId}/storage/targets`, {
      json: { targets: state.targets.map(payloadFor) }
    }).json()
    if (!resp?.ok) {
      throw new Error(resp?.message || 'An unexpected error occured.')
    }
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
      const resp = await API_CLIENT.post(
        `sites/${adminStore.currentSiteId}/storage/targets/${state.selectedTarget}/actions/${act.handler}`
      ).json()
      if (!resp?.ok) {
        throw new Error(resp?.message || 'An unexpected error occured.')
      }
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

async function setupDestroy() {
  confirm({
    title: t('admin.storage.destroyConfirm'),
    message: t('admin.storage.destroyConfirmInfo'),
    cancel: true,
    persistent: true
  }).onOk(async () => {
    loading.show({
      message: t('admin.storage.destroyingSetup')
    })

    try {
      const resp = await API_CLIENT.delete(
        `sites/${adminStore.currentSiteId}/storage/targets/${state.selectedTarget}/setup`
      ).json()
      if (!resp?.ok) {
        throw new Error(resp?.message || 'An unexpected error occured.')
      }
      state.target.setup.state = 'notconfigured'
      // -> A provider-backed setup handler may need a moment to settle before it can be started over
      setTimeout(() => {
        loading.hide()
        notify({
          type: 'positive',
          message: t('admin.storage.setupDestroySuccess')
        })
      }, 2000)
    } catch (err) {
      loading.hide()
      notify({
        type: 'negative',
        message: t('admin.storage.setupDestroyFailed'),
        caption: apiErrorMessage(err)
      })
    }
  })
}

function generateGraph() {
  const types = [
    {
      key: 'images',
      label: t('admin.storage.contentTypeImages'),
      icon: 'las',
      iconText: '&#xf1c5;'
    },
    {
      key: 'documents',
      label: t('admin.storage.contentTypeDocuments'),
      icon: 'las',
      iconText: '&#xf1c1;'
    },
    {
      key: 'others',
      label: t('admin.storage.contentTypeOthers'),
      icon: 'las',
      iconText: '&#xf15b;'
    },
    {
      key: 'large',
      label: t('admin.storage.contentTypeLargeFiles'),
      icon: 'las',
      iconText: '&#xf1c6;'
    }
  ]

  // -> Create PagesNodes

  state.deliveryNodes = {
    user: {
      name: t('admin.storage.deliveryPathsUser'),
      borderRadius: 16,
      icon: '/_assets/icons/fluent-account.svg'
    },
    pages: {
      name: t('admin.storage.contentTypePages'),
      color: '#3f51b5',
      icon: 'las',
      iconText: '&#xf15c;'
    },
    pages_wiki: { name: 'Wiki.js', icon: '/_assets/logo-wikijs.svg', color: '#161b22' }
  }
  state.deliveryEdges = {
    user_pages: { source: 'user', target: 'pages' },
    pages_in: { source: 'pages', target: 'pages_wiki' },
    pages_out: { source: 'pages_wiki', target: 'pages' }
  }
  state.deliveryLayouts.nodes = {
    user: { x: -30, y: 30 },
    pages: { x: 0, y: 0 },
    pages_wiki: { x: 60, y: 0 }
  }
  state.deliveryPaths = []

  // -> Create Asset Nodes

  for (const [i, tp] of types.entries()) {
    state.deliveryNodes[tp.key] = {
      name: tp.label,
      color: '#3f51b5',
      icon: tp.icon,
      iconText: tp.iconText
    }
    state.deliveryEdges[`user_${tp.key}`] = { source: 'user', target: tp.key }
    state.deliveryLayouts.nodes[tp.key] = { x: 0, y: (i + 1) * 15 }

    // -> Find target with direct access
    const dt = state.targets.find((tgt) => {
      return (
        tgt.module !== 'db' &&
        tgt.contentTypes.activeTypes.includes(tp.key) &&
        tgt.isEnabled &&
        tgt.assetDelivery.isDirectAccessSupported &&
        tgt.assetDelivery.directAccess
      )
    })

    if (dt) {
      state.deliveryNodes[`${tp.key}_${dt.module}`] = { name: dt.title, icon: dt.icon }
      state.deliveryNodes[`${tp.key}_wiki`] = {
        name: 'Wiki.js',
        icon: '/_assets/logo-wikijs.svg',
        color: '#161b22'
      }
      state.deliveryLayouts.nodes[`${tp.key}_${dt.module}`] = { x: 60, y: (i + 1) * 15 }
      state.deliveryLayouts.nodes[`${tp.key}_wiki`] = { x: 120, y: (i + 1) * 15 }
      state.deliveryEdges[`${tp.key}_${dt.module}_in`] = {
        source: tp.key,
        target: `${tp.key}_${dt.module}`
      }
      state.deliveryEdges[`${tp.key}_${dt.module}_out`] = {
        source: `${tp.key}_${dt.module}`,
        target: tp.key
      }
      state.deliveryEdges[`${tp.key}_${dt.module}_wiki`] = {
        source: `${tp.key}_wiki`,
        target: `${tp.key}_${dt.module}`,
        color: '#02c39a',
        animationSpeed: 25
      }
      continue
    }

    // -> Find target with streaming

    const st = state.targets.find((tgt) => {
      return (
        tgt.module !== 'db' &&
        tgt.contentTypes.activeTypes.includes(tp.key) &&
        tgt.isEnabled &&
        tgt.assetDelivery.isStreamingSupported &&
        tgt.assetDelivery.streaming
      )
    })

    if (st) {
      state.deliveryNodes[`${tp.key}_${st.module}`] = { name: st.title, icon: st.icon }
      state.deliveryNodes[`${tp.key}_wiki`] = {
        name: 'Wiki.js',
        icon: '/_assets/logo-wikijs.svg',
        color: '#161b22'
      }
      state.deliveryLayouts.nodes[`${tp.key}_${st.module}`] = { x: 120, y: (i + 1) * 15 }
      state.deliveryLayouts.nodes[`${tp.key}_wiki`] = { x: 60, y: (i + 1) * 15 }
      state.deliveryEdges[`${tp.key}_wiki_in`] = { source: tp.key, target: `${tp.key}_wiki` }
      state.deliveryEdges[`${tp.key}_wiki_out`] = { source: `${tp.key}_wiki`, target: tp.key }
      state.deliveryEdges[`${tp.key}_${st.module}_out`] = {
        source: `${tp.key}_${st.module}`,
        target: `${tp.key}_wiki`
      }
      state.deliveryEdges[`${tp.key}_${st.module}_in`] = {
        source: `${tp.key}_wiki`,
        target: `${tp.key}_${st.module}`
      }
      state.deliveryEdges[`${tp.key}_${st.module}_wiki`] = {
        source: `${tp.key}_wiki`,
        target: `${tp.key}_${st.module}`,
        color: '#02c39a',
        animationSpeed: 25
      }
      continue
    }

    // -> Check DB fallback

    const dbt = state.targets.find((tgt) => tgt.module === 'db')
    if (dbt?.contentTypes?.activeTypes?.includes(tp.key)) {
      state.deliveryNodes[`${tp.key}_wiki`] = {
        name: 'Wiki.js',
        icon: '/_assets/logo-wikijs.svg',
        color: '#161b22'
      }
      state.deliveryLayouts.nodes[`${tp.key}_wiki`] = { x: 60, y: (i + 1) * 15 }
      state.deliveryEdges[`${tp.key}_db_in`] = { source: tp.key, target: `${tp.key}_wiki` }
      state.deliveryEdges[`${tp.key}_db_out`] = { source: `${tp.key}_wiki`, target: tp.key }
    } else {
      state.deliveryNodes[`${tp.key}_wiki`] = {
        name: t('admin.storage.missingOrigin'),
        color: '#f03a47',
        icon: 'las',
        iconText: '&#xf071;'
      }
      state.deliveryLayouts.nodes[`${tp.key}_wiki`] = { x: 60, y: (i + 1) * 15 }
      state.deliveryEdges[`${tp.key}_db_in`] = {
        source: tp.key,
        target: `${tp.key}_wiki`,
        color: '#f03a47',
        animate: false
      }
      state.deliveryPaths.push({ edges: [`${tp.key}_db_in`], color: '#f03a4755' })
    }
  }
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
