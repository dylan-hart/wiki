<template>
  <!--
    The band's foreground is `--color-header-fg`, not `text-ink`: Cobalt's header is a solid blue bar
    and everything on it is white, which no ink-and-dark-mode pair of utilities can express.
  -->
  <div class="site-header bg-header">
    <div class="flex flex-nowrap">
      <w-toolbar style="height: 64px">
        <!--
          First in the bar, ahead of the logo, so the wordmark is what gets pushed right -- where a
          hamburger is expected to be. Content-only, like the rest of this component: the layout
          owning the sidebar decides WHEN (`showSidebarToggle`) and does the opening (`openSidebar`).
          `pages/Search.vue` mounts this header too and has no sidebar, so the default is no toggle.
        -->
        <w-btn
          v-if="showSidebarToggle"
          class="flush-hover-btn header-nav-btn"
          flat
          icon="tabler:menu-2"
          color="slate-soft"
          :aria-label="t(`common.sidebar.mainMenu`)"
          @click="emit('openSidebar')" />
        <!--
          On the same `header-nav-btn` band as the icon buttons at the far end of this 64px bar: a
          flush, squared 64x64 target whose hover lights the header's full height, rather than the
          smaller rounded box `WBtn`'s own dense sizing draws around a 64px mark. `flat` alone, no
          `dense` -- `_base.css`'s rule overrides both of `dense`'s effects with `!important` anyway,
          so leaving it on would only misdescribe the button.
        -->
        <w-btn
          class="flush-hover-btn header-nav-btn"
          flat
          to="/"
          :aria-label="t(`common.header.home`)">
          <w-avatar v-if="siteStore.logoText" size="64px" square>
            <img :src="`/_site/current/logo`" alt="" />
          </w-avatar>
          <img v-else :src="`/_site/current/logo`" style="height: 64px" alt="" />
        </w-btn>
        <div v-if="siteStore.logoText" class="ms-2.5 min-w-0 flex-1">
          <div class="site-title truncate">{{ siteStore.title }}</div>
          <div v-if="siteStore.description" class="site-subtitle truncate">
            {{ siteStore.description }}
          </div>
        </div>
      </w-toolbar>
      <!--
        -> A replicated instance resets on a schedule, and an author mid-edit on one has no other
           cue that their work won't outlive the next reset. Generic wording only, not the actual
           schedule. Hidden below `md`: the row is already tight for the title, the still-inline
           search field and the action buttons, and a warning nobody has room to read is worse than
           one dropped outright.
      -->
      <div
        v-if="siteStore.isReplicationEnabled && !isReplicationBannerCollapsed"
        class="replication-banner flex items-center flex-none">
        <w-icon name="tabler:alert-triangle" size="16px" class="me-1.5 flex-none" />
        <span class="truncate">{{ t('common.header.replicationWarning') }}</span>
      </div>
      <header-search v-if="!isSearchCollapsed" />
      <w-toolbar style="height: 64px">
        <w-space />
        <transition name="syncing">
          <w-spinner v-show="commonStore.routerLoading" size="20px" class="text-accent" />
        </transition>
        <w-btn
          v-if="isSearchCollapsed && siteStore.features.search"
          class="ms-4"
          flat
          round
          dense
          :icon="searchRowIsOpen ? `tabler:x` : `tabler:search`"
          color="slate-soft"
          :aria-label="searchRowIsOpen ? t(`common.actions.close`) : t(`common.header.search`)"
          :aria-expanded="searchRowIsOpen"
          @click="toggleSearchRow" />
        <!-- One button for the five: an icon whose meaning is only in a tooltip is nothing a touch
             screen can offer, and by 900px they are crowding the site title too -->
        <header-actions-menu v-if="isActionsCollapsed" />
        <template v-else>
          <w-btn
            v-if="userStore.can(`write:pages`)"
            class="flush-hover-btn header-nav-btn"
            flat
            icon="tabler:plus"
            color="slate-soft"
            :aria-label="t('common.header.createNewPage')">
            <w-tooltip>{{ t('common.header.createNewPage') }}</w-tooltip>
            <new-menu />
          </w-btn>
          <!--
            -> `write:pages` counts too, for an author whose rules cover the pages but not the assets
               beside them, since the editor sends them here to insert an image. The endpoints behind
               the manager check every path again, so this decides only whether the door is shown.
          -->
          <w-btn
            v-if="userStore.can(`write:assets`) || userStore.can(`write:pages`)"
            class="flush-hover-btn header-nav-btn"
            flat
            icon="tabler:folder"
            color="slate-soft"
            :aria-label="t('fileman.title')"
            @click="openFileManager">
            <w-tooltip>{{ t('fileman.title') }}</w-tooltip>
          </w-btn>
          <w-btn
            v-if="siteStore.features.browse"
            class="flush-hover-btn header-nav-btn"
            flat
            icon="tabler:hierarchy"
            color="slate-soft"
            :aria-label="t(`common.header.graph`)"
            @click="onGraphNavClick">
            <w-tooltip>{{ t('common.header.graph') }}</w-tooltip>
          </w-btn>
          <!--
            The badge counts unread page-watch notifications, so this button opens onto the tab that
            lists them. Its glyph follows that destination: it must stay equal to what `InboxOverlay`
            draws for itself and to `HeaderActionsMenu.vue`'s collapsed copy of this row, which
            `inboxGlyph.test.js` asserts for both together.
          -->
          <w-btn
            v-if="userStore.authenticated"
            class="flush-hover-btn header-nav-btn"
            flat
            icon="tabler:inbox"
            color="slate-soft"
            :aria-label="t(`inbox.title`)"
            @click="openInbox">
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
            class="flush-hover-btn header-nav-btn"
            flat
            icon="tabler:tool"
            color="slate-soft"
            to="/_admin"
            :aria-label="t(`common.header.admin`)">
            <w-tooltip>{{ t('common.header.admin') }}</w-tooltip>
          </w-btn>

          <account-menu v-if="userStore.authenticated" />
          <w-btn
            v-else
            class="ms-4"
            flat
            rounded
            icon="tabler:login"
            color="slate"
            :label="$t(`common.actions.login`)"
            :aria-label="$t(`common.actions.login`)"
            to="/login"
            padding="sm" />
        </template>
      </w-toolbar>
    </div>
    <!--
      Focused from `@after-enter` rather than on mount: focusing the field is what draws the
      suggestions panel under it, and doing that mid-slide puts a fresh layout and a
      `backdrop-filter` blur into the middle of the animation, which makes it stutter.
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
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { useMinWidth } from '@/composables/screen'

