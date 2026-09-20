<template>
  <w-dialog
    v-model="dialogVisible"
    max-width="450px"
    :aria-label="t(`admin.system.checkingForUpdates`)"
    @hide="onDialogHide">
    <w-card style="min-width: 350px">
      <w-card-section class="card-header">
        <w-icon name="tabler:refresh-alert" size="sm" class="me-2" />
        <span>{{ t(`admin.system.checkingForUpdates`) }}</span>
      </w-card-section>
      <w-card-section>
        <div class="p-4 text-center">
          <img
            src="/_assets/illustrations/undraw_going_up.svg"
            class="mx-auto"
            style="width: 150px"
            alt="" />
        </div>
        <template v-if="state.isLoading">
          <w-linear-progress indeterminate size="lg" rounded />
          <div class="mt-2 text-center text-caption">
            {{ $t('admin.system.fetchingLatestVersionInfo') }}
          </div>
        </template>
        <template v-else>
          <div class="text-center">
            <strong v-if="status === 'offline'" class="text-grey" data-test="update-offline">{{
              $t('admin.system.updateCheckOffline')
            }}</strong>
            <strong v-else-if="status === 'unknown'" class="text-grey" data-test="update-unknown">{{
              $t('admin.system.updateCheckUnavailable')
            }}</strong>
            <strong
              v-else-if="status === 'latest'"
              class="text-positive"
              data-test="update-latest"
              >{{ $t('admin.system.runningLatestVersion') }}</strong
            >
            <strong v-else class="text-pink" data-test="update-available">{{
              $t('admin.system.newVersionAvailable')
            }}</strong>
            <div class="text-body2 mt-4">
              Current: <strong>{{ state.current }}</strong>
            </div>
            <template v-if="status === 'latest' || status === 'outdated'">
              <div class="text-body2">
                Latest: <strong>{{ state.latest }}</strong>
              </div>
              <div class="text-body2">
                Release Date: <strong>{{ state.latestDate }}</strong>
              </div>
            </template>
          </div>
        </template>
      </w-card-section>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="state.isLoading ? t(`common.actions.cancel`) : t(`common.actions.close`)"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import semverGte from 'semver/functions/gte'
import semverValid from 'semver/functions/valid'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { computed, onMounted, reactive } from 'vue'

import { useUserStore } from '@/stores/user'

import { apiErrorMessage } from '@/helpers/apiError'

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const userStore = useUserStore()

const { t } = useI18n()

const state = reactive({
  isLoading: false,
  offline: false,
  current: '',
  latest: '',
  latestDate: ''
})

// FIXME: hardcoded, so the dialog always reports the instance as up to date and `state.canUpgrade`
//        never flips -- compare `state.current` against `state.latest` once the check returns.
const status = computed(() => {
  if (state.offline) {
    return 'offline'
  }
  if (!semverValid(state.current) || !semverValid(state.latest)) {
    return 'unknown'
  }
  return semverGte(state.current, state.latest) ? 'latest' : 'outdated'
})

async function check() {
  state.isLoading = true
  try {
    const resp = await API_CLIENT.post('system/checkForUpdate').json()
    if (resp?.current) {
      state.current = resp.current
      state.latest = resp.latest ?? ''
      state.offline = resp.offline === true
      state.latestDate = resp.latestDate ? userStore.formatDate(resp.latestDate) : ''
    } else {
      throw new Error(resp?.message || t('common.error.unexpected'))
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
    onDialogCancel()
  }
  state.isLoading = false
}

onMounted(() => {
  check()
})
</script>
