<template>
  <w-layout container>
    <w-header class="card-header">
      <w-icon name="tabler:users" left size="md" />
      <div>
        <span>{{ t(`admin.groups.edit`) }}</span>
        <div class="text-caption">{{ state.group.name }}</div>
      </div>
      <w-space />
      <w-btn-group>
        <w-btn
          color="grey-6"
          text-color="white"
          :aria-label="t(`common.actions.refresh`)"
          icon="tabler:refresh"
          @click="refresh">
          <w-tooltip anchor="center left" self="center right">{{
            t(`common.actions.refresh`)
          }}</w-tooltip>
        </w-btn>
        <w-btn
          color="white"
          text-color="grey-7"
          :label="t(`common.actions.close`)"
          icon="tabler:x"
          @click="close" />
        <w-btn
          color="positive"
          text-color="white"
          :label="t(`common.actions.save`)"
          icon="tabler:check"
          :loading="state.isLoading"
          v-if="canManage"
          @click="save" />
      </w-btn-group>
    </w-header>
    <w-drawer class="bg-dark-6" :model-value="true" :width="250" dark>
      <w-list padding dark v-show="!state.isLoading">
        <template v-for="sc of sections" :key="`section-` + sc.key">
          <w-item
            v-if="!(isGuestGroup && sc.excludeGuests)"
            clickable
            :to="{ params: { section: sc.key } }"
            active-class="bg-primary text-white"
            :disabled="sc.disabled">
            <w-item-section side><w-icon :name="sc.icon" color="white" /></w-item-section>
            <w-item-section>{{ sc.text }}</w-item-section>
            <w-item-section side v-if="sc.usersTotal">
              <w-badge color="dark-3" :label="state.usersTotal" />
            </w-item-section>
            <w-item-section side v-if="sc.rulesTotal && state.group.rules">
              <w-badge color="dark-3" :label="state.group.rules.length" />
            </w-item-section>
          </w-item>
        </template>
      </w-list>
    </w-drawer>
    <w-page-container>
      <!--
        Ahead of the loading page below, and keyed off the overlay's own id rather than the fetched
        record: the members list reads nothing OF the group, and waiting on `fetchGroup` would
        unmount and refetch it every time that request runs.
      -->
      <group-users-panel
        v-if="route.params.section === `users`"
        :group-id="adminStore.overlayOpts.id"
        :can-manage="canManage"
        @update:total="state.usersTotal = $event" />
      <w-page v-else-if="state.isLoading" />
      <w-page v-else-if="route.params.section === `overview`">
        <div class="p-4">
          <div class="grid grid-cols-12 gap-4">
            <div class="col-span-12 lg:col-span-8">
              <w-card class="shadow-1 pb-2">
                <w-card-header>{{ t('admin.groups.general') }}</w-card-header>
                <w-item>
                  <blueprint-icon icon="tabler:users" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.groups.name`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.groups.nameHint`) }}</w-item-label>
                  </w-item-section>
                  <w-item-section>
                    <w-input
                      v-model="state.group.name"
                      dense
                      :rules="groupNameValidation"
                      hide-bottom-space
                      :aria-label="t(`admin.groups.name`)"
                      :disabled="isGuestGroup" />
                  </w-item-section>
                </w-item>
              </w-card>
              <w-card class="shadow-1 pb-2 mt-4" v-if="!isGuestGroup">
                <w-card-header>{{ t('admin.groups.authBehaviors') }}</w-card-header>
                <w-item>
                  <blueprint-icon icon="tabler:chevrons-right" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.groups.redirectOnLogin`) }}</w-item-label>
                    <w-item-label caption>{{ t(`admin.groups.redirectOnLoginHint`) }}</w-item-label>
                  </w-item-section>
                  <w-item-section>
                    <w-input
                      v-model="state.group.redirectOnLogin"
                      dense
                      :aria-label="t(`admin.groups.redirectOnLogin`)" />
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="tabler:chevron-right" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.groups.redirectOnFirstLogin`) }}</w-item-label>
                    <w-item-label caption>{{
                      t(`admin.groups.redirectOnFirstLoginHint`)
                    }}</w-item-label>
                  </w-item-section>
                  <w-item-section>
                    <w-input
                      v-model="state.group.redirectOnFirstLogin"
                      dense
                      :aria-label="t(`admin.groups.redirectOnLogin`)" />
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="tabler:logout" />
                  <w-item-section>
                    <w-item-label>{{ t(`admin.groups.redirectOnLogout`) }}</w-item-label>
                    <w-item-label caption>{{
                      t(`admin.groups.redirectOnLogoutHint`)
                    }}</w-item-label>
                  </w-item-section>
                  <w-item-section>
                    <w-input
                      v-model="state.group.redirectOnLogout"
                      dense
                      :aria-label="t(`admin.groups.redirectOnLogout`)" />
                  </w-item-section>
                </w-item>
              </w-card>
            </div>
            <div class="col-span-12 lg:col-span-4">
              <w-card class="shadow-1 pb-2">
                <w-card-header>{{ t('admin.groups.info') }}</w-card-header>
                <w-item>
                  <blueprint-icon icon="tabler:users" />
                  <w-item-section>
                    <w-item-label>{{ t(`common.field.id`) }}</w-item-label>
                    <w-item-label
                      ><strong>{{ state.group.id }}</strong></w-item-label
                    >
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="tabler:calendar-plus" />
                  <w-item-section>
                    <w-item-label>{{ t(`common.field.createdOn`) }}</w-item-label>
                    <w-item-label>
                      <strong>{{ humanizeDate(t, state.group.createdAt) }}</strong>
                    </w-item-label>
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="tabler:sun" />
                  <w-item-section>
                    <w-item-label>{{ t(`common.field.lastUpdated`) }}</w-item-label>
                    <w-item-label>
                      <strong>{{ humanizeDate(t, state.group.updatedAt) }}</strong>
                    </w-item-label>
                  </w-item-section>
                </w-item>
              </w-card>
            </div>
          </div>
        </div>
      </w-page>
      <group-rules-editor
        v-else-if="route.params.section === `rules`"
        v-model:rules="state.group.rules"
        :is-guest-group="isGuestGroup"
        :can-manage="canManage" />
      <w-page v-else-if="route.params.section === `permissions`">
        <div class="p-4">
          <div class="grid grid-cols-12 gap-4">
            <div class="col-span-12 lg:col-span-6">
              <w-card class="shadow-1 pb-2">
                <w-card-header>
                  {{ t(`admin.groups.permissions`) }}
                </w-card-header>
                <template v-for="(perm, idx) of permissions" :key="perm.permission">
                  <w-item tag="label">
                    <w-item-section class="items-center" style="flex: 0 0 40px">
                      <w-icon name="tabler:snowflake" color="primary" size="sm" />
                    </w-item-section>
                    <w-item-section>
                      <w-item-label>{{ perm.permission }}</w-item-label>
                      <w-item-label caption>{{ perm.hint }}</w-item-label>
                    </w-item-section>
                    <w-item-section avatar>
                      <w-toggle
                        v-model="state.group.permissions"
                        :val="perm.permission"
                        :disabled="isSystemPermissionLocked(perm.permission)"
                        :aria-label="t(`admin.general.allowComments`)" />
                    </w-item-section>
                  </w-item>
                  <w-separator class="my-2" inset v-if="idx < permissions.length - 1" />
                </template>
              </w-card>
            </div>
          </div>
        </div>
      </w-page>
    </w-page-container>
  </w-layout>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'

