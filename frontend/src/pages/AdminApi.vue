<template>
  <w-page class="admin-api">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:api" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.api.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.api.subtitle') }}
        </div>
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center">
          <template v-if="state.enabled">
            <w-signal class="me-2" color="green" size="md" />
            <div class="text-caption text-green">{{ t('admin.api.enabled') }}</div>
          </template>
          <template v-else>
            <w-signal class="me-2" color="red" size="md" />
            <div class="text-caption text-red">{{ t('admin.api.disabled') }}</div>
          </template>
        </div>
      </div>
      <div class="flex-none">
        <!-- -> A real href, not a router link: the Swagger UI at `/_api` is served by the backend,
             not by this SPA. Its visible label is already the accessible name, hence no
             `aria-label` -->
        <w-btn
          class="acrylic-btn me-2 ms-4"
          icon="tabler:book"
          flat
          color="grey"
          :label="t(`admin.api.docsButton`)"
          href="/_api"
          target="_blank" />
        <w-btn
          class="acrylic-btn me-2"
          icon="tabler:refresh"
          flat
          color="slate"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="refresh">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2"
          icon="tabler:power"
          :label="!state.enabled ? t(`admin.api.enableButton`) : t(`admin.api.disableButton`)"
          :color="!state.enabled ? `positive` : `negative`"
          @click="globalSwitch"
          :loading="state.isToggleLoading"
          :disabled="state.loading > 0" />
        <w-btn
          icon="tabler:plus"
          :label="t(`admin.api.newKeyButton`)"
          color="primary"
          @click="newKey"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <div class="grid grid-cols-12 p-4 gap-4">
      <!--
        An admin-issued key here has no bearing on MCP page-authorship attribution -- that is a
        personal token, minted from the reader's own Profile. Shown unconditionally rather than
        gated on `state.keys.length`, since the confusion applies whether or not admin keys exist.
      -->
      <div class="col-span-12">
        <w-card class="rounded bg-warning-fill text-ink">
          <w-card-section class="items-center" horizontal>
            <w-card-section class="flex-none pe-0">
              <w-icon name="tabler:alert-triangle" size="sm" />
            </w-card-section>
            <w-card-section class="text-caption">
              <i18n-t tag="span" keypath="admin.api.personalTokenNote" scope="global">
                <template #link>
                  <button
                    type="button"
                    class="cursor-pointer border-0 bg-transparent p-0 text-primary"
                    @click="openProfileApi">
                    {{ t('admin.api.personalTokenNoteLink') }}
                  </button>
                </template>
              </i18n-t>
            </w-card-section>
          </w-card-section>
        </w-card>
      </div>
      <div class="col-span-12" v-if="state.keys.length < 1">
        <w-card
          class="rounded"
          :class="dark.isActive ? `bg-dark-5 text-white` : `bg-grey-3 text-dark`">
          <w-card-section class="items-center" horizontal>
            <w-card-section class="flex-none pe-0">
              <w-icon name="tabler:info-circle" size="sm" />
            </w-card-section>
            <w-card-section class="text-caption">{{ t('admin.api.none') }}</w-card-section>
          </w-card-section>
        </w-card>
      </div>
      <div class="col-span-12" v-else>
        <w-settings-card :title="t('admin.api.title')">
          <!--
            An unusable key is marked by the plate's own dot rather than by a red glyph: the plate
            is chrome, and a green key beside a red key reads as two different kinds of thing.
          -->
          <w-settings-row
            v-for="key of state.keys"
            :key="key.id"
            control-width="auto"
            icon="tabler:key"
            :indicator="isUsable(key) ? null : `negative`"
            :indicator-text="keyState(key) ? t(`admin.api.${keyState(key)}`) : null"
            :label="key.name">
            <template #hint>
              <div>{{ t('admin.api.keyEndingIn', { suffix: key.keyShort }) }}</div>
              <!--
                A personal token carries its owner's own permissions, resolved live -- there is no
                fixed `groups` list to name the way an admin-issued key has, so this names the
                owner instead.
              -->
              <div v-if="key.userId">
                {{ t('admin.api.personalTokenOf', { user: ownerName(key) }) }}
              </div>
              <div v-else>{{ t('admin.api.permissionsFrom', { groups: groupNames(key) }) }}</div>
              <!-- -> A `null` scope is unscoped, not an empty list: hence "Full Access" wording -->
              <div>
                {{
                  key.scope === null
                    ? t('admin.api.newKeyFullAccess')
                    : t('admin.api.scopedTo', { scope: key.scope.join(', ') })
                }}
              </div>
              <!--
                `null` is unrestricted; an empty array is a distinct, deliberately-reachable state
                (every level unchecked) and gets its own wording rather than reading the same way.
              -->
              <template v-if="key.allowedClassifications != null">
                <div v-if="key.allowedClassifications.length < 1">
                  {{ t('admin.api.limitedToNone') }}
                </div>
                <div v-else>
                  {{ t('admin.api.limitedTo', { levels: classificationLevelNames(key) }) }}
                </div>
              </template>
              <!-- -> A `null` site is instance-wide, worded as the picker's own "All Sites" -->
              <div>{{ t('admin.api.keySite', { site: siteName(key) }) }}</div>
              <div>{{ t('admin.api.createdOn', { date: humanizeDate(t, key.createdAt) }) }}</div>
              <div>
                <span :style="key.isRevoked ? `text-decoration: line-through;` : ``">{{
                  t('admin.api.expiresOn', { date: humanizeDate(t, key.expiration) })
                }}</span>
              </div>
            </template>
            <div class="flex items-center gap-2">
              <div v-if="keyState(key)">
                <div class="flex items-center">
                  <w-icon class="me-2" color="negative" size="xs" name="tabler:alert-triangle" />
                  <div class="text-caption text-negative">
                    {{ t(`admin.api.${keyState(key)}`) }}
                  </div>
                </div>
                <!-- -> In the row, not a tooltip: a tooltip here opens over the admin sidebar -->
                <div class="text-caption text-grey mt-1 text-right" style="max-width: 340px">
                  {{ stateHint(key) }}
                </div>
              </div>
              <w-separator vertical />
              <w-btn
                class="acrylic-btn"
                :color="key.isRevoked ? `gray` : `red`"
                icon="tabler:ban"
                flat
                :aria-label="t(`admin.api.revoke`)"
                @click="revoke(key)"
                :disabled="key.isRevoked">
                <w-tooltip v-if="!key.isRevoked" anchor="center left" self="center right">{{
                  t('admin.api.revoke')
                }}</w-tooltip>
              </w-btn>
            </div>
          </w-settings-row>
        </w-settings-card>
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
import { useSiteStore } from '@/stores/site'

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
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const dark = useDark()

const adminStore = useAdminStore()
const siteStore = useSiteStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.api.title')
}))

const { state, load, refresh } = useAdminSettings({
  i18nPrefix: 'admin.api',
  siteScoped: false,
  extraState: {
    enabled: false,
    isToggleLoading: false,
    keys: [],
    groups: [],
    sites: [],
    users: [],
    classificationLevels: [],
    /** What an invalidated key is invalidated by. */
    certificatesGeneratedAt: null
  },
  // -> `limit: 100` rather than every page: naming a token's owner is a display convenience, not a
  //    picker that has to be complete, and `ownerName()` falls back to the raw ID beyond that.
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
    // -> Keeps the admin sidebar's status light in step without another round trip
    adminStore.info.isApiEnabled = state.enabled
  }
})

function openProfileApi() {
  siteStore.openOverlay('Profile', { section: 'api' })
}

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

/** Falls back to the raw ID for a group that has since been deleted. */
function groupNames(key) {
  return (key.groups ?? [])
    .map((id) => state.groups.find((g) => g.id === id)?.name ?? id)
    .join(', ')
}

/** Falls back to the raw ID for a deleted account, or one beyond the fetched page of users. */
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

<style></style>
