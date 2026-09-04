<template>
  <div class="site-header bg-header text-white">
    <div class="flex flex-nowrap">
      <w-toolbar style="height: 64px">
        <w-btn dense flat to="/" :aria-label="t(`common.header.home`)">
          <w-avatar v-if="siteStore.logoText" size="34px" square>
            <img :src="`/_site/current/logo`" alt="" />
          </w-avatar>
          <img v-else :src="`/_site/current/logo`" style="height: 34px" alt="" />
        </w-btn>
        <div v-if="siteStore.logoText" class="site-title text-h6 ms-2 min-w-0 flex-1 truncate">
          {{ siteStore.title }}
        </div>
      </w-toolbar>
      <!-- -> Inline between the title and the actions only where there is room for all three; on a
              phone the field gets a row of its own at the bottom of this header instead -->
      <header-search v-if="!isSearchCollapsed" />
      <w-toolbar style="height: 64px">
        <w-space />
        <transition name="syncing">
          <w-spinner v-show="commonStore.routerLoading" size="20px" class="text-accent" />
        </transition>
        <!--
          The two halves of the right-hand group collapse at different widths, so they are separate tests
          rather than one phone/desktop switch: the field is the first thing that stops fitting beside the
          site title, and the five buttons hold out for another 300px.
        -->
        <w-btn
          v-if="isSearchCollapsed && siteStore.features.search"
          class="ms-4"
          flat
          round
          dense
          :icon="searchRowIsOpen ? `la:times` : `la:search`"
          color="white"
          :aria-label="searchRowIsOpen ? t(`common.actions.close`) : t(`common.header.search`)"
          :aria-expanded="searchRowIsOpen"
          @click="toggleSearchRow" />
        <!--
          One button for the five. Icon buttons whose meaning is only in a tooltip are not something a
          touch screen can offer at all, and by 900px they are also crowding the site title.
        -->
        <header-actions-menu v-if="isActionsCollapsed" />
        <template v-else>
          <w-btn
            v-if="userStore.can(`write:pages`)"
            class="header-nav-btn"
            flat
            icon="la:plus"
            color="blue-4"
            :aria-label="t('common.header.createNewPage')">
            <w-tooltip>{{ t('common.header.createNewPage') }}</w-tooltip>
            <new-menu />
          </w-btn>
          <!--
            -> Whoever may put a file somewhere: `write:assets` outright, or `write:pages` for an
               author whose rules cover the pages but not the assets beside them, since the editor
               sends them here to insert an image. Every folder and every file is checked again by the
               endpoints behind the manager, which answer per path, so this decides only whether the
               door is shown.
          -->
          <w-btn
            v-if="userStore.can(`write:assets`) || userStore.can(`write:pages`)"
            class="header-nav-btn"
            flat
            icon="la:folder-open"
            color="positive"
            :aria-label="t('fileman.title')"
            @click="openFileManager">
            <w-tooltip>{{ t('fileman.title') }}</w-tooltip>
          </w-btn>
          <w-btn
            v-if="siteStore.features.browse"
            class="header-nav-btn"
            flat
            icon="mdi:graph-outline"
            color="teal"
            to="/_graph"
            :aria-label="t(`common.header.graph`)">
            <w-tooltip>{{ t('common.header.graph') }}</w-tooltip>
          </w-btn>
          <!--
            -> 2.5.x parity (OpenProject #987, #1120): the only way into `/_tags` used to be clicking
               an existing tag chip on an already-tagged page -- nothing pointed there for a reader
               who isn't on one yet. No feature flag gates it, the same as the tag chips themselves.

               Moved out of this button group and docked to the search field itself
               (`HeaderSearch.vue`) as of OpenProject #1218, to match the 2.5.x reference layout --
               it is no longer one of the five icons here.
          -->
          <!--
            OpenProject #2024: this badge counts unread page-watch notifications
            (`unreadNotifications` below), so it has to land on the tab that actually lists them --
            `/_inbox/watching`, not the old `/_inbox` redirect into the now-deleted Messages stub.
            `la:bell` matches the icon `InboxWatching`/`InboxLayout`'s sidenav already use for that
            tab, so the glyph agrees with the destination instead of pointing at the unrelated
            `mdi:inbox-full` glyph.
          -->
          <w-btn
            v-if="userStore.authenticated"
            class="header-nav-btn"
            flat
            icon="la:bell"
            color="amber"
            to="/_inbox/watching"
            :aria-label="t(`inbox.title`)">
            <!--
              Same `floating` badge shape `PageActionsCol`'s pending-assets button uses, on the one
              button here that is reachable from every page (`HeaderNav` is shared by `MainLayout`
              and `InboxLayout` -- Profile is a `MainOverlayDialog` entry now, OpenProject #2532, so
              it no longer has a layout of its own to share this with) -- see `unreadNotifications`
              for where the count comes from and how it stays current.
            -->
            <w-badge
              v-if="unreadNotifications > 0"
              rounded
              floating
              color="negative"
              text-color="white">
              <strong>{{ unreadNotifications }}</strong>
            </w-badge>
            <w-tooltip>{{ t('inbox.title') }}</w-tooltip>
          </w-btn>
          <w-btn
            v-if="userStore.can(`access:admin`)"
            class="header-nav-btn"
            flat
            icon="la:tools"
            color="pink"
            to="/_admin"
            :aria-label="t(`common.header.admin`)">
            <w-tooltip>{{ t('common.header.admin') }}</w-tooltip>
          </w-btn>

          <!-- USER BUTTON / DROPDOWN -->
          <account-menu v-if="userStore.authenticated" />
          <w-btn
            v-else
            class="ms-4"
            flat
            rounded
            icon="la:sign-in-alt"
            color="white"
            :label="$t(`common.actions.login`)"
            :aria-label="$t(`common.actions.login`)"
            to="/login"
            padding="sm"
            no-caps />
        </template>
      </w-toolbar>
    </div>
    <!--
      The phone search field, in a row of its own under the bar. Unmounted on the way out, so there is
      never a second field bound to the same query.

      Focused from `@after-enter` rather than on mount: focusing the field is what draws the suggestions
      panel under it, and doing that while the row is still sliding put a fresh layout and a
      `backdrop-filter` blur into the middle of the animation -- which is what made it stutter.
    -->
    <transition name="header-search-row" @after-enter="searchRow?.focus()">
      <div v-if="isSearchCollapsed && searchRowIsOpen" class="header-search-row">
        <header-search ref="searchRow" row />
      </div>
    </transition>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { useMinWidth } from '@/composables/screen'

import { useCommonStore } from '@/stores/common'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import AccountMenu from '@/components/AccountMenu.vue'
import NewMenu from '@/components/PageNewMenu.vue'
import HeaderActionsMenu from '@/components/HeaderActionsMenu.vue'
import HeaderSearch from '@/components/HeaderSearch.vue'

/**
 * Site header content.
 *
 * Content only, for the same reason as `FooterNav`: the enclosing layout supplies the header
 * element, so layouts sharing this component can migrate independently.
 */

// STORES

const commonStore = useCommonStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// ROUTER

const route = useRoute()

// I18N

const { t } = useI18n()

// REFS

/** The phone search field, for the one thing this component does to it: focus it once it is down. */
const searchRow = ref(null)

// DATA

/** Whether the phone search row is down. Never consulted above the breakpoint. */
const searchRowIsOpen = ref(false)

/**
 * How many unread page-watch notifications (task 535) the caller has on this site, badged on the
 * inbox button above. `0` (never shown) for a guest, who has nothing to be notified about.
 */
const unreadNotifications = ref(0)

// COMPUTED

/**
 * Below the `sm` breakpoint (`css/tailwind.css`), where the search field gives up its place between the
 * site title and the actions and becomes a button that opens a row of its own.
 */
const isAtLeastSm = useMinWidth(600)
const isSearchCollapsed = computed(() => !isAtLeastSm.value)

/**
 * Below 900px, where the five action buttons become the one overflow menu.
 *
 * A separate question from the search field above, and a wider one: the field is what stops fitting
 * first, while the buttons are 5 × 40px that only start crowding the title around here. The same 900 the
 * profile and search cards collapse their sidebars at, which is coincidence rather than a shared cause —
 * it is simply where a window stops being a desktop one.
 */
const isAtLeast900 = useMinWidth(900)
const isActionsCollapsed = computed(() => !isAtLeast900.value)

// WATCHERS

/*
  The search row closes on arriving somewhere, which is what pressing Enter in it does: the results are
  the answer, and a field still hanging under the header is one more thing to put away by hand.
*/
watch(
  () => route.path,
  () => {
    searchRowIsOpen.value = false
  }
)

/*
  Logging in/out changes whose notifications (if anyone's) are being counted -- refetched rather than
  left at whatever the previous session's count was, which would otherwise flash a stranger's badge
  for a moment after a fresh login, or a signed-out reader's own leftover count after logout.
*/
watch(() => userStore.authenticated, loadUnreadNotifications, { immediate: true })

// MOUNTED

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  // -> Emitted by `InboxWatching.vue` after marking a notification read, since that page has no
  //    reference of its own to the header the badge lives in.
  EVENT_BUS.on('notificationsChanged', loadUnreadNotifications)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  EVENT_BUS.off('notificationsChanged', loadUnreadNotifications)
})

