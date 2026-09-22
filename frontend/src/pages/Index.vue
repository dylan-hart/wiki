<template>
  <!--
    `h-full min-h-0`: the page must CLAIM the definite height the shell hands it, or the whole page
    scrolls inside the shell -- sidebars and all -- instead of the article column scrolling alone.
  -->
  <w-page class="flex flex-col h-full min-h-0">
    <!--
      Kept mounted through editing, not just while reading: the trail is how an author gets back out,
      and `path`/`breadcrumbs`/`updatedAt` do not move until a save lands, so the bar keeps reporting
      the true last-saved state mid-edit rather than something that changed underfoot.
    -->
    <div class="page-breadcrumbs px-4 flex flex-wrap items-center" v-if="!pageStore.notFound">
      <div class="min-w-0 flex-1">
        <w-breadcrumbs
          :items="breadcrumbs"
          :active-color="dark.isActive ? `grey-5` : `grey-7`"
          separator-color="grey">
          <template #separator><w-icon name="tabler:chevron-right" /></template>
        </w-breadcrumbs>
      </div>
      <!--
        Off on a phone, where the date takes a whole line under the trail, and off for a page never
        saved: there is no last-saved moment to report yet, and `publishState`/`updatedAt` would
        otherwise carry over from whatever page was open before.
      -->
      <div class="flex-none items-center justify-end hidden sm:flex" v-if="!isUnsavedNewPage">
        <template v-if="pageStore.publishState === 'draft'">
          <div class="page-breadcrumbs-modified text-accent">
            {{ t(`common.page.unpublished`) }}
          </div>
          <w-separator class="mx-2" vertical />
        </template>
        <div class="page-breadcrumbs-modified">
          {{ t(`common.page.lastModified`) }} {{ lastModified }}
        </div>
      </div>
    </div>
    <page-header v-if="!pageStore.notFound" ref="pageHeaderComp" />
    <w-banner
      v-if="siteBannerShown"
      class="site-banner mx-4 mt-3 flex-none border border-hairline bg-tint text-slate dark:border-hairline-dark dark:bg-dark-2 dark:text-text-secondary-dark"
      role="region"
      :aria-label="siteBannerTitle || undefined">
      <div v-if="siteBannerTitle" class="site-banner-title font-bold">{{ siteBannerTitle }}</div>
      <div v-if="siteBannerContent" class="site-banner-content whitespace-pre-line">
        {{ siteBannerContent }}
      </div>
    </w-banner>
    <div class="page-container flex min-h-0 flex-nowrap items-stretch" style="flex: 1 1 100%">
      <div
        class="min-w-0 flex-1"
        :style="siteStore.theme.tocPosition === `left` ? `order: 2;` : `order: 1;`">
        <component :is="editorComponents[editorStore.editor]" v-if="editorStore.isActive" />
        <!-- -> Nothing is hidden client-side: the server sends no body at all for a locked page -->
        <div v-else-if="pageStore.isLocked" class="page-placeholder">
          <w-icon class="page-placeholder-icon" name="tabler:lock" />
          <div class="text-h6">{{ t('common.page.locked') }}</div>
          <div class="text-body2 mt-1 opacity-60">{{ t('common.page.lockedHint') }}</div>
          <w-btn
            class="mt-6"
            icon="tabler:lock-open"
            color="primary"
            padding="xs lg"
            :label="t(`common.page.unlock`)"
            @click="promptUnlock" />
        </div>
        <div v-else-if="pageStore.notFound" class="page-placeholder">
          <w-icon class="page-placeholder-icon" name="tabler:file-text" />
          <div class="text-h6">
            {{ canCreatePage ? t('common.newpage.title') : t('common.notfound.subtitle') }}
          </div>
          <div class="text-body2 mt-1 opacity-60" v-if="canCreatePage">
            {{ t('common.newpage.subtitle') }}
          </div>
          <div class="text-caption font-robotomono mt-3 opacity-50">/{{ pageStore.path }}</div>
          <w-btn
            class="mt-6"
            v-if="canCreatePage"
            icon="tabler:plus"
            color="primary"
            padding="xs lg"
            :label="t(`common.newpage.create`)"
            @click="createPage" />
          <w-btn
            class="mt-6"
            v-else
            outline
            icon="tabler:arrow-left"
            color="primary"
            padding="xs lg"
            :label="t(`common.newpage.goback`)"
            @click="goBack" />
          <w-btn
            class="mt-4"
            v-if="canViewDeletionHistory"
            flat
            dense
            icon="tabler:history"
            color="grey-6"
            :label="t(`history.recovery.entryLink`)"
            :to="`/_admin/` + siteStore.id + `/pages/deleted`" />
        </div>
        <!--
          Ordering is load-bearing: ahead of the article because a redirection has none, and behind the
          locked and missing screens because neither has a target to have been given yet.
        -->
        <page-redirect v-else-if="pageStore.editor === `redirect`" />
        <w-scroll-area class="page-container-scrl" ref="pageScroller" v-else style="height: 100%">
          <div
            class="page-container-body"
            :class="{ 'is-measured': resolvedContentWidth === `measured` }">
            <!-- -> Delegated: the anchors come from `v-html` and are replaced wholesale on every
                 render -->
            <div
              class="page-contents"
              ref="pageContents"
              v-html="pageStore.render"
              @click="onContentClick"
              @change="onContentChange" />
            <template v-if="pageStore.relations && pageStore.relations.length > 0">
              <w-separator class="my-6" />
              <div class="flex flex-wrap">
                <div class="min-w-0 flex-1 text-left" v-if="relationsLeft.length > 0">
                  <w-btn
                    class="me-2 mb-2"
                    padding="sm md"
                    outline
                    color="primary"
                    v-for="rel of relationsLeft"
                    :key="`rel-id-` + rel.id"
                    v-bind="relationLink(rel)">
                    <w-icon :name="rel.icon" />
                    <div class="flex flex-col text-left ps-4">
                      <div class="text-body2">
                        <strong>{{ rel.label }}</strong>
                      </div>
                      <div class="text-caption">{{ rel.caption }}</div>
                    </div>
                  </w-btn>
                </div>
                <div class="min-w-0 flex-1 text-center" v-if="relationsCenter.length > 0">
                  <div class="flex flex-col">
                    <w-btn
                      color="primary"
                      flat
                      v-for="rel of relationsCenter"
                      :key="`rel-id-` + rel.id"
                      v-bind="relationLink(rel)">
                      <w-icon class="me-2" :name="rel.icon" />
                      <span>{{ rel.label }}</span>
                    </w-btn>
                  </div>
                </div>
                <div class="min-w-0 flex-1 text-right" v-if="relationsRight.length > 0">
                  <w-btn
                    class="ms-2 mb-2"
                    padding="sm md"
                    outline
                    color="primary"
                    v-for="rel of relationsRight"
                    :key="`rel-id-` + rel.id"
                    v-bind="relationLink(rel)">
                    <div class="flex flex-col text-left pe-4">
                      <div class="text-body2">
                        <strong>{{ rel.label }}</strong>
                      </div>
                      <div class="text-caption">{{ rel.caption }}</div>
                    </div>
                    <w-icon :name="rel.icon" />
                  </w-btn>
                </div>
              </div>
            </template>
            <template v-if="siteStore.features.comments && pageStore.allowComments">
              <w-separator class="my-6" />
              <!--
                `commentsProvider` is set only for a third-party `codeTemplate` provider
                (Disqus/Commento/Artalk); the native provider and no provider at all both fall to
                `page-comments`.
              -->
              <div class="page-comments-measure">
                <page-comments-embed v-if="siteStore.commentsProvider" />
                <page-comments v-else />
              </div>
            </template>
          </div>
          <!--
            Inside the scrolling column, and last: the footer is the bottom of the PAGE, reached by
            reading to the end of it rather than pinned over the article the whole way down.
          -->
          <w-footer>
            <footer-nav />
          </w-footer>
        </w-scroll-area>
      </div>
      <!-- -> Also how the panel is dismissed without picking a heading; same treatment as `WDrawer`'s -->
      <transition name="page-sidebar-scrim">
        <div v-if="tocPanelIsOpen" class="page-sidebar-scrim" @click="closeTocPanel" />
      </transition>
      <!--
        Mounted at every width: below 750px this is a slide-in panel rather than a column, and `is-open`
        is what decides whether it is on screen. The click handler tests `closest('a')` rather than any
        click, so the panel closes behind a heading or tag link but not behind the tag editor's button.
      -->
      <div
        class="page-sidebar"
        v-if="showSidebar"
        :class="{ 'is-open': tocPanelIsOpen }"
        :style="siteStore.theme.tocPosition === `left` ? `order: 1;` : `order: 2;`"
        @click="onSidebarClick">
        <!--
          This wrapper lets the cards below fill the rail's height through the same flex pass that
          computes it, rather than an independent block-flow measurement that can round a hair taller
          and spuriously trip the column's own overflow. `NavSidebar.vue` documents the mechanism.
        -->
        <div class="page-sidebar-content">
          <!--
            Two boxes because Cobalt draws the rail as two floating cards where Ledger draws one
            continuous column. Every `--float-*` token collapses to transparent/0/none under Ledger, so
            the wrappers are invisible there.
          -->
          <div class="page-sidebar-card" v-if="showToc">
            <div class="page-sidebar-heading">{{ t('common.page.contents') }}</div>
            <page-toc
              :nodes="pageStore.toc"
              :min-depth="pageStore.tocDepth.min"
              :max-depth="pageStore.tocDepth.max"
              v-model:selected="state.tocSelected" />
          </div>
          <div class="page-sidebar-card" v-if="showTags || showRevision || showWatching">
            <template v-if="showTags">
              <w-separator v-if="showToc" />
              <div
                @mouseover="state.showTagsEditBtn = true"
                @mouseleave="state.showTagsEditBtn = false">
                <div class="flex items-center">
                  <div class="page-sidebar-heading flex-1">{{ t('common.page.tags') }}</div>
                  <!--
                  Hidden with `visibility`, not `display: none` (which took the row's height with it and
                  jumped the heading 6px) and not `opacity: 0` alone (which leaves it in the tab order
                  and hit-testable). A reader who cannot save gets no button at all.
                -->
                  <w-btn
                    v-if="canEditPage"
                    class="tags-edit-btn"
                    :class="{ 'is-hidden': !state.tagEditMode && !state.showTagsEditBtn }"
                    size="sm"
                    padding="none xs"
                    :icon="state.tagEditMode ? `tabler:check` : `tabler:pencil`"
                    color="accent"
                    flat
                    :label="
                      state.tagEditMode ? t('common.actions.exitEdit') : t('common.actions.edit')
                    "
                    @click="state.tagEditMode = !state.tagEditMode" />
                </div>
                <page-tags :edit="state.tagEditMode" />
              </div>
            </template>
            <!-- -> No link to the full history: that is a page of its own, reached from the actions
                 column, and a link here would be a second way to the same place -->
            <template v-if="showRevision">
              <w-separator v-if="showToc || showTags" />
              <div class="page-sidebar-heading">{{ t('common.page.revision') }}</div>
              <div class="page-sidebar-revision">
                <div v-if="revisionLine">{{ revisionLine }}</div>
                <div v-if="pageStore.authorName" class="flex flex-wrap items-center gap-1">
                  <span>{{ pageStore.authorName }}</span>
                  <!--
                  Provenance: whether a person typed this or an MCP tool call acting as them. The row's
                  `flex-wrap` lets the badge drop under the name on a narrow column rather than
                  truncating either.
                -->
                  <w-badge v-if="pageStore.revision?.via === 'mcp'" outline color="accent">
                    {{ t('history.viaMcp') }}
                    <w-tooltip>{{ t('history.viaMcpHint') }}</w-tooltip>
                  </w-badge>
                </div>
                <!-- -> The masthead's own "Last modified" value: the same fact about the same page,
                   so the two must not drift -->
                <div v-if="pageStore.updatedAt" class="page-sidebar-revision-time">
                  {{ lastModified }}
                </div>
              </div>
            </template>
            <!--
            Absent entirely, heading and rule included, when nobody watches -- and a failed or refused
            fetch looks the same on purpose. A rail section is a glance, not a place to report an error;
            the bell in the page header is where watching is acted on and where failures surface.
          -->
            <template v-if="showWatching">
              <!-- -> Each rail section owns the rule ABOVE it, conditioned on there being anything
                   above it to separate from -->
              <w-separator v-if="showToc || showTags || showRevision" />
              <div class="page-sidebar-heading">{{ t('common.page.watching') }}</div>
              <div class="page-watchers">
                <!-- -> The plate is two letters wide by design, so the full name is hovered for; two
                     uppercase letters are not a name to a screen reader either -->
                <component
                  :is="canViewProfiles ? 'button' : 'div'"
                  v-for="watcher of watcherPlates"
                  :key="watcher.userId"
                  class="page-watchers-plate"
                  :class="{ 'page-watchers-plate--button': canViewProfiles }"
                  :type="canViewProfiles ? 'button' : undefined"
                  :aria-haspopup="canViewProfiles ? 'dialog' : undefined"
                  :title="watcher.name"
                  :aria-label="
                    canViewProfiles
                      ? t('profilePopover.avatarLabel', { name: watcher.name })
                      : watcher.name
                  "
                  @click="openWatcherProfile(watcher, $event)">
                  {{ watcher.initials }}
                </component>
                <span
                  v-if="watcherRemainder > 0"
                  class="page-watchers-remainder"
                  :title="t('common.page.watchingMore', { count: watcherRemainder })"
                  :aria-label="t('common.page.watchingMore', { count: watcherRemainder })">
                  +{{ watcherRemainder }}
                </span>
              </div>
            </template>
          </div>
        </div>
      </div>
      <page-actions-col v-if="!pageStore.notFound" />
    </div>
    <!--
      Not gated on having scrolled, as scroll-to-top is: the contents are how a reader decides where to
      go in a long page, which is most useful before they have gone anywhere.

      `right-0`, not `end-0`, on purpose: this corner pairs with ANOTHER fixed corner button rather than
      with the reading direction, so it must not move when the locale does -- see
      `frontend/src/physicalPositioning.test.js`. `toc-open-btn-anchor` is the hook the Cobalt-only
      `bottom` override below clears the fixed footer bar with.
    -->
    <transition name="toc-open-btn">
      <div v-if="showTocPanelBtn" class="toc-open-btn-anchor fixed bottom-0 right-0 z-30">
        <w-btn
          class="corner-btn corner-btn--right"
          icon="tabler:binary-tree"
          color="primary"
          round
          size="md"
          :aria-label="t(`common.page.contents`)"
          :aria-expanded="tocPanelIsOpen"
          @click="openTocPanel" />
      </div>
    </transition>
    <!--
      On screen for as long as `?highlight=` is, whether or not the term was found: a silent "0 of 0"
      says more than nothing appearing, since the reader followed a graph node promising this term.
    -->
    <transition name="keyword-highlight-bar">
      <div
        v-if="showHighlightIndicator"
        class="keyword-highlight-bar fixed z-30"
        role="status"
        aria-live="polite">
        <span class="keyword-highlight-bar-count">{{ highlightCountLabel }}</span>
        <w-btn
          flat
          dense
          round
          size="sm"
          icon="tabler:arrow-up"
          :disabled="highlightMatches.length === 0"
          :aria-label="t('common.renderedContent.highlightPrevious')"
          @click="goToPreviousHighlightMatch" />
        <w-btn
          flat
          dense
          round
          size="sm"
          icon="tabler:arrow-down"
          :disabled="highlightMatches.length === 0"
          :aria-label="t('common.renderedContent.highlightNext')"
          @click="goToNextHighlightMatch" />
        <w-btn
          flat
          dense
          round
          size="sm"
          icon="tabler:x"
          :aria-label="t('common.renderedContent.highlightDismiss')"
          @click="dismissHighlight" />
      </div>
    </transition>
    <side-dialog />
  </w-page>
