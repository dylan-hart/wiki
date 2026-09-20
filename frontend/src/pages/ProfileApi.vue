<template>
  <w-page class="profile-api">
    <h1 class="w-section-header">{{ t('profile.api.title') }}</h1>
    <div class="p-4 pb-0">
      <div class="text-body2 text-grey">{{ t('profile.api.subtitle') }}</div>
    </div>
    <div class="actions-bar">
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
    <w-separator inset />
    <div class="p-4">
      <!--
        Three branches, not two: with the initial fetch still in flight and no keys yet, neither
        card renders -- only the `w-inner-loading` overlay below. A loading guard on the empty-state
        `v-if` alone would fall through to the tokens card for that whole window, flashing its
        header before the real state is known. A refresh of an already-populated list stays on the
        final branch throughout, so it flickers nothing of its own.
      -->
      <div v-if="state.loading > 0 && state.keys.length < 1" />
      <div v-else-if="state.keys.length < 1">
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
        ROW alone. An unusable token says so on the plate's indicator dot and in its hint, where the
        eye already is, rather than in a third column of its own.
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
              A personal token's reach is always the holder's own current permissions, so there is
              no "permissions from group X" line here as in the admin listing -- only the scope it
              has been narrowed by.
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

const dark = useDark()

const { t } = useI18n()

useMeta(() => ({
  title: t('profile.api.title')
}))

const state = reactive({
  loading: 0,
  keys: [],
  sites: [],
  classificationLevels: [],
  /** What an invalidated token was invalidated by: the signing keypair's generation. */
  certificatesGeneratedAt: null
})

/*
  `helpers/apiKeyState.js` holds what a token's row says about itself, shared with the admin key
  list; each of these binds it to this screen's vocabulary and to the lists it managed to load.
*/
function stateHint(key) {
  // -> A self-service reader cannot read `certificatesGeneratedAt`, so this line's date falls back
  //    to `---` rather than the hint being withheld.
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
  // -> Separately from the token list and best-effort: `GET /sites` needs `read:sites`/
  //    `access:admin`, which most of this page's audience does not hold. It only *names* the site a
  //    token is pinned to, and `siteName()` falls back to the raw `siteId`, so a failure here
  //    degrades the display rather than taking the token list down with it.
  try {
    state.sites = (await API_CLIENT.get('sites').json()) ?? []
  } catch {
    state.sites = []
  }
  // -> Needs no permission, so it should always succeed; still soft, falling back to bare ids.
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

onMounted(load)
</script>

<style></style>
