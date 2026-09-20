<template>
  <w-dialog v-model="dialogVisible" :aria-label="t(`profile.api.newKeyTitle`)" @hide="onDialogHide">
    <w-card style="width: 700px; max-width: 94vw">
      <w-card-section class="card-header">
        <w-icon name="tabler:plus" size="sm" class="me-2" />
        <span>{{ t(`profile.api.newKeyTitle`) }}</span>
      </w-card-section>
      <!--
        No groups picker, unlike the admin form (`ApiKeyCreateDialog.vue`): a personal token always
        carries exactly the creating user's own current permissions -- there is nothing to pick,
        only an optional scope to narrow it.
      -->
      <w-card-section class="text-body2 text-grey">
        {{ t(`profile.api.newKeyInfo`) }}
      </w-card-section>
      <w-form ref="createKeyForm" class="py-2" @submit="create">
        <div class="grid grid-cols-1 gap-x-4 md:grid-cols-2">
          <w-item class="md:col-span-2">
            <blueprint-icon icon="tabler:key" />
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
            <blueprint-icon icon="tabler:calendar-time" />
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
            <blueprint-icon icon="tabler:home" />
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
            <blueprint-icon icon="tabler:lock" />
            <w-item-section>
              <div class="text-caption mb-1">{{ t(`profile.api.newKeyPermissionScopes`) }}</div>
              <api-key-scope-picker v-model="state.keyScope" />
              <div class="text-caption text-grey mt-1">{{ t(`profile.api.newKeyScopeHint`) }}</div>
            </w-item-section>
          </w-item>
          <w-item>
            <blueprint-icon icon="tabler:shield-check" />
            <w-item-section>
              <!--
                Every level starts checked: the token may reach anything its own scope and rules
                otherwise grant. Unchecking a level narrows it -- the token is never granted a page
                permission on a page classified at an unchecked level, whatever the rules say.
              -->
              <div class="text-caption mb-1">
                {{ t(`profile.api.newKeyClassificationLevels`) }}
              </div>
              <!--
                A 5.5rem floor, not the 9rem `ApiKeyCreateDialog.vue` uses: this field shares a grid
                row with Permission Scopes, so it gets only about half the dialog's width, where a
                9rem floor fits two columns and strands a third level alone on its own row.
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

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptName.value
})

const { t } = useI18n()

const adminStore = useAdminStore()

const createKeyForm = ref(null)
const iptName = ref(null)

/*
  `silentLoadErrors`: `GET /sites` needs `read:sites`/`access:admin`, which an ordinary self-service
  user does not hold, so failing there is the expected case for this dialog's audience. It degrades
  to a site picker offering only "All Sites", which still creates a perfectly good token.
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