// METHODS

/**
 * Refresh the badge count. Silent on failure -- a stale or missing badge is not worth a toast over,
 * and this can run on every login/logout before the rest of the app has finished settling in.
 */
async function loadUnreadNotifications() {
  if (!userStore.authenticated || !siteStore.id) {
    unreadNotifications.value = 0
    return
  }
  try {
    const resp = await API_CLIENT.get(`sites/${siteStore.id}/notifications/unread-count`).json()
    unreadNotifications.value = resp?.count ?? 0
  } catch {
    // -> Left at whatever it last was; see this function's own comment.
  }
}

/*
  Cmd+K (macOS/iOS) or Ctrl+K (everywhere else) below 600px, where the field is not mounted and so
  cannot claim the shortcut itself: this opens the row, and `HeaderSearch` focuses on mount. Above the
  breakpoint, and while the row is already down, the field's own handler is the one that answers --
  see `HeaderSearch.handleKeyPress`.
*/
function onKeydown(ev) {
  if (!isSearchCollapsed.value || searchRowIsOpen.value || !siteStore.features.search) {
    return
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'k' && !siteStore.overlayIsShown) {
    ev.preventDefault()
    searchRowIsOpen.value = true
  }
}

function toggleSearchRow() {
  searchRowIsOpen.value = !searchRowIsOpen.value
}

