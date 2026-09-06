<template>
  <w-page class="py-4 profile-api">
    <div class="flex items-center p-4">
      <div class="min-w-0 flex-1">
        <h1 class="w-section-header">{{ t('profile.api.title') }}</h1>
        <div class="text-body2 text-grey">{{ t('profile.api.subtitle') }}</div>
      </div>
      <div class="flex-none">
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
          icon="tabler:plus"
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
          :class="dark.isActive ? `bg-dark-5 text-white` : `bg-grey-3 text-dark`">
          <w-card-section class="items-center" horizontal>
            <w-card-section class="flex-none pe-0">
              <w-icon name="tabler:info-circle" size="sm" />
            </w-card-section>
            <w-card-section class="text-caption">{{ t('profile.api.none') }}</w-card-section>
          </w-card-section>
        </w-card>
      </div>
      <!--
        A list of tokens rather than a settings form, so what the settings pattern lends it is the
        ROW -- the 34px plate, the name over everything the token says about itself, the one action
        at the trailing edge. What used to be a separate `side` section for an unusable token's
        warning is now the plate's own indicator dot plus a line in the hint: a token that cannot be
        used says so where the eye already is rather than in a third column.

        The broader question of what the pattern means for the app's other list and viewer pages is
        Task #2702's, not this one's.
      -->
      <w-settings-card v-else :title="t('profile.api.listTitle')">
        <w-settings-row
          v-for="key of state.keys"
          :key="key.id"
          control-width="auto"
          icon="tabler:key"
          :indicator="isUsable(key) ? null : `negative`"
          :indicator-text="keyState(key) ? t(`profile.api.${keyState(key)}`) : null"
          :label="key.name">
          <template #hint>
            <div>{{ t('profile.api.keyEndingIn', { suffix: key.keyShort }) }}</div>
            <!--
              A personal token's reach is always the holder's own current permissions -- there is no
              "permissions from group X" line the admin listing shows, only whether it has been
              narrowed by a scope.
            -->
            <div>
              {{
                key.scope === null
                  ? t('profile.api.newKeyFullAccess')
                  : t('profile.api.scopedTo', { scope: key.scope.join(', ') })
              }}
            </div>
            <template v-if="key.allowedClassifications != null">
              <div v-if="key.allowedClassifications.length < 1">
                {{ t('profile.api.limitedToNone') }}
              </div>
              <div v-else>
                {{ t('profile.api.limitedTo', { levels: classificationLevelNames(key) }) }}
              </div>
            </template>
            <div>{{ t('profile.api.keySite', { site: siteName(key) }) }}</div>
            <div>{{ t('profile.api.createdOn', { date: humanizeDate(t, key.createdAt) }) }}</div>
            <div>
              <span :style="key.isRevoked ? `text-decoration: line-through;` : ``">{{
                t('profile.api.expiresOn', { date: humanizeDate(t, key.expiration) })
              }}</span>
            </div>
            <div v-if="keyState(key)" class="text-negative mt-1 flex items-center">
              <w-icon class="me-2" size="xs" name="tabler:alert-triangle" />
              <span>{{ t(`profile.api.${keyState(key)}`) }} &mdash; {{ stateHint(key) }}</span>
            </div>
          </template>
          <w-btn
            class="acrylic-btn"
            :color="key.isRevoked ? `gray` : `red`"
            icon="tabler:ban"
            flat
            :aria-label="t(`profile.api.revoke`)"
            @click="revoke(key)"
            :disabled="key.isRevoked">
            <w-tooltip v-if="!key.isRevoked" anchor="center left" self="center right">{{
              t('profile.api.revoke')
            }}</w-tooltip>
          </w-btn>
        </w-settings-row>
      </w-settings-card>
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
