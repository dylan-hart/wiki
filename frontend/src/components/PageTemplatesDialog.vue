<template>
  <w-dialog
    v-model="dialogVisible"
    max-width="850px"
    :aria-label="t(`pageTemplateManage.title`)"
    @hide="onDialogHide">
    <w-card style="min-width: 550px">
      <w-card-section class="card-header">
        <w-icon name="tabler:settings" size="sm" class="me-2" />
        <span>{{ t(`pageTemplateManage.title`) }}</span>
      </w-card-section>
      <w-card-section v-if="state.loading">
        <w-spinner size="sm" />
      </w-card-section>
      <w-card-section v-else-if="state.loadFailed">
        <span class="text-negative">{{ t(`pageTemplateManage.loadFailed`) }}</span>
        <w-btn
          class="ms-2"
          flat
          color="primary"
          :label="t(`common.actions.refresh`)"
          @click="load" />
      </w-card-section>
      <w-card-section v-else-if="!state.templates.length">{{
        t(`pageTemplateManage.empty`)
      }}</w-card-section>
      <w-list v-else separator>
        <w-item v-for="tpl of state.templates" :key="tpl.id" class="template-row">
          <template v-if="state.editingId === tpl.id">
            <w-item-section>
              <w-input
                v-model="state.draftName"
                dense
                :label="t(`pageTemplateManage.name`)"
                :rules="[nameRule]"
                @keyup:enter="commitEdit(tpl)" />
              <w-input
                v-model="state.draftDescription"
                class="mt-1"
                dense
                :label="t(`pageTemplateManage.description`)"
                @keyup:enter="commitEdit(tpl)" />
            </w-item-section>
            <w-item-section side>
              <div class="flex gap-1">
                <w-btn
                  class="acrylic-btn"
                  color="positive"
                  round
                  icon="tabler:check"
                  size="xs"
                  flat
                  :loading="state.saving"
                  :aria-label="t(`pageTemplateManage.confirmEdit`)"
                  @click="commitEdit(tpl)" />
                <w-btn
                  class="acrylic-btn"
                  color="grey"
                  round
                  icon="tabler:x"
                  size="xs"
                  flat
                  :aria-label="t(`pageTemplateManage.cancelEdit`)"
                  @click="cancelEdit" />
              </div>
            </w-item-section>
          </template>
          <template v-else>
            <w-item-section>
              <w-item-label>{{ tpl.name }}</w-item-label>
              <w-item-label v-if="tpl.description" caption>{{ tpl.description }}</w-item-label>
              <w-item-label caption>{{ scopeLabel(tpl) }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <div class="flex gap-1">
                <w-btn
                  class="acrylic-btn"
                  color="grey"
                  round
                  icon="tabler:edit"
                  size="xs"
                  flat
                  :aria-label="t(`pageTemplateManage.rename`)"
                  @click="startEdit(tpl)" />
                <w-btn
                  class="acrylic-btn"
                  color="negative"
                  round
                  icon="tabler:trash"
                  size="xs"
                  flat
                  :aria-label="t(`pageTemplateManage.delete`)"
                  @click="askDelete(tpl)" />
              </div>
            </w-item-section>
          </template>
        </w-item>
      </w-list>
      <w-card-section class="text-caption text-grey">{{
        t(`pageTemplateManage.deleteHint`)
      }}</w-card-section>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`common.actions.close`)"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'

import { confirm, dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { useSiteStore } from '@/stores/site'

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogCancel } = useDialogComponent()

const siteStore = useSiteStore()

const { t } = useI18n()

const state = reactive({
  templates: [],
  loading: true,
  loadFailed: false,
  editingId: null,
  draftName: '',
  draftDescription: '',
  saving: false
})

function nameRule(value) {
  return value.trim().length > 0 || t('pageTemplateManage.nameMissing')
}

function scopeLabel(tpl) {
  return tpl.locale
    ? t('pageTemplateManage.scopeLocale', { locale: tpl.locale })
    : t('pageTemplateManage.scopeAll')
}

async function load() {
  state.loading = true
  state.loadFailed = false
  try {
    const templates = await API_CLIENT.get(`sites/${siteStore.id}/page-templates`).json()
    state.templates = Array.isArray(templates) ? templates : []
  } catch {
    state.loadFailed = true
  }
  state.loading = false
}

function startEdit(tpl) {
  state.editingId = tpl.id
  state.draftName = tpl.name
  state.draftDescription = tpl.description ?? ''
}

function cancelEdit() {
  state.editingId = null
  state.draftName = ''
  state.draftDescription = ''
}

async function commitEdit(tpl) {
  if (state.saving || state.editingId !== tpl.id) {
    return
  }
  const name = state.draftName.trim()
  if (!name) {
    return
  }
  state.saving = true
  try {
    const updated = await API_CLIENT.put(`sites/${siteStore.id}/page-templates/${tpl.id}`, {
      json: { name, description: state.draftDescription.trim() }
    }).json()
    Object.assign(tpl, {
      name: updated?.name ?? name,
      description: updated?.description ?? state.draftDescription.trim()
    })
    cancelEdit()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('pageTemplateManage.renameFailed'),
      caption: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
  state.saving = false
}

function askDelete(tpl) {
  confirm({
    title: t('pageTemplateManage.deleteTitle'),
    message: t('pageTemplateManage.deleteConfirm', { name: tpl.name }),
    destructive: true,
    persistent: true
  }).onOk(() => deleteTemplate(tpl))
}

async function deleteTemplate(tpl) {
  try {
    await API_CLIENT.delete(`sites/${siteStore.id}/page-templates/${tpl.id}`)
    state.templates = state.templates.filter((row) => row.id !== tpl.id)
    if (state.editingId === tpl.id) {
      cancelEdit()
    }
    notify({ type: 'positive', message: t('pageTemplateManage.deleteSuccess') })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('pageTemplateManage.deleteFailed'),
      caption: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
}

onMounted(load)
</script>
