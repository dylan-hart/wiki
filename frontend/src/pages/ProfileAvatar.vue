<template>
  <w-page>
    <h1 class="w-section-header">{{ t('profile.avatar') }}</h1>
    <div class="p-4">
      <!--
        The same stacked shape AdminGeneral's logo and favicon rows use -- the pair of buttons at the
        trailing edge and the image itself in the row's `preview` slot, which spans the full width
        under both halves. Not a second stacked variant: this is the one WSettingsRow already draws.
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
                :color="userStore.hasAvatar ? `dark-1` : `primary`"
                text-color="white"
                :class="userStore.hasAvatar ? `is-image` : ``">
                <img
                  v-if="userStore.hasAvatar"
                  :src="`/_user/current/avatar?` + state.assetTimestamp"
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
import { apiErrorMessage } from '@/helpers/apiError'
import { computed, reactive } from 'vue'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

// STORES

const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('profile.avatar')
}))

// DATA

const state = reactive({
  loading: 0,
  assetTimestamp: new Date().toISOString()
})

/** What the upload endpoint accepts. */
const acceptedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

const canEdit = computed(() => siteStore.features?.profile)

// METHODS

async function uploadImage() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = acceptedTypes.join(',')

  input.onchange = async (e) => {
    const file = e.target.files?.[0]
    if (!file) {
      return
    }
    // -> The file picker's filter is a suggestion the user can override, and the server checks the
    //    bytes anyway; saying so here beats a 415 with nothing to explain it
    if (!acceptedTypes.includes(file.type)) {
      notify({
        type: 'negative',
        message: t('profile.avatarUploadFailed'),
        caption: t('profile.avatarUploadInvalidType')
      })
      return
    }
    state.loading++
    try {
      // -> The image is the request body itself: the endpoint takes the raw file, not a form
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
  }

  input.click()
}

async function clearImage() {
  state.loading++
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
}
</script>

<style lang="scss">
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