</template>

<script setup>
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch
} from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { useDark } from '@/composables/dark'
import { dialog } from '@/composables/dialog'
import { useMeta } from '@/composables/meta'
import { usePageScripts } from '@/composables/pageScripts'
import { canOpenProfilePopover, openProfilePopover } from '@/composables/profilePopover'
import { useMinWidth } from '@/composables/screen'
import { notify } from '@/composables/notify'
import { useTaskToggle } from '@/composables/taskToggle'
import { loading } from '@/composables/loading'
import { scrollToAnchor, scrollToAnchorWhenReady } from '@/helpers/anchors'
import { apiErrorMessage } from '@/helpers/apiError'
import { pickEditor } from '@/helpers/editorPicker'
import { initials } from '@/helpers/initials'
import { log } from '@/helpers/log'
import {
  applyKeywordHighlight,
  clearKeywordHighlight,
  enhanceRenderedContent,
  routableHref,
  sameDocumentHash
} from '@/helpers/renderedContent'
import { flattenToc } from '@/helpers/toc'

import { enterCreateMode, enterEditMode, loadPageForRoute } from './index/pageRouting'

import { useEditorStore } from '@/stores/editor'
import { useFlagsStore } from '@/stores/flags'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import FooterNav from '@/components/FooterNav.vue'
import LoadingGeneric from '@/components/LoadingGeneric.vue'
import PageActionsCol from '@/components/PageActionsCol.vue'
import PageComments from '@/components/PageComments.vue'
import PageCommentsEmbed from '@/components/PageCommentsEmbed.vue'
import PageHeader from '@/components/PageHeader.vue'
import PageRedirect from '@/components/PageRedirect.vue'
import PageTags from '@/components/PageTags.vue'
import PageToc from '@/components/PageToc.vue'
import PageUnlockDialog from '@/components/PageUnlockDialog.vue'
import SideDialog from '@/components/SideDialog.vue'

