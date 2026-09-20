<template>
  <w-page>
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:checkbox" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.approval.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.approval.subtitle') }}
        </div>
      </div>
      <div class="flex flex-none">
        <w-btn
          class="acrylic-btn me-2"
          icon="tabler:refresh"
          flat
          color="slate"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          icon="tabler:plus"
          :label="t(`admin.approval.newRule`)"
          color="primary"
          @click="createRule" />
      </div>
    </div>
    <div class="p-4">
      <w-banner
        v-if="state.rules.length < 1 && state.loading < 1"
        :class="dark.isActive ? `bg-dark-3 text-grey-4` : `bg-grey-2 text-grey-8`">
        {{ t('admin.approval.noRules') }}
      </w-banner>
      <template v-else>
        <!--
          No drag-reorder and no precedence marker on the list below, deliberately: rules have no
          order to reorder into.
        -->
        <div class="text-caption text-grey mb-2">
          {{ t('admin.approval.overlapHint') }}
        </div>
        <w-settings-card :title="t('admin.approval.title')">
          <!--
            A disabled rule is dimmed rather than hidden or moved: it is still part of the
            configuration being read. Text only -- the controls stay at full strength, since
            re-enabling the rule is what the reader is most likely here to do.
          -->
          <w-settings-row
            v-for="rule of state.rules"
            :key="rule.id"
            control-width="auto"
            icon="tabler:checklist">
            <template #label>
              <strong :class="rule.isEnabled ? `` : `opacity-60`">{{ rule.name }}</strong>
            </template>
            <template #hint>
              <div :class="rule.isEnabled ? `` : `opacity-60`">
                <div>
                  {{ matchLabel(rule.match) }}
                  <span class="font-mono">{{ patternLabel(rule) }}</span>
                </div>
                <div>
                  <span class="text-grey">{{ t('admin.approval.submitters') }}:</span>
                  {{ groupNames(rule.submitterGroups) }}
                </div>
                <div>
                  <span class="text-grey">{{ t('admin.approval.reviewers') }}:</span>
                  {{ groupNames(rule.reviewerGroups) }}
                  <template v-if="rule.minApprovals > 1">
                    &middot;
                    {{ t('admin.approval.minApprovals') }}: {{ rule.minApprovals }}
                  </template>
                </div>
              </div>
            </template>
            <div class="flex items-center gap-2">
              <w-toggle
                :model-value="rule.isEnabled"
                :label="t(`admin.approval.enabled`)"
                :aria-label="t(`admin.approval.enabled`)"
                @update:model-value="
                  (val) => {
                    setEnabled(rule, val)
                  }
                " />
              <w-separator vertical />
              <w-btn
                class="acrylic-btn"
                flat
                @click="editRule(rule)"
                icon="tabler:pencil"
                :color="dark.isActive ? `indigo-4` : `indigo`"
                :label="t(`common.actions.edit`)" />
              <w-btn
                class="acrylic-btn"
                flat
                icon="tabler:trash"
                color="negative"
                @click="deleteRule(rule)"
                :aria-label="t(`common.actions.delete`)" />
            </div>
          </w-settings-row>
        </w-settings-card>
      </template>
    </div>
    <w-inner-loading :showing="state.loading > 0" />
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { useAdminSettings } from '@/composables/adminSettings'
import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { confirm, dialog } from '@/composables/dialog'
import { useSiteAdminAccess } from '@/composables/siteAdminAccess'

import { useAdminStore } from '@/stores/admin'

import ApprovalRuleDialog from '@/components/ApprovalRuleDialog.vue'
import { apiErrorMessage } from '@/helpers/apiError'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const dark = useDark()
useSiteAdminAccess('site:approvals')

const adminStore = useAdminStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.approval.title')
}))

const { state, load } = useAdminSettings({
  i18nPrefix: 'admin.approval',
  // -> A listing, not a settings form: no full-screen overlay while its rows load
  overlay: false,
  extraState: {
    rules: [],
    groups: []
  },
  fetch: (siteId) =>
    Promise.all([
      API_CLIENT.get(`sites/${siteId}/approvals/rules`).json(),
      API_CLIENT.get('groups').json()
    ]),
  onLoaded: ([rules, groups]) => {
    state.rules = rules ?? []
    state.groups = groups ?? []
  }
})

function matchLabel(match) {
  return (
    {
      START: t('admin.approval.matchStart'),
      EXACT: t('admin.approval.matchExact'),
      END: t('admin.approval.matchEnd'),
      REGEX: t('admin.approval.matchRegex'),
      TAG: t('admin.approval.matchTag'),
      TAGALL: t('admin.approval.matchTagAll')
    }[match] ?? match
  )
}

function patternLabel(rule) {
  if (['TAG', 'TAGALL'].includes(rule.match)) {
    return rule.path
  }
  return rule.match === 'REGEX' ? `/${rule.path}/` : `/${rule.path}`
}

/**
 * An ID with no group left to name is shown as-is rather than dropped: a rule pointing at a deleted
 * group grants nothing, and hiding that would make the row look correct.
 */
function groupNames(groupIds) {
  return (groupIds ?? []).map((id) => state.groups.find((g) => g.id === id)?.name ?? id).join(', ')
}

/**
 * The row is updated from the response rather than optimistically: a refused change has to leave
 * the switch showing what the server actually holds.
 */
async function setEnabled(rule, isEnabled) {
  state.loading++
  try {
    const resp = await API_CLIENT.put(
      `sites/${adminStore.currentSiteId}/approvals/rules/${rule.id}`,
      { json: { isEnabled } }
    ).json()
    Object.assign(rule, resp.rule)
    notify({
      type: 'positive',
      message: isEnabled ? t('admin.approval.enableSuccess') : t('admin.approval.disableSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.approval.saveFailed'),
      caption: apiErrorMessage(err)
    })
    await load()
  }
  state.loading--
}

function createRule() {
  dialog({
    component: ApprovalRuleDialog,
    componentProps: {
      siteId: adminStore.currentSiteId,
      groups: state.groups
    }
  }).onOk(load)
}

function editRule(rule) {
  dialog({
    component: ApprovalRuleDialog,
    componentProps: {
      siteId: adminStore.currentSiteId,
      groups: state.groups,
      rule
    }
  }).onOk(load)
}

function deleteRule(rule) {
  confirm({
    title: t('admin.approval.deleteRule'),
    message: t('admin.approval.deleteRuleConfirm', {
      pattern: `${matchLabel(rule.match)} ${patternLabel(rule)}`
    }),
    cancel: true,
    color: 'negative',
    okLabel: t('common.actions.delete')
  }).onOk(async () => {
    state.loading++
    try {
      await API_CLIENT.delete(`sites/${adminStore.currentSiteId}/approvals/rules/${rule.id}`)
      notify({
        type: 'positive',
        message: t('admin.approval.deleteSuccess')
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.approval.deleteFailed'),
        caption: apiErrorMessage(err)
      })
    }
    state.loading--
    await load()
  })
}
</script>
