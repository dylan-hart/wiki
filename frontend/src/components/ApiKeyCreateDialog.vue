<template>
  <w-dialog v-model="dialogVisible" :aria-label="t(`admin.api.newKeyTitle`)" @hide="onDialogHide">
    <w-card style="min-width: 650px">
      <w-card-section class="card-header">
        <w-icon name="tabler:plus" size="sm" class="me-2" />
        <span>{{ t(`admin.api.newKeyTitle`) }}</span>
      </w-card-section>
      <!--
        No `self-start` on the icons. Top-aligning one is for a row whose main section is TALLER than the
        field it holds -- a field showing a hint line underneath, or a stack of several controls -- where
        the icon belongs against the first of them. Every field here passes `hide-bottom-space`, which
        suppresses that hint line, so each row is the field alone and `self-start` lifted the icon 8px
        above the field it labels. Centred is what lines the two up, as in `UserCreateDialog`.
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
              Single-select: a key has one lifetime. It was declared `multiple` against a string
              model, which showed the default as a stray chip and let several be picked at once.
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
              Single-select, same reasoning as expiration above: a key is pinned to one site or none.
              `null` (the "All Sites" entry prepended below) is instance-wide -- today's only
              behavior, and what a key created before site-pinning existed still has.
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
              Left empty, a key carries the full union of its groups' permissions -- exactly what
              creating a key did before scoping existed, so an operator who never touches this field
              gets identical behavior. Selecting anything narrows the key: the API always intersects
              this list against what the groups actually grant, so a permission picked here that no
              selected group holds still grants nothing (`apiKeys.narrowToScope`, backend).

              OpenProject #1272: a verb-grouped tri-state tree, replacing the earlier flat
              `w-select multiple use-chips` field -- see `ApiKeyScopePicker.vue`.
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
              OpenProject #1205: a checkbox grid replacing the earlier #1055 single-select "ceiling" --
              Dylan's review feedback was that "No Limit" vs. picking one named level read as a
              confusing UX. Every level starts checked, which is exactly equivalent to the old "No
              Limit" default (see `allowedClassifications` below): the key may reach anything its
              scope/groups' rules otherwise grant. Unchecking a level narrows the key -- it may never
              be granted a page permission on a page classified at an unchecked level, whatever the
              rules say.
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
  The lifetimes, the site picker, the classification grid, the name rules and the create round trip
  are shared with the self-service form (`ProfileApiKeyCreateDialog.vue`) -- see
  `composables/apiKeyCreateForm.js`. The groups picker below is what only an admin-issued key has:
  a personal token always carries its creator's own permissions, so there is nothing to pick there.
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

// COMPUTED

const selectedGroupName = computed(() => {
  return state.groups.filter((g) => g.id === state.keyGroups[0])[0]?.name
})

// VALIDATION RULES

const keyGroupsValidation = [(val) => val.length > 0 || t('admin.api.groupsMissing')]

// METHODS

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
      caption: err.message
    })
  }
  state.loadingGroups = false
  state.loading--
}

// MOUNTED

onMounted(loadGroups)
</script>