import { localizedPagePath } from '@/helpers/pagePaths'
import { useCommonStore } from '@/stores/common'
import { useGraphStore } from '@/stores/graph'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import AccountMenu from '@/components/AccountMenu.vue'
import NewMenu from '@/components/PageNewMenu.vue'
import HeaderActionsMenu from '@/components/HeaderActionsMenu.vue'
import HeaderSearch from '@/components/HeaderSearch.vue'

/** Content only, like `FooterNav`: the enclosing layout supplies the header element. */

defineProps({
  /**
   * The layout that owns a sidebar answers this off its own breakpoint/open state and listens for
   * `openSidebar`; a layout with no sidebar leaves it off.
   */
  showSidebarToggle: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['openSidebar'])

const commonStore = useCommonStore()
const graphStore = useGraphStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const route = useRoute()
const router = useRouter()

/**
 * The graph's fixed route path -- no locale prefix, unlike an ordinary content page. Deliberately a
 * second literal beside `composables/navSidebarDestination.js`'s own `GRAPH_ROUTE_PATH` rather than
 * a shared import, for one string used by two otherwise-unrelated call sites.
 */
const GRAPH_ROUTE_PATH = '/_graph'

const { t } = useI18n()

const searchRow = ref(null)

const searchRowIsOpen = ref(false)

const unreadNotifications = ref(0)

/**
 * The last non-graph route, kept current by the watcher below -- where the Graph button returns to
 * on exit. Deliberately independent of the graph's own `path` query param: a reader who moves the
 * graph's root from the sidebar while still inside `/_graph` must land back on the page they were
 * reading before they opened it, not wherever the root ended up. Defaults to `/` for a session that
 * lands straight on `/_graph`.
 */
const lastNonGraphPath = ref('/')

/** Below `sm`, where the search field gives up its place between the title and the actions. */
const isAtLeastSm = useMinWidth(600)
const isSearchCollapsed = computed(() => !isAtLeastSm.value)

/**
 * A separate, wider question than the search field above: the field is what stops fitting first,
 * while the buttons only start crowding the title around here.
 */
const isAtLeast900 = useMinWidth(900)
const isActionsCollapsed = computed(() => !isAtLeast900.value)

/** A third independent width question: the banner is not a shrink of either of the two above. */
const isAtLeastMd = useMinWidth(1024)
const isReplicationBannerCollapsed = computed(() => !isAtLeastMd.value)

/*
  Arriving somewhere is what pressing Enter in the row does, and the results are the answer -- a
  field still hanging under the header is one more thing to put away by hand.
*/
watch(
  () => route.path,
  () => {
    searchRowIsOpen.value = false
  }
)

/*
  A live watcher rather than a value captured when the Graph button is clicked: the reader can also
  reach `/_graph` by a sidebar link, browser history or a typed URL, and this still has to know where
  to send them back.
*/
watch(
  () => route.fullPath,
  () => {
    if (route.path !== GRAPH_ROUTE_PATH) {
      lastNonGraphPath.value = route.fullPath
    }
  },
  { immediate: true }
)

/*
  Logging in or out changes whose notifications are being counted: left alone, the badge would show
  the previous session's count for a moment.
*/
watch(() => userStore.authenticated, loadUnreadNotifications, { immediate: true })

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  // -> Emitted by `InboxWatching.vue` after marking one read; it has no reference of its own to the
  //    header the badge lives in.
  EVENT_BUS.on('notificationsChanged', loadUnreadNotifications)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  EVENT_BUS.off('notificationsChanged', loadUnreadNotifications)
})

