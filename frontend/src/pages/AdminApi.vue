<template>
  <w-page class="admin-api">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-rest-api-animated.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 pl-4">
        <h1 class="text-h5 text-primary animated fadeInLeft">{{ t('admin.api.title') }}</h1>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.api.subtitle') }}
        </div>
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center">
          <template v-if="state.enabled">
            <w-signal class="mr-2" color="green" size="md" />
            <div class="text-caption text-green">{{ t('admin.api.enabled') }}</div>
          </template>
          <template v-else>
            <w-signal class="mr-2" color="red" size="md" />
            <div class="text-caption text-red">{{ t('admin.api.disabled') }}</div>
          </template>
        </div>
      </div>
      <div class="flex-none">
        <!-- -> A real href, not a router link: the Swagger UI at `/_api` is served by the backend and is
             not part of this SPA. Labelled rather than tooltipped, so the visible text is already the
             accessible name and there is no `aria-label` -->
        <w-btn
          class="acrylic-btn mr-2 ml-4"
          icon="la:book"
          flat
          color="grey"
          :label="t(`admin.api.docsButton`)"
          href="/_api"
          target="_blank" />
        <w-btn
          class="acrylic-btn mr-2"
          icon="la:redo-alt"
          flat
          color="secondary"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="refresh">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="mr-2"
          unelevated
          icon="la:power-off"
          :label="!state.enabled ? t(`admin.api.enableButton`) : t(`admin.api.disableButton`)"
          :color="!state.enabled ? `positive` : `negative`"
          @click="globalSwitch"
          :loading="state.isToggleLoading"
          :disabled="state.loading > 0" />
        <w-btn
          unelevated
          icon="la:plus"
          :label="t(`admin.api.newKeyButton`)"
          color="primary"
          @click="newKey"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12" v-if="state.keys.length < 1">
        <w-card
          class="rounded"
          flat
          :class="dark.isActive ? `bg-dark-5 text-white` : `bg-grey-3 text-dark`">
          <w-card-section class="items-center" horizontal>
            <w-card-section class="flex-none pr-0">
              <w-icon name="la:info-circle" size="sm" />
            </w-card-section>
            <w-card-section class="text-caption">{{ t('admin.api.none') }}</w-card-section>
          </w-card-section>
        </w-card>
      </div>
      <div class="col-span-12" v-else>
        <w-card>
          <w-list separator>
            <w-item v-for="key of state.keys" :key="key.id">
              <w-item-section side>
                <w-icon name="la:key" :color="isUsable(key) ? `positive` : `negative`" />
              </w-item-section>
              <w-item-section>
                <w-item-label>{{ key.name }}</w-item-label>
                <w-item-label caption>{{
                  t('admin.api.keyEndingIn', { suffix: key.keyShort })
                }}</w-item-label>
                <!--
                A personal token (`key.userId` set, task/OpenProject #788) carries exactly its owner's
                own current permissions, resolved live -- there is no fixed `groups` list to name the
                way an admin-issued key's does, so this line names the owner instead.
              -->
                <w-item-label v-if="key.userId" caption>{{
                  t('admin.api.personalTokenOf', { user: ownerName(key) })
                }}</w-item-label>
                <w-item-label v-else caption>{{
                  t('admin.api.permissionsFrom', { groups: groupNames(key) })
                }}</w-item-label>
                <!--
                  A key's actual reach: `null` means unscoped, the same as every key before scoping
                  existed, so that state gets the reassuring "Full Access" wording rather than reading
                  as an empty, broken list.
                -->
                <w-item-label caption>{{
                  key.scope === null
                    ? t('admin.api.newKeyFullAccess')
                    : t('admin.api.scopedTo', { scope: key.scope.join(', ') })
                }}</w-item-label>
                <!--
                  OpenProject #1205: `null` is unrestricted, the same as every key before this
                  existed -- same "no narrowing" treatment as `scope` above, rather than a blank
                  line. An empty array is a distinct, deliberately-reachable state (every level
                  unchecked) and gets its own wording rather than reading as "unrestricted".
                -->
                <template v-if="key.allowedClassifications != null">
                  <w-item-label v-if="key.allowedClassifications.length < 1" caption>{{
                    t('admin.api.limitedToNone')
                  }}</w-item-label>
                  <w-item-label v-else caption>{{
                    t('admin.api.limitedTo', { levels: classificationLevelNames(key) })
                  }}</w-item-label>
                </template>
                <!--
                  Which site the key is pinned to: `null` is instance-wide, the same as every key
                  before site-pinning existed, so it gets the same "All Sites" wording the picker
                  itself uses rather than reading as a missing value.
                -->
                <w-item-label caption>{{
                  t('admin.api.keySite', { site: siteName(key) })
                }}</w-item-label>
                <w-item-label caption>{{
                  t('admin.api.createdOn', { date: humanizeDate(t, key.createdAt) })
                }}</w-item-label>
                <w-item-label caption>
                  <span :style="key.isRevoked ? `text-decoration: line-through;` : ``">{{
                    t('admin.api.expiresOn', { date: humanizeDate(t, key.expiration) })
                  }}</span>
                </w-item-label>
              </w-item-section>
              <!--
                One state, in the order they explain the key best: revoked is what an operator did
                to this key, invalidated is what happened to every key at once, expired is the key
                simply running its course.
              -->
              <w-item-section v-if="keyState(key)" side>
                <div class="flex items-center">
                  <w-icon class="mr-2" color="negative" size="xs" name="la:exclamation-triangle" />
                  <div class="text-caption text-negative">
                    {{ t(`admin.api.${keyState(key)}`) }}
                  </div>
                </div>
                <!-- -> In the row rather than in a tooltip: it is the explanation of the state right
                     above it, and a tooltip here opened over the admin sidebar -->
                <div class="text-caption text-grey mt-1 text-right" style="max-width: 340px">
                  {{ stateHint(key) }}
                </div>
              </w-item-section>
              <w-separator class="ml-4" vertical />
              <w-item-section side style="flex-direction: row; align-items: center">
                <w-btn
                  class="acrylic-btn"
                  :color="key.isRevoked ? `gray` : `red`"
                  icon="la:ban"
                  flat
                  :aria-label="t(`admin.api.revoke`)"
                  @click="revoke(key)"
                  :disabled="key.isRevoked">
                  <w-tooltip v-if="!key.isRevoked" anchor="center left" self="center right">{{
                    t('admin.api.revoke')
                  }}</w-tooltip>
                </w-btn>
              </w-item-section>
            </w-item>
          </w-list>
        </w-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { useAdminSettings } from '@/composables/adminSettings'
import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { dialog } from '@/composables/dialog'

import { useAdminStore } from '@/stores/admin'

import ApiKeyCreateDialog from '../components/ApiKeyCreateDialog.vue'
import ApiKeyRevokeDialog from '../components/ApiKeyRevokeDialog.vue'
import { apiErrorMessage } from '@/helpers/apiError'
import {
  classificationLevelNames as keyClassificationLevelNames,
  isUsable,
  keyState,
  siteName as keySiteName,
  stateHint as keyStateHint
} from '@/helpers/apiKeyState'
import { humanizeDate } from '@/helpers/datetime'

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.api.title')
}))

