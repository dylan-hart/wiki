<template>
  <w-dialog v-model="dialogVisible" :aria-label="t(`fileman.folderCreate`)" @hide="onDialogHide">
    <w-card style="min-width: 650px">
      <w-card-section class="card-header">
        <w-icon name="tabler:plus" size="sm" class="me-2" />
        <span>{{ t(`fileman.folderCreate`) }}</span>
      </w-card-section>
      <!--
        Neither icon is `self-start`: both fields pass `hide-bottom-space`, which suppresses the hint
        line, so each row is the field alone and a centred icon is what lines up with it. See the note in
        `ApiKeyCreateDialog`.
      -->
      <w-form ref="newFolderForm" class="py-2" @submit="create">
        <w-item>
          <blueprint-icon icon="folder" />
          <w-item-section>
            <w-input
              ref="iptTitle"
              v-model="state.title"
              dense
              :rules="titleValidation"
              hide-bottom-space
              :label="t(`fileman.folderTitle`)"
              lazy-rules="ondemand"
              @keyup:enter="create" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="file-submodule" />
          <w-item-section>
            <w-input
              v-model="state.path"
              dense
              :rules="pathValidation"
              hide-bottom-space
              :label="t(`fileman.folderFileName`)"
              :hint="t(`fileman.folderFileNameHint`)"
              lazy-rules="ondemand"
              @focus="state.pathDirty = true"
              @keyup:enter="create" />
          </w-item-section>
        </w-item>
      </w-form>
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
          :label="t(`common.actions.create`)"
          color="primary"
          padding="xs md"
          :loading="state.loading > 0"
          @click="create" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { reactive, ref, watch } from 'vue'
import slugify from 'slugify'

import { useSiteStore } from '@/stores/site'
import { apiErrorMessage } from '@/helpers/apiError'
import { normalizePagePath } from '@/helpers/pagePaths'

// PROPS

const props = defineProps({
  parentId: {
    type: String,
    default: null
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptTitle.value
})

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  path: '',
  title: '',
  pathDirty: false,
  loading: false
})

// REFS

const newFolderForm = ref(null)
const iptTitle = ref(null)

// VALIDATION RULES

const titleValidation = [
  (val) => val.length > 0 || t('fileman.folderTitleMissing'),
  (val) => /^[^<>"]+$/.test(val) || t('fileman.folderTitleInvalidChars')
]

const pathValidation = [
  (val) => val.length > 0 || t('fileman.folderFileNameMissing'),
  (val) => /^[a-z0-9-]+$/.test(val) || t('fileman.folderFileNameInvalid')
]

// WATCHERS

watch(
  () => state.title,
  (newValue) => {
    if (state.pathDirty && !state.path) {
      state.pathDirty = false
    }
    if (!state.pathDirty) {
      state.path = slugify(newValue, { lower: true, strict: true })
    }
  }
)

// METHODS

async function create() {
  state.loading++
  try {
    // -> The name is a segment of every page path under the folder, and is corrected the way one is
    state.path = normalizePagePath(state.path)
    const isFormValid = await newFolderForm.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('fileman.createFolderInvalidData'))
    }
    // -> No locale is sent: the server puts the folder in the site's primary one
    await API_CLIENT.post(`sites/${siteStore.id}/tree/folders`, {
      json: {
        parentId: props.parentId,
        pathName: state.path,
        title: state.title
      }
    }).json()
    notify({
      type: 'positive',
      message: t('fileman.createFolderSuccess')
    })
    onDialogOK()
  } catch (err) {
    // -> ky throws above 400 — a name already taken in this folder answers 409
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.loading--
}
</script>