/**
 * Silent on failure: a stale or missing badge is not worth a toast over, and this can run on every
 * login/logout before the rest of the app has finished settling in.
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
    // -> Deliberately silent; the count stays at whatever it last was.
  }
}

/*
  Cmd+K or Ctrl+K below 600px, where the field is not mounted and so cannot claim the shortcut
  itself: this opens the row. Above the breakpoint, and while the row is already down, the field's
  own handler answers instead.
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

function openInbox() {
  siteStore.openOverlay('Inbox', { tab: 'watching' })
}

/**
 * From an ordinary page the graph opens rooted on the page's nearest containing folder, not the page
 * itself. `pageStore.path`/`folderPath` are only trustworthy while `route.meta.contentPage` is set:
 * on any other non-graph route they are stale leftover from whichever page was last actually read,
 * not "nothing".
 *
 * Whether to send a `path` query param at all therefore branches on `route.meta.contentPage`, not on
 * `folderPath` being truthy -- `folderPath` is `''` for a top-level page and for the homepage, and
 * that empty string is a deliberate root-anchor request, which truthiness would collapse into "no
 * anchor requested".
 *
 * `router.push` both ways: this is a deliberate mode change each time, unlike the sidebar's repeated
 * in-graph re-rooting (`composables/navSidebarDestination.js#graphSidebarBranch`), which prefers
 * `replace` to avoid spamming history.
 */
function onGraphNavClick() {
  if (route.path === GRAPH_ROUTE_PATH) {
    const selected = graphStore.selectedPath
    router.push(
      selected
        ? localizedPagePath(selected, pageStore.locale, siteStore.localeRouting)
        : lastNonGraphPath.value
    )
    return
  }
  if (route.meta.contentPage) {
    router.push({ path: GRAPH_ROUTE_PATH, query: { path: pageStore.folderPath } })
    return
  }
  router.push(GRAPH_ROUTE_PATH)
}
</script>