// DATA

const { state, load, refresh } = useAdminSettings({
  i18nPrefix: 'admin.api',
  // -> Instance-wide, not one site's: no site picker, no reload on switching site
  siteScoped: false,
  extraState: {
    enabled: false,
    isToggleLoading: false,
    keys: [],
    groups: [],
    sites: [],
    users: [],
    classificationLevels: [],
    /** When the signing keypair was generated — what an invalidated key is invalidated by. */
    certificatesGeneratedAt: null
  },
  // -> Groups and sites are fetched alongside the keys so the list can name the permissions and
  //    the site each key carries, the certificate date so an invalidated key can say what
  //    invalidated it, and users so a personal token (`key.userId` set) can name its owner --
  //    `limit: 100` rather than every page: this is a display convenience for naming an owner, not
  //    a picker that has to be complete, and `ownerName()` falls back to the raw ID beyond that.
  fetch: () =>
    Promise.all([
      API_CLIENT.get('api-keys').json(),
      API_CLIENT.get('system/api').json(),
      API_CLIENT.get('groups').json(),
      API_CLIENT.get('sites').json(),
      API_CLIENT.get('system/certificates').json(),
      API_CLIENT.get('users', { searchParams: { limit: 100 } }).json(),
      API_CLIENT.get('classification-levels').json()
    ]),
  onLoaded: ([keys, apiState, groups, sites, certs, usersResp, classificationLevels]) => {
    state.keys = keys ?? []
    state.groups = groups ?? []
    state.sites = sites ?? []
    state.users = usersResp?.users ?? []
    state.classificationLevels = classificationLevels ?? []
    state.enabled = apiState?.isEnabled === true
    state.certificatesGeneratedAt = certs?.generatedAt ?? null
    // -> Keeps the status light in the admin sidebar in step without another round trip
    adminStore.info.isApiEnabled = state.enabled
  }
})

// METHODS

/*
  What a key's row says about itself is shared with the self-service token list
  (`pages/ProfileApi.vue`) -- see `helpers/apiKeyState.js`. Each of these is that helper bound to
  this screen's own vocabulary and to the lists it managed to load.
*/
function stateHint(key) {
  return keyStateHint(key, t, {
    i18nPrefix: 'admin.api',
    certificatesGeneratedAt: state.certificatesGeneratedAt
  })
}

function siteName(key) {
  return keySiteName(key, state.sites, { t, i18nPrefix: 'admin.api' })
}

function classificationLevelNames(key) {
  return keyClassificationLevelNames(key, state.classificationLevels)
}

/** Group names rather than IDs, falling back to the ID for a group that has since been deleted. */
function groupNames(key) {
  return (key.groups ?? [])
    .map((id) => state.groups.find((g) => g.id === id)?.name ?? id)
    .join(', ')
}

/** A personal token's owner, by name -- falling back to the ID for an account since deleted. */
function ownerName(key) {
  return state.users.find((u) => u.id === key.userId)?.name ?? key.userId
}

async function globalSwitch() {
  state.isToggleLoading = true
  const wanted = !state.enabled
  try {
    await API_CLIENT.put('system/api', {
      json: { isEnabled: wanted }
    }).json()
    notify({
      type: 'positive',
      message: wanted
        ? t('admin.api.toggleStateEnabledSuccess')
        : t('admin.api.toggleStateDisabledSuccess')
    })
    await load()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.api.toggleStateFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.isToggleLoading = false
}

async function newKey() {
  dialog({
    component: ApiKeyCreateDialog
  }).onOk(() => {
    load()
  })
}

function revoke(key) {
  dialog({
    component: ApiKeyRevokeDialog,
    componentProps: {
      apiKey: key
    }
  }).onOk(() => {
    load()
  })
}
</script>

<style lang="scss"></style>