const editorComponents = {
  asciidoc: defineAsyncComponent({
    loader: () => import('../components/EditorAsciidoc.vue'),
    loadingComponent: LoadingGeneric
  }),
  code: defineAsyncComponent({
    loader: () => import('../components/EditorCode.vue'),
    loadingComponent: LoadingGeneric
  }),
  markdown: defineAsyncComponent({
    loader: () => import('../components/EditorMarkdown.vue'),
    loadingComponent: LoadingGeneric
  }),
  redirect: defineAsyncComponent({
    loader: () => import('../components/EditorRedirect.vue'),
    loadingComponent: LoadingGeneric
  }),
  wysiwyg: defineAsyncComponent({
    loader: () => import('../components/EditorWysiwyg.vue'),
    loadingComponent: LoadingGeneric
  })
}

/** Deliberately not responsive: the rail is a fixed-width column, so there is no width to fit against. */
const WATCHER_PLATE_CAP = 3

const editorStore = useEditorStore()
const flagsStore = useFlagsStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const router = useRouter()
const route = useRoute()

const { t } = useI18n()

const dark = useDark()

usePageScripts()

/*
  A getter, not a plain object: the view mounts for the path and the title arrives with the page a
  moment later, and it has to keep up with every navigation after that since the view is reused rather
  than remounted.
*/
useMeta(() => ({
  title: pageStore.title
}))

const state = reactive({
  showSideDialog: false,
  sideDialogComponent: null,
  showGlobalDialog: false,
  globalDialogComponent: null,
  showTagsEditBtn: false,
  tagEditMode: false,
  tocSelected: null,
  tocPanelOpen: false
})
const pageContents = ref(null)
const { onContentChange } = useTaskToggle(pageContents)
const pageScroller = ref(null)
/**
 * The mounted `<page-header>`, reached only for its exposed `titleDisplayEl`. `null` while
 * `pageStore.notFound` -- the header is not rendered at all then -- or before it has mounted.
 */
const pageHeaderComp = ref(null)

// -> `-1` means no current match, never `0` into an empty array.
const highlightMatches = ref([])
const highlightCurrentIndex = ref(-1)

/*
  `watcherTotal` is counted server-side over EVERY watcher regardless of the `limit` asked for, which
  is what makes the `+N` remainder possible without fetching the whole list. A page nobody watches and
  a page whose watchers could not be read are the same empty list on purpose: neither draws a section.
*/
const watchers = ref([])
const watcherTotal = ref(0)

const resolvedContentWidth = computed(() =>
  userStore.contentWidth === 'site' ? siteStore.theme.contentWidth : userStore.contentWidth
)

/**
 * Below 750px the contents stop being a column beside the article and become a panel over it.
 *
 * This view's own threshold, not one of the app's shared breakpoints. `MainLayout` — where
 * scroll-to-top gives up this corner — and `749.98px` in the stylesheet below both have to agree.
 */
const isAtLeast750 = useMinWidth(750)
const tocIsPanel = computed(() => !isAtLeast750.value)

const tocPanelIsOpen = computed(() => tocIsPanel.value && showSidebar.value && state.tocPanelOpen)

const showTocPanelBtn = computed(() => tocIsPanel.value && showSidebar.value && !state.tocPanelOpen)

const siteBannerTitle = computed(() => (siteStore.banner?.title ?? '').trim())

const siteBannerContent = computed(() => (siteStore.banner?.content ?? '').trim())

const siteBannerShown = computed(
  () =>
    !editorStore.isActive &&
    siteStore.banner?.isEnabled === true &&
    (siteBannerTitle.value !== '' || siteBannerContent.value !== '')
)

const showSidebar = computed(() => {
  return (
    pageStore.showSidebar &&
    siteStore.showSidebar &&
    siteStore.theme.tocPosition !== 'off' &&
    !editorStore.isActive &&
    !pageStore.notFound &&
    // -> A redirection has no headings to list and is gone in a moment
    pageStore.editor !== 'redirect'
  )
})
/*
  Whether there is a contents SECTION, heading and separator included -- not just whether the page
  asked for one, which would draw "Contents" over empty space on a page with no headings. Asked of the
  same helper the list itself draws from, so the two cannot disagree about whether a row survives.
*/
const showToc = computed(() => {
  if (!pageStore.showToc) {
    return false
  }
  return (
    flattenToc(pageStore.toc, {
      minDepth: pageStore.tocDepth.min,
      maxDepth: pageStore.tocDepth.max
    }).length > 0
  )
})
/*
  Same question for the tags, and held open while the tag editor is in use so that removing the last
  tag does not take the field being typed into away with it.
*/
const showTags = computed(() => {
  return pageStore.showTags && (pageStore.tags?.length > 0 || state.tagEditMode)
})
/*
  Always true on a loaded page -- an author and a last-saved moment are facts about every stored page
  -- so this is not the "did the page volunteer one" question `showToc`/`showTags` ask. It guards only
  the store before a page has landed in it.
*/
const showRevision = computed(() =>
  Boolean(pageStore.revision || pageStore.authorName || pageStore.updatedAt)
)
/**
 * The difference between this line's three renderings is ABSENCE, never a zero: no `revision` at all
 * means the reader has no `read:history`, so there is no line; a `revision` with no `changeCount` is a
 * page whose only version is its creation, so `rev 1` stands alone. The full line is assembled through
 * a locale key rather than by joining two strings, so the separator and clause order stay a
 * translator's.
 *
 * The `> 0` is defensive: the server never sends a zero, and one that arrives must render as `rev 1`
 * rather than as `rev 1 · 0 changes`, which this section never draws.
 */
const revisionLine = computed(() => {
  const revision = pageStore.revision
  if (!revision?.ordinal) {
    return ''
  }
  const ordinal = t('common.page.revisionOrdinal', { ordinal: revision.ordinal })
  if (!(revision.changeCount > 0)) {
    return ordinal
  }
  return t('common.page.revisionLine', {
    revision: ordinal,
    changes: t('common.page.revisionChanges', { count: revision.changeCount }, revision.changeCount)
  })
})
const showWatching = computed(() => watcherPlates.value.length > 0)
/**
 * The leading `WATCHER_PLATE_CAP` watchers, oldest first as the route answers -- except that a reader
 * who is watching is pinned first regardless. The route is asked for only that many rows, so on a page
 * with that many existing watchers the reader's own freshly-added row is the newest and never comes
 * back in the slice at all; without the pin, pressing Watch would flip the bell while the rail stayed
 * silent about the person who pressed it. De-duplicated by `userId`, and `watcherRemainder` needs no
 * adjustment: the server's `total` already counts every real watcher.
 *
 * The two letters come from the server's own `initials` so every consumer draws the same two, falling
 * back to `helpers/initials.js`, which stays the single client-side derivation.
 */
