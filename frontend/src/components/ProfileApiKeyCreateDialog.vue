<template>
  <w-dialog v-model="dialogVisible" @hide="onDialogHide">
    <w-card style="min-width: 650px">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-plus-plus.svg" size="sm" class="mr-2" />
        <span>{{ t(`profile.api.newKeyTitle`) }}</span>
      </w-card-section>
      <!--
        No groups picker, unlike the admin form (`ApiKeyCreateDialog.vue`): a personal token always
        carries exactly the creating user's own current permissions -- there is nothing to pick, only
        an optional scope to narrow it. See `profile.api.newKeyInfo` below and the design decision in
        `backend/models/apiKeys.ts`'s doc comment.
      -->
      <w-card-section class="text-body2 text-grey">
        {{ t(`profile.api.newKeyInfo`) }}
      </w-card-section>
      <w-form ref="createKeyForm" class="py-2" @submit="create">
        <w-item>
          <blueprint-icon icon="grand-master-key" />
          <w-item-section>
            <w-input
              ref="iptName"
              v-model="state.keyName"
              outlined
              dense
              :rules="keyNameValidation"
              hide-bottom-space
              :label="t(`profile.api.newKeyName`)"
              :hint="t(`profile.api.newKeyNameHint`)"
              lazy-rules="ondemand"
              autofocus />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="schedule" />
          <w-item-section>
            <w-select
              v-model="state.keyExpiration"
              outlined
              :options="expirations"
              map-options
              option-value="value"
              option-label="text"
              emit-value
              options-dense
              dense
              hide-bottom-space
              :label="t(`profile.api.newKeyExpiration`)"
              :hint="t(`profile.api.newKeyExpirationHint`)" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="home" />
          <w-item-section>
            <w-select
              v-model="state.keySiteId"
              outlined
              :options="siteOptions"
              map-options
              option-value="id"
              option-label="title"
              emit-value
              options-dense
              dense
              hide-bottom-space
              :label="t(`profile.api.newKeySite`)"
              :hint="t(`profile.api.newKeySiteHint`)"
              :loading="state.loadingSites" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="lock" />
          <w-item-section>
            <!--
              Left empty, the token carries the full extent of the creator's own current permissions --
              picking anything here narrows it, exactly like the admin form's scope field.
            -->
            <w-select
              v-model="state.keyScope"
              outlined
              :options="scopeOptions"
              multiple
              map-options
              emit-value
              option-value="value"
              option-label="label"
              options-dense
              dense
              use-chips
              hide-bottom-space
              :label="t(`profile.api.newKeyPermissionScopes`)"
              :hint="t(`profile.api.newKeyScopeHint`)" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="secure" />
          <w-item-section>
            <!--
              OpenProject #1055: left at "No Limit", the token may reach anything its own scope/rules
              otherwise grant. Picking a level caps it -- the token may never be granted a page
              permission on a page classified stricter than this, whatever the rules say. This is the
              control that resolves the "an agent authenticating with my token can read my password
              pages too" concern the feature exists for.
            -->
            <w-select
              v-model="state.keyMaxClassification"
              outlined
              :options="classificationOptions"
              map-options
              option-value="id"
              option-label="name"
              emit-value
              options-dense
              dense
              hide-bottom-space
              :label="t(`profile.api.newKeyMaxClassification`)"
              :hint="t(`profile.api.newKeyMaxClassificationHint`)"
              :loading="state.loadingClassificationLevels" />
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

import { dialog, dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { computed, onMounted, reactive, ref } from 'vue'

import ApiKeyCopyDialog from './ApiKeyCopyDialog.vue'
import { apiErrorMessage } from '@/helpers/apiError'

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  keyName: '',
  keyExpiration: '90d',
  // -> Empty means unscoped (null on the wire): the token carries the full extent of the creator's
  //    own current permissions. Anything picked here narrows it -- see the field's own comment above.
  keyScope: [],
  // -> null is the "All Sites" entry -- instance-wide, exactly like the admin-issued form's default.
  keySiteId: null,
  sites: [],
  loadingSites: false,
  // -> null is "No Limit" -- unrestricted, today's only behavior for a token minted without this.
  keyMaxClassification: null,
  classificationLevels: [],
  loadingClassificationLevels: false,
  loading: 0
})

