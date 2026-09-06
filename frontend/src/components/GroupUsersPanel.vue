<template>
  <w-page>
    <w-toolbar :class="dark.isActive ? `bg-dark-3 text-white` : `bg-white text-dark`">
      <div class="text-subtitle1">{{ t('admin.groups.users') }}</div>
      <w-space />
      <w-input
        class="denser fill-outline me-2"
        v-model="state.usersFilter"
        :placeholder="t(`admin.groups.filterUsers`)"
        dense>
        <template #prepend><w-icon name="tabler:search" /></template>
      </w-input>
      <w-btn
        class="me-2 acrylic-btn"
        icon="tabler:refresh"
        flat
        color="slate"
        :aria-label="t(`common.actions.refresh`)"
        @click="refreshUsers" />
      <w-btn
        class="me-1"
        icon="tabler:user-plus"
        :label="t(`admin.groups.assignUser`)"
        color="primary"
        v-if="canManage"
        @click="assignUser" />
    </w-toolbar>
    <w-separator />
    <div class="p-4">
      <w-banner
        v-if="state.syncStrategies.length > 0"
        class="mb-4"
        :class="dark.isActive ? `bg-deep-orange text-white` : `bg-orange-1 text-deep-orange`">
        <i18n-t keypath="admin.groups.syncWarning" tag="span">
          <template #provider
            ><strong>{{
              state.syncStrategies.map((s) => s.displayName).join(', ')
            }}</strong></template
          >
        </i18n-t>
      </w-banner>
      <w-card class="shadow-1">
        <w-table
          :rows="state.users"
          :columns="usersHeaders"
          row-key="id"
          flat
          hide-header
          :loading="state.isLoadingUsers">
          <template #no-data>
            <w-banner :class="dark.isActive ? `bg-negative text-white` : `bg-grey-4 text-grey-9`">{{
              t('admin.groups.usersNone')
            }}</w-banner>
          </template>
          <template #body-cell-id="props">
            <w-td :props="props"><w-icon name="tabler:user" color="primary" size="sm" /></w-td>
          </template>
          <template #body-cell-name="props">
            <w-td :props="props">
              <div class="flex items-center">
                <strong>{{ props.value }}</strong>
                <w-icon class="ms-2" v-if="props.row.isSystem" name="tabler:lock" color="pink" />
                <w-icon class="ms-2" v-if="!props.row.isActive" name="tabler:ban" color="pink" />
              </div>
            </w-td>
          </template>
          <template #body-cell-email="props">
            <w-td :props="props"
              ><em>{{ props.value }}</em></w-td
            >
          </template>
          <template #body-cell-date="props">
            <w-td :props="props">
              <i18n-t class="text-caption" keypath="admin.users.createdAt" tag="div">
                <template #date
                  ><strong>{{ humanizeDate(t, props.value) }}</strong></template
                >
              </i18n-t>
              <i18n-t
                class="text-caption"
                v-if="props.row.lastLoginAt"
                keypath="admin.users.lastLoginAt"
                tag="div">
                <template #date>
                  <strong>{{ humanizeDate(t, props.row.lastLoginAt) }}</strong>
                </template>
              </i18n-t>
            </w-td>
          </template>
          <template #body-cell-edit="props">
            <w-td :props="props">
              <w-btn
                class="acrylic-btn me-2"
                v-if="!props.row.isSystem"
                flat
                :to="`/_admin/users/` + props.row.id"
                icon="tabler:pencil"
                :color="dark.isActive ? `indigo-4` : `indigo`"
                :label="t(`common.actions.edit`)" />
              <!-- Hidden for system users: the guest account's membership is fixed, and the API -->
              <!-- refuses to change it either way -->
              <w-btn
                class="acrylic-btn"
                v-if="!props.row.isSystem && canManage"
                flat
                icon="tabler:user-minus"
                color="accent"
                :aria-label="t(`admin.groups.unassignUser`)"
                @click="unassignUser(props.row)">
                <w-tooltip anchor="center left" self="center right">{{
                  t('admin.groups.unassignUser')
                }}</w-tooltip>
              </w-btn>
            </w-td>
          </template>
        </w-table>
      </w-card>
      <div class="flex items-center justify-center mt-4" v-if="usersTotalPages > 1">
        <w-pagination
          v-model="state.usersPage"
          :max="usersTotalPages"
          :max-pages="9"
          boundary-numbers
          direction-links />
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, watch } from 'vue'

import { confirm, dialog } from '@/composables/dialog'
import { useDark } from '@/composables/dark'
import { notify } from '@/composables/notify'

import UserSearchDialog from '@/components/UserSearchDialog.vue'
import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDate } from '@/helpers/datetime'

/**
 * The members half of `GroupEditOverlay.vue`: one paginated, filterable page of the group's users,
 * plus assigning and unassigning them.
 *
 * Split out of the overlay because none of it is about the group's own record -- it is a second,
 * separately-paged listing that happens to be reached from the same screen, and the only thing it
 * needs from the group is which one it is.
 */

// COMPOSABLES

const dark = useDark()

// I18N

const { t } = useI18n()

// PROPS