const watcherPlates = computed(() => {
  const fetched = watchers.value
  const pinSelf = pageStore.isWatching && userStore.authenticated
  let ordered = fetched
  if (pinSelf) {
    const rest = fetched.filter((watcher) => watcher.userId !== userStore.id)
    const self = fetched.find((watcher) => watcher.userId === userStore.id) ?? {
      userId: userStore.id,
      name: userStore.name
    }
    ordered = [self, ...rest]
  }
  return ordered.slice(0, WATCHER_PLATE_CAP).map((watcher) => ({
    userId: watcher.userId,
    name: watcher.name,
    initials: watcher.initials || initials(watcher.name)
  }))
})
/**
 * Counted off the server's `total` -- every watcher, not the returned slice -- and floored at zero
 * rather than trusted: a `total` behind the list it came with would otherwise draw `+-1`.
 */
const watcherRemainder = computed(() =>
  Math.max(watcherTotal.value - watcherPlates.value.length, 0)
)
const canViewProfiles = computed(() => canOpenProfilePopover())

function openWatcherProfile(watcher, ev) {
  if (canViewProfiles.value) {
    openProfilePopover({ userId: watcher.userId, anchor: ev.currentTarget, name: watcher.name })
  }
}
/*
  Editing the tags is saving the page -- they go up with the rest of it rather than through an endpoint
  of their own -- so the test is the pair the PATCH route accepts. Read off `pagePermissions`, not
  `userStore.can()`: the group-wide list says what a user may do somewhere, and this asks about HERE.
*/
const canEditPage = computed(() =>
  ['write:pages', 'manage:pages'].some((permission) =>
    userStore.pagePermissions.includes(permission)
  )
)

/*
  `write:pages` at THIS path: page rules are written against paths, not pages, so they answer for one
  that does not exist yet, and it is the check the create endpoint itself makes. The group-wide list
  would say "may write pages somewhere", which is how a button ends up leading to a 403.

  The editor is part of the answer because creating a page opens one, and markdown is the only editor
  this view can mount.
*/
const canCreatePage = computed(
  () => userStore.pagePermissions.includes('write:pages') && siteStore.editors.markdown
)

/**
 * Two permissions of two different kinds, both needed before the Recently Deleted link is offered:
 * the GLOBAL `access:admin` is what `AdminLayout` checks on arrival, and the PAGE-scoped
 * `read:history` at this exact path is what a row for it would need to appear on that list at all. A
 * group can grant either without the other, so neither alone promises the link leads somewhere real.
 */
const canViewDeletionHistory = computed(
  () => userStore.can('access:admin') && userStore.pagePermissions.includes('read:history')
)

const relationsLeft = computed(() => {
  return pageStore.relations ? pageStore.relations.filter((r) => r.position === 'left') : []
})
const relationsCenter = computed(() => {
  return pageStore.relations ? pageStore.relations.filter((r) => r.position === 'center') : []
})
const relationsRight = computed(() => {
  return pageStore.relations ? pageStore.relations.filter((r) => r.position === 'right') : []
})
/**
 * `editorStore.isActive` is checked alongside `mode` rather than `mode` alone: `mode` stays `create`
 * until the save that flips it to `edit` completes, and starts out `create` before any page has been
 * opened -- so a stale read while merely reading a page must not suppress "Last modified" there.
 */
const isUnsavedNewPage = computed(() => editorStore.isActive && editorStore.mode === 'create')

const lastModified = computed(() => {
  return pageStore.updatedAt
    ? userStore.formatRecent(t, pageStore.updatedAt)
    : t('common.notAvailable')
})

const breadcrumbs = computed(() => [
  {
    key: 'home',
    icon: 'tabler:home',
    to: '/',
    ariaLabel: t(`common.header.home`),
    tooltip: t(`common.header.home`)
  },
  ...pageStore.breadcrumbs.map((brd) => ({
    key: brd.id,
    icon: brd.icon,
    label: brd.title,
    ariaLabel: brd.title,
    to: brd.path
  }))
])

/**
 * A repeated query key (`?highlight=a&highlight=b`) parses as an array; there is only ever one keyword
 * to carry forward, so the first value wins and anything that is not a string means no param at all.
 */
const highlightTerm = computed(() => {
  const raw = route.query.highlight
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value.trim() : ''
})

/** A term being active is the whole test: the indicator shows even when nothing was found. */
const showHighlightIndicator = computed(() => highlightTerm.value.length > 0)

const highlightCountLabel = computed(() =>
  t('common.renderedContent.highlightCount', {
    current: highlightCurrentIndex.value + 1,
    total: highlightMatches.value.length
  })
)

/*
  Keyed on the render rather than on the route: it arrives after the page has already mounted, and is
  replaced again on every save without the route moving at all.

  `highlightTerm` is a second source because the router reuses this component instance across content
  navigations, so a reader clicking a second highlighted graph node changes only the query -- an
  `onMounted` check would never see it. `pageStore.title` is a third: the title is a reactive text node
  in `PageHeader.vue`, not `v-html` like the body, and `applyKeywordHighlight`'s clear-then-rewrap
  detaches Vue's binding from it, so a title change under an active highlight would leave stale marks.
*/
watch(
  [() => pageStore.render, highlightTerm, () => pageStore.title],
  () => {
    nextTick(() => {
      enhanceRenderedContent(pageContents.value, t)
      syncKeywordHighlight()
    })
  },
  { immediate: true }
)

/*
  `pageSave` patches `pageStore.render` while the editor is STILL mounted, so the watcher above fires
  against a null `pageContents` and no-ops. Only afterwards does the editor close and mount the reading
  view, and none of that watcher's three sources move again at that point -- so without this, the
  rendered content is never enhanced until something else changes render/title/highlight.

  `isActive` flipping to `false` is the one signal that watcher cannot see for itself. Re-running on
  every other path the editor closes onto (locked, not found, redirect) is a no-op: `pageContents`
  stays null there and `enhanceRenderedContent` guards on it.
*/
watch(
  () => editorStore.isActive,
  (isActive) => {
    if (isActive) {
      return
    }
    nextTick(() => {
      enhanceRenderedContent(pageContents.value, t)
      syncKeywordHighlight()
    })
  }
)

/*
  Keyed on the page rather than on the flag, so dismissing the prompt does not immediately reopen it --
  the lock screen's own button is the way back in -- while walking to another protected page prompts
  again.

  Deliberately NOT `immediate`: this component remounts around any route outside the page view and the
  store it reads is global, so an immediate run fires against whatever page was on screen BEFORE that
  detour. Every real case still fires, because `pageLoad` clears the flag as it starts and the reply
  sets it again -- a locked page always arrives as a change, mount or no mount.
*/
watch(
  () => (pageStore.isLocked ? pageStore.id : null),
  (lockedPageId) => {
    if (lockedPageId) {
      promptUnlock()
    }
  }
)

/*
  Fetched here rather than in `pageStore.pageLoad`: it is a second round trip and the article must not
  wait on it.

  `pageStore.watchersRevision` rather than `isWatching`, which flips synchronously the moment the bell
  is pressed, before the PUT/DELETE it kicked off has committed -- a watcher keyed on it asked the
  server while the write was still in flight and got back the state from before the click.
  `watchersRevision` only moves once that request has resolved.

  Same generation guard as `pageLoadGeneration` below: navigating A -> B while A's watchers are still
  in flight must not let A's answer land over B's.
*/
let watchersGeneration = 0

