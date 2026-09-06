<template>
  <w-page>
    <!--
      No page padding: the first band opens the panel flush against its top edge (and drops its top
      rule as `:first-child`), which is the shape every other panel in the app opens with. Each
      section's body carries its own inset instead, so a band always spans the panel rather than being
      held 16px in from it on either side -- and at `px-4` that body's text finally starts at the same
      inset as the heading above it, where `px-5` left the two 4px out of step.

      Notifications first, Watching second: this is the tab `InboxOverlay`'s sidebar rail's first
      entry ("Inbox") opens onto directly (OpenProject #2000 repointed it here once the dead
      `/_inbox/messages` stub it used to point at was deleted; #2531 later converted the rail entry
      itself from a route link to local tab state). What that entry is FOR is unread notifications —
      the list of watched pages underneath is the source those notifications come from, not the more
      urgent of the two.
    -->
    <div class="w-section-header">{{ t('inbox.notificationsTitle') }}</div>
    <div class="px-4 pb-4">
      <div class="text-body2">{{ t('inbox.notificationsInfo') }}</div>
      <w-banner
        v-if="state.notifications.length < 1"
        class="mt-6"
        :class="dark.isActive ? `bg-dark-4 text-grey-4` : `bg-grey-2 text-grey-8`">
        <div>{{ t('inbox.notificationsNone') }}</div>
      </w-banner>
      <w-list v-else class="mt-6" bordered separator>
        <w-item
          v-for="notification of state.notifications"
          :key="notification.id"
          clickable
          @click="openNotification(notification)">
          <w-item-section avatar>
            <w-avatar color="primary" text-color="white" rounded>
              <w-icon name="tabler:bell" />
            </w-avatar>
          </w-item-section>
          <w-item-section>
            <w-item-label>{{ notificationLine(notification) }}</w-item-label>
            <w-item-label caption>{{
              localizedPagePath(
                notification.pagePath,
                notification.pageLocale,
                siteStore.localeRouting
              )
            }}</w-item-label>
            <w-item-label caption>{{ humanizeDate(t, notification.createdAt) }}</w-item-label>
          </w-item-section>
          <w-item-section side>
            <!-- `@click.stop`, so marking read does not also follow the row to the page. -->
            <w-btn
              class="acrylic-btn"
              flat
              dense
              icon="tabler:check"
              color="grey"
              :aria-label="t(`inbox.notificationsMarkRead`)"
              :disabled="state.markingRead === notification.id"
              @click.stop="markRead(notification)">
              <w-tooltip>{{ t('inbox.notificationsMarkRead') }}</w-tooltip>
            </w-btn>
          </w-item-section>
        </w-item>
      </w-list>
    </div>

    <div class="w-section-header">{{ t('inbox.watching') }}</div>
    <div class="px-4 pb-4">
      <div class="text-body2">{{ t('inbox.watchingInfo') }}</div>
      <!--
        The empty state carries the instruction with it: this screen is reached from the sidebar, quite
        possibly before the reader has ever noticed the bell it is telling them about.
      -->
      <w-banner
        v-if="state.pages.length < 1"
        class="mt-6"
        :class="dark.isActive ? `bg-dark-4 text-grey-4` : `bg-grey-2 text-grey-8`">
        <div>{{ t('inbox.watchingNone') }}</div>
        <div class="text-caption mt-1 opacity-70">{{ t('inbox.watchingHint') }}</div>
      </w-banner>
      <w-list v-else class="mt-6" bordered separator>
        <w-item v-for="page of state.pages" :key="page.pageId" clickable @click="openPage(page)">
          <w-item-section avatar>
            <!--
              The page's own icon, which is what it is recognised by everywhere else. It is a reference
              a USER picked, so it resolves through `/_icons` rather than the bundled set — see WIcon.
            -->
            <w-avatar color="slate" text-color="white" rounded>
              <w-icon :name="page.icon || DEFAULT_PAGE_ICON" />
            </w-avatar>
          </w-item-section>
          <w-item-section>
            <w-item-label>
              <strong>{{ page.title }}</strong>
            </w-item-label>
            <w-item-label caption>{{
              localizedPagePath(page.path, page.locale, siteStore.localeRouting)
            }}</w-item-label>
            <w-item-label caption>
              {{ t('inbox.watchingUpdated', { date: humanizeDate(t, page.updatedAt) }) }}
              &middot;
              {{ t('inbox.watchingSince', { date: humanizeDate(t, page.watchedAt) }) }}
            </w-item-label>
          </w-item-section>
          <w-item-section side>
            <div class="flex items-center gap-1">
              <!--
                Task 1895: the PATCH this menu calls already existed (`resolvePreference` /
                `setPreference` in `models/pageWatching.ts`) with nothing in the UI to reach it -- the
                watch button only ever PUTs/DELETEs. `@click.stop` on the trigger for the same reason
                as Stop Watching below: this row is itself clickable, and opening the menu must not
                also follow it to the page.
              -->
              <w-btn
                class="acrylic-btn"
                flat
                dense
                icon="tabler:adjustments"
                color="grey"
                :aria-label="t('inbox.watchingPreferences')"
                @click.stop>
                <w-tooltip>{{ t('inbox.watchingPreferences') }}</w-tooltip>
                <w-menu
                  class="translucent-menu"
                  anchor="bottom right"
                  self="top right"
                  :ref="(el) => setPreferenceMenuRef(page.pageId, el)"
                  @show="openPreferenceMenu(page)">
                  <w-card style="width: 300px">
                    <w-card-header>{{ t('inbox.watchingPreferences') }}</w-card-header>
                    <div class="px-4 pb-2" v-if="state.editingPreference">
                      <w-select
                        dense
                        class="mb-3"
                        :label="t('inbox.watchingPreferencesMode')"
                        v-model="state.editingPreference.notifyMode"
                        :options="notifyModeOptions"
                        emit-value
                        map-options />
                      <w-checkbox
                        class="block"
                        v-model="state.editingPreference.notifyOnEdited"
                        :label="t('inbox.watchingPreferencesEdited')" />
                      <w-checkbox
                        class="mt-2 block"
                        v-model="state.editingPreference.notifyOnMoved"
                        :label="t('inbox.watchingPreferencesMoved')" />
                      <w-checkbox
                        class="mt-2 block"
                        v-model="state.editingPreference.notifyOnDeleted"
                        :label="t('inbox.watchingPreferencesDeleted')" />
                    </div>
                    <w-card-actions>
                      <w-space />
                      <w-btn
                        flat
                        :label="t('common.actions.cancel')"
                        @click="closePreferenceMenu(page)" />
                      <w-btn
                        color="primary"
                        :label="t('common.actions.save')"
                        :loading="state.savingPreferenceFor === page.pageId"
                        @click="savePreference(page)" />
                    </w-card-actions>
                  </w-card>
                </w-menu>
              </w-btn>
              <!--
                `@click.stop`, so pressing Stop Watching does not also follow the row to the page it is
                about — which would leave the reader on a page they just said they were done with.
              -->
              <!-- -> `mdi`, to match the bell this is the undoing of; see the page header -->
              <w-btn
                class="acrylic-btn"
                flat
                dense
                icon="tabler:bell-off"
                color="grey"
                :aria-label="t(`inbox.watchingUnwatch`)"
                :disabled="state.unwatching === page.pageId"
                @click.stop="unwatch(page)">
                <w-tooltip>{{ t('inbox.watchingUnwatch') }}</w-tooltip>
              </w-btn>
            </div>
          </w-item-section>
        </w-item>
      </w-list>
    </div>
  </w-page>
