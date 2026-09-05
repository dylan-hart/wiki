<template>
  <w-page class="admin-terminal">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-network-animated.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.cluster.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.cluster.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <w-btn
          class="me-2"
          icon="la:redo-alt"
          outline
          color="slate-soft"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <w-separator inset />
    <div class="p-4 gap-4">
      <w-card>
        <w-table
          :rows="state.nodes"
          :columns="nodesHeaders"
          row-key="id"
          flat
          :loading="state.loading > 0">
          <template v-slot:body-cell-icon="props">
            <w-td :props="props"><w-icon name="la:server" color="positive" size="sm" /></w-td>
          </template>
          <template v-slot:body-cell-id="props">
            <w-td :props="props">
              <strong>{{ props.value }}</strong>
              <div>
                <small class="text-grey"
                  ><strong>{{ props.row.ip }}</strong></small
                >
              </div>
              <div>
                <small class="text-grey">{{ props.row.dbUser }}</small>
              </div>
            </w-td>
          </template>
          <template v-slot:body-cell-cons="props">
            <w-td :props="props">
              <w-chip icon="la:plug" size="md" color="blue" text-color="white">
                <span class="font-robotomono">{{ props.value }}</span>
              </w-chip>
            </w-td>
          </template>
          <template v-slot:body-cell-subs="props">
            <w-td :props="props">
              <w-chip icon="la:broadcast-tower" size="md" color="green" text-color="white">
                <small class="uppercase">{{ props.value }}</small>
              </w-chip>
            </w-td>
          </template>
          <template v-slot:body-cell-firstseen="props">
            <w-td :props="props">
              <span>{{ props.value }}</span>
              <div>
                <small class="text-grey">{{ humanizeDate(t, props.row.dbFirstSeen) }}</small>
              </div>
            </w-td>
          </template>
          <template v-slot:body-cell-lastseen="props">
            <w-td :props="props">
              <span>{{ props.value }}</span>
              <div>
                <small class="text-grey">{{ humanizeDate(t, props.row.dbLastSeen) }}</small>
              </div>
            </w-td>
          </template>
          <template #no-data>
            {{ t('admin.cluster.emptyText') }}
          </template>
        </w-table>
      </w-card>
    </div>
  </w-page>
</template>

<script setup>
import { onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'

import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'

import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDate, relativeDate } from '@/helpers/datetime'

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.cluster.title')
}))

// DATA

const state = reactive({
  nodes: [],
  loading: 0
})

const nodesHeaders = [
  {
    align: 'center',
    field: 'id',
    name: 'icon',
    sortable: false,
    style: 'width: 15px; padding-inline-end: 0;'
  },
  {
    label: t('common.field.id'),
    align: 'left',
    field: 'id',
    name: 'id',
    sortable: true
  },
  {
    label: t('admin.cluster.activeConnections'),
    align: 'left',
    field: 'activeConnections',
    name: 'cons',
    sortable: true
  },
  {
    label: t('admin.cluster.activeListeners'),
    align: 'left',
    field: 'activeListeners',
    name: 'subs',
    sortable: true
  },
  {
    label: t('admin.cluster.firstSeen'),
    align: 'left',
    field: 'dbFirstSeen',
    name: 'firstseen',
    sortable: true,
    format: relativeDate
  },
  {
    label: t('admin.cluster.lastSeen'),
    align: 'left',
    field: 'dbLastSeen',
    name: 'lastseen',
    sortable: true,
    format: relativeDate
  }
]

// METHODS

async function load() {
  state.loading++
  try {
    state.nodes = await API_CLIENT.get('system/cluster').json()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.cluster.loadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
}

// MOUNTED

onMounted(() => {
  load()
})
</script>
