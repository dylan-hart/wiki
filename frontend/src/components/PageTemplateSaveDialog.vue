<template>
  <w-dialog v-model="dialogVisible" :aria-label="t(`pageTemplateSave.title`)" @hide="onDialogHide">
    <w-card style="min-width: 550px">
      <w-card-section class="card-header">
        <w-icon name="tabler:file-plus" size="sm" class="me-2" />
        <span>{{ t(`pageTemplateSave.title`) }}</span>
      </w-card-section>
      <w-form ref="templateForm" class="py-2" @submit="save">
        <w-item>
          <w-item-section>
            <w-input
              ref="iptName"
              v-model="state.name"
              dense
              :rules="nameValidation"
              hide-bottom-space
              :label="t(`pageTemplateSave.name`)"
              lazy-rules="ondemand"
              @keyup:enter="save" />
          </w-item-section>
        </w-item>
        <w-item>
          <w-item-section>
            <w-input
              v-model="state.description"
              dense
              hide-bottom-space
              :label="t(`pageTemplateSave.description`)"
              :hint="t(`pageTemplateSave.descriptionHint`)"
              @keyup:enter="save" />
          </w-item-section>
        </w-item>
        <w-item v-if="locale">
          <w-item-section>
            <w-checkbox
              v-model="state.allLocales"
              :label="t(`pageTemplateSave.allLocales`)"
              dense />
            <div class="text-caption text-grey">
              {{
                state.allLocales
                  ? t(`pageTemplateSave.allLocalesHint`)
                  : t(`pageTemplateSave.thisLocaleHint`, { locale })
              }}
            </div>
          </w-item-section>
        </w-item>
        <w-item>
          <w-item-section>
            <div class="text-caption text-grey">{{ t(`pageTemplateSave.contentHint`) }}</div>
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
          :label="t(`common.actions.save`)"
          color="primary"
          padding="xs md"
          :loading="state.loading"
          @click="save" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { buildTemplatePayload } from '@/helpers/pageTemplates'
import { useSiteStore } from '@/stores/site'

const props = defineProps({
  content: {
    type: String,
    required: true
  },
  editor: {
    type: String,
    required: true
  },
  locale: {
    type: String,
    default: null
  },
  defaultName: {
    type: String,
    default: ''
  },
  defaultDescription: {
    type: String,
    default: ''
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptName.value
})

const siteStore = useSiteStore()

const { t } = useI18n()

const state = reactive({
  name: props.defaultName,
  description: props.defaultDescription,
  allLocales: true,
  loading: false
})

const templateForm = ref(null)
const iptName = ref(null)

const nameValidation = [(val) => val.trim().length > 0 || t('pageTemplateSave.nameMissing')]

async function save() {
  if (state.loading) {
    return
  }
  state.loading = true
  try {
    const isFormValid = await templateForm.value.validate(true)
    if (!isFormValid) {
      return
    }
    const template = await API_CLIENT.post(`sites/${siteStore.id}/page-templates`, {
      json: buildTemplatePayload({
        name: state.name,
        description: state.description,
        editor: props.editor,
        content: props.content,
        locale: props.locale,
        allLocales: state.allLocales
      })
    }).json()
    notify({
      type: 'positive',
      message: t('pageTemplateSave.saveSuccess')
    })
    onDialogOK(template)
  } catch (err) {
    notify({
      type: 'negative',
      message: t('pageTemplateSave.saveFailed'),
      caption: apiErrorMessage(err, t('common.error.unexpected'))
    })
  } finally {
    state.loading = false
  }
}
</script>
