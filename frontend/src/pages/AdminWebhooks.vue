<template>
  <w-page class="admin-webhooks">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-lightning-bolt-animated.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.webhooks.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.webhooks.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="me-2"
          icon="la:question-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/webhooks`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="acrylic-btn me-2"
          icon="la:redo-alt"
          flat
          color="secondary"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          icon="la:plus"
          :label="t(`admin.webhooks.new`)"
          color="primary"
          @click="createHook" />
      </div>
    </div>
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12" v-if="state.hooks.length < 1">
        <w-card
          class="rounded"
          :class="dark.isActive ? `bg-dark-5 text-white` : `bg-grey-3 text-dark`">
          <w-card-section class="items-center" horizontal>
            <w-card-section class="flex-none pe-0">
              <w-icon name="la:info-circle" size="sm" />
            </w-card-section>
            <w-card-section class="text-caption">{{ t('admin.webhooks.none') }}</w-card-section>
          </w-card-section>
        </w-card>
      </div>
      <div class="col-span-12" v-else>
        <w-card>
          <w-list separator>
            <w-item v-for="hook of state.hooks" :key="hook.id">
              <w-item-section side><w-icon name="la:bolt" color="primary" /></w-item-section>
              <w-item-section>
                <w-item-label>{{ hook.name }}</w-item-label>
                <w-item-label caption>{{ hook.url }}</w-item-label>
                <w-item-label caption>{{ siteScopeLabel(hook.siteId) }}</w-item-label>
              </w-item-section>
              <w-item-section side style="flex-direction: row; align-items: center">
                <template v-if="hook.state === `pending`">
                  <w-spinner class="me-2" color="indigo" size="xs" />
                  <div class="text-caption text-indigo">{{ t('admin.webhooks.statePending') }}</div>
                  <w-tooltip anchor="center left" self="center right">{{
                    t('admin.webhooks.statePendingHint')
                  }}</w-tooltip>
                </template>
                <template v-else-if="hook.state === `success`">
                  <w-spinner class="me-2" color="positive" size="xs" />
                  <div class="text-caption text-positive">
                    {{ t('admin.webhooks.stateSuccess') }}
                  </div>
                  <w-tooltip anchor="center left" self="center right">{{
                    t('admin.webhooks.stateSuccessHint')
                  }}</w-tooltip>
                </template>
                <template v-else-if="hook.state === `error`">
                  <w-icon class="me-2" color="negative" size="xs" name="la:exclamation-triangle" />
                  <div class="text-caption text-negative">{{ t('admin.webhooks.stateError') }}</div>
                  <w-tooltip anchor="center left" self="center right">{{
                    t('admin.webhooks.stateErrorHint')
                  }}</w-tooltip>
                </template>
              </w-item-section>
              <w-separator class="ms-4" vertical />
              <w-item-section side style="flex-direction: row; align-items: center">
                <w-btn
                  class="acrylic-btn me-2"
                  color="grey"
                  icon="la:paper-plane"
                  flat
                  :loading="state.testingHookId === hook.id"
                  :aria-label="t(`admin.webhooks.testSend`)"
                  @click="testHook(hook)">
                  <w-tooltip>{{ t(`admin.webhooks.testSend`) }}</w-tooltip>
                </w-btn>
                <w-btn
                  class="acrylic-btn me-2"
                  color="grey"
                  icon="la:history"
                  flat
                  :aria-label="t(`admin.webhooks.history`)"
                  @click="viewHistory(hook)">
                  <w-tooltip>{{ t(`admin.webhooks.history`) }}</w-tooltip>
                </w-btn>
                <w-btn
                  class="acrylic-btn me-2"
                  color="indigo"
                  icon="la:pen"
                  :label="t('common.actions.edit')"
                  flat
                  @click="editHook(hook.id)" />
                <w-btn
                  class="acrylic-btn"
                  color="red"
                  icon="la:trash"
                  flat
                  :aria-label="t(`common.actions.delete`)"
                  @click="deleteHook(hook)" />
              </w-item-section>
            </w-item>
          </w-list>
        </w-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { onMounted, reactive } from 'vue'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { loading } from '@/composables/loading'
import { confirm, dialog } from '@/composables/dialog'
import { apiErrorMessage } from '@/helpers/apiError'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'

import WebhookEditDialog from '@/components/WebhookEditDialog.vue'
import WebhookHistoryDialog from '@/components/WebhookHistoryDialog.vue'

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.webhooks.title')
}))

// DATA

const state = reactive({
  hooks: [],
  loading: 0,
  /** Id of the hook whose row test button is mid-request, or null. Only one row at a time. */
  testingHookId: null
})

// METHODS

/** The site a webhook is scoped to, or the "all sites" label for a null (instance-wide) one. */
function siteScopeLabel(siteId) {
  if (!siteId) {
    return t('admin.webhooks.siteAll')
  }
  return adminStore.sites.find((s) => s.id === siteId)?.title ?? siteId
}

async function load() {
  state.loading++
  loading.show()
  try {
    state.hooks = (await API_CLIENT.get('hooks').json()) ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.webhooks.loadFailed'),
      caption: err.message
    })
  }
  loading.hide()
  state.loading--
}

function createHook() {
  dialog({
    component: WebhookEditDialog,
    componentProps: {
      hookId: null
    }
  }).onOk(() => {
    load()
  })
}

function editHook(id) {
  dialog({
    component: WebhookEditDialog,
    componentProps: {
      hookId: id
    }
  }).onOk(() => {
    load()
  })
}

/**
 * Re-validates a saved webhook's endpoint without opening the edit dialog, via the same
 * `POST /_api/hooks/test` the edit dialog itself calls -- the persisted `url`/`authHeader`/
 * `acceptUntrusted` pass through the same body shape rather than a second, hookId-based endpoint.
 */
async function testHook(hook) {
  state.testingHookId = hook.id
  try {
    const resp = await API_CLIENT.post('hooks/test', {
      json: {
        url: hook.url,
        authHeader: hook.authHeader || undefined,
        acceptUntrusted: hook.acceptUntrusted
      }
    }).json()
    notify({
      type: resp?.ok ? 'positive' : 'negative',
      message: resp?.message || t('admin.webhooks.testFailed')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err, t('admin.webhooks.testFailed'))
    })
  }
  state.testingHookId = null
}

function viewHistory(hook) {
  dialog({
    component: WebhookHistoryDialog,
    componentProps: {
      hook
    }
  })
}

function deleteHook(hook) {
  confirm({
    title: t('admin.webhooks.delete'),
    message: [
      t('admin.webhooks.deleteConfirm', { name: `**${hook.name}**` }),
      `**${t('admin.webhooks.deleteConfirmWarn')}**`
    ],
    destructive: true,
    persistent: true
  }).onOk(async () => {
    try {
      await API_CLIENT.delete(`hooks/${hook.id}`)
      notify({
        type: 'positive',
        message: t('admin.webhooks.deleteSuccess')
      })
      load()
    } catch (err) {
      // -> ky throws above 400 -- a webhook deleted from another tab answers 404
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
