<template>
  <w-layout container>
    <w-header class="card-header">
      <w-icon name="tabler:user" left size="md" />
      <div>
        <span>{{ t(`admin.users.edit`) }}</span>
        <div class="text-caption">{{ state.user.name }}</div>
      </div>
      <w-space />
      <w-btn-group>
        <w-btn
          color="grey-6"
          text-color="white"
          :aria-label="t(`common.actions.refresh`)"
          icon="tabler:refresh"
          @click="fetchUser"
          :loading="state.loading > 0">
          <w-tooltip anchor="center left" self="center right">{{
            t(`common.actions.refresh`)
          }}</w-tooltip>
        </w-btn>
        <w-btn
          color="white"
          text-color="grey-7"
          :label="t(`common.actions.close`)"
          :aria-label="t(`common.actions.close`)"
          icon="tabler:x"
          @click="close" />
        <w-btn
          v-if="canManage"
          color="positive"
          text-color="white"
          :label="t(`common.actions.save`)"
          :aria-label="t(`common.actions.save`)"
          icon="tabler:check"
          @click="save()"
          :disabled="state.loading > 0" />
      </w-btn-group>
    </w-header>
    <w-drawer class="bg-dark-6" :model-value="true" :width="250" dark>
      <w-list padding dark v-if="state.loading < 1">
        <template v-for="sc of sections" :key="`section-` + sc.key">
          <w-item
            v-if="!sc.disabled || flagsStore.experimental"
            clickable
            :to="{ params: { section: sc.key } }"
            active-class="bg-primary text-white"
            :disabled="sc.disabled">
            <w-item-section side><w-icon :name="sc.icon" color="white" /></w-item-section>
            <w-item-section>{{ sc.text }}</w-item-section>
          </w-item>
        </template>
      </w-list>
    </w-drawer>
    <w-page-container>
      <w-page v-if="state.loading > 0">
        <div class="flex p-6 items-center">
          <w-spinner color="primary" size="32px" />
          <div class="text-caption text-primary ps-4">
            <strong>{{ t('admin.users.loading') }}</strong>
          </div>
        </div>
      </w-page>
      <w-page v-else-if="route.params.section === `overview`">
        <div class="p-4">
          <div class="grid grid-cols-12 gap-4">
            <div class="col-span-12 lg:col-span-8">
              <w-card class="shadow-1 pb-2">
                <w-card-header>{{ t('admin.users.profile') }}</w-card-header>
                <w-item>
                  <blueprint-icon icon="tabler:user" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.users.firstName`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.users.firstNameHint`) }}</w-item-label>
                  </w-item-section>
                  <w-item-section>
                    <w-input
                      v-model="state.user.firstName"
                      dense
                      :rules="[requiredNameRule]"
                      hide-bottom-space
                      :aria-label="t(`admin.users.firstName`)" />
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="tabler:user" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.users.lastName`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.users.lastNameHint`) }}</w-item-label>
                  </w-item-section>
                  <w-item-section>
                    <w-input
                      v-model="state.user.lastName"
                      dense
                      :rules="[optionalNameRule]"
                      hide-bottom-space
                      :aria-label="t(`admin.users.lastName`)" />
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <!--
                  Shown, not hidden: the display name is derived from the two halves above on every
                  save, and editing it here is the only way to reach the override Feature #2608
                  grants. The server decides -- writing back exactly what the halves derive to puts
                  the account on derivation again, anything else authors it.
                -->
                <w-item>
                  <blueprint-icon icon="tabler:address-book" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.users.name`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.users.nameHint`) }}</w-item-label>
                  </w-item-section>
                  <w-item-section>
                    <w-input
                      v-model="state.user.name"
                      dense
                      :rules="[requiredNameRule]"
                      hide-bottom-space
                      :aria-label="t(`admin.users.name`)" />
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="tabler:mail" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.users.email`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.users.emailHint`) }}</w-item-label>
                  </w-item-section>
                  <w-item-section>
                    <w-input
                      v-model="state.user.email"
                      dense
                      :aria-label="t(`admin.users.email`)" />
                  </w-item-section>
                </w-item>
                <template v-if="state.user.meta">
                  <w-separator class="my-2" inset />
                  <w-item>
                    <blueprint-icon icon="tabler:map-pin" />
                    <w-item-section>
                      <w-item-label>{{ t(`admin.users.location`) }}</w-item-label>
                      <w-item-label caption>{{ t(`admin.users.locationHint`) }}</w-item-label>
                    </w-item-section>
                    <w-item-section>
                      <w-input
                        v-model="state.user.meta.location"
                        dense
                        :aria-label="t(`admin.users.location`)" />
                    </w-item-section>
                  </w-item>
                  <w-separator class="my-2" inset />
                  <w-item>
                    <blueprint-icon icon="tabler:briefcase" />
                    <w-item-section>
                      <w-item-label>{{ t(`admin.users.jobTitle`) }}</w-item-label>
                      <w-item-label caption>{{ t(`admin.users.jobTitleHint`) }}</w-item-label>
                    </w-item-section>
                    <w-item-section>
                      <w-input
                        v-model="state.user.meta.jobTitle"
                        dense
                        :aria-label="t(`admin.users.jobTitle`)" />
                    </w-item-section>
                  </w-item>
                  <w-separator class="my-2" inset />
                  <w-item>
                    <blueprint-icon icon="tabler:gender-bigender" />
                    <w-item-section>
                      <w-item-label>{{ t(`admin.users.pronouns`) }}</w-item-label>
                      <w-item-label caption>{{ t(`admin.users.pronounsHint`) }}</w-item-label>
                    </w-item-section>
                    <w-item-section>
                      <w-input
                        v-model="state.user.meta.pronouns"
                        dense
                        :aria-label="t(`admin.users.pronouns`)" />
                    </w-item-section>
                  </w-item>
                </template>
              </w-card>
              <w-card class="shadow-1 pb-2 mt-4" v-if="state.user.meta">
                <w-card-header>{{ t('admin.users.preferences') }}</w-card-header>
                <w-item>
                  <blueprint-icon icon="tabler:clock-hour-4" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.users.timezone`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.users.timezoneHint`) }}</w-item-label>
                  </w-item-section>
                  <w-item-section>
                    <w-select
                      v-model="state.user.prefs.timezone"
                      :options="timezones"
                      option-value="value"
                      option-label="text"
                      emit-value
                      map-options
                      dense
                      options-dense
                      :aria-label="t(`admin.users.timezone`)" />
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="tabler:calendar" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.users.dateFormat`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.users.dateFormatHint`) }}</w-item-label>
                  </w-item-section>
                  <w-item-section>
                    <w-select
                      v-model="state.user.prefs.dateFormat"
                      emit-value
                      map-options
                      dense
                      :aria-label="t(`admin.users.dateFormat`)"
                      :options="[
                        { label: t('profile.localeDefault'), value: '' },
                        { label: 'DD/MM/YYYY', value: 'DD/MM/YYYY' },
                        { label: 'DD.MM.YYYY', value: 'DD.MM.YYYY' },
                        { label: 'MM/DD/YYYY', value: 'MM/DD/YYYY' },
                        { label: 'YYYY-MM-DD', value: 'YYYY-MM-DD' },
                        { label: 'YYYY/MM/DD', value: 'YYYY/MM/DD' }
                      ]" />
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="tabler:clock" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.users.timeFormat`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.users.timeFormatHint`) }}</w-item-label>
                  </w-item-section>
                  <w-item-section class="flex-none">
                    <w-btn-toggle
                      v-model="state.user.prefs.timeFormat"
                      toggle-color="primary"
                      :aria-label="t(`admin.users.timeFormat`)"
                      :options="[
                        { label: t('profile.timeFormat12h'), value: '12h' },
                        { label: t('profile.timeFormat24h'), value: '24h' }
                      ]" />
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="tabler:bulb" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.users.appearance`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.users.darkModeHint`) }}</w-item-label>
                  </w-item-section>
                  <w-item-section class="flex-none">
                    <w-btn-toggle
                      v-model="state.user.prefs.appearance"
                      toggle-color="primary"
                      :aria-label="t(`admin.users.appearance`)"
                      :options="[
                        { label: t('profile.appearanceDefault'), value: 'site' },
                        { label: t('profile.appearanceLight'), value: 'light' },
                        { label: t('profile.appearanceDark'), value: 'dark' }
                      ]" />
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="tabler:eye-off" />
                  <w-item-section>
                    <w-item-label>{{ t(`profile.cvd`) }}</w-item-label>
                    <w-item-label caption>{{ t(`profile.cvdHint`) }}</w-item-label>
                  </w-item-section>
                  <w-item-section class="flex-none">
                    <w-btn-toggle
                      v-model="state.user.prefs.cvd"
                      toggle-color="primary"
                      :aria-label="t(`profile.cvd`)"
                      :options="[
                        { value: 'none', label: t('profile.cvdNone') },
                        { value: 'protanopia', label: t('profile.cvdProtanopia') },
                        { value: 'deuteranopia', label: t('profile.cvdDeuteranopia') },
                        { value: 'tritanopia', label: t('profile.cvdTritanopia') }
                      ]" />
                  </w-item-section>
                </w-item>
              </w-card>
            </div>
            <div class="col-span-12 lg:col-span-4">
              <w-card class="shadow-1 pb-2">
                <w-card-header>{{ t('admin.users.info') }}</w-card-header>
                <w-item>
                  <blueprint-icon icon="tabler:user" />
                  <w-item-section>
                    <w-item-label>{{ t(`common.field.id`) }}</w-item-label>
                    <w-item-label
                      ><strong>{{ state.user.id }}</strong></w-item-label
                    >
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="tabler:calendar-plus" />
                  <w-item-section>
                    <w-item-label>{{ t(`common.field.createdOn`) }}</w-item-label>
                    <w-item-label>
                      <strong>{{ humanizeDate(t, state.user.createdAt) }}</strong>
                    </w-item-label>
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="tabler:sun" />
                  <w-item-section>
                    <w-item-label>{{ t(`common.field.lastUpdated`) }}</w-item-label>
                    <w-item-label>
                      <strong>{{ humanizeDate(t, state.user.updatedAt) }}</strong>
                    </w-item-label>
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="tabler:arrow-bar-to-right" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.users.lastLoginAt`) }}</w-item-label>
                    <w-item-label>
                      <strong>{{ humanizeDate(t, state.user.lastLoginAt) }}</strong>
                    </w-item-label>
                  </w-item-section>
                </w-item>
              </w-card>
              <w-card class="shadow-1 pb-2 mt-4" v-if="state.user.meta">
                <w-card-header>{{ t('admin.users.notes') }}</w-card-header>
                <w-card-section class="pt-0">
                  <w-input
                    v-model="state.user.meta.notes"
                    type="textarea"
                    :aria-label="t(`admin.users.notes`)"
                    :hint="t(`admin.users.noteHint`)" />
                </w-card-section>
              </w-card>
            </div>
          </div>
        </div>
      </w-page>
      <w-page v-else-if="route.params.section === `activity`"><span>---</span></w-page>
      <w-page v-else-if="route.params.section === `auth`">
        <div class="p-4">
          <div class="grid grid-cols-12 gap-4">
            <div class="col-span-12 lg:col-span-7">
              <w-card class="shadow-1 pb-2">
                <w-card-header>{{ t('admin.users.passAuth') }}</w-card-header>
                <w-item>
                  <blueprint-icon icon="tabler:password" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.users.changePassword`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.users.changePasswordHint`) }}</w-item-label>
                    <w-item-label caption>
                      <strong
                        :class="localAuth.isPasswordSet ? `text-positive` : `text-negative`"
                        >{{
                          localAuth.isPasswordSet
                            ? t(`admin.users.pwdSet`)
                            : t(`admin.users.pwdNotSet`)
                        }}</strong
                      >
                    </w-item-label>
                  </w-item-section>
                  <w-item-section side>
                    <w-btn
                      class="acrylic-btn"
                      flat
                      icon="tabler:circle-arrow-right"
                      color="primary"
                      v-if="canManage"
                      @click="changePassword"
                      :label="t(`common.actions.proceed`)" />
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item tag="label">
                  <blueprint-icon icon="tabler:lock-cog" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.users.mustChangePwd`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.users.mustChangePwdHint`) }}</w-item-label>
                  </w-item-section>
                  <w-item-section avatar>
                    <w-toggle
                      v-model="localAuth.mustChangePwd"
                      :aria-label="t(`admin.users.mustChangePwd`)" />
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item tag="label">
                  <blueprint-icon icon="tabler:key" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.users.pwdAuthRestrict`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.users.pwdAuthRestrictHint`) }}</w-item-label>
                  </w-item-section>
                  <w-item-section avatar>
                    <w-toggle
                      v-model="localAuth.restrictLogin"
                      :aria-label="t(`admin.users.pwdAuthRestrict`)" />
                  </w-item-section>
                </w-item>
              </w-card>
              <w-card class="shadow-1 pb-2 mt-4">
                <w-card-header>{{ t('admin.users.tfa') }}</w-card-header>
                <w-item tag="label">
                  <blueprint-icon icon="tabler:key" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.users.tfaRequired`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.users.tfaRequiredHint`) }}</w-item-label>
                  </w-item-section>
                  <w-item-section avatar>
                    <w-toggle
                      v-model="localAuth.isTfaRequired"
                      :aria-label="t(`admin.users.tfaRequired`)" />
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="tabler:password" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.users.tfaInvalidate`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.users.tfaInvalidateHint`) }}</w-item-label>
                    <w-item-label caption>
                      <strong :class="localAuth.isTfaSetup ? `text-positive` : `text-negative`">{{
                        localAuth.isTfaSetup ? t(`admin.users.tfaSet`) : t(`admin.users.tfaNotSet`)
                      }}</strong>
                    </w-item-label>
                  </w-item-section>
                  <w-item-section side>
                    <w-btn
                      class="acrylic-btn"
                      flat
                      icon="tabler:circle-arrow-right"
                      color="primary"
                      v-if="canManage"
                      @click="invalidateTFA"
                      :label="t(`common.actions.proceed`)" />
                  </w-item-section>
                </w-item>
              </w-card>
              <w-card class="shadow-1 pb-2 mt-4" v-if="canManage">
                <w-card-header>{{ t('admin.users.passkeys') }}</w-card-header>
                <w-card-section class="pt-0">
                  <w-banner
                    v-if="state.passkeys.length < 1"
                    :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`"
                    >{{ t('admin.users.passkeysEmpty') }}</w-banner
                  >
                  <w-list v-else bordered separator>
                    <w-item v-for="pkey of state.passkeys" :key="pkey.id">
                      <w-item-section avatar>
                        <w-avatar color="slate" text-color="white" rounded>
                          <w-icon name="tabler:key" />
                        </w-avatar>
                      </w-item-section>
                      <w-item-section>
                        <strong>{{ pkey.name }}</strong>
                        <div class="text-caption">{{ pkey.siteHostname }}</div>
                        <div class="text-caption text-grey-7">
                          {{ humanizeDate(t, pkey.createdAt) }}
                        </div>
                      </w-item-section>
                      <w-item-section side>
                        <w-btn
                          class="acrylic-btn"
                          flat
                          icon="tabler:trash"
                          :aria-label="t(`common.actions.delete`)"
                          color="negative"
                          v-if="canManage"
                          @click="revokePasskey(pkey)" />
                      </w-item-section>
                    </w-item>
                  </w-list>
                </w-card-section>
              </w-card>
            </div>
            <div class="col-span-12 lg:col-span-5">
              <w-card class="shadow-1 pb-2">
                <w-card-header>{{ t('admin.users.linkedProviders') }}</w-card-header>
                <w-card-section v-if="linkedAuthProviders.length < 1" class="pt-0">
                  <w-banner
                    :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`"
                    >{{ t('admin.users.noLinkedProviders') }}</w-banner
                  >
                </w-card-section>
                <template v-for="(prv, idx) in linkedAuthProviders" :key="prv.authId">
                  <w-separator class="my-2" inset v-if="idx > 0" />
                  <w-item>
                    <blueprint-icon :icon="prv.strategyIcon" />
                    <w-item-section>
                      <w-item-label>{{ prv.authName }}</w-item-label>
                      <w-item-label caption>{{ prv.config.key }}</w-item-label>
                    </w-item-section>
                  </w-item>
                </template>
              </w-card>
            </div>
          </div>
        </div>
      </w-page>
      <w-page v-else-if="route.params.section === `groups`">
        <div class="p-4">
          <div class="grid grid-cols-12 gap-4">
            <div class="col-span-12 lg:col-span-8">
              <w-card class="shadow-1 pb-2">
                <w-card-header>{{ t('admin.users.groups') }}</w-card-header>
                <template v-for="(grp, idx) of state.user.groups" :key="grp.id">
                  <w-separator class="my-2" inset v-if="idx > 0" />
                  <w-item>
                    <blueprint-icon icon="tabler:users" />
                    <w-item-section
                      ><w-item-label>{{ grp.name }}</w-item-label></w-item-section
                    >
                    <w-item-section side>
                      <w-btn
                        class="acrylic-btn"
                        flat
                        icon="tabler:x"
                        color="accent"
                        v-if="canManage"
                        @click="unassignGroup(grp.id)"
                        :aria-label="t(`admin.users.unassignGroup`)">
                        <w-tooltip anchor="center left" self="center right">{{
                          t('admin.users.unassignGroup')
                        }}</w-tooltip>
                      </w-btn>
                    </w-item-section>
                  </w-item>
                </template>
              </w-card>
              <w-card class="shadow-1 py-2 mt-4">
                <w-item>
                  <blueprint-icon icon="tabler:arrows-join" />
                  <w-item-section>
                    <w-select
                      :options="state.groups"
                      v-model="state.groupToAdd"
                      map-options
                      emit-value
                      option-value="id"
                      option-label="name"
                      options-dense
                      dense
                      hide-bottom-space
                      :label="t(`admin.users.groups`)"
                      :aria-label="t(`admin.users.groups`)"
                      :loading="state.loading > 0" />
                  </w-item-section>
                  <w-item-section side>
                    <w-btn
                      icon="tabler:plus"
                      :label="t(`admin.users.assignGroup`)"
                      color="primary"
                      v-if="canManage"
                      @click="assignGroup" />
                  </w-item-section>
                </w-item>
                <w-item v-if="groupToAddSyncStrategies.length > 0">
                  <w-item-section>
                    <w-banner
                      :class="
                        dark.isActive ? `bg-deep-orange text-white` : `bg-orange-1 text-deep-orange`
                      ">
                      <i18n-t keypath="admin.users.groupSyncWarning" tag="span">
                        <template #provider
                          ><strong>{{
                            groupToAddSyncStrategies.map((s) => s.displayName).join(', ')
                          }}</strong></template
                        >
                      </i18n-t>
                    </w-banner>
                  </w-item-section>
                </w-item>
              </w-card>
            </div>
          </div>
        </div>
      </w-page>
      <w-page v-else-if="route.params.section === `metadata`">
        <div class="p-4">
          <div class="grid grid-cols-12 gap-4">
            <div class="col-span-12 lg:col-span-8">
              <w-card class="shadow-1 pb-2">
                <w-card-header>
                  {{ t('admin.users.metadata') }}
                  <template #action>
                    <w-badge v-if="state.metadataInvalidJSON" color="negative">
                      <w-icon class="me-1" name="tabler:alert-triangle" size="20px" />
                      <span>{{ t('admin.users.invalidJSON') }}</span>
                    </w-badge>
                    <w-badge
                      class="py-1"
                      v-else
                      :label="t('admin.users.jsonBadgeLabel')"
                      color="positive" />
                  </template>
                </w-card-header>
                <w-item>
                  <w-item-section>
                    <util-code-editor
                      v-model="metadata"
                      language="json"
                      :min-height="500"
                      :aria-label="t('admin.users.metadataAriaLabel')" />
                  </w-item-section>
                </w-item>
              </w-card>
            </div>
          </div>
        </div>
      </w-page>
      <w-page v-else-if="route.params.section === `operations`">
        <div class="p-4">
          <div class="grid grid-cols-12 gap-4">
            <div class="col-span-12 lg:col-span-8">
              <w-card class="shadow-1 pb-2">
                <w-card-header>{{ t('admin.users.operations') }}</w-card-header>
                <w-item>
                  <blueprint-icon icon="tabler:check" />
                  <w-item-section>
                    <w-item-label>{{
                      state.user.isVerified ? t(`admin.users.unverify`) : t(`admin.users.verify`)
                    }}</w-item-label>
                    <w-item-label caption>{{
                      state.user.isVerified
                        ? t(`admin.users.unverifyHint`)
                        : t(`admin.users.verifyHint`)
                    }}</w-item-label>
                    <w-item-label caption>
                      <strong :class="state.user.isVerified ? `text-positive` : `text-negative`">{{
                        state.user.isVerified
                          ? t(`admin.users.verified`)
                          : t(`admin.users.unverified`)
                      }}</strong>
                    </w-item-label>
                  </w-item-section>
                  <w-item-section side>
                    <w-btn
                      class="acrylic-btn"
                      flat
                      icon="tabler:circle-arrow-right"
                      color="primary"
                      v-if="canManage"
                      @click="toggleVerified"
                      :label="t(`common.actions.proceed`)" />
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="tabler:user-minus" />
                  <w-item-section>
                    <w-item-label>{{
                      state.user.isActive ? t(`admin.users.ban`) : t(`admin.users.unban`)
                    }}</w-item-label>
                    <w-item-label caption>{{
                      state.user.isActive ? t(`admin.users.banHint`) : t(`admin.users.unbanHint`)
                    }}</w-item-label>
                    <w-item-label caption>
                      <strong :class="state.user.isActive ? `text-positive` : `text-negative`">{{
                        state.user.isActive ? t(`admin.users.active`) : t(`admin.users.banned`)
                      }}</strong>
                    </w-item-label>
                  </w-item-section>
                  <w-item-section side>
                    <w-btn
                      class="acrylic-btn"
                      flat
                      icon="tabler:circle-arrow-right"
                      color="primary"
                      v-if="canManage"
                      @click="toggleBan"
                      :label="t(`common.actions.proceed`)" />
                  </w-item-section>
                </w-item>
              </w-card>
              <w-card class="shadow-1 py-2 mt-4">
                <w-item>
                  <blueprint-icon icon="tabler:ban" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.users.delete`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.users.deleteHint`) }}</w-item-label>
                  </w-item-section>
                  <w-item-section side>
                    <w-btn
                      class="acrylic-btn"
                      flat
                      icon="tabler:circle-arrow-right"
                      color="negative"
                      v-if="canManage"
                      @click="deleteUser"
                      :label="t(`common.actions.proceed`)" />
                  </w-item-section>
                </w-item>
              </w-card>
            </div>
          </div>
        </div>
      </w-page>
    </w-page-container>
  </w-layout>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'

import { confirm, dialog } from '@/composables/dialog'
import { useDerivedDisplayName } from '@/composables/displayName'
import { loading } from '@/composables/loading'
import { useDark } from '@/composables/dark'
import { notify } from '@/composables/notify'

import { useAdminStore } from '@/stores/admin'
import { useFlagsStore } from '@/stores/flags'
import { useUserStore } from '@/stores/user'

import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDate } from '@/helpers/datetime'
import { GUESTS_GROUP_ID } from '@/helpers/systemIds'

import UserChangePwdDialog from './UserChangePwdDialog.vue'
import UserDeleteDialog from './UserDeleteDialog.vue'
import UtilCodeEditor from './UtilCodeEditor.vue'

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()
const flagsStore = useFlagsStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()
const route = useRoute()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  invalidCharsRegex: /^[^<>"]+$/,
  user: {
    meta: {},
    prefs: {},
    groups: []
  },
  groups: [],
  groupToAdd: null,
  /** groupId -> the enabled, mapGroups-on strategies that could revoke it -- see
   *  `groupToAddSyncStrategies` and `fetchGroupSyncWarnings()`. */
  groupSyncWarnings: {},
  passkeys: [],
  loading: 0,
  metadataInvalidJSON: false
})

const sections = [
  { key: 'overview', text: t('admin.users.overview'), icon: 'tabler:user' },
  { key: 'activity', text: t('admin.users.activity'), icon: 'tabler:chart-area', disabled: true },
  { key: 'auth', text: t('admin.users.auth'), icon: 'tabler:key' },
  { key: 'groups', text: t('admin.users.groups'), icon: 'tabler:users' },
  { key: 'metadata', text: t('admin.users.metadata'), icon: 'tabler:clipboard-list' },
  { key: 'operations', text: t('admin.users.operations'), icon: 'tabler:tool' }
]

const timezones = Intl.supportedValuesOf('timeZone')

/*
  Keeps the display name in step with the two halves until an administrator overrides it. Without it,
  editing a half alone would leave a stale `name` in the patch -- which the server reads as a
  deliberate override and would freeze this user's display name for good. A getter because
  `fetchUser()` REPLACES `state.user` wholesale. See the composable's own doc.
*/
const { syncFromStored: syncDisplayName } = useDerivedDisplayName(() => state.user)

/**
 * The first-name and display-name rule: a value must be there and must not contain the characters
 * a name has always refused.
 *
 * A named function rather than the inline array both fields used to declare. That inline rule read
 * a bare `invalidCharsRegex`, which is a `state` member and so resolved to `undefined` in the
 * template -- the rule threw `Cannot read properties of undefined (reading 'test')` the moment it
 * ran, which is any validation of the Overview tab's name field. Nothing covered that tab, so it
 * went unnoticed; Task #2642's own coverage is what surfaced it.
 */
function requiredNameRule(val) {
  return (val && state.invalidCharsRegex.test(val)) || t('admin.users.nameInvalidChars')
}

/**
 * The last-name rule. Unlike the two above it accepts an empty value: a mononym has no surname and
 * nothing fabricates one, so only a value that IS there is checked for the same characters.
 */
function optionalNameRule(val) {
  return !val || state.invalidCharsRegex.test(val) || t('admin.users.nameInvalidChars')
}

// COMPUTED

/*
  `read:users` opens this overlay read-only: every write below needs `manage:users` (see
  `api/users/admin.ts`), so the actions that perform one are hidden rather than left to fail at the API.
  The fields stay as they are -- without Save there is nowhere for a typed change to go.
*/
const canManage = computed(() => userStore.can('manage:users'))

const metadata = computed({
  get() {
    return JSON.stringify(state.user.meta ?? {}, null, 2)
  },
  set(val) {
    try {
      state.user.meta = JSON.parse(val)
      state.metadataInvalidJSON = false
    } catch (err) {
      state.metadataInvalidJSON = true
    }
  }
})

const localAuth = computed({
  get() {
    return state.user?.auth?.find((prv) => prv.strategyKey === 'local')?.config ?? {}
  },
  set(val) {
    if (localAuth.value.authId) {
      state.user.auth.find((prv) => prv.strategyKey === 'local').config = val
    }
  }
})

/**
 * Which enabled, provider-sync strategies could revoke `state.groupToAdd` on the user's next login
 * (WP #2440), so the picker can warn before a manual grant is made. Empty whenever no group is
 * selected, or the selected one is not on any strategy's `mappableGroups` allow-list.
 */
const groupToAddSyncStrategies = computed(() => {
  if (!state.groupToAdd) {
    return []
  }
  return state.groupSyncWarnings[state.groupToAdd] ?? []
})

const linkedAuthProviders = computed(() => {
  if (!state.user?.auth) {
    return []
  }

  return state.user.auth.filter((prv) => prv.strategyKey !== 'local')
})

// WATCHERS

watch(() => route.params.section, checkRoute)

// METHODS

async function fetchUser() {
  state.loading++
  loading.show()
  try {
    const [groups, user, groupSyncWarnings] = await Promise.all([
      API_CLIENT.get('groups').json(),
      API_CLIENT.get(`users/${adminStore.overlayOpts.id}`).json(),
      fetchGroupSyncWarnings()
    ])
    state.groups = (groups ?? []).filter((g) => g.id !== GUESTS_GROUP_ID)
    state.groupSyncWarnings = groupSyncWarnings
    if (!user?.id) {
      throw new Error(t('common.error.unexpected'))
    }
    state.user = user
    // -> After the whole record is in the fields, not per-field: the answer depends on all three.
    syncDisplayName()
    if (canManage.value) {
      await fetchPasskeys()
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: err.message
    })
  }
  loading.hide()
  state.loading--
}

/**
 * groupId -> the strategies that could revoke it, for `groupToAddSyncStrategies`'s warning.
 * Best-effort: a viewer who cannot reach this route for any reason simply sees no warning rather
 * than a broken Groups tab, since the warning is a courtesy, not a requirement.
 */
async function fetchGroupSyncWarnings() {
  try {
    const warnings = await API_CLIENT.get('authentication/synced-groups').json()
    return Object.fromEntries((warnings ?? []).map((w) => [w.groupId, w.strategies]))
  } catch {
    return {}
  }
}

async function fetchPasskeys() {
  try {
    const resp = await API_CLIENT.get(`users/${adminStore.overlayOpts.id}/passkeys`).json()
    state.passkeys = resp?.passkeys ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
}

function close() {
  adminStore.$patch({ overlay: '' })
}

function checkRoute() {
  if (!route.params.section) {
    router.replace({ params: { section: 'overview' } })
  }
  if (route.params.section === 'metadata') {
    state.metadataInvalidJSON = false
  }
}

function assignGroup() {
  if (!state.groupToAdd) {
    notify({
      type: 'negative',
      message: t('admin.users.noGroupSelected')
    })
  } else if (state.user.groups.some((gr) => gr.id === state.groupToAdd)) {
    notify({
      type: 'warning',
      message: t('admin.users.groupAlreadyAssigned')
    })
  } else {
    const newGroup = state.groups.find((gr) => gr.id === state.groupToAdd)
    state.user.groups = [...state.user.groups, newGroup]
  }
}

function unassignGroup(id) {
  if (state.user.groups.length <= 1) {
    notify({
      type: 'negative',
      message: t('admin.users.minimumGroupRequired')
    })
  } else {
    state.user.groups = state.user.groups.filter((gr) => gr.id !== id)
  }
}

async function save(patch, { silent, keepOpen } = { silent: false, keepOpen: false }) {
  loading.show()
  if (!patch) {
    patch = {
      // -> All three go every time; `models/users.ts#updateUser` owns which of them wins. A `name`
      //    equal to what the halves derive to reads as "keep deriving", so saving the form does not
      //    mark an untouched account as having a hand-authored display name.
      name: state.user.name,
      firstName: state.user.firstName,
      lastName: state.user.lastName,
      email: state.user.email,
      isVerified: state.user.isVerified,
      isActive: state.user.isActive,
      meta: state.user.meta,
      prefs: state.user.prefs,
      groups: state.user.groups.map((gr) => gr.id),
      auth: {
        tfaRequired: localAuth.value.isTfaRequired,
        mustChangePwd: localAuth.value.mustChangePwd,
        restrictLogin: localAuth.value.restrictLogin
      }
    }
  }
  try {
    await API_CLIENT.put(`users/${adminStore.overlayOpts.id}`, {
      json: patch
    }).json()
    if (!silent) {
      notify({
        type: 'positive',
        message: t('admin.users.saveSuccess')
      })
    }
    if (!keepOpen) {
      close()
    }
  } catch (err) {
    // -> ky throws above 400 with the reason in the body, which is where the server explains itself;
    //    some error codes have a nicer translation under `admin.users.*`
    notify({
      type: 'negative',
      message: t(
        `admin.users.${err.data?.error}`,
        apiErrorMessage(err, t('common.error.unexpected'))
      )
    })
  }
  loading.hide()
}