watch(
  [showSidebar, () => pageStore.id, () => pageStore.watchersRevision],
  async ([sidebarShown, pageId]) => {
    const generation = ++watchersGeneration
    // -> Cleared first, unconditionally: whatever is on screen belongs to the page being left.
    watchers.value = []
    watcherTotal.value = 0
    if (!sidebarShown || !pageId || !siteStore.id) {
      return
    }
    try {
      const resp = await API_CLIENT.get(`sites/${siteStore.id}/pages/${pageId}/watchers`, {
        searchParams: { limit: WATCHER_PLATE_CAP }
      }).json()
      if (generation !== watchersGeneration) {
        return
      }
      watchers.value = resp?.watchers ?? []
      watcherTotal.value = resp?.total ?? 0
    } catch (err) {
      /*
        Silent by design, and the section stays absent: who watches a page is not something the reader
        asked for, and the request is refused for ordinary reasons the view already says out loud.
      */
      log.warn('page', 'could not load the page watchers', err)
    }
  },
  { immediate: true }
)

/*
  `hashchange` is handled here as well as natively because the browser gets nowhere when the heading is
  inside a panel that is not open — the helper reveals it first.
*/
onMounted(() => {
  window.addEventListener('hashchange', onHashChange)
  window.addEventListener('keydown', onWindowKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange)
  window.removeEventListener('keydown', onWindowKeydown)
})

function onHashChange() {
  scrollToAnchorWhenReady(window.location.hash)
}

/**
 * A window-level listener rather than one scoped to the indicator: find-mode arrived already active,
 * from a graph click, so nothing is focused for a scoped handler to sit on. `WDialog`'s own Escape
 * handling does not stop propagation, so Escape with a dialog open both closes it and dismisses the
 * highlight -- harmless, since dismissing an inactive highlight is a no-op.
 */
function onWindowKeydown(ev) {
  if (ev.key === 'Escape' && showHighlightIndicator.value) {
    dismissHighlight()
  }
}

/*
  The watcher below is `async` and Vue does not cancel a previous, still-running invocation when
  `route.path` changes again -- so navigating A -> B while A's `pageLoad` is in flight can let A's
  slower response land AFTER B's, stomping B's title/body/tags/permissions. A plain counter, not
  reactive state: it is only ever read and written inside the watcher's own closures.
*/
let pageLoadGeneration = 0

watch(
  () => route.path,
  async (newValue) => {
    if (editorStore.ignoreRouteChange) {
      editorStore.$patch({ ignoreRouteChange: false })
      return
    }

    if (newValue.startsWith('/_create')) {
      return enterCreateMode(route, { router, t })
    }

    if (newValue.startsWith('/_edit')) {
      return enterEditMode(route, { router })
    }

    if (newValue.startsWith('/_')) {
      return
    }

    // -> Captured before the first await.
    const generation = ++pageLoadGeneration
    return loadPageForRoute(route, generation, {
      router,
      state,
      pageContents,
      scrollPageToTop,
      currentGeneration: () => pageLoadGeneration
    })
  },
  { immediate: true }
)

/**
 * The article column scrolls, not the window, so the router's own `scrollBehavior` has nothing to do:
 * it scrolls the document, which never moved. Called before the content is swapped, so the jump
 * happens on the page being left rather than showing the new one at the old offset for a frame. A
 * `#heading` in the URL still wins -- `scrollToAnchorWhenReady` runs once the render has settled.
 */
function scrollPageToTop() {
  pageScroller.value?.$el?.scrollTo({ top: 0, left: 0 })
}

/**
 * `null` while `pageStore.notFound` or before the header mounts. Reaches into the component instance
 * rather than a plain template ref because the title lives in a separate DOM subtree from
 * `.page-contents`.
 */
function highlightableTitleEl() {
  return pageHeaderComp.value?.titleDisplayEl ?? null
}

/**
 * Reads `highlightTerm` fresh rather than taking it as an argument -- always called from the watcher
 * above, after `nextTick`, so the DOM and the term are already in step. Matches are concatenated
 * title-first, so the "N of M" count and navigation walk the title before the body it sits above.
 *
 * Always resets to match 0: `applyKeywordHighlight`'s clear-then-rewrap has already thrown away the
 * `<mark>` the old index pointed at, so keeping it would point navigation at a detached node.
 */
function syncKeywordHighlight() {
  const term = highlightTerm.value
  if (!term) {
    clearKeywordHighlight(highlightableTitleEl())
    clearKeywordHighlight(pageContents.value)
    highlightMatches.value = []
    highlightCurrentIndex.value = -1
    return
  }

  const { matches: titleMatches } = applyKeywordHighlight(highlightableTitleEl(), term)
  const { matches: bodyMatches } = applyKeywordHighlight(pageContents.value, term)
  const matches = [...titleMatches, ...bodyMatches]
  highlightMatches.value = matches
  highlightCurrentIndex.value = matches.length > 0 ? 0 : -1
  if (matches.length > 0) {
    focusHighlightMatch(0)
  }
}

function focusHighlightMatch(index) {
  for (const [i, mark] of highlightMatches.value.entries()) {
    mark.classList.toggle('is-current-match', i === index)
  }
  highlightCurrentIndex.value = index
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  highlightMatches.value[index]?.scrollIntoView({
    behavior: reduceMotion ? 'auto' : 'smooth',
    block: 'center'
  })
}

function stepHighlightMatch(delta) {
  const total = highlightMatches.value.length
  if (total === 0) {
    return
  }
  focusHighlightMatch((highlightCurrentIndex.value + delta + total) % total)
}

function goToNextHighlightMatch() {
  stepHighlightMatch(1)
}

function goToPreviousHighlightMatch() {
  stepHighlightMatch(-1)
}

/**
 * `router.replace`, not `push`: no new history entry, so Back leaves by however the reader actually
 * arrived rather than bouncing them straight back into find-mode.
 */
function dismissHighlight() {
  clearKeywordHighlight(highlightableTitleEl())
  clearKeywordHighlight(pageContents.value)
  highlightMatches.value = []
  highlightCurrentIndex.value = -1
  if (!('highlight' in route.query)) {
    return
  }
  const query = { ...route.query }
  delete query.highlight
  router.replace({ path: route.path, query, hash: route.hash })
}

/**
 * A target is stored as `PageRelationDialog` leaves it — a rooted path within this wiki or a complete
 * external address — so the two are told apart by `routableHref`, the same way an in-content link is,
 * and the router takes the ones that are ours rather than reloading the app to reach them.
 *
 * Nothing at all for a relation with no target: the dialog only requires a label, and an `<a>` with an
 * empty href reloads the current page.
 */
function relationLink(rel) {
  const target = rel.target?.trim()
  if (!target) {
    return {}
  }
  let url
  try {
    // -> Resolved against this origin, because a stored page target is a path rather than a URL and
    //    `routableHref` compares origins
    url = new URL(target, window.location.origin)
  } catch {
    return {}
  }
  const routed = routableHref({ href: url.toString() }, window.location)
  if (routed) {
    return { to: routed }
  }
  // -> A target is author-supplied, and `javascript:` in an href is script this page would run on
  //    click
  return /^https?:$/.test(url.protocol) ? { href: url.toString() } : {}
}

function onContentClick(ev) {
  if (
    ev.defaultPrevented ||
    ev.button !== 0 ||
    ev.metaKey ||
    ev.ctrlKey ||
    ev.shiftKey ||
    ev.altKey
  ) {
    return
  }
  const anchor = ev.target?.closest?.('a[href]')
  if (!anchor) {
    return
  }
  /*
    Through the helper, so a heading inside a closed tab is revealed first, and only claimed once it
    says it found somewhere to go -- a fragment naming nothing in the render is left to the browser.
    `router.push` rather than assigning `location.hash`, which would jump the page as well; since a
    pushed hash sets no target element, marking where the reader landed is the helper's job
    (`LANDED_CLASS`) rather than `:target`'s.
  */
  const hash = sameDocumentHash(anchor, window.location)
  if (hash) {
    if (scrollToAnchor(hash, { smooth: true })) {
      ev.preventDefault()
      router.push({ path: route.path, query: route.query, hash })
    }
    return
  }
  const target = routableHref(anchor, window.location)
  if (!target) {
    return
  }
  ev.preventDefault()
  router.push(target)
}

function openTocPanel() {
  state.tocPanelOpen = true
}

function closeTocPanel() {
  state.tocPanelOpen = false
}

/**
 * Delegated rather than bound per row: `PageToc` emits only `update:selected`, which does not fire
 * again when the heading already showing is picked a second time — so a click is the thing to listen
 * for, not the selection changing. Any anchor counts, which is what also covers a tag.
 */
