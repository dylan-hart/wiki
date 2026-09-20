<template>
  <w-dialog
    v-model="dialogVisible"
    max-width="450px"
    :aria-label="t(`admin.users.deleteConfirmTitle`)"
    @hide="onDialogHide">
    <w-card style="min-width: 350px">
      <w-card-section class="card-header">
        <w-icon name="tabler:trash" size="sm" class="me-2" />
        <span>{{ t(`admin.users.deleteConfirmTitle`) }}</span>
      </w-card-section>
      <w-card-section>
        <div class="text-body2">
          <i18n-t keypath="admin.users.deleteConfirmText">
            <template #username>
              <strong>{{ props.user.name }}</strong>
            </template>
          </i18n-t>
        </div>
        <!--
          Said up front, not only on failure: a user who has written anything cannot be deleted at
          all, and an error after confirming comes too late to choose deactivation instead.
        -->
        <div class="text-body2 mt-4">{{ t(`admin.users.deleteConfirmForeignNotice`) }}</div>
        <div class="text-body2 mt-4">{{ t(`admin.users.deleteConfirmReplaceWarn`) }}</div>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <w-chip
            v-if="state.targetUser"
            :label="state.targetUser.name"
            icon="tabler:user"
            removable
            :remove-label="t('common.actions.clear')"
            @remove="state.targetUser = null" />
          <w-btn
            flat
            dense
            color="primary"
            :label="t(`admin.users.deleteReassignChoose`)"
            @click="chooseTargetUser" />
        </div>
        <div class="text-body2 mt-4">
          <strong class="text-negative">{{ t(`admin.users.deleteHint`) }}</strong>
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
          :label="t(`common.actions.delete`)"
          color="negative"
          padding="xs md"
          :loading="state.isDeleting"
          @click="confirm" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { reactive } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialog, dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { localizeError } from '@/helpers/localization'
import UserSearchDialog from '@/components/UserSearchDialog.vue'

const props = defineProps({
  user: {
    type: Object,
    required: true
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const { t } = useI18n()

const state = reactive({
  isDeleting: false,
  /** Who inherits this user's pages and assets. Optional: the delete route demands one only from a
   *  user who actually owns something. */
  targetUser: null
})

function chooseTargetUser() {
  dialog({
    component: UserSearchDialog,
    componentProps: {
      title: t('admin.users.deleteReassignChoose'),
      singleSelect: true,
      excludeUserIds: [props.user.id]
    }
  }).onOk((selected) => {
    state.targetUser = selected[0] ?? null
  })
}

async function confirm() {
  state.isDeleting = true
  try {
    /*
      A reassignment failure stops here, before the delete is attempted: content left half-reassigned
      is worse than a delete that has not happened yet.
    */
    if (state.targetUser) {
      await API_CLIENT.post(`users/${props.user.id}/reassignContent`, {
        json: { targetUserId: state.targetUser.id }
      })
    }

    await API_CLIENT.delete(`users/${props.user.id}`)
    notify({
      type: 'positive',
      message: t('admin.users.deleteSuccess', { username: props.user.name })
    })
    onDialogOK()
  } catch (err) {
    /*
      This endpoint refuses for several distinct reasons -- owned pages, last root administrator,
      system user, the caller's own account -- all as one status, with the reason in the body. The
      dialog stays open showing it rather than closing on a failure it did not report.
    */
    notify({
      type: 'negative',
      message: localizeError(apiErrorMessage(err), t)
    })
  }
  state.isDeleting = false
}
</script>
