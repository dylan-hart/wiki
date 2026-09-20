<template>
  <w-dialog v-model="dialogVisible" :aria-label="t(`admin.api.newKeyTitle`)" @hide="onDialogHide">
    <w-card style="min-width: 650px">
      <w-card-section class="card-header">
        <w-icon name="tabler:plus" size="sm" class="me-2" />
        <span>{{ t(`admin.api.newKeyTitle`) }}</span>
      </w-card-section>
      <!--
        No `self-start` on the icons: top-aligning is for a row whose main section is TALLER than the
        field it holds -- a hint line underneath, or a stack of several controls. Every field here
        passes `hide-bottom-space`, so each row is the field alone and `self-start` lifts the icon
        above the field it labels.
      -->
      <w-form ref="createKeyForm" class="py-2" @submit="create">
        <w-item>
          <blueprint-icon icon="tabler:key" />
          <w-item-section>
            <w-input
              ref="iptName"
              v-model="state.keyName"
              dense
              :rules="keyNameValidation"
              hide-bottom-space
              :label="t(`admin.api.newKeyName`)"
              :hint="t(`admin.api.newKeyNameHint`)"
              lazy-rules="ondemand" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="tabler:calendar-time" />
          <w-item-section>
            <!--
              Single-select: a key has one lifetime, and `multiple` against a string model renders
              the default as a stray chip.
            -->
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
              :label="t(`admin.api.newKeyExpiration`)"
              :hint="t(`admin.api.newKeyExpirationHint`)" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="tabler:home" />
          <w-item-section>
            <!--
              Single-select: a key is pinned to one site or none. `null` (the prepended "All Sites"
              entry) is instance-wide.
            -->
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
              :label="t(`admin.api.newKeySite`)"
              :hint="t(`admin.api.newKeySiteHint`)"
              :loading="state.loadingSites" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="tabler:shield-lock" />
          <w-item-section>
            <w-select
              v-model="state.keyGroups"
              :options="state.groups"
              multiple
              map-options
              emit-value
              option-value="id"
              option-label="name"
              options-dense
              dense
              :rules="keyGroupsValidation"
              hide-bottom-space
              :label="t(`admin.api.permissionGroups`)"
              :hint="t(`admin.api.newKeyGroupHint`)"
              lazy-rules="ondemand"
              :loading="state.loadingGroups">
              <template #selected>
                <span v-if="state.keyGroups.length > 1" class="text-caption">
                  <i18n-t keypath="admin.api.groupsSelected" scope="global">
                    <template #count>
                      <strong>{{ state.keyGroups.length }}</strong>
                    </template>
                  </i18n-t>
                </span>
                <span v-else-if="state.keyGroups.length === 1" class="text-caption">
                  <i18n-t keypath="admin.api.groupSelected" scope="global">
                    <template #group>
                      <strong>{{ selectedGroupName }}</strong>
                    </template>
                  </i18n-t>
                </span>
                <span v-else />
              </template>
            </w-select>
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="tabler:lock" />
          <w-item-section>
            <!--
              Left empty, a key carries the full union of its groups' permissions; selecting
              anything narrows it. The API always intersects this list against what the groups
              actually grant, so a permission picked here that no selected group holds still grants
              nothing (`apiKeys.narrowToScope`, backend).
            -->
            <div class="text-caption mb-1">{{ t(`admin.api.newKeyPermissionScopes`) }}</div>
            <api-key-scope-picker v-model="state.keyScope" />
            <div class="text-caption text-grey mt-1">{{ t(`admin.api.newKeyScopeHint`) }}</div>
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="tabler:shield-check" />
          <w-item-section>
            <!--
              Every level starts checked: the key may reach anything its scope and its groups' rules
              otherwise grant. Unchecking a level narrows the key -- it may never be granted a page
              permission on a page classified at an unchecked level, whatever the rules say.
            -->
            <div class="text-caption mb-1">{{ t(`admin.api.newKeyClassificationLevels`) }}</div>
            <div
              class="classification-grid grid gap-x-4 gap-y-1"
              style="grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr))">
              <w-checkbox
                v-for="level of adminStore.classificationLevels"
                :key="level.id"
                v-model="state.keyClassifications"
                :val="level.id"
                :label="level.name" />
            </div>
            <div class="text-caption text-grey mt-1">
              {{ t(`admin.api.newKeyClassificationLevelsHint`) }}
            </div>
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
import { computed, onMounted, ref } from 'vue'

import ApiKeyScopePicker from './ApiKeyScopePicker.vue'
import { useApiKeyCreateForm } from '@/composables/apiKeyCreateForm'
import { GUESTS_GROUP_ID } from '@/helpers/systemIds'
import { apiErrorMessage } from '@/helpers/apiError'
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
  Everything but the groups picker is shared with the self-service form
  (`composables/apiKeyCreateForm.js`). Groups are admin-only: a personal token always carries its
  creator's own permissions, so there is nothing to pick there.
*/
const { state, expirations, siteOptions, keyNameValidation, create } = useApiKeyCreateForm({
  endpoint: 'api-keys',
  i18nPrefix: 'admin.api',
  form: () => createKeyForm.value,
  onOk: onDialogOK,
  t,
  extraState: {
    keyGroups: [],
    groups: [],
    loadingGroups: false
  },
  extraJson: (formState) => ({ groups: formState.keyGroups })
})

const selectedGroupName = computed(() => {
  return state.groups.filter((g) => g.id === state.keyGroups[0])[0]?.name
})

const keyGroupsValidation = [(val) => val.length > 0 || t('admin.api.groupsMissing')]

async function loadGroups() {
  state.loading++
  state.loadingGroups = true
  try {
    const resp = await API_CLIENT.get('groups').json()
    // -> The guests group is anonymous access, so a key carrying its permissions would grant nothing
    //    a caller cannot already do. The API rejects it too.
    state.groups = (resp ?? []).filter((g) => g.id !== GUESTS_GROUP_ID)
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.users.groupsLoadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loadingGroups = false
  state.loading--
}

onMounted(loadGroups)
</script>
