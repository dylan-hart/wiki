<template>
  <w-dialog
    v-model="dialogVisible"
    max-width="450px"
    :aria-label="props.targetState ? t(`admin.sites.activate`) : t(`admin.sites.deactivate`)"
    @hide="onDialogHide">
    <w-card style="min-width: 350px">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-shutdown.svg" size="sm" class="me-2" />
        <span>{{
          props.targetState ? t(`admin.sites.activate`) : t(`admin.sites.deactivate`)
        }}</span>
      </w-card-section>
      <w-card-section>
        <div class="text-body2">
          <i18n-t
            :keypath="
              props.targetState ? `admin.sites.activateConfirm` : `admin.sites.deactivateConfirm`
            ">
            <template #siteTitle>
              <strong>{{ props.site.title }}</strong>
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
          :label="props.targetState ? t(`common.actions.activate`) : t(`common.actions.deactivate`)"
          :color="props.targetState ? `positive` : `negative`"
          padding="xs md"
          :loading="state.isLoading"
          @click="confirm" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { cloneDeep } from 'es-toolkit/object'
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { reactive, ref } from 'vue'

import { useAdminStore } from '../stores/admin'

// PROPS

const props = defineProps({
  site: {
    type: Object,
    required: true
  },
  targetState: {
    type: Boolean,
    default: false
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// STORES

const adminStore = useAdminStore()

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
    await API_CLIENT.put(`sites/${props.site.id}`, {
      json: {
        isEnabled: props.targetState
      }
    })
    notify({
      type: 'positive',
      message: t('admin.sites.updateSuccess')
    })
    adminStore.$patch({
      sites: adminStore.sites.map((s) => {
        if (s.id === props.site.id) {
          const ns = cloneDeep(s)
          ns.isEnabled = props.targetState
          return ns
        } else {
          return s
        }
      })
    })
    onDialogOK()
  } catch (err) {
    // -> ky throws for statuses above 400 (e.g. a future "cannot disable the last enabled site"
    //    guard), where the reason the API gave is in the response body rather than in the error
    //    message. Chaining `.json()` straight off the request -- as this used to -- throws before
    //    it gets the chance to parse anything for a status above 400.
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}
</script>