</template>

<script setup>
import { onMounted, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'

import { DEFAULT_PAGE_ICON, usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDate } from '@/helpers/datetime'
import { localizedPagePath } from '@/helpers/pagePaths'

// COMPOSABLES

const dark = useDark()

// ROUTER

const router = useRouter()

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('inbox.watching')
}))

// DATA

const state = reactive({
  pages: [],
  /** The page whose Stop Watching is in flight, so its button cannot be pressed twice. */
  unwatching: null,
  notifications: [],
  /** The notification whose Mark Read is in flight, so its button cannot be pressed twice. */
  markingRead: null,
  /** A copy of the preference the open menu is editing, seeded fresh from the page's own on open. */
  editingPreference: null,
  /** The page whose preference Save is in flight, so its button cannot be pressed twice. */
  savingPreferenceFor: null
})

/** One `<w-menu>` ref per watched page, keyed by pageId, so Save/Cancel can close the right one. */
const preferenceMenuRefs = new Map()

function setPreferenceMenuRef(pageId, el) {
  if (el) {
    preferenceMenuRefs.set(pageId, el)
  } else {
    preferenceMenuRefs.delete(pageId)
  }
}

const notifyModeOptions = [
  { value: 'digest', label: t('inbox.watchingPreferencesModeDigest') },
  { value: 'immediate', label: t('inbox.watchingPreferencesModeImmediate') }
]

// MOUNTED

onMounted(load)
onMounted(loadNotifications)

// METHODS

/** The one-line summary of a notification, phrased by its action — see `inbox.notificationAction*`. */
function notificationLine(notification) {
  return t(
    `inbox.notificationAction${notification.action[0].toUpperCase()}${notification.action.slice(1)}`,
    { actor: notification.actorName, title: notification.pageTitle }
  )
}

