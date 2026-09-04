<template>
  <w-page class="admin-audit-log">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-event-log.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="text-h5 text-primary animated fadeInLeft">{{ t('admin.audit.title') }}</h1>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.audit.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <w-btn
          class="me-2 acrylic-btn"
          icon="la:question-circle"
          flat
          color="grey"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/audit-log`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2 acrylic-btn"
          icon="la:redo-alt"
          flat
          color="secondary"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="reload">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <w-separator inset />
    <div class="p-4">
      <w-card class="rounded mb-4" flat :class="dark.isActive ? `bg-dark-5` : `bg-grey-2`">
        <w-card-section class="flex flex-wrap gap-3 items-end">
          <div style="min-width: 220px">
            <div class="text-caption text-grey mb-1">{{ t('admin.audit.filterActor') }}</div>
            <w-select
              outlined
              dense
              options-dense
              emit-value
              map-options
              v-model="state.filters.actorId"
              :options="actorOptions"
              :aria-label="t('admin.audit.filterActor')" />
          </div>
          <div style="min-width: 220px">
            <div class="text-caption text-grey mb-1">{{ t('admin.audit.filterEvent') }}</div>
            <w-select
              outlined
              dense
              options-dense
              emit-value
              map-options
              v-model="state.filters.event"
              :options="eventOptions"
              :aria-label="t('admin.audit.filterEvent')" />
          </div>
          <div style="min-width: 160px">
            <div class="text-caption text-grey mb-1">{{ t('admin.audit.filterFrom') }}</div>
            <w-input
              outlined
              dense
              type="date"
              v-model="state.filters.from"
              :aria-label="t('admin.audit.filterFrom')" />
          </div>
          <div style="min-width: 160px">
            <div class="text-caption text-grey mb-1">{{ t('admin.audit.filterTo') }}</div>
            <w-input
              outlined
              dense
              type="date"
              v-model="state.filters.to"
              :aria-label="t('admin.audit.filterTo')" />
          </div>
          <w-btn
            class="acrylic-btn"
            flat
            color="primary"
            :label="t('admin.audit.applyFilters')"
            :loading="state.loading > 0"
            @click="reload" />
          <w-btn
            class="acrylic-btn"
            flat
            color="grey"
            :label="t('admin.audit.resetFilters')"
            @click="resetFilters" />
        </w-card-section>
      </w-card>

      <w-card flat>
        <w-table
          :rows="state.entries"
          :columns="headers"
          row-key="id"
          flat
          :loading="state.loading > 0">
          <template #no-data>
            <w-card-section
              class="items-center"
              horizontal
              :class="dark.isActive ? `bg-dark-5` : `bg-grey-3`">
              <w-card-section class="flex-none pe-0">
                <w-icon name="la:info-circle" size="sm" />
              </w-card-section>
              <w-card-section class="text-caption">{{ t('admin.audit.none') }}</w-card-section>
            </w-card-section>
          </template>
          <template v-slot:body-cell-event="props">
            <w-td :props="props">
              <strong>{{ eventLabel(props.value) }}</strong>
            </w-td>
          </template>
          <template v-slot:body-cell-actor="props">
            <w-td :props="props">
              <span>{{ props.row.actor.name || t('admin.audit.systemActor') }}</span>
              <div v-if="props.row.actorIp">
                <small class="text-grey">{{ props.row.actorIp }}</small>
              </div>
            </w-td>
          </template>
          <template v-slot:body-cell-target="props">
            <w-td :props="props">
              <span>{{ props.row.targetLabel || '---' }}</span>
              <div v-if="props.row.targetType">
                <small class="text-grey">{{ props.row.targetType }}</small>
              </div>
            </w-td>
          </template>
          <template v-slot:body-cell-detail="props">
            <w-td :props="props">
              <small v-if="Object.keys(props.row.detail || {}).length > 0" class="text-grey">{{
                JSON.stringify(props.row.detail)
              }}</small>
              <span v-else>---</span>
            </w-td>
          </template>
          <template v-slot:body-cell-date="props">
            <w-td :props="props">
              <span>{{ humanizeDate(t, props.value) }}</span>
              <div>
                <small class="text-grey">{{ relativeDate(props.value) }}</small>
              </div>
            </w-td>
          </template>
        </w-table>
      </w-card>
      <div class="flex items-center mt-2">
        <div class="text-caption text-grey flex-1">
          {{ t('admin.audit.shownOfTotal', { shown: state.entries.length, total: state.total }) }}
        </div>
        <w-btn
          v-if="state.total > state.entries.length"
          class="acrylic-btn"
          flat
          color="primary"
          :label="t('admin.audit.loadMore')"
          :loading="state.loading > 0"
          @click="loadMore" />
      </div>

      <w-separator class="my-4" inset />

      <!--
        Card-local save, not a page-header Apply, by decision (OpenProject #2089): this page is a
        viewer (audit entries + filters) with settings embedded in it, not itself a settings form,
        and its filter card above already commits locally the same way -- see
        `docs/decisions/embedded-setting-save-affordance.md`.
      -->
      <w-card class="rounded" flat :class="dark.isActive ? `bg-dark-5` : `bg-grey-2`">
        <w-card-section>
          <div class="text-subtitle1">{{ t('admin.audit.retentionTitle') }}</div>
          <div class="text-caption text-grey mb-2">{{ t('admin.audit.retentionSubtitle') }}</div>
          <!--
            The days input carries `:rules`, so without `hide-bottom-space` `w-input` reserves a
            hint/error row below its visible box even while empty (see WInput.vue's
            `showsBottom`), making the field taller than the button beside it. Flex `items-center`
            then centres each item on its own box -- the button on its actual height, the input on
            its taller reserved-space-included height -- so the two visible controls land on
            different horizontal lines even though both are "centred" (OpenProject #2331,
            attempted with `items-center` alone; still visibly off). `hide-bottom-space` (the same
            prop `GroupCreateDialog.vue`/`FolderCreateDialog.vue` use for the identical reason)
            drops the reserved row until a real validation error sets it, which is what actually
            equalises the two heights.
          -->
          <div class="flex items-center gap-3 retention-actions">
            <div style="width: 160px">
              <w-input
                ref="retentionInput"
                outlined
                dense
                type="number"
                min="1"
                max="3650"
                v-model.number="state.retentionDays"
                :rules="retentionDaysRules"
                hide-bottom-space
                lazy-rules="ondemand"
                :suffix="t('admin.audit.retentionDaysSuffix')"
                :aria-label="t('admin.audit.retentionTitle')" />
            </div>
            <w-btn
              class="acrylic-btn retention-save-btn"
              flat
              color="primary"
              :label="t('common.actions.save')"
              :loading="state.savingRetention"
              @click="saveRetention" />
          </div>
        </w-card-section>
      </w-card>
    </div>
  </w-page>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'

import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDate, relativeDate } from '@/helpers/datetime'

import { useSiteStore } from '@/stores/site'

// COMPOSABLES

const dark = useDark()

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.audit.title')
}))

// DATA

/** How many entries a page of the list fetches at a time. The API caps this at 500. */
const PAGE_LIMIT = 50

const AUDIT_EVENTS = [
  'user.created',
  'user.updated',
  'user.deleted',
  'user.passwordReset',
  'user.tfaDisabledByAdmin',
  'group.created',
  'group.updated',
  'group.deleted',
  'group.memberAdded',
  'group.memberRemoved',
  'apiKey.issued',
  'apiKey.revoked',
  'auth.strategyUpdated',
  'site.settingsUpdated',
  'storage.targetUpdated',
  'glossaryTerm.created',
  'glossaryTerm.updated',
  'glossaryTerm.deleted',
  'login.success',
  'login.failed',
  'page.classificationChanged',
  'mcp.sessionOpened',
  'mcp.writeToolCalled'
]

const headers = [
  {
    label: t('admin.audit.colDate'),
    align: 'left',
    field: 'createdAt',
    name: 'date',
    sortable: true
  },
  {
    label: t('admin.audit.colEvent'),
    align: 'left',
    field: 'event',
    name: 'event',
    sortable: true
  },
  { label: t('admin.audit.colActor'), align: 'left', field: 'actor', name: 'actor' },
  { label: t('admin.audit.colTarget'), align: 'left', field: 'targetLabel', name: 'target' },
  { label: t('admin.audit.colDetail'), align: 'left', field: 'detail', name: 'detail' }
]

const state = reactive({
  entries: [],
  total: 0,
  retentionDays: 365,
  savingRetention: false,
  loading: 0,
  filters: {
    actorId: null,
    event: null,
    from: '',
    to: ''
  }
})

function eventLabel(ev) {
  const translated = t(`admin.audit.event.${ev}`)
  return translated === `admin.audit.event.${ev}` ? ev : translated
}

const eventOptions = ref([
  { label: t('admin.audit.allEvents'), value: null },
  ...AUDIT_EVENTS.map((ev) => ({ label: eventLabel(ev), value: ev }))
])

const actorOptions = ref([{ label: t('admin.audit.allActors'), value: null }])

const retentionInput = ref(null)

/**
 * `min`/`max` on the native control stop the spinner and the slider, not a pasted value -- typing or
 * pasting "0" or "9999" bypasses both silently. Mirrors `ApprovalRuleDialog.vue`'s
 * `minApprovalsValidation` convention.
 */
const retentionDaysRules = [
  (val) =>
    (Number.isInteger(val) && val >= 1 && val <= 3650) || t('admin.audit.retentionDaysInvalid')
]

// METHODS

function resetFilters() {
  state.filters.actorId = null
  state.filters.event = null
  state.filters.from = ''
  state.filters.to = ''
  reload()
}

function buildSearchParams(offset) {
  const searchParams = new URLSearchParams()
  if (state.filters.actorId) {
    searchParams.set('actorId', state.filters.actorId)
  }
  if (state.filters.event) {
    searchParams.set('event', state.filters.event)
  }
  if (state.filters.from) {
    searchParams.set('from', new Date(`${state.filters.from}T00:00:00.000Z`).toISOString())
  }
  if (state.filters.to) {
    searchParams.set('to', new Date(`${state.filters.to}T23:59:59.999Z`).toISOString())
  }
  searchParams.set('limit', PAGE_LIMIT)
  searchParams.set('offset', offset)
  return searchParams
}

async function fetchPage(offset) {
  const resp = await API_CLIENT.get('audit-log', { searchParams: buildSearchParams(offset) }).json()
  return resp
}

async function reload() {
  state.loading++
  try {
    const resp = await fetchPage(0)
    state.entries = resp?.entries ?? []
    state.total = resp?.total ?? 0
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.audit.loadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
}

async function loadMore() {
  state.loading++
  try {
    const resp = await fetchPage(state.entries.length)
    state.entries = [...state.entries, ...(resp?.entries ?? [])]
    state.total = resp?.total ?? state.total
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.audit.loadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
}

async function loadActors() {
  try {
    const actors = (await API_CLIENT.get('audit-log/actors').json()) ?? []
    actorOptions.value = [
      { label: t('admin.audit.allActors'), value: null },
      ...actors.map((a) => ({ label: a.name, value: a.id }))
    ]
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.audit.loadActorsFailed'),
      caption: apiErrorMessage(err)
    })
  }
}

async function loadRetention() {
  try {
    const resp = await API_CLIENT.get('audit-log/settings').json()
    state.retentionDays = resp?.retentionDays ?? 365
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.audit.loadFailed'),
      caption: apiErrorMessage(err)
    })
  }
}

async function saveRetention() {
  if (retentionInput.value && !retentionInput.value.validate()) {
    return
  }
  state.savingRetention = true
  try {
    await API_CLIENT.put('audit-log/settings', {
      json: { retentionDays: state.retentionDays }
    }).json()
    notify({
      type: 'positive',
      message: t('admin.audit.retentionSaveSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.audit.retentionSaveFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.savingRetention = false
}

// MOUNTED

onMounted(async () => {
  await Promise.all([reload(), loadActors(), loadRetention()])
})
</script>