const props = defineProps({
  /** The group whose members are listed. */
  groupId: {
    type: String,
    required: true
  },
  /** Whether the viewer holds `manage:groups` -- what gates assigning and unassigning. */
  canManage: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:total'])

// DATA

const state = reactive({
  users: [],
  isLoadingUsers: false,
  usersFilter: '',
  usersPage: 1,
  usersPageSize: 15,
  usersTotal: 0,
  /** Every enabled, mapGroups-on strategy that could revoke this group on a member's next login
   *  (WP #2440) -- see `fetchSyncWarning()`. Empty means this group is not currently synced. */
  syncStrategies: []
})

const usersHeaders = [
  {
    align: 'center',
    field: 'id',
    name: 'id',
    sortable: false,
    style: 'width: 20px'
  },
  {
    label: t('common.field.name'),
    align: 'left',
    field: 'name',
    name: 'name',
    sortable: true
  },
  {
    label: t('admin.users.email'),
    align: 'left',
    field: 'email',
    name: 'email',
    sortable: false
  },
  {
    align: 'left',
    field: 'createdAt',
    name: 'date',
    sortable: false
  },
  {
    label: '',
    align: 'right',
    field: 'edit',
    name: 'edit',
    sortable: false,
    style: 'width: 250px'
  }
]

// COMPUTED

const usersTotalPages = computed(() => {
  if (state.usersTotal < 1) {
    return 0
  }
  return Math.ceil(state.usersTotal / state.usersPageSize)
})

// WATCHERS

watch([() => state.usersPage, () => state.usersFilter], refreshUsers)

// METHODS

async function refreshUsers() {
  state.isLoadingUsers = true
  try {
    const resp = await API_CLIENT.get(`groups/${props.groupId}/users`, {
      searchParams: {
        ...(state.usersFilter ? { filter: state.usersFilter } : {}),
        page: state.usersPage,
        limit: state.usersPageSize
      }
    }).json()
    if (!Array.isArray(resp?.users)) {
      throw new Error(t('common.error.unexpected'))
    }
    state.usersTotal = resp.total ?? 0
    // -> The overlay's own section badge counts members too, and this is where the true count is
    //    learned -- `state.group.userCount` only seeds it before the list is first read.
    emit('update:total', state.usersTotal)
    state.users = resp.users
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.isLoadingUsers = false
}

function assignUser() {
  dialog({
    component: UserSearchDialog,
    componentProps: {
      title: t('admin.groups.assignUserTitle'),
      // -> Only offer users the API would actually accept: not already members, not system users
      assignableToGroupId: props.groupId
    }
  }).onOk(async (users) => {
    state.isLoadingUsers = true
    // -> Assignment is one user per request, so a failure partway through still leaves the
    //    successful ones assigned; report both sides rather than a single all-or-nothing message.
    let assigned = 0
    for (const usr of users) {
      try {
        await API_CLIENT.post(`groups/${props.groupId}/users/${usr.id}`).json()
        assigned++
      } catch (err) {
        // -> ky throws above 400, with the reason in the body
        notify({
          type: 'negative',
          message: t('admin.groups.assignUserFailed', { userName: usr.name }),
          caption: apiErrorMessage(err)
        })
      }
    }
    if (assigned > 0) {
      notify({
        type: 'positive',
        message: t('admin.groups.assignUserSuccess', { count: assigned })
      })
    }
    await refreshUsers()
  })
}

async function unassignUser(user) {
  confirm({
    title: t('admin.groups.unassignUser'),
    message: t('admin.groups.unassignUserConfirm', { userName: user.name }),
    cancel: true,
    persistent: true,
    color: 'negative',
    okLabel: t('common.actions.delete')
  }).onOk(async () => {
    state.isLoadingUsers = true
    try {
      await API_CLIENT.delete(`groups/${props.groupId}/users/${user.id}`)
      notify({
        type: 'positive',
        message: t('admin.groups.unassignUserSuccess')
      })
      await refreshUsers()
    } catch (err) {
      // -> ky throws above 400 (e.g. 409 for the last root admin), with the reason in the body
      notify({
        type: 'negative',
        message: apiErrorMessage(err)
      })
    }
    state.isLoadingUsers = false
  })
}

// MOUNTED

/**
 * groupId -> whether it is currently on any enabled, mapGroups-on strategy's `mappableGroups`
 * allow-list, and if so which. Best-effort: a viewer who cannot reach this route for any reason
 * simply sees no warning rather than a broken panel, since the warning is a courtesy, not a
 * requirement this panel's own listing depends on.
 */
async function fetchSyncWarning() {
  try {
    const warnings = await API_CLIENT.get('authentication/synced-groups').json()
    state.syncStrategies =
      (warnings ?? []).find((w) => w.groupId === props.groupId)?.strategies ?? []
  } catch {
    state.syncStrategies = []
  }
}

/*
  This panel is only mounted while the overlay is on its `users` section, so mounting IS entering
  that section -- which is exactly when the overlay used to call `refreshUsers()` from `checkRoute`.
*/
onMounted(() => {
  refreshUsers()
  fetchSyncWarning()
})
</script>
