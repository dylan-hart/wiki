<template>
  <w-page class="admin-groups">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:users" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.groups.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.groups.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex items-center">
        <w-input
          class="denser me-2"
          v-model="state.search"
          dense
          :placeholder="t('common.header.search')"
          :aria-label="t('common.header.search')"
          :class="dark.isActive ? `bg-dark text-white` : `bg-white`">
          <template #prepend
            ><w-icon class="opacity-50" name="tabler:search" size="20px"
          /></template>
        </w-input>
        <w-btn
          class="acrylic-btn me-2"
          icon="tabler:help-circle"
          flat
          color="grey"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/groups`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2"
          icon="tabler:refresh"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.refresh`)"
          @click="load"
          :loading="state.loading > 0">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          v-if="canManage"
          icon="tabler:plus"
          :label="t(`admin.groups.create`)"
          color="primary"
          @click="createGroup" />
      </div>
    </div>
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
              <w-td :props="props"><w-icon name="tabler:users" color="primary" size="sm" /></w-td>
            </template>
            <template v-slot:body-cell-name="props">
              <w-td :props="props">
                <div class="flex items-center">
                  <strong>{{ props.value }}</strong>
                  <w-icon class="ms-2" v-if="props.row.isSystem" name="tabler:lock" color="pink" />
                </div>
              </w-td>
            </template>
            <template v-slot:body-cell-usercount="props">
              <w-td :props="props">
                <!-- Uncoloured on purpose: a hairline outline reads as a tally, whereas a filled
                     chip reads as a status. -->
                <w-chip class="text-caption" dense>{{
                  t('admin.groups.usersCount', { count: props.value })
                }}</w-chip>
              </w-td>
            </template>
            <template v-slot:body-cell-edit="props">
              <w-td :props="props">
                <w-btn
                  class="acrylic-btn me-2"
                  flat
                  :to="`/_admin/groups/` + props.row.id"
                  :icon="canManage ? `tabler:pencil` : `tabler:eye`"
                  :color="dark.isActive ? `indigo-4` : `indigo`"
                  :label="canManage ? t(`common.actions.edit`) : t(`common.actions.view`)" />
                <w-btn
                  class="acrylic-btn"
                  v-if="canManage"
                  flat
                  icon="tabler:trash"
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
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const dark = useDark()

const siteStore = useSiteStore()
const userStore = useUserStore()

const router = useRouter()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.groups.title')
}))

// -> `read:groups` alone reaches this page, so every writing control is hidden behind
//    `manage:groups` rather than left to fail at the API.
const canManage = computed(() => userStore.can('manage:groups'))

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

useAdminOverlayRoute({
  overlay: 'GroupEditOverlay',
  listPath: '/_admin/groups',
  onClosed: load
})

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
      // -> ky throws on any non-2xx (409 for a system group, say), and the API's reason is in the
      //    response body rather than the error message.
      notify({
        type: 'negative',
        message: apiErrorMessage(err)
      })
    }
  })
}

onMounted(() => {
  load()
})
</script>

<style></style>
