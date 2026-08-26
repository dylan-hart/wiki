<template>
  <w-page class="py-4">
    <!--
      Notifications first, Watching second: this is the page the bell in `InboxLayout`'s sidebar
      points at (task 535 reuses its `la:bell` icon rather than adding a second nav item), and what
      that bell is FOR is unread notifications — the list of watched pages underneath is the source
      those notifications come from, not the more urgent of the two.
    -->
    <div class="w-section-header">{{ t('inbox.notificationsTitle') }}</div>
    <div class="p-4">
      <div class="text-body2">{{ t('inbox.notificationsInfo') }}</div>
      <w-banner
        v-if="state.notifications.length < 1 && state.loadingNotifications < 1"
        class="mt-6"
        rounded
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
              <w-icon name="la:bell" />
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
            <w-item-label caption>{{ humanizeDate(notification.createdAt) }}</w-item-label>
          </w-item-section>
          <w-item-section side>
            <!-- `@click.stop`, so marking read does not also follow the row to the page. -->
            <w-btn
              class="acrylic-btn"
              flat
              dense
              icon="mdi:check"
              color="grey"
              :aria-label="t(`inbox.notificationsMarkRead`)"
              :disable="state.markingRead === notification.id"
              @click.stop="markRead(notification)">
              <w-tooltip>{{ t('inbox.notificationsMarkRead') }}</w-tooltip>
            </w-btn>
          </w-item-section>
        </w-item>
      </w-list>
    </div>

    <div class="w-section-header">{{ t('inbox.watching') }}</div>
    <div class="p-4">
      <div class="text-body2">{{ t('inbox.watchingInfo') }}</div>
      <!--
        The empty state carries the instruction with it: this screen is reached from the sidebar, quite
        possibly before the reader has ever noticed the bell it is telling them about.
      -->
      <w-banner
        v-if="state.pages.length < 1 && state.loading < 1"
        class="mt-6"
        rounded
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
            <w-avatar color="secondary" text-color="white" rounded>
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
              {{ t('inbox.watchingUpdated', { date: humanizeDate(page.updatedAt) }) }}
              &middot;
              {{ t('inbox.watchingSince', { date: humanizeDate(page.watchedAt) }) }}
            </w-item-label>
          </w-item-section>
          <w-item-section side>
            <!--
              `@click.stop`, so pressing Stop Watching does not also follow the row to the page it is
              about — which would leave the reader on a page they just said they were done with.
            -->
            <!-- -> `mdi`, to match the bell this is the undoing of; see the page header -->
            <w-btn
              class="acrylic-btn"
              flat
              dense
              icon="mdi:bell-off-outline"
              color="grey"
              :aria-label="t(`inbox.watchingUnwatch`)"
              :disable="state.unwatching === page.pageId"
              @click.stop="unwatch(page)">
              <w-tooltip>{{ t('inbox.watchingUnwatch') }}</w-tooltip>
            </w-btn>
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
  loading: 0,
  pages: [],
  /** The page whose Stop Watching is in flight, so its button cannot be pressed twice. */
  unwatching: null,
  loadingNotifications: 0,
  notifications: [],
  /** The notification whose Mark Read is in flight, so its button cannot be pressed twice. */
  markingRead: null
})

// MOUNTED

onMounted(load)
onMounted(loadNotifications)

// METHODS

function humanizeDate(val) {
  return Temporal.Instant.from(val).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
}

/** The one-line summary of a notification, phrased by its action — see `inbox.notificationAction*`. */
function notificationLine(notification) {
  return t(
    `inbox.notificationAction${notification.action[0].toUpperCase()}${notification.action.slice(1)}`,
    { actor: notification.actorName, title: notification.pageTitle }
  )
}

async function load() {
  state.loading++
  try {
    state.pages = (await API_CLIENT.get(`sites/${siteStore.id}/watching`).json()) ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('inbox.watchingLoadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
}

/**
 * Load the caller's unread notifications (task 535).
 *
 * A separate request/loading flag from `load()` above rather than one combined fetch: the two lists
 * come from different endpoints, and a slow watch list must not hold up notifications from showing
 * (or the other way around).
 */
async function loadNotifications() {
  state.loadingNotifications++
  try {
    state.notifications = (await API_CLIENT.get(`sites/${siteStore.id}/notifications`).json()) ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('inbox.notificationsLoadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loadingNotifications--
}

function openPage(page) {
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
</script>
