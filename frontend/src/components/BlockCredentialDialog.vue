<template>
  <w-dialog v-model="dialogVisible" :aria-label="dialogTitle" @hide="onDialogHide">
    <w-card style="width: 450px; max-width: 90vw">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-key-2.svg" size="sm" class="me-2" />
        <span>{{ dialogTitle }}</span>
      </w-card-section>
      <w-card-section>
        <p class="text-body2 text-grey">
          {{ dialogSubtitle }}
        </p>
        <w-input
          v-if="mode === 'create'"
          ref="iptName"
          outlined
          v-model="state.name"
          :label="t('admin.blocks.credentialName')"
          :hint="t('admin.blocks.credentialNameHint')"
          class="mb-2" />
        <w-input
          v-if="mode !== 'domains'"
          ref="iptSecret"
          outlined
          v-model="state.secret"
          type="password"
          revealable
          :reveal-label="t('admin.blocks.credentialSecretReveal')"
          :hide-label="t('admin.blocks.credentialSecretHide')"
          :label="t('admin.blocks.credentialSecret')"
          :hint="t('admin.blocks.credentialSecretHint')"
          class="mb-2" />
        <template v-if="mode !== 'rotate'">
          <div class="flex flex-wrap gap-1 mb-2" v-if="state.allowedOrigins.length > 0">
            <w-chip
              v-for="origin of state.allowedOrigins"
              :key="origin"
              square
              dense
              removable
              @remove="removeOrigin(origin)">
              {{ origin }}
            </w-chip>
          </div>
          <w-input
            ref="originInputRef"
            outlined
            v-model="state.originInput"
            :label="t('admin.blocks.credentialAllowedDomains')"
            :hint="t('admin.blocks.credentialAllowedDomainsHint')"
            :rules="originValidation"
            lazy-rules="ondemand"
            @keyup:enter="addOrigin">
            <template #append>
              <w-btn
                flat
                round
                dense
                icon="la:plus"
                :aria-label="t('common.actions.add')"
                @click="addOrigin" />
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
import { isValidOriginPattern } from '@/helpers/originPattern'

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

/**
 * Which field is "first" depends on `mode`: create shows the name field, rotate shows the secret
 * field (the only one it renders), domains shows the allowed-domains input.
 */
const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => {
    if (props.mode === 'create') return iptName.value
    if (props.mode === 'rotate') return iptSecret.value
    return originInputRef.value
  }
})

// STORES

const adminStore = useAdminStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  name: '',
  secret: '',
  allowedOrigins: props.mode === 'domains' ? [...(props.credential?.allowedOrigins ?? [])] : [],
  originInput: '',
  isLoading: false
})

const originInputRef = ref(null)
const iptName = ref(null)
const iptSecret = ref(null)

/**
 * Matches `originMatchesAllowlist`'s own accepted syntax (see `helpers/originPattern.js`) rather
 * than accepting anything non-empty (OpenProject #1099, extended by #2185/#2195/#2198 to a full
 * origin+path-prefix shape): a malformed entry used to be stored silently and just never match any
 * real request at resolve time.
 */
const originValidation = [
  (value) =>
    !(value ?? '').trim() ||
    isValidOriginPattern(value.trim()) ||
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
  return !state.name.trim() || !state.secret.trim() || state.allowedOrigins.length === 0
})

// METHODS

/**
 * Lowercases only the scheme and host, never the path: unlike a bare hostname, an origin+prefix
 * entry can carry a case-sensitive path (`https://api.example.com/V1` legitimately differs from
 * `.../v1` on most APIs), so blindly lowercasing the whole value the way the old hostname-only
 * input did would silently corrupt an intentionally-cased prefix.
 */
function normalizeOrigin(raw) {
  const trimmed = raw.trim()
  if (!trimmed) {
    return ''
  }
  try {
    const url = new URL(trimmed)
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
    return `${url.protocol}//${url.host}${path}`
  } catch {
    return trimmed
  }
}

function addOrigin() {
  const value = normalizeOrigin(state.originInput)
  if (!value) {
    return
  }
  // -> Written back before validating, so an admin who typed a mixed-case scheme or host (neither
  //    is meaningful case, unlike the path) sees the normalized form rather than their raw input.
  //    The push decision itself is `isValidOriginPattern(value)` directly, not
  //    `originInputRef.value.validate()`'s return: `validate()` reads the *prop* `WInput` was last
  //    rendered with, which only catches up to this synchronous write on the next render, so
  //    calling it right here would validate the stale, pre-normalization value.
  state.originInput = value
  originInputRef.value?.validate()
  if (!isValidOriginPattern(value)) {
    return
  }
  state.originInput = ''
  if (state.allowedOrigins.includes(value)) {
    return
  }
  state.allowedOrigins.push(value)
}

function removeOrigin(origin) {
  state.allowedOrigins = state.allowedOrigins.filter((o) => o !== origin)
}

async function submit() {
  state.isLoading = true
  try {
    if (props.mode === 'rotate') {
      await API_CLIENT.post(
        `sites/${adminStore.currentSiteId}/block-credentials/${props.credential.id}/rotate`,
        { json: { secret: state.secret } }
      ).json()
      notify({ type: 'positive', message: t('admin.blocks.credentialRotateSuccess') })
      onDialogOK()
    } else if (props.mode === 'domains') {
      await API_CLIENT.post(
        `sites/${adminStore.currentSiteId}/block-credentials/${props.credential.id}/allowed-origins`,
        { json: { allowedOrigins: state.allowedOrigins } }
      ).json()
      notify({ type: 'positive', message: t('admin.blocks.credentialDomainsUpdateSuccess') })
      onDialogOK()
    } else {
      const credential = await API_CLIENT.post(
        `sites/${adminStore.currentSiteId}/block-credentials`,
        {
          json: {
            name: state.name.trim(),
            secret: state.secret,
            allowedOrigins: state.allowedOrigins
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

defineExpose({ state, removeOrigin })
</script>