import { cloneDeep } from 'es-toolkit/object'
import { isEqual } from 'es-toolkit/predicate'

import { notify } from '@/composables/notify'

import { useAdminStore } from '@/stores/admin'
import { useUserStore } from '@/stores/user'

import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDate } from '@/helpers/datetime'
import { GUESTS_GROUP_ID } from '@/helpers/systemIds'

import GroupRulesEditor from '@/components/GroupRulesEditor.vue'
import GroupUsersPanel from '@/components/GroupUsersPanel.vue'

const adminStore = useAdminStore()
const userStore = useUserStore()

const router = useRouter()
const route = useRoute()

const { t } = useI18n()

const state = reactive({
  group: {
    rules: []
  },
  /**
   * Deep-cloned snapshot as last fetched or saved, so `save()` can PUT only what the admin changed:
   * data a schema now rejects, sitting untouched in another field, must not fail an unrelated save.
   */
  original: null,
  isLoading: false,
  /** For the section badge only; `GroupUsersPanel` owns the listing and keeps this current. */
  usersTotal: 0
})

/**
 * `normalize` exists so `undefined` (never fetched, or cleared client-side) and the field's empty
 * default compare equal -- otherwise an untouched field reads as changed.
 */
const EDITABLE_FIELDS = [
  { key: 'name', normalize: (v) => v ?? '' },
  { key: 'redirectOnLogin', normalize: (v) => v ?? '' },
  { key: 'redirectOnFirstLogin', normalize: (v) => v ?? '' },
  { key: 'redirectOnLogout', normalize: (v) => v ?? '' },
  { key: 'permissions', normalize: (v) => v ?? [] },
  { key: 'rules', normalize: (v) => v ?? [] }
]

