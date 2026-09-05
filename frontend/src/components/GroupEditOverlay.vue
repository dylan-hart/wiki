<template>
  <w-layout container>
    <w-header class="card-header px-4 py-2">
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
          icon="la:redo-alt"
          @click="refresh">
          <w-tooltip anchor="center left" self="center right">{{
            t(`common.actions.refresh`)
          }}</w-tooltip>
        </w-btn>
        <w-btn
          color="white"
          text-color="grey-7"
          :label="t(`common.actions.close`)"
          icon="la:times"
          @click="close" />
        <w-btn
          color="positive"
          text-color="white"
          :label="t(`common.actions.save`)"
          icon="la:check"
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
      <!-- ----------------------------------------------------------------------- -->
      <!-- USERS -->
      <!-- ----------------------------------------------------------------------- -->
      <!--
        Ahead of the loading page below, and keyed off the overlay's own id rather than the fetched
        record: the members list is the one section that reads nothing OF the group, so it has
        never had a reason to wait on `fetchGroup` -- and waiting would also unmount and refetch it
        each time that request runs.
      -->
      <group-users-panel
        v-if="route.params.section === `users`"
        :group-id="adminStore.overlayOpts.id"
        :can-manage="canManage"
        @update:total="state.usersTotal = $event" />
      <w-page v-else-if="state.isLoading" />
      <!-- ----------------------------------------------------------------------- -->
      <!-- OVERVIEW -->
      <!-- ----------------------------------------------------------------------- -->
      <w-page v-else-if="route.params.section === `overview`">
        <div class="p-4">
          <div class="grid grid-cols-12 gap-4">
            <div class="col-span-12 lg:col-span-8">
              <w-card class="shadow-1 pb-2">
                <w-card-header>{{ t('admin.groups.general') }}</w-card-header>
                <w-item>
                  <blueprint-icon icon="team" />
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
                  <blueprint-icon icon="double-right" />
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
                  <blueprint-icon icon="chevron-right" />
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
                  <blueprint-icon icon="exit" />
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
                  <blueprint-icon icon="team" :hue-rotate="-45" />
                  <w-item-section>
                    <w-item-label>{{ t(`common.field.id`) }}</w-item-label>
                    <w-item-label
                      ><strong>{{ state.group.id }}</strong></w-item-label
                    >
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="calendar-plus" :hue-rotate="-45" />
                  <w-item-section>
                    <w-item-label>{{ t(`common.field.createdOn`) }}</w-item-label>
                    <w-item-label>
                      <strong>{{ humanizeDate(t, state.group.createdAt) }}</strong>
                    </w-item-label>
                  </w-item-section>
                </w-item>
                <w-separator class="my-2" inset />
                <w-item>
                  <blueprint-icon icon="summertime" :hue-rotate="-45" />
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
      <!-- ----------------------------------------------------------------------- -->
      <!-- RULES -->
      <!-- ----------------------------------------------------------------------- -->
      <group-rules-editor
        v-else-if="route.params.section === `rules`"
        v-model:rules="state.group.rules"
        :is-guest-group="isGuestGroup"
        :can-manage="canManage" />
      <!-- ----------------------------------------------------------------------- -->
      <!-- PERMISSIONS -->
      <!-- ----------------------------------------------------------------------- -->
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
                      <w-icon name="la:snowflake" color="primary" size="sm" />
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

// STORES

const adminStore = useAdminStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()
const route = useRoute()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  group: {
    rules: []
  },
  /**
   * A deep-cloned snapshot of `state.group` as last fetched (or last saved) -- what `save()` diffs
   * against, so it PUTs only the fields the admin actually changed rather than resubmitting the
   * entire fetched group verbatim (OpenProject #2555: stale/legacy data in an untouched field --
   * e.g. a pre-existing group's `permissions` -- must not be able to trip a save of something else
   * entirely).
   */
  original: null,
  isLoading: false,
  /**
   * Members, for the section badge only -- seeded from the group's own `userCount` and kept up to
   * date by `GroupUsersPanel`, which owns the listing itself.
   */
  usersTotal: 0
})

/**
 * The fields `save()` may PUT, each with how to normalize a value before comparing/sending it --
 * `undefined` (never fetched, or cleared client-side) and the field's own empty default must compare
 * equal, or an untouched field would look "changed" purely from that difference.
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
  { key: 'overview', text: t('admin.groups.overview'), icon: 'la:users' },
  { key: 'rules', text: t('admin.groups.rules'), icon: 'la:file-invoice', rulesTotal: true },
  {
    key: 'permissions',
    text: t('admin.groups.permissions'),
    icon: 'la:list-alt',
    excludeGuests: true
  },
  {
    key: 'users',
    text: t('admin.groups.users'),
    icon: 'la:user',
    usersTotal: true,
    excludeGuests: true
  }
]

/*
  Structural data only -- no English text. `title:`/`hint:` are resolved from
  `admin.groups.permissions.<permission>.title` / `.hint` in the `permissions` computed below, where
  `t()` is available; a plain module-scope array can only ever hold a literal, not a reactive
  translation, so it stays purely structural here.
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

// VALIDATION RULES

const groupNameValidation = [(val) => /^[^<>"]+$/.test(val) || t('admin.groups.nameInvalidChars')]

// COMPUTED

/*
  `read:groups` opens this overlay read-only: saving a group, and assigning a user to one, need
  `manage:groups` / `write:groups` (see `api/groups.ts`), so the actions that perform one are hidden
  rather than left to fail at the API. Exporting rules stays -- it only reads what is on screen.
*/
const canManage = computed(() => userStore.can('manage:groups'))

/*
  `manage:system` is the one permission a `manage:groups` holder may not move: granting it hands over
  the instance, revoking it locks the real administrators out. `api/groups.ts` refuses the change
  either way, so the toggle is held rather than left to fail on save -- every OTHER permission on such
  a group stays editable, which is why this is per-permission and not a read-only group.
*/
function isSystemPermissionLocked(permission) {
  return permission === 'manage:system' && !userStore.can('manage:system')
}

const isGuestGroup = computed(() => {
  return adminStore.overlayOpts.id === GUESTS_GROUP_ID
})

// WATCHERS

watch(() => route.params.section, checkRoute)

// METHODS

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
      message: err.message
    })
  }
  state.isLoading = false
}

async function save() {
  state.isLoading = true
  try {
    // -> Diff-and-send: only a field that actually differs from the last-fetched (or last-saved)
    //    snapshot is included, so stale/legacy data sitting untouched in another field (see
    //    OpenProject #2555) can never ride along on a save of something else.
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
    // -> Merge the just-sent patch onto the snapshot rather than refetching, so a second save in the
    //    same session diffs correctly with no extra round trip.
    state.original = { ...state.original, ...cloneDeep(patch) }
    notify({
      type: 'positive',
      message: t('admin.groups.saveSuccess')
    })
  } catch (err) {
    // -> ky throws above 400 with the reason in the body, which is where the server explains itself;
    //    some error codes have a nicer translation under `admin.groups.*`, so look it up before
    //    falling back to the server's own message
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

// MOUNTED

onMounted(() => {
  checkRoute()
  fetchGroup()
})
</script>
