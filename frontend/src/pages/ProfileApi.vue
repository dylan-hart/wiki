<template>
  <w-page class="py-4 profile-api">
    <div class="flex items-center p-4">
      <div class="min-w-0 flex-1">
        <div class="w-section-header">{{ t('profile.api.title') }}</div>
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
              <w-item-label caption>{{
                t('profile.api.keySite', { site: siteName(key) })
              }}</w-item-label>
              <w-item-label caption>{{
                t('profile.api.createdOn', { date: humanizeDate(key.createdAt) })
              }}</w-item-label>
              <w-item-label caption>
                <span :style="key.isRevoked ? `text-decoration: line-through;` : ``">{{
                  t('profile.api.expiresOn', { date: humanizeDate(key.expiration) })
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
                :disable="key.isRevoked">
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

// COMPOSABLES

const dark = useDark()

// I18N

const { t } = useI18n()

// META

useMeta({
  title: t('profile.api.title')
})

// DATA

const state = reactive({
  loading: 0,
  keys: [],
  sites: [],
  /** When the signing keypair was generated -- what an invalidated token is invalidated by. */
  certificatesGeneratedAt: null
})

// METHODS

function humanizeDate(val) {
  if (!val) {
    return '---'
  }
  return Temporal.Instant.from(val).toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  })
}

/** A token past its expiration still authenticates nothing, even though it was never revoked. */
function isExpired(key) {
  return (
    Temporal.Instant.compare(Temporal.Instant.from(key.expiration), Temporal.Now.instant()) <= 0
  )
}

/** Why a token does not work, or null when it does -- same ordering as `AdminApi.vue`'s `keyState`. */
function keyState(key) {
  if (key.isRevoked) {
    return 'revoked'
  }
  if (key.isInvalidated) {
    return 'invalidated'
  }
  return isExpired(key) ? 'expired' : null
}

/** The sentence under a token's state: what it means, and what to do about it. */
function stateHint(key) {
  const status = keyState(key)
  if (!status) {
    return ''
  }
  return status === 'invalidated'
    ? t('profile.api.invalidatedHint', { date: humanizeDate(state.certificatesGeneratedAt) })
    : t(`profile.api.${status}Hint`)
}

function isUsable(key) {
  return keyState(key) === null
}

/**
 * The site a token is pinned to, by title -- `null` is instance-wide ("All Sites"), and a site that
 * has since been deleted falls back to its ID, same as `AdminApi.vue`'s `siteName`.
 */
function siteName(key) {
  if (key.siteId === null) {
    return t('profile.api.newKeySiteAllSites')
  }
  return state.sites.find((s) => s.id === key.siteId)?.title ?? key.siteId
}

async function load() {
  state.loading++
  try {
    // -> Sites are fetched alongside the tokens so the list can name the site each one is pinned to.
    //    Certificates: the endpoint the admin area uses (`system/certificates`) needs `manage:system`,
    //    which a regular user does not hold -- `isInvalidated` (from the list response itself) is
    //    enough to show the badge; only the exact regeneration date in the hint is unavailable here,
    //    so `stateHint` falls back to `---` via `humanizeDate(null)` for that one line.
    const [keys, sites] = await Promise.all([
      API_CLIENT.get('users/profile/api-keys').json(),
      API_CLIENT.get('sites').json()
    ])
    state.keys = keys ?? []
    state.sites = sites ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('profile.api.loadFailed'),
      caption: apiErrorMessage(err)
    })
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
