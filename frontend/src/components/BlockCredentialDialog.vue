<template>
  <w-dialog v-model="dialogVisible" @hide="onDialogHide">
    <w-card style="width: 450px; max-width: 90vw">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-key-2.svg" size="sm" class="mr-2" />
        <span>{{ dialogTitle }}</span>
      </w-card-section>
      <w-card-section>
        <p class="text-body2 text-grey">
          {{ dialogSubtitle }}
        </p>
        <w-input
          v-if="mode === 'create'"
          outlined
          v-model="state.name"
          :label="t('admin.blocks.credentialName')"
          :hint="t('admin.blocks.credentialNameHint')"
          autofocus
          class="mb-2" />
        <w-input
          v-if="mode !== 'domains'"
          outlined
          v-model="state.secret"
          type="password"
          :autofocus="mode === 'rotate'"
          :label="t('admin.blocks.credentialSecret')"
          :hint="t('admin.blocks.credentialSecretHint')"
          class="mb-2" />
        <template v-if="mode !== 'rotate'">
          <div class="flex flex-wrap gap-1 mb-2" v-if="state.allowedDomains.length > 0">
            <w-chip
              v-for="domain of state.allowedDomains"
              :key="domain"
              square
              dense
              removable
              @remove="removeDomain(domain)">
              {{ domain }}
            </w-chip>
          </div>
          <w-input
            ref="domainInputRef"
            outlined
            v-model="state.domainInput"
            :autofocus="mode === 'domains'"
            :label="t('admin.blocks.credentialAllowedDomains')"
            :hint="t('admin.blocks.credentialAllowedDomainsHint')"
            :rules="domainValidation"
            lazy-rules="ondemand"
            @keyup:enter="addDomain">
            <template #append>
              <w-btn
                flat
                round
                dense
                icon="la:plus"
                :aria-label="t('common.actions.add')"
                @click="addDomain" />
            </template>
          </w-input>
        </template>
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
          :label="submitLabel"
          color="primary"
          padding="xs md"
          :loading="state.isLoading"
          :disabled="submitDisabled"
          @click="submit" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, reactive, ref } from 'vue'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { useAdminStore } from '@/stores/admin'
import { apiErrorMessage } from '@/helpers/apiError'
import { isValidDomainPattern } from '@/helpers/domainPattern'

// PROPS

const props = defineProps({
  mode: {
    type: String,
    required: true,
    validator: (value) => ['create', 'rotate', 'domains'].includes(value)
  },
  /** Required for mode `rotate` and `domains`: the credential row being edited. */
  credential: {
    type: Object,
    default: null
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
  name: '',
  secret: '',
  allowedDomains: props.mode === 'domains' ? [...(props.credential?.allowedDomains ?? [])] : [],
  domainInput: '',
  isLoading: false
})

const domainInputRef = ref(null)

/**
 * Matches `hostnameMatchesAllowlist`'s own accepted syntax (see `helpers/domainPattern.js`) rather
 * than accepting anything non-empty (OpenProject #1099): a malformed entry used to be stored silently
 * and just never match any real hostname at resolve time.
 */
const domainValidation = [
  (value) =>
    !(value ?? '').trim() ||
    isValidDomainPattern(value.trim()) ||
    t('admin.blocks.credentialAllowedDomainsInvalid')
]

const dialogTitle = computed(() => {
  if (props.mode === 'rotate') return t('admin.blocks.credentialRotate')
  if (props.mode === 'domains') return t('admin.blocks.credentialDomains')
  return t('admin.blocks.credentialAdd')
})

const dialogSubtitle = computed(() => {
  if (props.mode === 'rotate') {
    return t('admin.blocks.credentialRotateSubtitle', { name: props.credential?.name ?? '' })
  }
  if (props.mode === 'domains') {
    return t('admin.blocks.credentialDomainsSubtitle', { name: props.credential?.name ?? '' })
  }
  return t('admin.blocks.credentialAddSubtitle')
})

const submitLabel = computed(() => dialogTitle.value)

const submitDisabled = computed(() => {
  if (props.mode === 'rotate') {
    return !state.secret.trim()
  }
  if (props.mode === 'domains') {
    return false
  }
  return !state.name.trim() || !state.secret.trim() || state.allowedDomains.length === 0
})

// METHODS

function addDomain() {
  const value = state.domainInput.trim().toLowerCase()
  if (!value) {
    return
  }
  if (!domainInputRef.value?.validate()) {
    return
  }
  state.domainInput = ''
  if (state.allowedDomains.includes(value)) {
    return
  }
  state.allowedDomains.push(value)
}

function removeDomain(domain) {
  state.allowedDomains = state.allowedDomains.filter((d) => d !== domain)
}

async function submit() {
  state.isLoading = true
  try {
    if (props.mode === 'rotate') {
      const resp = await API_CLIENT.post(
        `sites/${adminStore.currentSiteId}/block-credentials/${props.credential.id}/rotate`,
        { json: { secret: state.secret } }
      ).json()
      if (!resp?.ok) {
        throw new Error(resp?.message || 'An unexpected error occured.')
      }
      notify({ type: 'positive', message: t('admin.blocks.credentialRotateSuccess') })
      onDialogOK()
    } else if (props.mode === 'domains') {
      const resp = await API_CLIENT.post(
        `sites/${adminStore.currentSiteId}/block-credentials/${props.credential.id}/allowed-domains`,
        { json: { allowedDomains: state.allowedDomains } }
      ).json()
      if (!resp?.ok) {
        throw new Error(resp?.message || 'An unexpected error occured.')
      }
      notify({ type: 'positive', message: t('admin.blocks.credentialDomainsUpdateSuccess') })
      onDialogOK()
    } else {
      const credential = await API_CLIENT.post(
        `sites/${adminStore.currentSiteId}/block-credentials`,
        {
          json: {
            name: state.name.trim(),
            secret: state.secret,
            allowedDomains: state.allowedDomains
          }
        }
      ).json()
      notify({ type: 'positive', message: t('admin.blocks.credentialCreateSuccess') })
      onDialogOK(credential)
    }
  } catch (err) {
    const failMessage =
      props.mode === 'rotate'
        ? t('admin.blocks.credentialRotateFailed')
        : props.mode === 'domains'
          ? t('admin.blocks.credentialDomainsUpdateFailed')
          : t('admin.blocks.credentialCreateFailed')
    notify({
      type: 'negative',
      message: failMessage,
      caption: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}

defineExpose({ state, removeDomain })
</script>