function onSidebarClick(ev) {
  if (tocPanelIsOpen.value && ev.target?.closest?.('a')) {
    closeTocPanel()
  }
}

function promptUnlock() {
  dialog({ component: PageUnlockDialog })
}

/**
 * The path comes from the store rather than from the route, because the route is where it goes: the
 * editor moves to `/_create/<editor>` and the path travels in the page itself, the same way every
 * other New Page button works. `pickEditor` asks only when the site has more than one editor active.
 */
async function createPage() {
  const editor = await pickEditor(siteStore)
  if (!editor) {
    return
  }
  loading.show()
  try {
    await pageStore.pageCreate({ editor, path: pageStore.path, locale: pageStore.locale })
  } catch (err) {
    notify({ type: 'negative', message: apiErrorMessage(err) })
  } finally {
    loading.hide()
  }
}

/**
 * `router.back()` alone lands on the wiki's own error screen for a reader who arrived at this URL
 * directly, having nothing to go back to, so that case goes home.
 */
function goBack() {
  if (window.history.state?.back) {
    router.back()
  } else {
    router.push('/')
  }
}
</script>

<style>
.page-contents .task-list-item-checkbox:not(:disabled) {
  cursor: pointer;
}

/*
  Shared by the lock screen, the missing page and the redirection so the three cannot drift apart --
  `PageRedirect.vue` draws its own screens with these classes for that reason.
*/
.page-placeholder {
  display: flex;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* -> Off dead centre: the text reads better a little above the middle of the column */
  padding: 0 24px 10vh;
  text-align: center;

  /*
    Stated per theme because the article's own colours come from `_page-contents.css`: a plain block
    dropped in beside it inherits the document's black and goes invisible on the dark surface.
  */
  .body--light & {
    color: var(--color-grey-9);
  }
  .body--dark & {
    color: #fff;
  }
}

.page-placeholder-icon {
  margin-bottom: 24px;
  font-size: 96px;
  opacity: 0.12;
}

.page-breadcrumbs {
  /*
    41px to match `MainLayout.vue`'s `.sidebar-actions`, the band immediately to the left: the two sit
    at the same vertical position and each rules itself off with its own hairline, so any disagreement
    in height leaves the two rules on different lines. Both boxes are `border-box`, so that 1px border
    is inside the 41px on either side.

    A fixed height at all, rather than one sized by its contents, because the bar's height otherwise
    moved with whatever the trail held: a crumb with an icon made it taller than one without.
    `min-height` rather than `height` so a trail long enough to wrap can still grow past the band.
  */
  min-height: 41px;
  font-family: var(--font-mono);
  font-size: 11.5px;

  /*
    The bar sets a background per theme, so it owes a foreground too: the LAST crumb deliberately
    inherits rather than taking `active-color`, and in dark mode would inherit the document's black.
  */
  .body--light:not(.body--cobalt) & {
    background-color: var(--color-surface);
    border-bottom: 1px solid var(--color-hairline);
    color: var(--color-text-caption);
  }
  .body--dark:not(.body--cobalt) & {
    background-color: var(--color-dark-3);
    border-bottom: 1px solid var(--color-hairline-dark);
    color: var(--color-text-caption-dark);
  }

  /*
    One rule for both themes: every token in it is already aesthetic- and theme-aware.

    Every non-last `<li>` carries an inline `color` from `WBreadcrumbs`' `active-color` prop, so a
    plain `color:` on this block alone never reaches a trail segment. `.w-breadcrumbs__el` gets its own
    explicit `color` instead -- a declaration on the element beats an inherited value with no
    `!important`. The separator's inline `color` sits on that SAME `<li>`, not a child, so unseating
    it does need one.
  */
  body.body--cobalt & {
    background-color: transparent;
    border-bottom: 0;
    color: var(--color-text-caption);

    li:not(:last-child) .w-breadcrumbs__el {
      color: var(--color-text-caption);
    }

    li:last-child .w-breadcrumbs__el {
      color: var(--color-accent-strong);
      font-weight: 500;
    }

    .w-breadcrumbs__separator {
      color: var(--color-breadcrumb-separator) !important;
    }
  }

  /*
    Sized on the bar rather than on the crumbs: `WBreadcrumbs` sets no size of its own and its icons
    are 125% of whatever it inherits, so one declaration here takes the text and the icons down
    together and keeps the two in proportion.
  */
  @media (max-width: 599.98px) {
    min-height: 30px;
    font-size: 10.5px;
  }
}

.page-breadcrumbs-modified {
  white-space: nowrap;

  .body--light & {
    color: var(--color-text-caption);
  }
  .body--dark & {
    color: var(--color-text-caption-dark);
  }
}
/*
  The same 120px on every page: sized by its contents, the band came out taller on a page with a
  description than on one without, and moving between the two visibly shifted the article under it.
  The 8px of block padding is what makes 120px reachable -- the text column brings its own `p-4`, and
  16px here on top of that left less room than a title-plus-description block needs.

  A MINIMUM, not a height, for one case: a title long enough to wrap. There is about a line of slack at
  120px, and a fixed height here has already cropped a wrapped title once.
*/
.page-header {
  min-height: 120px;
  padding-block: 8px;
  margin-inline: var(--page-header-margin-inline);
  margin-block-start: var(--page-header-margin-block-start);
  border-radius: var(--page-header-radius);
  box-shadow: var(--page-header-shadow);
  background: var(--page-header-bg);
  color: var(--page-header-fg);
  /*
    Sized by its contents on a phone instead: the 120px is pitched for a 64px icon beside 34px display
    type, and holding it under the halved icon and title left empty ground under the description.
  */
}
@media (max-width: 599.98px) {
  .page-header {
    min-height: 0;
    padding-block: 10px;
  }
}
.page-header {
  /* Ledger draws no card, just a ruled-off band, so its hairline stays a literal rule. */
}
.body--light .page-header {
  background-color: var(--color-surface);
  border-bottom: 1px solid var(--color-hairline);
}
.body--dark .page-header {
  background-color: var(--color-dark-3);
  border-bottom: 1px solid var(--color-hairline-dark);
}
.page-header {
  /*
    One rule for both themes -- the mockups draw the identical banner in light and dark.
    `background-color` must be restated rather than left to the base rule's `background:` shorthand:
    the light/dark rules above declare their own at the same two-class specificity, and light/dark and
    ledger/cobalt are independent body classes, so both can be present at once. The added type
    selector is what lets this block win over either.
  */
}
body.body--cobalt .page-header {
  border-bottom: 0;
  background-color: var(--page-header-bg);
}
.page-header {
  /* The one place the display face is set at full size; `pretty` stops a two-line title orphaning a word. */
}
.page-header-title {
  font-family: var(--font-display);
  font-size: 36px;
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: normal;
  text-wrap: pretty;
  /*
    The masthead's own foreground, not the app's ink: Cobalt's banner is a saturated flat colour with a
    white title. Dark mode keeps its own value, but only for Ledger -- Cobalt's banner is identical in
    both themes.
  */
  color: var(--page-header-fg);
}
.body--dark:not(.body--cobalt) .page-header-title {
  color: var(--color-text-dark);
}
.page-header {
  /* 400, not 500: at the title's weight the description read as a second heading. */
}
.page-header-subtitle {
  margin-top: 6px;
  font-weight: 400;
  font-size: 14.5px;
  line-height: 1.45;
  letter-spacing: normal;
  color: var(--page-header-subtitle-fg);
}
.body--dark:not(.body--cobalt) .page-header-subtitle {
  color: var(--color-text-secondary-dark);
}
/*
  `flex: 1 0 auto` on the article keeps the footer at the BOTTOM of a short page instead of leaving it
  hanging under two lines of content: the article takes the leftover height, and past that grows with
  its own content. It must not shrink either, or a long article would be squeezed rather than scroll.
*/
.page-container-scrl {
  display: flex;
  flex-direction: column;

  /*
    Under Cobalt the site footer becomes a full-width bar pinned to the bottom of the WINDOW.
    `position: fixed` is the whole mechanism -- nothing relocates the element in the template -- and it
    depends on nothing between here and the viewport setting a `transform`/`filter`/`contain` that
    would give it a nearer containing block.

    `inset-inline: 0` rather than `width: 100vw`: with a reserved scrollbar gutter, `100vw` counts the
    scrollbar as part of the viewport and forces a horizontal scrollbar into existence.

    `z-index: 45` sits one step above the overlay nav drawer's `z-40` (`WDrawer.vue`) and its `z-30`
    scrim. The nav drawer is the one exception: `MainLayout.vue` overrides ITS overlay to `46`.

    `.page-container-scrl` in the selector, not a bare `.w-footer`: this stylesheet is unscoped, so an
    unqualified class selector would reach every `<w-footer>` in the app -- `FileManager.vue`'s status
    bar and `Search.vue`'s footer use the same component and must not be affected.
  */
  .w-footer {
    body.body--cobalt & {
      position: fixed;
      inset-inline: 0;
      bottom: 0;
      z-index: 45;

      /*
        The bar makes room for the nav sidebar rather than the sidebar shrinking to clear the bar: the
        sidebar should always reach the true bottom of the screen. Below `MainLayout.vue`'s
        permanent-column breakpoint the drawer is a fixed overlay taking no layout space, so the bar
        keeps the full width set above.

        `MainLayout.vue` mirrors the sidebar's width onto one of these two properties and `0px` onto
        the other, split that way because plain CSS cannot pick an inset property from a custom
        property's value. Setting both unconditionally is what makes this correct for a left- or a
        right-positioned sidebar without this stylesheet knowing which is in effect.
      */
      @media (min-width: 1200px) {
        inset-inline-start: var(--sidebar-inset-inline-start, 0px);
        inset-inline-end: var(--sidebar-inset-inline-end, 0px);
      }
    }
  }
}