<style scoped>
/*
  The rule belongs here rather than to whatever is below: the sidebar and the breadcrumb bar each
  start with their own top edge, and only one of the three should draw the line between them.
  The band's FILL comes from `bg-header` on the element, since `--q-header` is the site's own to
  choose and is rewritten at runtime; only the rule is fixed.
*/
.site-header {
  border-bottom: 1px solid var(--color-hairline);
  color: var(--color-header-fg);
}

.body--dark .site-header {
  border-bottom-color: var(--color-hairline-dark);
}

/*
  Ledger's band is white paper, so its foreground follows dark mode like the rest of the app.
  Cobalt's is a solid blue bar in BOTH modes, so its white foreground is already correct and must not
  be overridden -- hence the `:not()`.
*/
.body--dark:not(.body--cobalt) .site-header {
  color: var(--color-text-dark);
}

/*
  The icon buttons follow the band they sit on rather than the app's own chrome tone. `WBtn` renders
  its `color` prop as an inline style, which no rule here can outrank, so the override has to reach
  the `.w-icon` child -- which has no inline colour of its own.
*/
.site-header :deep(.w-btn.header-nav-btn),
.site-header :deep(.w-btn.header-nav-btn .w-icon) {
  color: var(--color-header-icon);
}

/* Cobalt's header bar carries no ruling line at all, the same in light and dark */
body.body--cobalt .site-header {
  border-bottom: 0;
}

.site-title {
  font-family: var(--font-display);
  font-size: 21px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/*
  Small enough to read as a rule of type rather than as a sentence, which is the point. Nothing
  fainter than `--color-text-secondary`: at this size the tracking already holds it back, and
  anything fainter stops resolving as letters on a non-retina display.

  Through `--color-header-eyebrow` rather than that constant directly, so Cobalt's light-on-blue
  eyebrow applies. The dark override below is scoped off `body.body--cobalt` because an
  aesthetic-blind `.body--dark` selector would outrank the token base regardless of aesthetic.
*/
.site-subtitle {
  margin-top: 2px;
  font-family: var(--font-mono);
  font-size: 8.5px;
  font-weight: 500;
  line-height: 1.2;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--color-header-eyebrow);
}

.body--dark:not(.body--cobalt) .site-subtitle {
  color: var(--color-text-secondary-dark);
}

/* 21px reads as a heading next to the logo and buttons on a 390px bar, not as a wordmark */
@media (max-width: 599.98px) {
  .site-title {
    font-size: 17px;
  }
}

/*
  `--color-warning-text`, the TEXT tier of the warning pair, not `--color-warning-fill`'s brighter
  background tone: this sits directly on the header band's own fill and has to stay legible as text.

  `max-width` plus the icon+span's own `truncate`/`flex-none` split keeps a very long translation
  from pushing the search field or the action buttons out of the row entirely.
*/
.replication-banner {
  max-width: 260px;
  margin-inline-start: 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-warning-text);
}

/*
  The sidebar's tint is what says this is a second row rather than more of the bar: on a phone the
  sidebar is the panel this same header opens, so the two things that come out from behind the bar
  are one colour. Through `--color-sidebar` rather than the `bg-sidebar` utility, so the row follows
  a site that themes its colours at runtime (the variable is rewritten in place).
*/
.header-search-row {
  background-color: var(--color-sidebar);
  border-top: 1px solid var(--color-hairline);
}

.body--dark .header-search-row {
  border-top-color: var(--color-hairline-dark);
}

/*
  `max-height` rather than `height`, because the row is a `WToolbar` and carries `min-height: 50px` of
  its own -- which a height of 0 loses to, and a max-height overrules. 52px is the height the row is
  given in `HeaderSearch`; the two have to agree, or the slide stops short and jumps the rest of the
  way.

  `overflow: hidden` for the transition's duration only, so the search panel -- which hangs BELOW this
  row and is positioned against it -- is not clipped once the row is open.
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
