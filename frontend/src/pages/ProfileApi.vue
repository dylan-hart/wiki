<template>
  <w-page class="py-4 profile-api">
    <div class="flex items-center p-4">
      <div class="min-w-0 flex-1">
        <h1 class="w-section-header">{{ t('profile.api.title') }}</h1>
        <div class="text-body2 text-grey">{{ t('profile.api.subtitle') }}</div>
      </div>
      <div class="flex-none">
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
          unelevated
          icon="la:plus"
          :label="t(`profile.api.newKeyButton`)"
          color="primary"
          @click="newKey"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <div class="p-4">
      <div v-if="state.keys.length < 1 && state.loading < 1">
        <w-card
          class="rounded"
          flat
          :class="dark.isActive ? `bg-dark-5 text-white` : `bg-grey-3 text-dark`">
          <w-card-section class="items-center" horizontal>
            <w-card-section class="flex-none pr-0">
              <w-icon name="la:info-circle" size="sm" />
            </w-card-section>
            <w-card-section class="text-caption">{{ t('profile.api.none') }}</w-card-section>
          </w-card-section>
        </w-card>
      </div>
      <w-card v-else>
        <w-list separator>
          <w-item v-for="key of state.keys" :key="key.id">
            <w-item-section side>
              <w-icon name="la:key" :color="isUsable(key) ? `positive` : `negative`" />
            </w-item-section>
            <w-item-section>
              <w-item-label>{{ key.name }}</w-item-label>
              <w-item-label caption>{{
                t('profile.api.keyEndingIn', { suffix: key.keyShort })
              }}</w-item-label>
              <!--
                A personal token's reach is always the holder's own current permissions -- there is no
                "permissions from group X" line the admin listing shows, only whether it has been
                narrowed by a scope.
              -->
              <w-item-label caption>{{
                key.scope === null
                  ? t('profile.api.newKeyFullAccess')
                  : t('profile.api.scopedTo', { scope: key.scope.join(', ') })
              }}</w-item-label>
              <template v-if="key.allowedClassifications != null">
                <w-item-label v-if="key.allowedClassifications.length < 1" caption>{{
                  t('profile.api.limitedToNone')
                }}</w-item-label>
                <w-item-label v-else caption>{{
                  t('profile.api.limitedTo', { levels: classificationLevelNames(key) })
                }}</w-item-label>
              </template>
              <w-item-label caption>{{
                t('profile.api.keySite', { site: siteName(key) })
              }}</w-item-label>
              <w-item-label caption>{{
                t('profile.api.createdOn', { date: humanizeDate(t, key.createdAt) })
              }}</w-item-label>
              <w-item-label caption>
                <span :style="key.isRevoked ? `text-decoration: line-through;` : ``">{{
                  t('profile.api.expiresOn', { date: humanizeDate(t, key.expiration) })
                }}</span>
              </w-item-label>
            </w-item-section>
            <w-item-section v-if="keyState(key)" side>
              <div class="flex items-center">
                <w-icon class="mr-2" color="negative" size="xs" name="la:exclamation-triangle" />
                <div class="text-caption text-negative">
                  {{ t(`profile.api.${keyState(key)}`) }}
                </div>
              </div>
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
                :aria-label="t(`profile.api.revoke`)"
                @click="revoke(key)"
                :disabled="key.isRevoked">
                <w-tooltip v-if="!key.isRevoked" anchor="center left" self="center right">{{
                  t('profile.api.revoke')
                }}</w-tooltip>
              </w-btn>
            </w-item-section>
          </w-item>
        </w-list>
      </w-card>
    </div>

    <w-inner-loading :showing="state.loading > 0" />
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { onMounted, reactive } from 'vue'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { dialog } from '@/composables/dialog'

import ProfileApiKeyCreateDialog from '../components/ProfileApiKeyCreateDialog.vue'
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

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('profile.api.title')
}))

// DATA

const state = reactive({
  loading: 0,
  keys: [],
  sites: [],
  classificationLevels: [],
  /** When the signing keypair was generated -- what an invalidated token is invalidated by. */
  certificatesGeneratedAt: null
})

// METHODS

/*
  What a token's row says about itself is shared with the admin key list (`pages/AdminApi.vue`) --
  see `helpers/apiKeyState.js`. Each of these is that helper bound to this screen's own vocabulary
  (a personal token, not an admin's API key) and to the lists it managed to load.
*/
function stateHint(key) {
  // -> `certificatesGeneratedAt` is unavailable to a self-service reader (see `load()` below), so
  //    the date in this one line falls back to `---` rather than the hint being withheld
  return keyStateHint(key, t, {
    i18nPrefix: 'profile.api',
    certificatesGeneratedAt: state.certificatesGeneratedAt
  })
}

function siteName(key) {
  return keySiteName(key, state.sites, { t, i18nPrefix: 'profile.api' })
}

function classificationLevelNames(key) {
  return keyClassificationLevelNames(key, state.classificationLevels)
}

async function load() {
  state.loading++
  try {
    state.keys = (await API_CLIENT.get('users/profile/api-keys').json()) ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('profile.api.loadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  // -> Sites are fetched separately from the token list, on a best-effort basis: `GET /sites` needs
  //    `read:sites`/`access:admin`, which an ordinary self-service user does not hold, so this call
  //    fails for most of this page's actual audience. It's fetched only to *name* the site a token is
  //    pinned to -- `siteName()` already falls back to the raw `siteId` when a site can't be found in
  //    `state.sites`, so a failure here should degrade the display, not take down the token list
  //    itself. See also `ProfileApiKeyCreateDialog.vue`'s `loadSites()`, which has the same shape.
  //    Certificates: the endpoint the admin area uses (`system/certificates`) needs `manage:system`,
  //    which a regular user does not hold -- `isInvalidated` (from the list response itself) is
  //    enough to show the badge; only the exact regeneration date in the hint is unavailable here,
  //    so `stateHint` falls back to `---` via `humanizeDate(t, null)` for that one line.
  try {
    state.sites = (await API_CLIENT.get('sites').json()) ?? []
  } catch {
    state.sites = []
  }
  // -> Public-access (needs no permission), so this one is not wrapped in the same "degrade
  //    silently" reasoning as `sites` above -- it should always succeed, but still fails soft into
  //    `classificationLevelName()`'s own id fallback rather than take down the token list.
  try {
    state.classificationLevels = (await API_CLIENT.get('classification-levels').json()) ?? []
  } catch {
    state.classificationLevels = []
  }
  state.loading--
}

async function refresh() {
  await load()
  notify({
    type: 'positive',
    message: t('profile.api.refreshSuccess')
  })
}

function newKey() {
  dialog({
    component: ProfileApiKeyCreateDialog
  }).onOk(() => {
    load()
  })
}

function revoke(key) {
  dialog({
    component: ApiKeyRevokeDialog,
    componentProps: {
      apiKey: key,
      endpoint: 'users/profile/api-keys',
      labelPrefix: 'profile.api'
    }
  }).onOk(() => {
    load()
  })
}

// MOUNTED

onMounted(load)
</script>

<style lang="scss"></style>
