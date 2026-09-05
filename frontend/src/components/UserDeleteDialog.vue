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
          Said before the attempt rather than only when it fails: a user who has written anything
          cannot be deleted at all, and finding that out from an error after confirming is finding it
          out too late to have chosen deactivation instead.
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

// PROPS

const props = defineProps({
  user: {
    type: Object,
    required: true
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
  isDeleting: false,
  /** The user picked to inherit `props.user`'s pages and assets, if any. Optional: a user who owns
   *  nothing needs no target, and the delete route only actually requires one when it doesn't. */
  targetUser: null
})

// METHODS

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
      Reassignment happens first and only when a target was picked: skipping it for a user who owns
      nothing is what keeps a plain delete a one-step action, same as before this dialog could reassign
      anything at all. A reassignment failure stops here, before the delete is even attempted -- content
      left half-reassigned is a worse outcome than the delete simply not having happened yet.
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
      ky throws for statuses above 400, and this endpoint has several things to say through one: the
      account owns pages, it is the last root administrator, it is a system user, it is the caller's
      own. The reason is in the body, so the dialog stays open with it rather than closing on a
      failure it did not report.
    */
    notify({
      type: 'negative',
      message: localizeError(apiErrorMessage(err), t)
    })
  }
  state.isDeleting = false
}
</script>
