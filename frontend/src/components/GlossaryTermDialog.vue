<template>
  <w-dialog v-model="dialogVisible" @hide="onDialogHide">
    <w-card style="min-width: 650px">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-find-and-replace.svg" size="sm" class="mr-2" />
        <span>{{ isEdit ? t('admin.glossary.editTerm') : t('admin.glossary.newTerm') }}</span>
      </w-card-section>
      <w-form ref="termForm" class="py-2" @submit="save">
        <w-item>
          <blueprint-icon icon="rename" />
          <w-item-section>
            <w-input
              ref="iptTerm"
              v-model="state.term"
              outlined
              dense
              :rules="termValidation"
              hide-bottom-space
              :label="t(`admin.glossary.term`)"
              :hint="t(`admin.glossary.termHint`)"
              lazy-rules="ondemand"
              autofocus />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="quote-left" />
          <w-item-section>
            <w-input
              v-model="state.definition"
              type="textarea"
              outlined
              dense
              rows="3"
              :rules="definitionValidation"
              hide-bottom-space
              :label="t(`admin.glossary.definition`)"
              :hint="t(`admin.glossary.definitionHint`)"
              lazy-rules="ondemand" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="matches" />
          <w-item-section>
            <div class="flex flex-wrap gap-1 mb-2" v-if="state.aliases.length > 0">
              <w-chip
                v-for="alias of state.aliases"
                :key="alias"
                square
                dense
                removable
                @remove="removeAlias(alias)">
                {{ alias }}
              </w-chip>
            </div>
            <w-input
              v-model="state.aliasInput"
              outlined
              dense
              hide-bottom-space
              :label="t(`admin.glossary.aliases`)"
              :hint="t(`admin.glossary.aliasesHint`)"
              @keyup:enter="addAlias">
              <template #append>
                <w-btn
                  flat
                  round
                  dense
                  icon="la:plus"
                  :aria-label="t('common.actions.add')"
                  @click="addAlias" />
              </template>
            </w-input>
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="link" />
          <w-item-section>
            <w-select
              v-model="state.pageId"
              outlined
              dense
              use-input
              :options="pageOptions"
              option-value="id"
              option-label="title"
              emit-value
              map-options
              options-dense
              hide-bottom-space
              :label="t(`admin.glossary.canonicalPage`)"
              :hint="t(`admin.glossary.canonicalPageHint`)">
              <template #option="{ opt }">
                <w-item-label>{{ opt.title }}</w-item-label>
                <w-item-label v-if="opt.path" caption>/{{ opt.path }}</w-item-label>
              </template>
            </w-select>
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
          unelevated
          :label="isEdit ? t(`common.actions.save`) : t(`common.actions.create`)"
          color="primary"
          padding="xs md"
          :loading="state.isLoading"
          @click="save" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, reactive, ref } from 'vue'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

// PROPS

const props = defineProps({
  siteId: {
    type: String,
    required: true
  },
  /** The term being edited, or null to create one. */
  term: {
    type: Object,
    default: null
  },
  /** Candidate pages for the canonical-page picker, loaded once by the page rather than per dialog. */
  pages: {
    type: Array,
    default: () => []
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptTerm.value
})

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  term: props.term?.term ?? '',
  definition: props.term?.definition ?? '',
  aliases: [...(props.term?.aliases ?? [])],
  aliasInput: '',
  pageId: props.term?.pageId ?? null,
  isLoading: false
})

// REFS

const termForm = ref(null)
const iptTerm = ref(null)

// COMPUTED

const isEdit = computed(() => Boolean(props.term))

// -> `w-select` has no `clearable` prop (see its own header comment on scope) -- an explicit "none"
//    entry is how every other nullable-FK picker in this app (`WebhookEditDialog.vue`'s site picker)
//    lets the field go back to null.
const pageOptions = computed(() => [
  { id: null, title: t('admin.glossary.noCanonicalPage'), path: '' },
  ...props.pages
])

// VALIDATION RULES

const termValidation = [(val) => (val ?? '').trim().length > 0 || t('admin.glossary.termRequired')]

const definitionValidation = [
  (val) => (val ?? '').trim().length > 0 || t('admin.glossary.definitionRequired')
]

// METHODS

function addAlias() {
  const value = state.aliasInput.trim()
  state.aliasInput = ''
  if (!value || state.aliases.some((a) => a.toLowerCase() === value.toLowerCase())) {
    return
  }
  state.aliases.push(value)
}

function removeAlias(alias) {
  state.aliases = state.aliases.filter((a) => a !== alias)
}

async function save() {
  state.isLoading = true
  try {
    const isFormValid = await termForm.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('admin.glossary.formInvalid'))
    }

    const payload = {
      term: state.term.trim(),
      definition: state.definition.trim(),
      aliases: state.aliases,
      pageId: state.pageId
    }
    const resp = isEdit.value
      ? await API_CLIENT.put(`sites/${props.siteId}/glossary/${props.term.id}`, {
          json: payload
        }).json()
      : await API_CLIENT.post(`sites/${props.siteId}/glossary`, { json: payload }).json()

    notify({
      type: 'positive',
      message: isEdit.value ? t('admin.glossary.updateSuccess') : t('admin.glossary.createSuccess')
    })
    onDialogOK(resp)
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}
</script>
