<template>
  <w-dialog v-model="dialogVisible" @hide="onDialogHide">
    <w-card style="min-width: 650px">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-plus-plus.svg" size="sm" class="mr-2" />
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
          <blueprint-icon icon="grand-master-key" />
          <w-item-section>
            <w-input
              ref="iptName"
              v-model="state.keyName"
              outlined
              dense
              :rules="keyNameValidation"
              hide-bottom-space
              :label="t(`admin.api.newKeyName`)"
              :hint="t(`admin.api.newKeyNameHint`)"
              lazy-rules="ondemand"
              autofocus />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="schedule" />
          <w-item-section>
            <!--
              Single-select: a key has one lifetime. It was declared `multiple` against a string
              model, which showed the default as a stray chip and let several be picked at once.
            -->
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
              :label="t(`admin.api.newKeyExpiration`)"
              :hint="t(`admin.api.newKeyExpirationHint`)" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="home" />
          <w-item-section>
            <!--
              Single-select, same reasoning as expiration above: a key is pinned to one site or none.
              `null` (the "All Sites" entry prepended below) is instance-wide -- today's only
              behavior, and what a key created before site-pinning existed still has.
            -->
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
              :label="t(`admin.api.newKeySite`)"
              :hint="t(`admin.api.newKeySiteHint`)"
              :loading="state.loadingSites" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="access" />
          <w-item-section>
            <w-select
              v-model="state.keyGroups"
              outlined
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
          <blueprint-icon icon="lock" />
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
            <div class="text-caption q-mb-xs">{{ t(`admin.api.newKeyPermissionScopes`) }}</div>
            <api-key-scope-picker v-model="state.keyScope" />
            <div class="text-caption text-grey mt-1">{{ t(`admin.api.newKeyScopeHint`) }}</div>
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="secure" />
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
            <div class="text-caption q-mb-xs">{{ t(`admin.api.newKeyClassificationLevels`) }}</div>
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

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// I18N

const { t } = useI18n()

// STORES

const adminStore = useAdminStore()

// DATA

const state = reactive({
  keyName: '',
  keyExpiration: '90d',
  keyGroups: [],
  // -> Empty means unscoped (null on the wire): the key carries the full union of its groups, same
  //    as a key created before scoping existed. Anything picked here narrows it -- see the field's
  //    own comment in the template.
  keyScope: [],
  // -> null is the "All Sites" entry -- instance-wide, same as a key created before site-pinning
  //    existed.
  keySiteId: null,
  groups: [],
  loadingGroups: false,
  sites: [],
  loadingSites: false,
  // -> The checked ids of the classification checkbox grid, initialized to every level once
  //    `adminStore.classificationLevels` loads (see `onMounted`) -- all-checked, same as "No Limit"
  //    was before this existed. See `allowedClassifications` below for what actually gets sent.
  keyClassifications: [],
  loading: 0
})

/**
 * The guests group is anonymous access, so a key carrying its permissions would grant nothing a
 * caller cannot already do. Its ID is fixed at install (`systemIds.guestsGroupId` in base.yml), and
 * the API rejects it too.
 */
const GUESTS_GROUP_ID = '10000000-0000-4000-8000-000000000001'

const expirations = [
  { value: '30d', text: t('admin.api.expiration30d') },
  { value: '90d', text: t('admin.api.expiration90d') },
  { value: '180d', text: t('admin.api.expiration180d') },
  { value: '1y', text: t('admin.api.expiration1y') },
  { value: '3y', text: t('admin.api.expiration3y') }
]

// REFS

const createKeyForm = ref(null)
const iptName = ref(null)

// COMPUTED

const selectedGroupName = computed(() => {
  return state.groups.filter((g) => g.id === state.keyGroups[0])[0]?.name
})

/** The site select's own "All Sites" entry (`id: null`) is prepended -- see the field's template comment. */
const siteOptions = computed(() => {
  return [{ id: null, title: t('admin.api.newKeySiteAllSites') }, ...state.sites]
})

/**
 * What actually reaches the API (OpenProject #1205): `null` when every currently known level is
 * checked -- equivalent to the old "No Limit" default, and it stays that way against a level added
 * later too, exactly like a key created before this feature existed. Anything less than every level
 * checked is sent as the explicit array of checked ids, which only narrows.
 */
const allowedClassifications = computed(() => {
  const allIds = adminStore.classificationLevels.map((level) => level.id)
  const isEveryLevelChecked = allIds.every((id) => state.keyClassifications.includes(id))
  return isEveryLevelChecked ? null : state.keyClassifications
})

// VALIDATION RULES

const keyNameValidation = [
  (val) => val.length > 0 || t('admin.api.nameMissing'),
  (val) => /^[^<>"]+$/.test(val) || t('admin.api.nameInvalidChars')
]

const keyGroupsValidation = [(val) => val.length > 0 || t('admin.api.groupsMissing')]

// METHODS

async function loadGroups() {
  state.loading++
  state.loadingGroups = true
  try {
    const resp = await API_CLIENT.get('groups').json()
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

async function loadSites() {
  state.loading++
  state.loadingSites = true
  try {
    const resp = await API_CLIENT.get('sites').json()
    state.sites = resp ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.api.loadFailed'),
      caption: err.message
    })
  }
  state.loadingSites = false
  state.loading--
}

async function create() {
  state.loading++
  try {
    const isFormValid = await createKeyForm.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('admin.api.createInvalidData'))
    }
    const resp = await API_CLIENT.post('api-keys', {
      json: {
        name: state.keyName,
        expiration: state.keyExpiration,
        groups: state.keyGroups,
        scope: state.keyScope.length > 0 ? state.keyScope : null,
        allowedClassifications: allowedClassifications.value,
        siteId: state.keySiteId
      }
    }).json()
    if (!resp?.ok || !resp?.key) {
      throw new Error(resp?.message || 'An unexpected error occured.')
    }
    notify({
      type: 'positive',
      message: t('admin.api.createSuccess')
    })
    // -> The token exists only in this response, so hand it straight to the copy dialog
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

onMounted(async () => {
  loadGroups()
  loadSites()
  state.loading++
  try {
    await adminStore.fetchClassificationLevels()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.api.loadFailed'),
      caption: err.message
    })
  }
  // -> All-checked default (OpenProject #1205), equivalent to the old "No Limit" -- set only after
  //    the levels are known, since the checkbox grid above has nothing to check before then.
  state.keyClassifications = adminStore.classificationLevels.map((level) => level.id)
  state.loading--
})
</script>
