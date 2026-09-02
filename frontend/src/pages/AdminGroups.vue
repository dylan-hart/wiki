<template>
  <w-page class="admin-groups">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-people.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 pl-4">
        <h1 class="text-h5 text-primary animated fadeInLeft">{{ t('admin.groups.title') }}</h1>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.groups.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex items-center">
        <w-input
          class="denser mr-2"
          outlined
          v-model="state.search"
          dense
          :placeholder="t('common.header.search')"
          :aria-label="t('common.header.search')"
          :class="dark.isActive ? `bg-dark text-white` : `bg-white`">
          <template #prepend><w-icon class="opacity-50" name="la:search" size="20px" /></template>
        </w-input>
        <w-btn
          class="acrylic-btn mr-2"
          icon="la:question-circle"
          flat
          color="grey"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/groups`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="mr-2 acrylic-btn"
          icon="la:redo-alt"
          flat
          color="secondary"
          :aria-label="t(`common.actions.refresh`)"
          @click="load"
          :loading="state.loading > 0">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          v-if="canManage"
          unelevated
          icon="la:plus"
          :label="t(`admin.groups.create`)"
          color="primary"
          @click="createGroup" />
      </div>
    </div>
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12">
        <w-card>
          <w-table
            :rows="state.groups"
            :columns="headers"
            row-key="id"
            flat
            hide-header
            :loading="state.loading > 0"
            :filter="state.search">
            <template v-slot:body-cell-id="props">
              <w-td :props="props"><w-icon name="la:users" color="primary" size="sm" /></w-td>
            </template>
            <template v-slot:body-cell-name="props">
              <w-td :props="props">
                <div class="flex items-center">
                  <strong>{{ props.value }}</strong>
                  <w-icon class="ml-2" v-if="props.row.isSystem" name="la:lock" color="pink" />
                </div>
              </w-td>
            </template>
            <template v-slot:body-cell-usercount="props">
              <w-td :props="props">
                <w-chip
                  class="text-caption"
                  square
                  :color="dark.isActive ? `dark-6` : `grey-2`"
                  :text-color="dark.isActive ? `white` : `grey-8`"
                  dense
                  >{{ t('admin.groups.usersCount', { count: props.value }) }}</w-chip
                >
              </w-td>
            </template>
            <template v-slot:body-cell-edit="props">
              <w-td :props="props">
                <w-btn
                  class="acrylic-btn mr-2"
                  flat
                  :to="`/_admin/groups/` + props.row.id"
                  :icon="canManage ? `la:pen` : `la:eye`"
                  :color="dark.isActive ? `indigo-4` : `indigo`"
                  :label="canManage ? t(`common.actions.edit`) : t(`common.actions.view`)"
                  no-caps />
                <w-btn
                  class="acrylic-btn"
                  v-if="canManage"
                  flat
                  icon="la:trash"
                  :color="props.row.isSystem ? `grey` : `negative`"
                  :disabled="props.row.isSystem"
                  :aria-label="t(`common.actions.delete`)"
                  @click="deleteGroup(props.row)" />
              </w-td>
            </template>
            <template #no-data="{ rowsCount }">
              {{ rowsCount > 0 ? t('admin.groups.noMatchesText') : t('admin.groups.emptyText') }}
            </template>
          </w-table>
        </w-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive } from 'vue'
import { useRouter } from 'vue-router'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { loading } from '@/composables/loading'
import { confirm, dialog } from '@/composables/dialog'
import { useAdminOverlayRoute } from '@/composables/adminOverlayRoute'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { apiErrorMessage } from '@/helpers/apiError'

import GroupCreateDialog from '../components/GroupCreateDialog.vue'

// COMPOSABLES

const dark = useDark()

// STORES

const siteStore = useSiteStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.groups.title')
}))

// COMPUTED

/*
  `read:groups` reaches this page too (see the nav in `AdminLayout`), and everything that writes needs
  `manage:groups` -- so the controls behind it are hidden rather than left to fail at the API.
*/
const canManage = computed(() => userStore.can('manage:groups'))

// DATA

const state = reactive({
  groups: [],
  loading: 0,
  search: ''
})

const headers = [
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
    label: t('admin.groups.userCount'),
    align: 'center',
    field: 'userCount',
    name: 'usercount',
    sortable: false,
    style: 'width: 150px'
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

// OVERLAY ROUTE

useAdminOverlayRoute({
  overlay: 'GroupEditOverlay',
  listPath: '/_admin/groups',
  onClosed: load
})

// METHODS

async function load() {
  state.loading++
  loading.show()
  try {
    state.groups = await API_CLIENT.get('groups').json()
  } catch (err) {
    notify({
      type: 'negative',
      message: t(`admin.groups.loadFailed`),
      caption: apiErrorMessage(err)
    })
  }
  loading.hide()
  state.loading--
}

function createGroup() {
  dialog({
    component: GroupCreateDialog
  }).onOk(() => {
    load()
  })
}

function editGroup(gr) {
  router.push(`/_admin/groups/${gr.id}`)
}

function deleteGroup(gr) {
  confirm({
    title: t('admin.groups.delete'),
    message: [
      t('admin.groups.deleteConfirm', { groupName: `**${gr.name}**` }),
      `**${t('admin.groups.deleteConfirmWarn')}**`
    ],
    destructive: true,
    persistent: true
  }).onOk(async () => {
    try {
      await API_CLIENT.delete(`groups/${gr.id}`)
      notify({
        type: 'positive',
        message: t('admin.groups.deleteSuccess')
      })
      load()
    } catch (err) {
      // -> ky throws for statuses above 400 (e.g. 409 for a system group), where the reason the API
      //    gave is in the response body rather than in the error message
      notify({
        type: 'negative',
        message: apiErrorMessage(err)
      })
    }
  })
}

// MOUNTED

onMounted(() => {
  load()
})
</script>

<style lang="scss"></style>
