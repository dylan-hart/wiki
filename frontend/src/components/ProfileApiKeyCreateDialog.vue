<template>
  <w-dialog v-model="dialogVisible" :aria-label="t(`profile.api.newKeyTitle`)" @hide="onDialogHide">
    <w-card style="width: 700px; max-width: 94vw">
      <w-card-section class="card-header">
        <w-icon name="cardinal:add" size="sm" class="me-2" />
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
import { ref } from 'vue'

import ApiKeyScopePicker from './ApiKeyScopePicker.vue'
import { useApiKeyCreateForm } from '@/composables/apiKeyCreateForm'
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

// REFS

const createKeyForm = ref(null)
const iptName = ref(null)

// FORM

/*
  Everything below the template is shared with the admin-issued form
  (`ApiKeyCreateDialog.vue`) -- see `composables/apiKeyCreateForm.js`. `silentLoadErrors` is the one
  difference that is not vocabulary: `GET /sites` needs `read:sites`/`access:admin`, which an
  ordinary self-service user does not hold, so failing there is the expected common case for this
  dialog's actual audience. It degrades to a site picker showing only "All Sites", which still
  creates a perfectly good token, rather than an error worth alarming them with. The classification
  levels are public-access and should always load, but ride the same blind eye rather than taking the
  form down.
*/
const { state, expirations, siteOptions, keyNameValidation, create } = useApiKeyCreateForm({
  endpoint: 'users/profile/api-keys',
  i18nPrefix: 'profile.api',
  form: () => createKeyForm.value,
  onOk: onDialogOK,
  t,
  silentLoadErrors: true
})
</script>
