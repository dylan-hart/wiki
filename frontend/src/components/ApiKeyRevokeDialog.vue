<template>
  <w-dialog
    v-model="dialogVisible"
    max-width="450px"
    :aria-label="t(`${labelPrefix}.revokeConfirm`)"
    @hide="onDialogHide">
    <w-card style="min-width: 350px">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-unavailable.svg" size="sm" class="me-2" />
        <span>{{ t(`${labelPrefix}.revokeConfirm`) }}</span>
      </w-card-section>
      <w-card-section>
        <div class="text-body2">
          <i18n-t :keypath="`${labelPrefix}.revokeConfirmText`">
            <template #name>
              <strong>{{ apiKey.name }}</strong>
            </template>
          </i18n-t>
        </div>
      </w-card-section>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`common.actions.cancel`)"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
        <w-btn
          unelevated
          :label="t(`${labelPrefix}.revoke`)"
          color="negative"
          padding="xs md"
          :loading="state.isLoading"
          @click="confirm" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { reactive } from 'vue'
import { apiErrorMessage } from '@/helpers/apiError'

// PROPS

const props = defineProps({
  apiKey: {
    type: Object,
    required: true
  },
  // -> Which REST resource to revoke against: the admin listing (`api-keys`, every key) or the
  //    self-service one (`users/profile/api-keys`, the caller's own personal tokens only) —
  //    `ProfileApi.vue` passes the latter. Same dialog either way; only the endpoint differs.
  endpoint: {
    type: String,
    default: 'api-keys'
  },
  // -> `admin.api.*` for the admin listing, `profile.api.*` for the self-service one — the two
  //    string sets say the same things ("Revoke", "Revoke API Key?", ...) under different i18n
  //    namespaces, since a personal token isn't an admin's "API Key" to the reader holding it.
  labelPrefix: {
    type: String,
    default: 'admin.api'
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  isLoading: false
})

// METHODS

async function confirm() {
  state.isLoading = true
  try {
    await API_CLIENT.post(`${props.endpoint}/${props.apiKey.id}/revoke`).json()
    notify({
      type: 'positive',
      message: t(`${props.labelPrefix}.revokeSuccess`)
    })
    onDialogOK()
  } catch (err) {
    // -> ky throws above 400 — a key revoked from another tab answers 409
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}
</script>
