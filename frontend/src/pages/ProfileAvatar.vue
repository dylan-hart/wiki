<template>
  <w-page>
    <h1 class="w-section-header">{{ t('profile.avatar') }}</h1>
    <div class="p-4">
      <!--
        The image goes in the row's own `preview` slot, which spans the full width under both
        halves -- the stacked shape WSettingsRow already draws, not a second variant.
      -->
      <w-settings-card :title="t('profile.avatar')">
        <w-settings-row
          control-width="auto"
          icon="tabler:user-circle"
          :label="t(`profile.avatarUploadTitle`)"
          :hint="t(`profile.avatarUploadHint`)">
          <div v-if="canEdit" class="flex gap-2">
            <w-btn
              icon="tabler:upload"
              :label="t(`profile.uploadNewAvatar`)"
              color="primary"
              text-color="white"
              @click="uploadImage" />
            <w-btn
              icon="tabler:x"
              outline
              :label="t(`common.actions.clear`)"
              color="primary"
              :disabled="!userStore.hasAvatar"
              @click="clearImage" />
          </div>
          <!-- -> Why the buttons are absent, in their place rather than as a silent omission -->
          <div v-else class="text-caption text-negative">
            {{ t('profile.avatarUploadDisabled') }}
          </div>
          <template #preview>
            <div class="text-center">
              <w-avatar
                class="profile-avatar-circ"
                size="180px"
                :color="showsImage ? `dark-1` : `primary`"
                text-color="white"
                :class="showsImage ? `is-image` : ``">
                <img
                  v-if="userStore.hasAvatar"
                  :src="`/_user/current/avatar?` + state.assetTimestamp"
                  :alt="userStore.name" />
                <!--
                  -> A manual upload always wins; the provider-synced picture is only a fallback,
                     and has no "clear" of its own -- this page's routes never stored it, login
                     merely cached it.
                -->
                <img
                  v-else-if="userStore.avatarProviderUrl"
                  :src="userStore.avatarProviderUrl"
                  :alt="userStore.name" />
                <w-icon v-else name="tabler:user" />
              </w-avatar>
            </div>
          </template>
        </w-settings-row>
      </w-settings-card>
    </div>

    <w-inner-loading :showing="state.loading > 0" />
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { profileSaving } from '@/composables/profileSaving'
import { apiErrorMessage } from '@/helpers/apiError'
import { computed, reactive } from 'vue'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('profile.avatar')
}))

const state = reactive({
  loading: 0,
  assetTimestamp: new Date().toISOString()
})

/** Mirrors what the upload endpoint accepts. */
const acceptedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

const canEdit = computed(() => siteStore.features?.profile)
const showsImage = computed(() => userStore.hasAvatar || Boolean(userStore.avatarProviderUrl))

async function uploadImage() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = acceptedTypes.join(',')

  input.onchange = async (e) => {
    const file = e.target.files?.[0]
    if (!file) {
      return
    }
    // -> The picker's filter is a suggestion the user can override; saying so here beats the
    //    server's own 415 with nothing to explain it.
    if (!acceptedTypes.includes(file.type)) {
      notify({
        type: 'negative',
        message: t('profile.avatarUploadFailed'),
        caption: t('profile.avatarUploadInvalidType')
      })
      return
    }
    state.loading++
    // -> Counted separately from `state.loading`, which is local to this section and lost the
    //    moment the reader switches away from it.
    profileSaving.begin()
    try {
      // -> The endpoint takes the raw file as the request body, not a form.
      await API_CLIENT.put('users/profile/avatar', {
        body: file,
        headers: {
          'content-type': file.type
        }
      }).json()
      notify({
        type: 'positive',
        message: t('profile.avatarUploadSuccess')
      })
      state.assetTimestamp = new Date().toISOString()
      userStore.$patch({
        hasAvatar: true
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('profile.avatarUploadFailed'),
        caption: apiErrorMessage(err, t('common.error.unexpected'))
      })
    }
    state.loading--
    profileSaving.end()
  }

  input.click()
}

async function clearImage() {
  state.loading++
  profileSaving.begin()
  try {
    await API_CLIENT.delete('users/profile/avatar').json()
    notify({
      type: 'positive',
      message: t('profile.avatarClearSuccess')
    })
    state.assetTimestamp = new Date().toISOString()
    userStore.$patch({
      hasAvatar: false
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('profile.avatarClearFailed'),
      caption: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
  state.loading--
  profileSaving.end()
}
</script>

<style>
.profile-avatar-circ {
  box-shadow:
    2px 2px 15px -5px var(--color-primary),
    -2px -2px 15px -5px var(--color-primary),
    inset 0 0 2px 8px rgba(255, 255, 255, 0.15);

  &.is-image {
    box-shadow: 0 0 0 5px rgba(0, 0, 0, 0.1);
  }
}
</style>