function changePassword() {
  dialog({
    component: UserChangePwdDialog,
    componentProps: {
      userId: adminStore.overlayOpts.id
    }
  }).onOk(({ mustChangePassword }) => {
    localAuth.value = {
      ...localAuth.value,
      mustChangePwd: mustChangePassword
    }
  })
}

function invalidateTFA() {
  confirm({
    title: t('admin.users.tfaInvalidate'),
    message: t('admin.users.tfaInvalidateConfirm'),
    cancel: true,
    persistent: true,
    okLabel: t('common.actions.confirm')
  }).onOk(async () => {
    loading.show()
    try {
      await API_CLIENT.post(`users/${adminStore.overlayOpts.id}/tfa/invalidate`, {
        json: { strategyId: localAuth.value.authId }
      }).json()
      localAuth.value = {
        ...localAuth.value,
        isTfaSetup: false
      }
      notify({
        type: 'positive',
        message: t('admin.users.tfaInvalidateSuccess')
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.users.tfaInvalidateFailed'),
        caption: apiErrorMessage(err)
      })
    }
    loading.hide()
  })
}

function revokePasskey(pkey) {
  confirm({
    title: t('common.actions.delete'),
    message: t('admin.users.passkeysRevokeConfirm'),
    cancel: true,
    color: 'negative',
    okLabel: t('common.actions.delete')
  }).onOk(async () => {
    loading.show()
    try {
      await API_CLIENT.delete(
        `users/${adminStore.overlayOpts.id}/passkeys/${encodeURIComponent(pkey.id)}`
      )
      state.passkeys = state.passkeys.filter((p) => p.id !== pkey.id)
      notify({
        type: 'positive',
        message: t('admin.users.passkeysRevokeSuccess')
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.users.passkeysRevokeFailed'),
        caption: apiErrorMessage(err)
      })
    }
    loading.hide()
  })
}

function toggleVerified() {
  state.user.isVerified = !state.user.isVerified
  save(
    {
      isVerified: state.user.isVerified
    },
    { silent: true, keepOpen: true }
  )
}

function toggleBan() {
  state.user.isActive = !state.user.isActive
  save(
    {
      isActive: state.user.isActive
    },
    { silent: true, keepOpen: true }
  )
}

// -> Opens the same `UserDeleteDialog` the users list opens (`pages/AdminUsers.vue`), which owns the
//    confirmation, the optional content reassignment and the DELETE itself. On success the user this
//    overlay is editing no longer exists, so the overlay closes -- the list page reloads off that.
function deleteUser() {
  dialog({
    component: UserDeleteDialog,
    componentProps: {
      user: state.user
    }
  }).onOk(close)
}

// MOUNTED

onMounted(() => {
  checkRoute()
  fetchUser()
})
</script>

<!--
  -> The `.metadata-codemirror` rules that were here targeted `.cm-editor`, a CodeMirror 6 class this
     app never had, from a class no element in this file carries. Dead twice over.
-->