async function load() {
  try {
    state.pages = (await API_CLIENT.get(`sites/${siteStore.id}/watching`).json()) ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('inbox.watchingLoadFailed'),
      caption: apiErrorMessage(err)
    })
  }
}

/**
 * Load the caller's unread notifications (task 535).
 *
 * A separate request from `load()` above rather than one combined fetch: the two lists come from
 * different endpoints, and a slow watch list must not hold up notifications from showing (or the
 * other way around).
 */
async function loadNotifications() {
  try {
    state.notifications = (await API_CLIENT.get(`sites/${siteStore.id}/notifications`).json()) ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('inbox.notificationsLoadFailed'),
      caption: apiErrorMessage(err)
    })
  }
}

/**
 * Follow a watched page from the list.
 *
 * The overlay is closed first (OpenProject #2531): this used to be a routed `/_inbox/*` page, so
 * navigating away from it closed the dialog as a side effect of leaving the route; now that it is
 * `InboxOverlay` content, leaving it to view a page has to close the overlay explicitly, or the
 * dialog would stay open on top of the page just navigated to.
 */
function openPage(page) {
  siteStore.$patch({ overlay: '' })
  router.push(localizedPagePath(page.path, page.locale, siteStore.localeRouting))
}

/**
 * Mark a notification read from the list, then follow it to the page it is about — a click on the row
 * is "take me there," and reading it along the way is the natural side effect, not a separate step.
 *
 * The row is dropped from the list on the server's confirmation, the same "known exactly, so don't
 * refetch the whole list" reasoning `unwatch()` below already uses. `EVENT_BUS` tells the header badge
 * (`HeaderNav.vue`) to re-check its count rather than this component trying to keep it in sync itself —
 * the badge is reachable from layouts this page has no reference to.
 */
async function openNotification(notification) {
  await markRead(notification, { silent: true })
  // -> See `openPage`'s comment above: closing the overlay is no longer implicit in leaving a route.
  siteStore.$patch({ overlay: '' })
  router.push(
    localizedPagePath(notification.pagePath, notification.pageLocale, siteStore.localeRouting)
  )
}

async function markRead(notification, { silent = false } = {}) {
  if (state.markingRead === notification.id) {
    return
  }
  state.markingRead = notification.id
  try {
    await API_CLIENT.patch(`sites/${siteStore.id}/notifications/${notification.id}/read`)
    state.notifications = state.notifications.filter((n) => n.id !== notification.id)
    EVENT_BUS.emit('notificationsChanged')
  } catch (err) {
    if (!silent) {
      notify({
        type: 'negative',
        message: t('inbox.notificationsMarkReadFailed'),
        caption: apiErrorMessage(err)
      })
    }
  }
  state.markingRead = null
}

/**
 * Stop watching a page from the list.
 *
 * The row goes as soon as the server confirms, rather than the whole list being fetched again: what
 * changed is known exactly, and a reader unwatching three pages in a row should not watch the list
 * rebuild three times.
 *
 * The page store is kept in step for the one case where it is about the same page — the reader came
 * here from it, and going back must not find a bell still saying it is watched.
 */
async function unwatch(page) {
  state.unwatching = page.pageId
  try {
    await API_CLIENT.delete(`sites/${siteStore.id}/pages/${page.pageId}/watch`)
    state.pages = state.pages.filter((p) => p.pageId !== page.pageId)
    if (pageStore.id === page.pageId) {
      pageStore.$patch({ isWatching: false })
    }
    notify({
      type: 'positive',
      message: t('inbox.watchingUnwatched', { title: page.title })
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('inbox.watchingUnwatchFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.unwatching = null
}

/**
 * Notification preferences for one watch (task 1895).
 *
 * Opened, edited and saved as a copy in `state.editingPreference` rather than mutating `page`
 * directly: Cancel has to be able to walk away from a half-edited select/checkboxes without leaving
 * the row showing a preference that was never actually saved.
 */
function openPreferenceMenu(page) {
  state.editingPreference = { ...page.preference }
}

function closePreferenceMenu(page) {
  preferenceMenuRefs.get(page.pageId)?.hide()
}

async function savePreference(page) {
  state.savingPreferenceFor = page.pageId
  try {
    const resp = await API_CLIENT.patch(`sites/${siteStore.id}/pages/${page.pageId}/watch`, {
      json: state.editingPreference
    }).json()
    if (resp?.preference) {
      page.preference = resp.preference
    }
    preferenceMenuRefs.get(page.pageId)?.hide()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('inbox.watchingPreferencesSaveFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.savingPreferenceFor = null
}
</script>
