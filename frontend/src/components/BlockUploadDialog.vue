<template>
  <w-dialog v-model="dialogVisible" :aria-label="t(`admin.blocks.upload`)" @hide="onDialogHide">
    <w-card style="min-width: 450px">
      <w-card-section class="card-header">
        <w-icon name="tabler:cloud-upload" size="sm" class="me-2" />
        <span>{{ t(`admin.blocks.upload`) }}</span>
      </w-card-section>
      <w-card-section>
        <p class="text-body2 text-grey">{{ t('admin.blocks.uploadSubtitle') }}</p>

        <input
          type="file"
          ref="fileIpt"
          accept=".js,application/javascript,text/javascript"
          style="display: none"
          @change="onFileChange" />

        <w-item class="px-0">
          <w-item-section>
            <w-btn
              class="acrylic-btn"
              outline
              icon="la:file"
              :label="t(`admin.blocks.uploadChooseFile`)"
              color="primary"
              @click="pickFile" />
          </w-item-section>
          <w-item-section>
            <w-item-label>{{
              state.file?.name ?? t('admin.blocks.uploadNoFileChosen')
            }}</w-item-label>
            <w-item-label caption>
              {{ t('admin.blocks.uploadFileHint', { size: humanMaxFileSize }) }}
            </w-item-label>
          </w-item-section>
        </w-item>

        <div class="text-negative text-caption mt-1" v-if="state.fileError">
          {{ state.fileError }}
        </div>
      </w-card-section>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn block-upload-cancel"
          flat
          :label="t(`common.actions.cancel`)"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
        <w-btn
          class="block-upload-submit"
          :label="t(`admin.blocks.upload`)"
          color="primary"
          padding="xs md"
          :loading="state.isLoading"
          :disabled="!state.file || !!state.fileError"
          @click="upload" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { computed, onMounted, reactive, ref } from 'vue'

import { useAdminStore } from '@/stores/admin'
import { apiErrorMessage } from '@/helpers/apiError'
import { DEFAULT_MAX_BLOCK_UPLOAD_SIZE, validateBlockFile } from '@/helpers/blockUpload'
import { formatFileSize } from '@/helpers/fileSize'

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
  file: null,
  fileError: '',
  maxFileSize: DEFAULT_MAX_BLOCK_UPLOAD_SIZE,
  isLoading: false
})

const humanMaxFileSize = computed(() => formatFileSize(state.maxFileSize))

// REFS

const fileIpt = ref(null)

// METHODS

function messageForReason(reason) {
  switch (reason) {
    case 'extension':
      return t('admin.blocks.uploadInvalidExtension')
    case 'size':
      return t('admin.blocks.uploadTooLarge', { size: humanMaxFileSize.value })
    default:
      return ''
  }
}

function pickFile() {
  fileIpt.value.click()
}

function onFileChange() {
  const file = fileIpt.value.files?.[0] ?? null
  const result = validateBlockFile(file, state.maxFileSize)
  state.file = result.ok ? file : null
  state.fileError = result.ok || result.reason === 'missing' ? '' : messageForReason(result.reason)
}

async function upload() {
  const result = validateBlockFile(state.file, state.maxFileSize)
  if (!result.ok) {
    state.fileError = messageForReason(result.reason)
    return
  }

  state.isLoading = true
  try {
    const resp = await API_CLIENT.post(`sites/${adminStore.currentSiteId}/blocks`, {
      headers: {
        'content-type': state.file.type || 'application/javascript'
      },
      body: state.file
    }).json()
    notify({
      type: 'positive',
      message: t('admin.blocks.uploadSuccess')
    })
    onDialogOK(resp.block)
  } catch (err) {
    // -> ky throws above 400 (no static definition, tag collision, oversized file, ...), with the
    //    reason in the body -- surfaced the same way `deleteBlock()` surfaces its own errors
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}

// MOUNTED

onMounted(async () => {
  /*
    Best-effort only: reading the real configured limit requires `manage:system`, which a site admin
    who can manage this site's blocks does not necessarily hold. Falling back silently to the default
    still gives a useful pre-check, and the upload itself is refused server-side regardless -- this is
    a UX nicety to catch an oversized file before spending the request, not the enforcement.
  */
  try {
    const resp = await API_CLIENT.get('system/security').json()
    if (resp?.uploadMaxFileSize > 0) {
      state.maxFileSize = resp.uploadMaxFileSize
    }
  } catch {
    // -> Keep the default
  }
})
</script>