const sections = [
  { key: 'overview', text: t('admin.groups.overview'), icon: 'tabler:users' },
  { key: 'rules', text: t('admin.groups.rules'), icon: 'tabler:file-invoice', rulesTotal: true },
  {
    key: 'permissions',
    text: t('admin.groups.permissions'),
    icon: 'tabler:list-details',
    excludeGuests: true
  },
  {
    key: 'users',
    text: t('admin.groups.users'),
    icon: 'tabler:user',
    usersTotal: true,
    excludeGuests: true
  }
]

/*
  Structural only: a module-scope array can hold a literal but not a reactive translation, so
  titles and hints resolve through `t()` in the `permissions` computed below instead.
*/
const PERMISSIONS_DATA = [
  { permission: 'access:admin', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'read:users', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'manage:users', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'read:groups', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'manage:groups', warning: true, restrictedForSystem: true, disabled: false },
  { permission: 'manage:navigation', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'manage:theme', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'manage:sites', warning: true, restrictedForSystem: true, disabled: false },
  { permission: 'manage:glossary', warning: false, restrictedForSystem: true, disabled: false },
  { permission: 'manage:system', warning: true, restrictedForSystem: true, disabled: true }
]

const permissions = computed(() =>
  PERMISSIONS_DATA.map((perm) => ({
    ...perm,
    hint: t(`admin.groups.permissions.${perm.permission}.hint`)
  }))
)

const groupNameValidation = [(val) => /^[^<>"]+$/.test(val) || t('admin.groups.nameInvalidChars')]

/*
  `read:groups` opens this overlay read-only: saving a group and assigning a user both need
  `manage:groups`, so those actions are hidden rather than left to fail at the API.
*/
const canManage = computed(() => userStore.can('manage:groups'))

/*
  `manage:system` is the one permission a `manage:groups` holder may not move: granting it hands over
  the instance, revoking it locks the real administrators out. The API refuses it either way, so the
  toggle is held here -- per permission, since every other one on such a group stays editable.
*/
function isSystemPermissionLocked(permission) {
  return permission === 'manage:system' && !userStore.can('manage:system')
}

const isGuestGroup = computed(() => {
  return adminStore.overlayOpts.id === GUESTS_GROUP_ID
})

watch(() => route.params.section, checkRoute)

function close() {
  adminStore.$patch({ overlay: '' })
}

function checkRoute() {
  if (!route.params.section) {
    router.replace({ params: { section: 'overview' } })
  }
}

function refresh() {
  fetchGroup()
}

async function fetchGroup() {
  state.isLoading = true
  try {
    const resp = await API_CLIENT.get(`groups/${adminStore.overlayOpts.id}`).json()
    if (!resp?.id) {
      throw new Error(t('common.error.unexpected'))
    }
    state.group = resp
    state.original = cloneDeep(resp)
    state.usersTotal = state.group.userCount ?? 0
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}

async function save() {
  state.isLoading = true
  try {
    const patch = {}
    for (const field of EDITABLE_FIELDS) {
      const current = field.normalize(state.group[field.key])
      const original = field.normalize(state.original?.[field.key])
      if (!isEqual(current, original)) {
        patch[field.key] = current
      }
    }

    if (Object.keys(patch).length < 1) {
      state.isLoading = false
      return
    }

    await API_CLIENT.put(`groups/${state.group.id}`, { json: patch }).json()
    // -> Merged onto the snapshot rather than refetched, so a second save in the same session diffs
    //    correctly with no extra round trip.
    state.original = { ...state.original, ...cloneDeep(patch) }
    notify({
      type: 'positive',
      message: t('admin.groups.saveSuccess')
    })
  } catch (err) {
    // -> Some error codes have a nicer translation under `admin.groups.*`; the server's own message
    //    is the fallback for the rest.
    notify({
      type: 'negative',
      message: t(
        `admin.groups.${err.data?.error}`,
        apiErrorMessage(err, t('common.error.unexpected'))
      )
    })
  }
  state.isLoading = false
}

onMounted(() => {
  checkRoute()
  fetchGroup()
})
</script>
