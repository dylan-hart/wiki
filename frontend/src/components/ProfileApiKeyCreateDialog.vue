<template>
  <w-dialog v-model="dialogVisible" @hide="onDialogHide">
    <w-card style="width: 700px; max-width: 94vw">
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
        <div class="grid grid-cols-1 gap-x-4 md:grid-cols-2">
          <w-item class="md:col-span-2">
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
                lazy-rules="ondemand" />
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

                OpenProject #1272: a verb-grouped tri-state tree, replacing the earlier flat
                `w-select multiple use-chips` field -- see `ApiKeyScopePicker.vue`.
              -->
              <div class="text-caption mb-1">{{ t(`profile.api.newKeyPermissionScopes`) }}</div>
              <api-key-scope-picker v-model="state.keyScope" />
              <div class="text-caption text-grey mt-1">{{ t(`profile.api.newKeyScopeHint`) }}</div>
            </w-item-section>
          </w-item>
          <w-item>
            <blueprint-icon icon="secure" />
            <w-item-section>
              <!--
                OpenProject #1205: a checkbox grid replacing the earlier #1055 single-select "ceiling" --
                same review feedback and reasoning as `ApiKeyCreateDialog.vue`'s admin form. Every level
                starts checked, equivalent to the old "No Limit" default (see `allowedClassifications`
                below): the token may reach anything its own scope/rules otherwise grant. Unchecking a
                level narrows it -- the token may never be granted a page permission on a page classified
                at an unchecked level, whatever the rules say. This is the control that resolves the "an
                agent authenticating with my token can read my password pages too" concern the feature
                exists for.
              -->
              <div class="text-caption mb-1">
                {{ t(`profile.api.newKeyClassificationLevels`) }}
              </div>
              <!--
                OpenProject #1261 follow-up: this field shares row 3 of the 2-column grid above with
                Permission Scopes (#1292/#1293), so it only ever gets ~half the dialog's width --
                measured at ~310px, against ~618px for `ApiKeyCreateDialog.vue`'s single-column admin
                form, which is why that dialog keeps the wider 9rem floor. A 9rem (144px) floor still
                only fits 2 columns in 310px, stranding the 3rd of the 3 default levels alone on its
                own row -- the same defect #1261 was filed against. 5.5rem (88px) fits all 3 in either
                context with room to spare (real-browser-measured: `frontend/test/realGridLayout.js`,
                used by this component's own test suite) without cramping the labels.
              -->
              <div
                class="classification-grid grid gap-x-4 gap-y-1"
                style="grid-template-columns: repeat(auto-fit, minmax(5.5rem, 1fr))">
                <w-checkbox
                  v-for="level of adminStore.classificationLevels"
                  :key="level.id"
                  v-model="state.keyClassifications"
                  :val="level.id"
                  :label="level.name" />
              </div>
              <div class="text-caption text-grey mt-1">
                {{ t(`profile.api.newKeyClassificationLevelsHint`) }}
              </div>
            </w-item-section>
          </w-item>
        </div>
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
import ApiKeyScopePicker from './ApiKeyScopePicker.vue'
import { apiErrorMessage } from '@/helpers/apiError'
import { useAdminStore } from '@/stores/admin'

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptName.value
})

// I18N

const { t } = useI18n()

// STORES

const adminStore = useAdminStore()

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
  // -> The checked ids of the classification checkbox grid, initialized to every level once
  //    `adminStore.classificationLevels` loads (see `onMounted`) -- all-checked, same as "No Limit"
  //    was before this existed. See `allowedClassifications` below for what actually gets sent.
  keyClassifications: [],
  loading: 0
})

const expirations = [
  { value: '30d', text: t('profile.api.expiration30d') },
  { value: '90d', text: t('profile.api.expiration90d') },
  { value: '180d', text: t('profile.api.expiration180d') },
  { value: '1y', text: t('profile.api.expiration1y') },
  { value: '3y', text: t('profile.api.expiration3y') }
]

// REFS

const createKeyForm = ref(null)
const iptName = ref(null)

// COMPUTED

/** The site select's own "All Sites" entry (`id: null`) is prepended -- see the field's template comment. */
const siteOptions = computed(() => {
  return [{ id: null, title: t('profile.api.newKeySiteAllSites') }, ...state.sites]
})

/**
 * What actually reaches the API (OpenProject #1205): `null` when every currently known level is
 * checked -- equivalent to the old "No Limit" default, and it stays that way against a level added
 * later too, exactly like a token created before this feature existed. Anything less than every
 * level checked is sent as the explicit array of checked ids, which only narrows.
 */
const allowedClassifications = computed(() => {
  const allIds = adminStore.classificationLevels.map((level) => level.id)
  const isEveryLevelChecked = allIds.every((id) => state.keyClassifications.includes(id))
  return isEveryLevelChecked ? null : state.keyClassifications
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
        allowedClassifications: allowedClassifications.value,
        siteId: state.keySiteId
      }
    }).json()
    if (!resp?.ok || !resp?.key) {
      throw new Error(resp?.message || t('common.error.unexpected'))
    }
    notify({
      type: 'positive',
      message: t('profile.api.createSuccess')
    })
    // -> The token exists only in this response, so hand it straight to the copy dialog -- same
    //    generic dialog the admin form reuses, only with the `profile.api.*` vocabulary so it calls
    //    this an "Access Token" rather than the admin flow's "API Key".
    dialog({
      component: ApiKeyCopyDialog,
      componentProps: {
        keyValue: resp.key,
        labelPrefix: 'profile.api'
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

onMounted(async () => {
  loadSites()
  state.loading++
  try {
    await adminStore.fetchClassificationLevels()
  } catch {
    // -> Same read-access-blind-eye treatment as `loadSites()` above -- the level list is
    //    public-access (`GET /classification-levels` needs no permission), but this stays defensive
    //    either way, leaving the checkbox grid empty rather than surfacing an error.
  }
  // -> All-checked default (OpenProject #1205), equivalent to the old "No Limit" -- set only after
  //    the levels are known, since the checkbox grid above has nothing to check before then.
  state.keyClassifications = adminStore.classificationLevels.map((level) => level.id)
  state.loading--
})
</script>