/*
  The clearance goes on the wrapper, not on `.page-container-scrl`: that element is the wrapper's
  `height: 100%` child, and percentage height ignores margins, so a margin there would shrink nothing.
  (`.page-sidebar` below IS the stretched item, which is why a bare margin works there.) Addressed by
  the child combinator off the unique `.page-container` rather than a bare `.min-w-0.flex-1`, a
  Tailwind utility pair that recurs in this template and across the app.

  `32.5px` is a measurement of the footer bar's rendered height, not a formula off
  `--footer-bar-height`, whose fallback is a much larger conservative text-wrap estimate.
  `--article-column-pad`'s Cobalt bottom value is cut by the same 32.5px so the two net to zero: only
  the scrollbar track moves. Padding alone cannot do this job -- it lives INSIDE the scrollport.
*/
body.body--cobalt .page-container > .min-w-0.flex-1 {
  margin-bottom: 32.5px;
}
.page-container-body {
  flex: 1 0 auto;
  padding: var(--article-column-pad);

  @media (max-width: 599.98px) {
    padding: var(--article-column-pad-xs);
  }

  /*
    `--content-bleed` is how far the rule under an h1 reaches BACK through this surface's padding, so
    it has to move with that padding.

    Set on `.page-contents` rather than here, because that is where the default is declared and a
    custom property set on the parent would simply be shadowed by it. The editor's preview pane carries
    the class itself and pads differently, so it keeps the default.
  */
  .page-contents {
    --content-bleed: var(--content-bleed-default);
  }

  @media (max-width: 599.98px) {
    .page-contents {
      --content-bleed: var(--content-bleed-xs);
    }
  }

  /*
    In Ledger every one of these resolves to nothing, because the column IS the sheet there. In Cobalt
    the column is the paper ground and this box is the card floating on it, which is why the padding
    moves in here and `--content-bleed` goes to `0`: a card clips at its corner.
  */
  > .page-contents {
    background-color: var(--float-bg);
    padding: var(--article-card-pad);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
  }
}

/*
  A measure is a line length, not a position: the text stays FLUSH to the padded column's leading edge
  and simply stops early. Centring it left the article drifting away from the breadcrumbs and header
  above it on a wide window.

  Applied to the CONTENTS' CHILDREN rather than to `.page-contents` itself, with `block-infobox`
  excluded: an infobox floats within whatever box `.page-contents` resolves to, so capping that element
  would trap it at the measure width with nowhere to float into -- the reclaimed slack on the right is
  exactly what it is for.
*/
.page-container-body.is-measured > .page-contents > :not(block-infobox) {
  max-width: 720px;
}

.page-container-body.is-measured > .page-comments-measure {
  max-width: 720px;
}

/*
  Stated here rather than left to the body, whose ground is `--color-paper` -- see `MainLayout`.
*/
.page-container {
  .body--light:not(.body--cobalt) & {
    background-color: var(--color-surface);
  }
  .body--dark:not(.body--cobalt) & {
    background-color: var(--color-dark-3);
  }

  /*
    Transparent rather than a colour, so what shows through is `MainLayout`'s `--color-paper`: one
    ground behind every card, which is what makes them read as cards at all.
  */
  body.body--cobalt & {
    background-color: transparent;
  }
}
/*
  `visibility` is transitioned alongside the opacity so it still fades BOTH ways: as a discrete
  property it flips at the end of the transition going to hidden and at the start coming back.
*/
.tags-edit-btn {
  transition:
    opacity 0.2s var(--ease-standard),
    visibility 0.2s var(--ease-standard);

  &.is-hidden {
    visibility: hidden;
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tags-edit-btn {
    transition-duration: 0.01ms;
  }
}

.page-sidebar {
  flex: 0 0 300px;

  /*
    The inset lives on the column rather than on each section, which is what gives the rules between
    the sections their margins for free: a `w-separator` is a child of this box, so it spans the
    content width instead of running edge to edge across the rail.
  */
  padding: 28px 20px;

  /*
    1400px is this view's own threshold rather than one of the app's `--breakpoint-*`: it is where THIS
    column starts crowding the article, which depends on its own width and the nav's. 200px still holds
    a heading of a few words per line, since the contents list wraps rather than truncating.
  */
  @media (max-width: 1399.98px) {
    flex: 0 0 200px;
  }

  /*
    Below 750px it stops being a column at all and becomes a slide-in panel. `position: fixed` takes it
    out of the row, so the article gets the whole width whether the panel is open or not; `transform`
    is what animates, being the one property that moves a box without laying anything out again.

    Right regardless of `tocPosition`, and `right`/`translateX(100%)`/the shadow's x-offset all stay
    physical rather than logical: the panel is paired with the opener's fixed screen corner, not with
    the reading direction, so none of it should move when the locale does.
  */
  @media (max-width: 749.98px) {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 40;
    /* -> The wide column's width, capped so it cannot take the whole of a small screen */
    width: 300px;
    max-width: 85vw;
    transform: translateX(100%);
    transition: transform 0.2s var(--ease-standard);
    box-shadow: -2px 0 12px rgb(0 0 0 / 0.3);

    &.is-open {
      transform: none;
    }
  }

  .body--light:not(.body--cobalt) & {
    background-color: #fbfcfe;
    border-inline-start: 1px solid var(--color-hairline);
  }
  .body--dark:not(.body--cobalt) & {
    background-color: var(--color-dark-4);
    border-inline-start: 1px solid var(--color-hairline-dark);
  }

  /*
    Cobalt has no rail as a surface: the boxes inside it are cards on the page's own paper ground, so
    the column is transparent and unruled and the side inset moves into each card.
  */
  body.body--cobalt & {
    background-color: transparent;
    border-inline-start: 0;
    /*
      Left padding is 2px, not 0: `.page-sidebar-card`'s edge is a box-shadow ring
      (`--shadow-card`) extending 1px OUTSIDE its border-box. This column's `overflow-y: auto`
      silently computes `overflow-x` to `auto` too (the CSS Overflow spec's same-axis-pairing
      quirk, per `_page-contents.css`'s `.table-scroll` comment), so at 0 that 1px of ring has
      nothing to render into and is clipped away. The other three sides have padding to spare.
    */
    padding: 28px 24px 28px 2px;
  }

  .w-separator {
    --w-hairline-color: var(--color-hairline);
    margin-block: 22px;
  }
  .body--dark & .w-separator {
    --w-hairline-color: var(--color-hairline-dark);
  }

  /*
    No scrollbar styling here on purpose: one of the two standard scrollbar properties is inherited,
    and Chromium 121+ ignores every `::-webkit-scrollbar*` rule on an element carrying a non-auto value
    of the other, so declaring either here defeats the global `.body--ledger`/`.body--cobalt` spec for
    this column in every engine rather than merely losing a specificity fight.
  */
  overflow-y: auto;
  overscroll-behavior: contain;

  /*
    This column is a flex item stretched to the row's height, which can resolve to a fractional pixel
    value. Declaring it a flex column of its own is what lets `.page-sidebar-content` grow to fill it
    through that SAME layout pass rather than an independent block-flow measurement, so the two figures
    cannot round a hair apart and spuriously trip the overflow above on content that fits.
    `NavSidebar.vue`'s `.sidebar-nav` documents the mechanism.
  */
  display: flex;
  flex-direction: column;
}

/*
  `flex-grow` so it is sized by the same pass that sizes `.page-sidebar` when the cards are shorter
  than the column; `flex-shrink: 0` so it never shrinks below them when they are taller, which is
  genuine overflow and correctly still scrolls.
*/
.page-sidebar-content {
  flex: 1 0 auto;
}

/*
  This column stretches to the full height of `.page-container`'s row, so Cobalt's fixed footer bar
  paints straight over its bottom edge. `margin-bottom` shrinks the stretched box itself rather than
  padding blank space inside one that stays full height, which is what lets its scrollport -- and the
  native scrollbar riding along it -- stop above the bar. Mirrors `MainLayout.vue`'s `.bg-sidebar`.
*/
body.body--cobalt .page-sidebar {
  margin-bottom: var(--footer-bar-height);
}

/*
  Below `749.98px` this column is a fixed overlay, where a margin is NOT a no-op: with both `top` and
  `bottom` non-auto and `height: auto`, the spec solves the used height as the containing block minus
  `top`, `bottom` AND both margins. The rule above carries no width scoping, so left un-reset its
  `margin-bottom` would double-subtract the bar's height on top of the `bottom` override here. Same
  reasoning as `.bg-sidebar.w-drawer--overlay` in `MainLayout.vue`.
*/
@media (max-width: 749.98px) {
  body.body--cobalt .page-sidebar {
    margin-bottom: 0;
    bottom: var(--footer-bar-height);
  }
}

/*
  Every declaration here collapses to nothing under Ledger (`--float-bg: transparent`, `--float-pad:
  0`, `--radius-card: 0`, `--shadow-card: none`, `--float-gap: 0`), so the wrappers are invisible there
  and the rail is one continuous column; under Cobalt they are the two floating cards.
*/
.page-sidebar-card {
  background-color: var(--float-bg);
  padding: var(--float-pad);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);

  & + & {
    margin-block-start: var(--float-gap);
  }
}

