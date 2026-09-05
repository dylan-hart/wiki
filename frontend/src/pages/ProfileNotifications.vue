<template>
  <w-page class="py-4">
    <h1 class="w-section-header">{{ t('profile.notifications') }}</h1>
    <div class="px-4 text-body2 text-grey">{{ t('profile.notificationsSubtitle') }}</div>

    <template v-for="group of eventGroups" :key="group.key">
      <h2 class="w-section-header mt-6">{{ group.label }}</h2>
      <template v-for="(evt, idx) of group.events" :key="evt.key">
        <w-separator v-if="idx > 0" inset spaced="sm" />
        <w-item>
          <w-item-section>
            <w-item-label>{{ evt.label }}</w-item-label>
          </w-item-section>
          <w-item-section side>
            <w-toggle
              v-model="state.config[evt.key]"
              :loading="state.loading > 0"
              :aria-label="evt.label" />
          </w-item-section>
        </w-item>
      </template>
    </template>

    <div class="actions-bar mt-6">
      <w-btn
        icon="mdi:check"
        :label="t(`common.actions.saveChanges`)"
        color="secondary"
        :disabled="state.loading > 0"
        @click="save" />
    </div>

    <w-inner-loading :showing="state.loading > 0" />
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive } from 'vue'

import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('profile.notifications')
}))

// DATA

/**
 * The events a user may opt into an email for, grouped for display, mirroring the backend's own
 * `HOOK_EVENTS` vocabulary (`backend/models/hooks.ts`) exactly -- one entry here per event key that
 * vocabulary lists, so this page never offers a toggle the server would reject, and never hides one
 * it would accept. `GET /users/profile/notifications` is what actually seeds every key's value;
 * this is only the display grouping and labels.
 *
 * A computed, not a plain array evaluated once at setup, so switching interface language relabels
 * every row immediately rather than only after a remount -- same reasoning as
 * `ProfileOverlay.vue`'s own `sidenav`.
 */
const eventGroups = computed(() => [
  {
    key: 'pages',
    label: t('profile.notificationsGroupPages'),
    events: [
      { key: 'page:create', label: t('profile.notificationsEventPageCreate') },
      { key: 'page:edit', label: t('profile.notificationsEventPageEdit') },
      { key: 'page:rename', label: t('profile.notificationsEventPageRename') },
      { key: 'page:delete', label: t('profile.notificationsEventPageDelete') },
      {
        key: 'page:classification-changed',
        label: t('profile.notificationsEventPageClassificationChanged')
      }
    ]
  },
  {
    key: 'assets',
    label: t('profile.notificationsGroupAssets'),
    events: [
      { key: 'asset:upload', label: t('profile.notificationsEventAssetUpload') },
      { key: 'asset:edit', label: t('profile.notificationsEventAssetEdit') },
      { key: 'asset:rename', label: t('profile.notificationsEventAssetRename') },
      { key: 'asset:delete', label: t('profile.notificationsEventAssetDelete') }
    ]
  },
  {
    key: 'comments',
    label: t('profile.notificationsGroupComments'),
    events: [
      { key: 'comment:new', label: t('profile.notificationsEventCommentNew') },
      { key: 'comment:edit', label: t('profile.notificationsEventCommentEdit') },
      { key: 'comment:delete', label: t('profile.notificationsEventCommentDelete') }
    ]
  },
  {
    key: 'approvals',
    label: t('profile.notificationsGroupApprovals'),
    events: [
      { key: 'approval:submitted', label: t('profile.notificationsEventApprovalSubmitted') },
      { key: 'approval:approved', label: t('profile.notificationsEventApprovalApproved') },
      { key: 'approval:rejected', label: t('profile.notificationsEventApprovalRejected') }
    ]
  },
  {
    key: 'account',
    label: t('profile.notificationsGroupAccount'),
    events: [
      { key: 'user:join', label: t('profile.notificationsEventUserJoin') },
      { key: 'user:login', label: t('profile.notificationsEventUserLogin') },
      { key: 'user:logout', label: t('profile.notificationsEventUserLogout') }
    ]
  }
])

/** Every event key above, flattened -- what seeds `state.config` and what a full save sends back. */
const allEventKeys = eventGroups.value.flatMap((group) => group.events.map((evt) => evt.key))

const state = reactive({
  // -> Off until the real values arrive -- `:loading="state.loading > 0"` on each toggle is what
  //    stops that placeholder from visibly animating to the fetched value, same convention as
  //    WToggle's own doc comment describes.
  config: Object.fromEntries(allEventKeys.map((key) => [key, false])),
  loading: 0
})

// METHODS

async function fetchSubscriptions() {
  state.loading++
  try {
    const subscriptions = await API_CLIENT.get('users/profile/notifications').json()
    for (const key of allEventKeys) {
      state.config[key] = subscriptions[key] === true
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: t('profile.notificationsLoadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
}

async function save() {
  state.loading++
  try {
    await API_CLIENT.put('users/profile/notifications', { json: { ...state.config } }).json()
    notify({
      type: 'positive',
      message: t('profile.notificationsSaveSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('profile.notificationsSaveFailed'),
      caption: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
  state.loading--
}

// MOUNTED

onMounted(() => {
  fetchSubscriptions()
})
</script>
