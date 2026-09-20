<template>
  <w-menu
    class="translucent-menu"
    anchor="bottom right"
    self="top right"
    :offset="[0, 10]"
    ref="menuRef">
    <w-card style="width: 850px; max-width: 95vw">
      <w-card-section class="card-header">
        <w-icon name="tabler:eye" left size="sm" />
        <span>{{ t(`admin.users.profileVisibility`) }}</span>
      </w-card-section>
      <w-list padding>
        <w-item>
          <blueprint-icon icon="tabler:user" />
          <w-item-section>
            <w-item-label>{{ t(`admin.users.profileVisibilityForced`) }}</w-item-label>
            <w-item-label caption>{{ t(`admin.users.profileVisibilityForcedHint`) }}</w-item-label>
          </w-item-section>
          <w-item-section>
            <w-select
              v-model="state.forcedPublicFields"
              :options="fieldOptions"
              multiple
              map-options
              emit-value
              dense
              options-dense
              :disabled="!state.loaded"
              :aria-label="t(`admin.users.profileVisibilityForced`)" />
          </w-item-section>
        </w-item>
        <w-separator class="my-2" inset />
        <w-item tag="label">
          <blueprint-icon icon="tabler:eye" />
          <w-item-section>
            <w-item-label>{{ t(`admin.users.profileVisibilityGuests`) }}</w-item-label>
            <w-item-label caption>{{ t(`admin.users.profileVisibilityGuestsHint`) }}</w-item-label>
          </w-item-section>
          <w-item-section class="flex-none">
            <w-toggle
              v-model="state.guestsMayView"
              :disabled="!state.loaded"
              :aria-label="t(`admin.users.profileVisibilityGuests`)" />
          </w-item-section>
        </w-item>
      </w-list>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`common.actions.cancel`)"
          color="grey"
          padding="xs md"
          @click="menuRef.hide()" />
        <w-btn
          :label="t(`common.actions.save`)"
          color="primary"
          padding="xs md"
          :disabled="!state.loaded"
          @click="save" />
      </w-card-actions>
      <w-inner-loading :showing="state.loading > 0" />
    </w-card>
  </w-menu>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, ref } from 'vue'

import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

const { t } = useI18n()

const state = reactive({
  loading: 0,
  loaded: false,
  forcedPublicFields: [],
  guestsMayView: false
})

const menuRef = ref(null)

const fieldOptions = computed(() => [
  { value: 'location', label: t('profile.location') },
  { value: 'jobTitle', label: t('profile.jobTitle') },
  { value: 'pronouns', label: t('profile.pronouns') }
])

async function save() {
  if (!state.loaded) {
    return
  }
  state.loading++
  try {
    await API_CLIENT.put('users/profile-visibility', {
      json: {
        forcedPublicFields: state.forcedPublicFields,
        guestsMayView: state.guestsMayView
      }
    }).json()
    notify({
      type: 'positive',
      message: t('admin.users.profileVisibilitySaveSuccess')
    })
    menuRef.value?.hide()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.users.profileVisibilitySaveFailed'),
      caption: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
  state.loading--
}

onMounted(async () => {
  state.loading++
  try {
    const resp = await API_CLIENT.get('users/profile-visibility').json()
    state.forcedPublicFields = resp?.forcedPublicFields ?? []
    state.guestsMayView = resp?.guestsMayView === true
    state.loaded = true
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.users.profileVisibilityLoadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
})
</script>