const expirations = [
  { value: '30d', text: t('profile.api.expiration30d') },
  { value: '90d', text: t('profile.api.expiration90d') },
  { value: '180d', text: t('profile.api.expiration180d') },
  { value: '1y', text: t('profile.api.expiration1y') },
  { value: '3y', text: t('profile.api.expiration3y') }
]

/**
 * The closed permission vocabulary a scope entry may name -- mirrors `ALL_PERMISSIONS`
 * (`backend/helpers/permissions.ts`), which is what the API actually validates a scope against. Same
 * list `ApiKeyCreateDialog.vue` (the admin form) duplicates, for the same reason: a fixed, closed
 * list (see CLAUDE.md's "Permissions" section).
 */
const scopeOptions = [
  'access:admin',
  'manage:users',
  'manage:groups',
  'manage:navigation',
  'manage:theme',
  'manage:sites',
  'manage:system',
  'read:pages',
  'write:pages',
  'review:pages',
  'manage:pages',
  'delete:pages',
  'write:styles',
  'write:scripts',
  'read:source',
  'read:history',
  'read:assets',
  'write:assets',
  'manage:assets',
  'read:comments',
  'write:comments',
  'manage:comments'
].map((value) => ({ value, label: value }))

// REFS

const createKeyForm = ref(null)
const iptName = ref(null)

// COMPUTED

/** The site select's own "All Sites" entry (`id: null`) is prepended -- see the field's template comment. */
const siteOptions = computed(() => {
  return [{ id: null, title: t('profile.api.newKeySiteAllSites') }, ...state.sites]
})

/** The classification select's own "No Limit" entry (`id: null`) is prepended, same pattern as sites. */
const classificationOptions = computed(() => {
  return [
    { id: null, name: t('profile.api.newKeyMaxClassificationNoLimit') },
    ...state.classificationLevels
  ]
})

// VALIDATION RULES

const keyNameValidation = [
  (val) => val.length > 0 || t('profile.api.nameMissing'),
  (val) => /^[^<>"]+$/.test(val) || t('profile.api.nameInvalidChars')
]

// METHODS

async function loadSites() {
  state.loading++
  state.loadingSites = true
  try {
    // -> `GET /sites` needs `read:sites`/`access:admin`, which an ordinary self-service user does not
    //    hold -- this is the expected, common case for this dialog's actual audience, not an error
    //    worth alarming them with. Degrade silently to an empty list, which leaves the site picker
    //    showing only "All Sites" (siteId: null) -- the token is still fully creatable.
    const resp = await API_CLIENT.get('sites').json()
    state.sites = resp ?? []
  } catch {
    state.sites = []
  }
  state.loadingSites = false
  state.loading--
}

/** Same read-access-blind-eye treatment as `loadSites()` above -- the level list is public-access
 *  (`GET /classification-levels` needs no permission), but this stays defensive either way. */
async function loadClassificationLevels() {
  state.loading++
  state.loadingClassificationLevels = true
  try {
    const resp = await API_CLIENT.get('classification-levels').json()
    state.classificationLevels = resp ?? []
  } catch {
    state.classificationLevels = []
  }
  state.loadingClassificationLevels = false
  state.loading--
}

async function create() {
  state.loading++
  try {
    const isFormValid = await createKeyForm.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('profile.api.createInvalidData'))
    }
    const resp = await API_CLIENT.post('users/profile/api-keys', {
      json: {
        name: state.keyName,
        expiration: state.keyExpiration,
        scope: state.keyScope.length > 0 ? state.keyScope : null,
        maxClassification: state.keyMaxClassification,
        siteId: state.keySiteId
      }
    }).json()
    if (!resp?.ok || !resp?.key) {
      throw new Error(resp?.message || 'An unexpected error occured.')
    }
    notify({
      type: 'positive',
      message: t('profile.api.createSuccess')
    })
    // -> The token exists only in this response, so hand it straight to the copy dialog -- same
    //    generic dialog the admin form reuses, it only needs the token value.
    dialog({
      component: ApiKeyCopyDialog,
      componentProps: {
        keyValue: resp.key
      }
    }).onDismiss(() => {
      onDialogOK()
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.loading--
}

// MOUNTED

onMounted(() => {
  loadSites()
  loadClassificationLevels()
})
</script>