/*
  The separator between Contents and Tags is the FIRST child of the second card, and under Cobalt the
  card itself replaces the rule it stands in for. The rules BETWEEN Tags, Revision and Watching sit
  inside one card and still separate three things, so they stay.
*/
.page-sidebar-card > .w-separator:first-child {
  display: var(--float-rule-display);
}

.page-sidebar-heading {
  padding-block-end: 12px;
  color: var(--color-text-caption);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

.body--dark .page-sidebar-heading {
  color: var(--color-text-caption-dark);
}

/*
  One rule for both themes, overriding the dark-mode tone above: `--color-text-caption` already carries
  the correct light and dark Cobalt values on its own.
*/
body.body--cobalt .page-sidebar-heading {
  color: var(--color-text-caption);
}

/*
  One type size and leading for all three lines, because they are one statement about the page read top
  to bottom rather than a list of three fields. No margin of its own: the heading above owns the gap
  under itself, as it does for the contents list and the tag row.
*/
.page-sidebar-revision {
  color: var(--color-slate);
  font-size: 13px;
  line-height: 1.7;
}

/*
  Additive rather than a base-rule swap: Cobalt's revision tone is close to but not equal to
  `--color-slate`. Same shape as the sibling heading rule above.
*/
body.body--cobalt .page-sidebar-revision {
  color: var(--color-text-body);
}

.page-sidebar-revision-time {
  color: var(--color-text-caption);
}

.body--dark .page-sidebar-revision {
  color: var(--color-text-dark);
}

.body--dark .page-sidebar-revision-time {
  color: var(--color-text-caption-dark);
}

.page-watchers {
  display: flex;
  align-items: center;
  gap: 8px;
}

/*
  Square on purpose: Cardinal draws no rounded avatars, and the rail's tags are square too.
  `flex: none` because the plate is a fixed 26px and must not be squeezed by a long remainder beside it.
*/
.page-watchers-plate {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--color-hairline);
  /* -> A raw hex because there is no token at this step, between tint and hairline */
  background-color: #e9edf5;
  color: var(--color-slate);
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}

.page-watchers-plate--button {
  padding: 0;
  cursor: pointer;
}

.body--dark .page-watchers-plate {
  border-color: var(--color-hairline-dark);
  background-color: var(--color-dark-2);
  color: var(--color-text-dark);
}

.page-watchers-remainder {
  color: var(--color-text-caption);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 400;
}

.body--dark .page-watchers-remainder {
  color: var(--color-text-caption-dark);
}

/*
  One step below the panel it dims, and the same z-index as the nav drawer's scrim. The opener is at
  z-30 too but is not rendered while the panel is open, so the two never overlap.
*/
.page-sidebar-scrim {
  position: fixed;
  inset: 0;
  z-index: 30;
  background-color: rgb(0 0 0 / 0.4);
}

.page-sidebar-scrim-enter-active,
.page-sidebar-scrim-leave-active,
.toc-open-btn-enter-active,
.toc-open-btn-leave-active {
  transition: opacity 0.2s var(--ease-standard);
}
.page-sidebar-scrim-enter-from,
.page-sidebar-scrim-leave-to,
.toc-open-btn-enter-from,
.toc-open-btn-leave-to {
  opacity: 0;
}

/*
  The contents opener occupies the same bottom-right corner as Cobalt's fixed footer bar below 750px,
  and the bar is opaque and higher (`z-index: 45`), so left un-cleared it paints over the reader's only
  way to open the contents panel. No `margin-bottom` counterpart is needed: this button is never a
  stretched box. No narrow-viewport media query either -- `showTocPanelBtn` is already `false` at 750px
  and up, so the rule is dormant whenever the button is not rendered.
*/
body.body--cobalt .toc-open-btn-anchor {
  bottom: var(--footer-bar-height);
}

/*
  The breadcrumb bar and the page header above are both `position: static`, so this is the one element
  on the view actually pinned to the viewport up here.
*/
.keyword-highlight-bar {
  top: 12px;
  /* -> Physical `left` is fine: there is nothing about "centre" for a locale to disagree with */
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 4px;
  /*
    Logical, not physical: the extra room belongs at the START next to the count text and the tighter
    side at the END next to the close button, and the row itself flips under RTL where a physical
    `left`/`right` pair would not follow it.
  */
  padding-block: 4px;
  padding-inline: 12px 6px;
  border-radius: 999px;
  box-shadow: 0 2px 10px rgb(0 0 0 / 0.25);

  .body--light & {
    background-color: #fff;
    color: var(--color-grey-9);
  }
  .body--dark & {
    background-color: var(--color-dark-4);
    color: #fff;
  }
}

.keyword-highlight-bar-count {
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.keyword-highlight-bar-enter-active,
.keyword-highlight-bar-leave-active {
  transition:
    opacity 0.2s var(--ease-standard),
    transform 0.2s var(--ease-standard);
}
.keyword-highlight-bar-enter-from,
.keyword-highlight-bar-leave-to {
  opacity: 0;
  transform: translate(-50%, -8px);
}

@media (prefers-reduced-motion: reduce) {
  .page-sidebar,
  .page-sidebar-scrim-enter-active,
  .page-sidebar-scrim-leave-active,
  .toc-open-btn-enter-active,
  .toc-open-btn-leave-active,
  .keyword-highlight-bar-enter-active,
  .keyword-highlight-bar-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