function openFileManager() {
  siteStore.openFileManager()
}
</script>

<style scoped lang="scss">
/*
  The site name, a step down on a phone: `text-h6` is 20px, which is a heading's size next to a 34px
  logo and two buttons on a 390px bar. Slight on purpose -- the title is still the first thing the bar
  says.
*/
@media (max-width: $breakpoint-xs-max) {
  .site-title {
    font-size: 1.0625rem;
  }
}

/*
  The site's sidebar colour, which is what says this IS a second row rather than more of the bar: the
  header's colour is the site's to choose and is black by default, so against an identical black the
  field read as a pill floating in one tall bar -- generously padded above and cropped below.

  The sidebar's rather than any other: on a phone the sidebar is the panel this same header opens, so the
  two things that come out from behind the bar are the one colour.

  Through `--color-sidebar` rather than the `bg-sidebar` utility, so the row follows a site that themes
  its colours at runtime (the variable is rewritten in place; see `tailwind.css`).
*/
.header-search-row {
  background-color: var(--color-sidebar);
}

/*
  The search row sliding out from under the bar.

  `max-height` rather than `height`, because the row is a `WToolbar` and carries `min-height: 50px` of
  its own -- which a height of 0 loses to, and a max-height overrules. 52px is the height the row is
  given in `HeaderSearch`; the two have to agree, or the slide stops short of the row's full height and
  jumps the rest of the way.

  `overflow: hidden` for the duration only, so that the search panel -- which hangs BELOW this row and
  is positioned against it -- is not clipped once the row is open.
*/
.header-search-row-enter-active,
.header-search-row-leave-active {
  overflow: hidden;
  transition:
    max-height 0.2s var(--ease-standard),
    opacity 0.2s var(--ease-standard);
}
.header-search-row-enter-from,
.header-search-row-leave-to {
  max-height: 0;
  opacity: 0;
}
.header-search-row-enter-to,
.header-search-row-leave-from {
  max-height: 52px;
}

@media (prefers-reduced-motion: reduce) {
  .header-search-row-enter-active,
  .header-search-row-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
