<template>
  <w-page>
    <!--
      No page padding: each section's body carries its own inset instead, so a band spans the whole
      panel rather than being held 16px in from either edge, and the body's text starts at the same
      inset as the heading above it.

      Notifications first: this is what the rail's "Inbox" entry opens onto, and unread
      notifications are what it is for. The watched pages below are only where they come from.
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
            <!--
              `size` rather than the 40px `WItemSection` gives a flanking avatar everywhere else:
              that 40px rule is a scoped `:deep()` selector, and only an inline style beats it.

              `accent-fill`, the bright fill, because the plate carries a glyph rather than a white
              label -- and resolved through `dark.isActive`, since `--color-accent-fill` has no
              dark-mode override of its own and would otherwise draw light-mode on a dark ground.
            -->
            <w-avatar
              size="36px"
              font-size="18px"
              :color="dark.isActive ? `accent-dark` : `accent-fill`"
              text-color="white"
              square>
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
              class="inbox-square-btn"
              outline
              padding="none"
              color="slate-soft"
              :aria-label="t(`inbox.notificationsMarkRead`)"
              :disabled="state.markingRead === notification.id"
              @click.stop="markRead(notification)">
              <w-icon name="tabler:check" size="15px" />
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
        The empty state carries the instruction with it: this screen is reached from the sidebar,
        quite possibly before the reader has ever noticed the bell it is telling them about.
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
              A user-picked icon reference, so it resolves through `/_icons` at runtime rather than
              out of the build-time bundle.
            -->
            <w-avatar size="36px" font-size="18px" color="slate" text-color="white" square>
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
              {{
                t('inbox.watchingUpdated', {
                  date: userStore.formatRecent(t, page.updatedAt) || '---'
                })
              }}
              &middot;
              {{ t('inbox.watchingSince', { date: humanizeDate(t, page.watchedAt) }) }}
            </w-item-label>
          </w-item-section>
          <w-item-section side>
            <div class="flex items-center gap-1.5">
              <w-btn
                class="inbox-square-btn"
                outline
                padding="none"
                color="slate-soft"
                :aria-label="t('inbox.watchingPreferences')"
                @click.stop>
                <w-icon name="tabler:adjustments" size="15px" />
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
              <w-btn
                class="inbox-square-btn"
                outline
                padding="none"
                color="slate-soft"
                :aria-label="t(`inbox.watchingUnwatch`)"
                :disabled="state.unwatching === page.pageId"
                @click.stop="unwatch(page)">
                <w-icon name="tabler:bell-off" size="15px" />
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
import { useUserStore } from '@/stores/user'
import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDate } from '@/helpers/datetime'
import { localizedPagePath } from '@/helpers/pagePaths'

const dark = useDark()

const router = useRouter()

const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('inbox.watching')
}))

const state = reactive({
  pages: [],
  unwatching: null,
  notifications: [],
  markingRead: null,
  editingPreference: null,
  savingPreferenceFor: null
})

/** One `<w-menu>` ref per watched page, so Save and Cancel can close the right one. */
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

onMounted(load)
onMounted(loadNotifications)

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
 * A separate request from `load()` rather than one combined fetch: a slow watch list must not hold
 * notifications back from showing, or the other way around.
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
 * The overlay is closed first: this is `InboxOverlay` content rather than a route of its own, so
 * navigating away closes nothing and the overlay would sit on top of the page just opened.
 */
function openPage(page) {
  siteStore.$patch({ overlay: '' })
  router.push(localizedPagePath(page.path, page.locale, siteStore.localeRouting))
}

/**
 * A click on the row is "take me there", so marking it read along the way is a side effect rather
 * than a separate step. The header badge is reachable only from layouts this page has no reference
 * to, which is why `markRead` announces itself over `EVENT_BUS` instead of updating it.
 */
async function openNotification(notification) {
  await markRead(notification, { silent: true })
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
 * The row goes as soon as the server confirms rather than the whole list being fetched again: what
 * changed is known exactly, and unwatching three pages should not rebuild the list three times. The
 * page store is patched for the case where the reader came here from that page, so going back does
 * not find a bell still saying it is watched.
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
 * Edited as a copy rather than against `page` directly: Cancel has to walk away from half-edited
 * controls without leaving the row showing a preference that was never saved.
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
