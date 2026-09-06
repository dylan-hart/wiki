<template>
  <w-page class="py-4">
    <h1 class="w-section-header">{{ t('profile.notifications') }}</h1>
    <div class="p-4">
      <div class="text-body2 text-grey">{{ t('profile.notificationsSubtitle') }}</div>
      <!--
        One card per event group, one settings row per event -- the same shape AdminGeneral's
        Features card is, which is what settles the question this page raised: a per-event
        subscription list IS a settings form, just one whose every control happens to be a switch.
        `tag="label"` makes the whole row toggle the switch inside it, so the click target is the
        row's full width rather than the 40px at its trailing edge.
      -->
      <w-settings-card
        v-for="group of eventGroups"
        :key="group.key"
        class="mt-4"
        :title="group.label">
        <w-settings-row
          v-for="evt of group.events"
          :key="evt.key"
          tag="label"
          control-width="auto"
          :icon="evt.icon"
          :label="evt.label">
          <w-toggle
            v-model="state.config[evt.key]"
            :loading="state.loading > 0"
            :aria-label="evt.label" />
        </w-settings-row>
      </w-settings-card>
    </div>

    <div class="actions-bar mt-6">
      <w-btn
        icon="tabler:check"
        :label="t(`common.actions.saveChanges`)"
        color="slate"
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
 *
 * Each event carries the plate its settings row draws, written out as a literal `tabler:` reference
 * here rather than assembled from the event key: a name built by concatenation is invisible to
 * `scripts/generate-icons.mjs`'s scanner and would resolve at runtime through `/_icons` instead of
 * being inlined at build time (CLAUDE.md, "Icons").
 */
const eventGroups = computed(() => [
  {
    key: 'pages',
    label: t('profile.notificationsGroupPages'),
    events: [
      {
        key: 'page:create',
        icon: 'tabler:file-plus',
        label: t('profile.notificationsEventPageCreate')
      },
      {
        key: 'page:edit',
        icon: 'tabler:file-pencil',
        label: t('profile.notificationsEventPageEdit')
      },
      {
        key: 'page:rename',
        icon: 'tabler:file-symlink',
        label: t('profile.notificationsEventPageRename')
      },
      {
        key: 'page:delete',
        icon: 'tabler:file-x',
        label: t('profile.notificationsEventPageDelete')
      },
      {
        key: 'page:classification-changed',
        icon: 'tabler:shield-lock',
        label: t('profile.notificationsEventPageClassificationChanged')
      }
    ]
  },
  {
    key: 'assets',
    label: t('profile.notificationsGroupAssets'),
    events: [
      {
        key: 'asset:upload',
        icon: 'tabler:cloud-upload',
        label: t('profile.notificationsEventAssetUpload')
      },
      {
        key: 'asset:edit',
        icon: 'tabler:photo-edit',
        label: t('profile.notificationsEventAssetEdit')
      },
      {
        key: 'asset:rename',
        icon: 'tabler:photo-cog',
        label: t('profile.notificationsEventAssetRename')
      },
      {
        key: 'asset:delete',
        icon: 'tabler:photo-x',
        label: t('profile.notificationsEventAssetDelete')
      }
    ]
  },
  {
    key: 'comments',
    label: t('profile.notificationsGroupComments'),
    events: [
      {
        key: 'comment:new',
        icon: 'tabler:message-plus',
        label: t('profile.notificationsEventCommentNew')
      },
      {
        key: 'comment:edit',
        icon: 'tabler:message-circle',
        label: t('profile.notificationsEventCommentEdit')
      },
      {
        key: 'comment:delete',
        icon: 'tabler:message-x',
        label: t('profile.notificationsEventCommentDelete')
      }
    ]
  },
  {
    key: 'approvals',
    label: t('profile.notificationsGroupApprovals'),
    events: [
      {
        key: 'approval:submitted',
        icon: 'tabler:clipboard-text',
        label: t('profile.notificationsEventApprovalSubmitted')
      },
      {
        key: 'approval:approved',
        icon: 'tabler:clipboard-check',
        label: t('profile.notificationsEventApprovalApproved')
      },
      {
        key: 'approval:rejected',
        icon: 'tabler:clipboard-x',
        label: t('profile.notificationsEventApprovalRejected')
      }
    ]
  },
  {
    key: 'account',
    label: t('profile.notificationsGroupAccount'),
    events: [
      {
        key: 'user:join',
        icon: 'tabler:user-plus',
        label: t('profile.notificationsEventUserJoin')
      },
      { key: 'user:login', icon: 'tabler:login', label: t('profile.notificationsEventUserLogin') },
      {
        key: 'user:logout',
        icon: 'tabler:logout',
        label: t('profile.notificationsEventUserLogout')
      }
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
