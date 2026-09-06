<template>
  <!--
    `h-full min-h-0`: the shell hands this page a definite height, and the page has to CLAIM it for
    the article column below to scroll on its own. Left to grow, the whole page would scroll inside
    the shell instead and take the sidebars with it.
  -->
  <w-page class="flex flex-col h-full min-h-0">
    <!--
      Both bars are about a page: where it sits and when it was last written to. A path with no page
      AT ALL -- `pageStore.notFound` -- has neither to report, so the missing-page screen below is the
      whole column.

      Kept mounted through editing too (OpenProject #813), not just while reading: the trail is still
      how an author gets back out, and "Last modified" is exactly as useful mid-edit as it is while
      reading -- `pageStore.path`/`breadcrumbs` and `updatedAt` do not move until a save actually lands
      (see `pageSave`), so the bar keeps reporting the true last-saved state throughout an edit rather
      than something that just changed underfoot. Staying mounted across the view-to-edit transition
      also means this is no longer one more thing reflowing at the same moment as the side nav closing
      and the preview pane sliding in.
    -->
    <!-- -> `py-1` on a phone: with the date gone the bar holds one line of small type, and 8px above and
            below it made a strip nearly as tall as the crumbs themselves -->
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
        Off on a phone: on a 390px screen the date takes a whole line of its own under the trail, which
        is a lot of room for something a reader is not here for -- and the trail itself is how they get
        back out, so that is what the bar keeps.

        Also off for a page that has never been saved (`isUnsavedNewPage`): there is no last-saved
        moment to report yet, and `publishState`/`updatedAt` at that point either are blank or, absent
        the reset in `pageCreate`, would be carried over from whatever page was open before. The trail
        above stays up regardless, title-only if that is all there is -- the path is real even before
        the page behind it is.
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
    <page-header v-if="!pageStore.notFound" />
    <!-- -> `min-h-0` so the columns inside can be shorter than their content and scroll -->
    <div class="page-container flex min-h-0 flex-nowrap items-stretch" style="flex: 1 1 100%">
      <div
        class="min-w-0 flex-1"
        :style="siteStore.theme.tocPosition === `left` ? `order: 2;` : `order: 1;`">
        <component :is="editorComponents[editorStore.editor]" v-if="editorStore.isActive" />
        <!--
          The lock screen, in place of the article. There is nothing to hide here: the server sent no
          body at all, so this is the whole of what arrived for a protected page.
        -->
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
        <!--
          The same column for a path with no page behind it, which is a state of this view rather than
          an error screen: the reader is still inside the wiki, at a URL that could hold a page, and
          for anyone who may write one the answer to "this page does not exist" is the button that
          creates it -- at this path, so that the link they followed leads somewhere afterwards.
        -->
        <div v-else-if="pageStore.notFound" class="page-placeholder">
          <w-icon class="page-placeholder-icon" name="tabler:file-text" />
          <!-- -> "...yet" is an invitation, so it is for whoever can take it up; to a reader who
               cannot write here the page simply does not exist -->
          <div class="text-h6">
            {{ canCreatePage ? t('common.newpage.title') : t('common.notfound.subtitle') }}
          </div>
          <div class="text-body2 mt-1 opacity-60" v-if="canCreatePage">
            {{ t('common.newpage.subtitle') }}
          </div>
          <!--
            The path itself, because the sentence above is about a page the reader cannot see and this
            is the one thing that says WHICH page: the link they followed, and what the button is about
            to create.
          -->
          <div class="text-caption font-robotomono mt-3 opacity-50">/{{ pageStore.path }}</div>
          <w-btn
            class="mt-6"
            v-if="canCreatePage"
            icon="tabler:plus"
            color="primary"
            padding="xs lg"
            :label="t(`common.newpage.create`)"
            @click="createPage" />
          <!-- -> Nothing to create for this reader, so the way out is the way they came -->
          <w-btn
            class="mt-6"
            v-else
            outline
            icon="tabler:arrow-left"
            color="primary"
            padding="xs lg"
            :label="t(`common.newpage.goback`)"
            @click="goBack" />
          <!--
            A path that resolves to nothing is also what a deleted page's own address does, and
            `read:history` at this path -- fetched above alongside the rest of the permissions this
            screen needs -- is exactly the permission the Recently Deleted list itself is filtered
            on, so a reader who could not see this deletion there would not be shown a link to it.
          -->
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
          A redirection, which is a page with nowhere to read: it takes the reader on rather than
          showing them anything. Ahead of the article because there is no article -- see
          `PageRedirect.vue` -- and behind the two screens above because a page that is locked, or
          that is not there at all, has no target to have been given yet.
        -->
        <page-redirect v-else-if="pageStore.editor === `redirect`" />
        <w-scroll-area class="page-container-scrl" ref="pageScroller" v-else style="height: 100%">
          <!-- -> Half the padding on a phone, where 16px a side is 8% of the window spent on margin;
                  the stylesheet has `--content-bleed` to match -->
          <div
            class="page-container-body"
            :class="{ 'is-measured': siteStore.theme.contentWidth === `measured` }">
            <!--
              Delegated rather than bound per link: the anchors are written by `v-html`, so there is
              nothing here to put a handler on, and they are replaced wholesale on every render.
            -->
            <div
              class="page-contents"
              ref="pageContents"
              v-html="pageStore.render"
              @click="onContentClick" />
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
              <page-comments />
            </template>
          </div>
          <!--
            Inside the scrolling column, and last: this is the bottom of the PAGE, so it is reached by
            reading to the end of it rather than sitting over the article the whole way down.

            The editor replaces this column wholesale, which is how it goes without a footer, and the
            lock screen likewise -- a page that sent no body has no end to arrive at.
          -->
          <w-footer>
            <footer-nav />
          </w-footer>
        </w-scroll-area>
      </div>
      <!--
        The scrim behind the contents panel while it is overlaying the article, which is also how it is
        dismissed without picking a heading. Same treatment as the nav drawer's: see `WDrawer`.
      -->
      <transition name="page-sidebar-scrim">
        <div v-if="tocPanelIsOpen" class="page-sidebar-scrim" @click="closeTocPanel" />
      </transition>
      <!--
        The contents column. Below 750px it stops being a column and becomes a panel that slides in from
        the right over the article -- see the stylesheet -- so it stays mounted at every width and it is
        `is-open` that decides whether it is on screen.

        The click handler closes it on the way out: any anchor inside it is something that takes the reader
        somewhere (a heading, a tag), and a panel left over the place they were going would have to be
        dismissed by hand. A `<button>` in here -- the tag editor's, the rating -- is not that, which is
        why the test is `closest('a')` rather than any click at all.
      -->
      <div
        class="page-sidebar"
        v-if="showSidebar"
        :class="{ 'is-open': tocPanelIsOpen }"
        :style="siteStore.theme.tocPosition === `left` ? `order: 1;` : `order: 2;`"
        @click="onSidebarClick">
        <template v-if="showToc">
          <!-- TOC -->
          <!-- -> Its own string, not `common.page.toc`: this heading labels a column beside the
               article and reads better short, where "Table of Contents" is the full name of the
               thing and belongs where there is room for it -->
          <div class="page-sidebar-heading">{{ t('common.page.contents') }}</div>
          <page-toc
            :nodes="pageStore.toc"
            :min-depth="pageStore.tocDepth.min"
            :max-depth="pageStore.tocDepth.max"
            v-model:selected="state.tocSelected" />
        </template>
        <!-- Tags -->
        <template v-if="showTags">
          <w-separator v-if="showToc" />
          <div
            @mouseover="state.showTagsEditBtn = true"
            @mouseleave="state.showTagsEditBtn = false">
            <div class="flex items-center">
              <div class="page-sidebar-heading flex-1">{{ t('common.page.tags') }}</div>
              <!--
                Rendered for whoever may save the page, and hidden with `visibility` rather than
                removed as the pointer comes and goes: `display: none` took the row's height with it,
                so the heading jumped 6px the moment the pointer arrived. `visibility` also keeps it
                out of the tab order and out of hit-testing while hidden, which `opacity: 0` on its own
                would not.

                It stays put while editing, because that is when it is the way back out.

                A reader gets no button at all -- `v-if`, not the same `visibility` treatment, because
                for them it is not a control that happens to be out of sight.
              -->
              <w-btn
                v-if="canEditPage"
                class="tags-edit-btn"
                :class="{ 'is-hidden': !state.tagEditMode && !state.showTagsEditBtn }"
                size="sm"
                padding="none xs"
                :icon="state.tagEditMode ? `tabler:check` : `tabler:pencil`"
                color="deep-orange-9"
                flat
                :label="state.tagEditMode ? t('common.actions.exitEdit') : t('common.actions.edit')"
                @click="state.tagEditMode = !state.tagEditMode" />
            </div>
            <page-tags :edit="state.tagEditMode" />
          </div>
        </template>
        <!--
          Watching (OpenProject #2649) -- who else is following this page, as a run of initial plates
          with a `+N` remainder for everybody past the third.

          Absent entirely, heading and rule included, on a page nobody watches: the same reasoning
          `showTags` above is written against, and the reason a failed or refused request leaves this
          empty rather than saying so. A rail section is a glance, not a place to report an error --
          the bell in the page header is where watching is acted on and where a failure there is
          reported.
        -->
        <template v-if="showWatching">
          <!--
            Each rail section owns the rule ABOVE it, conditioned on there being anything above it to
            separate from -- the pattern Tags follows for Contents. `pageStore.revision` is the
            Revision section's own state (Task #2652, which inserts between Tags and this): reading
            the state rather than naming that section's computed keeps this correct both before and
            after it lands, and leaves nothing for the two to collide on.
          -->
          <w-separator v-if="showToc || showTags || Boolean(pageStore.revision)" />
          <div class="page-sidebar-heading">{{ t('common.page.watching') }}</div>
          <div class="page-watchers">
            <!--
              `title` rather than a visible name: the plate is two letters wide by design and the
              full name is what a reader hovers for. `aria-label` says the same thing to a screen
              reader, for which two uppercase letters are not a name at all.
            -->
            <div
              v-for="watcher of watcherPlates"
              :key="watcher.userId"
              class="page-watchers-plate"
              :title="watcher.name"
              :aria-label="watcher.name">
              {{ watcher.initials }}
            </div>
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
      <!-- -> Every action on it acts on a page: there is none here to edit, share, rate or delete -->
      <page-actions-col v-if="!pageStore.notFound" />
    </div>
    <!--
      What opens that panel, in the bottom-right corner -- the corner `MainLayout` gives to scroll-to-top,
      which stands down below 750px so that this can have it. Same position and the same `.corner-btn`
      shape (declared in `MainLayout`, which is always mounted above this view), so the two read as one
      button that changes what it does rather than as two buttons fighting for a corner.

      Not gated on having scrolled, as scroll-to-top is: the contents are how a reader decides where to go
      in a long page, and that is most useful before they have gone anywhere.

      `right-0` (not `end-0`) is deliberate -- OpenProject #1590's physical-positioning triage: this is
      the corner `scroll-to-top` stands down from, a pairing with ANOTHER fixed corner rather than with
      the reading direction, so it must not move when the locale does. See
      `frontend/src/physicalPositioning.test.js`.
    -->
    <transition name="toc-open-btn">
      <div v-if="showTocPanelBtn" class="fixed bottom-0 right-0 z-30">
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
      The keyword highlight/find indicator (OpenProject #2541): on screen for as long as `?highlight=`
      is, whether or not the term was actually found in this page's content -- a silent "0 of 0" says
      more than the indicator simply not appearing would, since the reader followed a graph node that
      promised this exact term.

      Fixed near the top, not bottom-right like the contents opener above: that corner is already
      claimed (by this button below 750px, by scroll-to-top above it), and a find bar reads naturally
      at the top of the content it is searching, the way a browser's own does.
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
import { useMinWidth } from '@/composables/screen'
import { notify } from '@/composables/notify'
import { loading } from '@/composables/loading'
import { scrollToAnchor, scrollToAnchorWhenReady } from '@/helpers/anchors'
import { apiErrorMessage } from '@/helpers/apiError'
import { pickEditor } from '@/helpers/editorPicker'
import { initials } from '@/helpers/initials'
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

/**
 * How many watcher plates the rail's Watching section draws before it stops counting out loud and
 * says `+N` instead.
 *
 * Fixed at three, as the design draws it, and deliberately not responsive: the rail is a
 * fixed-width column, so there is no width to fit plates against.
 */
const WATCHER_PLATE_CAP = 3

// STORES

const editorStore = useEditorStore()
const flagsStore = useFlagsStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()
const route = useRoute()

// I18N

const { t } = useI18n()

// COMPOSABLES

const dark = useDark()

// META

/*
  A getter, not a plain object: the page's title is not known when this runs. The view is mounted for
  the path, and the title arrives with the page a moment later -- read once, it was always the empty
  string, so the tab showed nothing but the site name the template appends. It has to keep up with
  every navigation after that too, since the view is reused rather than remounted.
*/
useMeta(() => ({
  title: pageStore.title
}))

// DATA

const state = reactive({
  showSideDialog: false,
  sideDialogComponent: null,
  showGlobalDialog: false,
  globalDialogComponent: null,
  showTagsEditBtn: false,
  tagEditMode: false,
  tocSelected: null,
  /**
   * Whether the contents panel has been slid open. Only consulted below 750px, where the contents are a
   * panel over the article rather than a column beside it.
   */
  tocPanelOpen: false
})
const pageContents = ref(null)
/** The article column, which is what scrolls -- see `scrollPageToTop`. */
const pageScroller = ref(null)

/*
  KEYWORD HIGHLIGHT / FIND (OpenProject #2541, Feature #2539)
  =============================================================
  The `<mark>` elements the current `?highlight=` term is wrapped in, in document order -- see
  `applyKeywordHighlight` -- and which one navigation is currently centred on. `-1` means "no
  matches" (or no highlight active at all), never `0` into an empty array.
*/
const highlightMatches = ref([])
const highlightCurrentIndex = ref(-1)

/*
  WATCHING (OpenProject #2649, Feature #2606)
  =============================================================
  The leading watchers of the open page and how many there are altogether, for the rail's Watching
  section. `watcherTotal` is counted server-side over EVERY watcher regardless of the `limit` asked
  for, which is what makes the `+N` remainder possible without fetching the whole list.

  Empty until the request answers, and empty again the moment the page changes -- see the watcher
  below. A page nobody watches and a page whose watchers could not be read are the same empty list on
  purpose: neither draws a section.
*/
const watchers = ref([])
const watcherTotal = ref(0)

// COMPUTED

/**
 * Below 750px, where the contents stop being a column beside the article and become a panel over it.
 *
 * This view's own threshold: at 200px (see `$toc-narrow-max`) the column still costs a third of a 600px
 * window, and an article is what the reader came for. `MainLayout` has to agree with it — that is where
 * scroll-to-top gives up this corner — and so does `$toc-overlay-max` in the stylesheet below.
 */
const isAtLeast750 = useMinWidth(750)
const tocIsPanel = computed(() => !isAtLeast750.value)

/** Whether the contents panel is on screen. Never true while the contents are a column. */
const tocPanelIsOpen = computed(() => tocIsPanel.value && showSidebar.value && state.tocPanelOpen)

/*
  The opener: only where the contents are a panel, only on a page that has one to show, and not while it is
  already open -- the scrim is what closes it then, and the button would be behind the panel in any case.
*/
const showTocPanelBtn = computed(() => tocIsPanel.value && showSidebar.value && !state.tocPanelOpen)

const showSidebar = computed(() => {
  return (
    pageStore.showSidebar &&
    siteStore.showSidebar &&
    siteStore.theme.tocPosition !== 'off' &&
    !editorStore.isActive &&
    // -> Contents, tags and a rating, all of a page that is not there
    !pageStore.notFound &&
    // -> Nor of one nobody stays on: a redirection has no headings to list and is gone in a moment
    pageStore.editor !== 'redirect'
  )
})
/*
  Whether there is a contents SECTION, heading and separator included -- not just whether the page
  asked for one. A page with no headings, or whose depth settings leave nothing to list, would
  otherwise show "Contents" over an empty space. Asked of the same helper the list itself draws from,
  so the two can never disagree about whether a row survives.
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
  Same question for the tags, and for the same reason: `showTags` is what the page ASKED for, and on a
  page carrying none that left a "Tags" heading over an empty space.

  Held open while the tag editor is in use, so that removing the last tag does not take the field being
  typed into away with it. That only arises mid-edit -- with no tags to start from there is no edit
  button to reach the mode through.
*/
const showTags = computed(() => {
  return pageStore.showTags && (pageStore.tags?.length > 0 || state.tagEditMode)
})
/*
  And the same question a third time for the watchers, with one fewer half to it: there is nothing a
  page can ASK for here, so having somebody to draw is the whole test. A page nobody watches, a page
  whose watchers have not come back yet, and a page whose watchers could not be read all answer false
  -- a "Watching" heading over nothing is the very thing `showTags` above exists to avoid.
*/
const showWatching = computed(() => watcherPlates.value.length > 0)
/**
 * The watchers actually drawn as plates: the leading `WATCHER_PLATE_CAP` of them, oldest first,
 * which is the order the route already answers in.
 *
 * The two letters come from the server's own `initials` field -- served alongside `name` precisely so
 * every consumer draws the same two -- falling back to `helpers/initials.js` for a payload without
 * one. That helper stays the single client-side derivation of this; nothing here re-derives it
 * inline, which is the drift Bug #2609 consolidated away.
 */
const watcherPlates = computed(() =>
  watchers.value.slice(0, WATCHER_PLATE_CAP).map((watcher) => ({
    userId: watcher.userId,
    name: watcher.name,
    initials: watcher.initials || initials(watcher.name)
  }))
)
/**
 * How many watchers the plates do not account for, as the trailing `+N`. Counted off the server's
 * `total` -- every watcher, not the returned slice -- so it stays right however many the request
 * asked for, and floored at zero rather than trusted: a `total` behind the list it came with would
 * otherwise draw `+-1`.
 */
const watcherRemainder = computed(() =>
  Math.max(watcherTotal.value - watcherPlates.value.length, 0)
)
/*
  Whether this user may save a change to the page, which is what editing the tags amounts to -- the tags
  go up with the rest of the page rather than through an endpoint of their own. So the test is the pair
  the PATCH route accepts: `write:pages` or `manage:pages`.

  Read off `pagePermissions` rather than through `userStore.can()`, which asks a broader question: the
  group-wide list from `whoami` says what a user may do somewhere, and the rules decide where. What
  they may do HERE is what `pages/userPermissions` answers, and it is the same authority the PATCH
  route itself consults.
*/
const canEditPage = computed(() =>
  ['write:pages', 'manage:pages'].some((permission) =>
    userStore.pagePermissions.includes(permission)
  )
)

/*
  Whether the missing-page screen offers to create the page. `write:pages` at THIS path, from the same
  list as the tag button above: page rules are written against paths, not against pages, so they answer
  for one that does not exist yet — and it is the check the create endpoint itself makes. The group-wide
  list would say "may write pages somewhere", which is how a button ends up leading to a 403.

  The editor is part of the answer: creating a page opens one, and markdown is the only editor this
  view can mount. A site with it switched off has nothing to open, so the screen says the page is
  missing and leaves it at that.
*/
const canCreatePage = computed(
  () => userStore.pagePermissions.includes('write:pages') && siteStore.editors.markdown
)

/**
 * Whether to point this reader at the Recently Deleted admin view.
 *
 * Two permissions, of the two different kinds, both have to hold: `access:admin` -- a GLOBAL
 * permission -- is what `AdminLayout` itself checks on arrival, and without it the link would only
 * bounce the reader to the unauthorized screen; `read:history` at this exact path -- a PAGE
 * permission, from the same `pages/userPermissions` fetch `canCreatePage` reads -- is what a row for
 * this path would need to appear on that list at all. A group can grant either without the other
 * (a contributor with `read:history` rules but no admin access is a normal setup, not an edge case),
 * so neither alone is enough to promise the link leads somewhere real.
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
 * Whether the page on screen has never been saved -- open in the editor, in `create` mode, and not
 * yet POSTed. `editorStore.isActive` is checked alongside `mode` rather than `mode` alone: `mode`
 * stays `create` until the save that flips it to `edit` completes (see `pageSave`), and also starts
 * out `create` before any page has ever been opened -- so a stale `mode` read while merely reading a
 * page (editor closed) must not be able to suppress "Last modified" there too.
 */
const isUnsavedNewPage = computed(() => editorStore.isActive && editorStore.mode === 'create')

const lastModified = computed(() => {
  return pageStore.updatedAt
    ? userStore.formatRecent(t, pageStore.updatedAt)
    : t('common.notAvailable')
})

/**
 * The trail the breadcrumb bar draws, root first. The Home crumb is prepended here rather than
 * written into the markup, so the bar takes a single flat list.
 */
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
 * The `highlight` query param, normalized to a single trimmed string -- or empty when absent.
 *
 * A repeated query key (`?highlight=a&highlight=b`) parses as an array; there is only ever one
 * keyword to carry forward, so the first value wins and anything else that is not a plain string
 * (an array of non-strings, `null`) is treated the same as no param at all.
 */
const highlightTerm = computed(() => {
  const raw = route.query.highlight
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value.trim() : ''
})

/** Whether the find-in-page indicator should be on screen at all -- a term is active, found or not. */
const showHighlightIndicator = computed(() => highlightTerm.value.length > 0)

const highlightCountLabel = computed(() =>
  t('common.renderedContent.highlightCount', {
    current: highlightCurrentIndex.value + 1,
    total: highlightMatches.value.length
  })
)

// WATCHERS

/*
  The copy buttons on code blocks are part of the content, so they are re-added whenever the content
  is. Keyed on the render rather than on the route: it arrives after the page has already mounted, and
  it is replaced again on every save without the route moving at all.

  The keyword highlight/find pass (OpenProject #2541) rides the same watcher rather than one of its
  own: it needs to re-run for exactly the same two reasons `enhanceRenderedContent` does -- the
  content changing under an unmoved route (a save, or first arrival) -- PLUS a reason unique to it,
  the `highlight` query param itself changing with the route otherwise unchanged. That third case is
  why `highlightTerm` is a second watched source rather than an `onMounted`-only read: Vue Router
  reuses this very component instance across two content-page navigations, so a reader clicking a
  second highlighted graph node while already on a content page changes only the query, not the
  component tree -- an `onMounted` check would never see it.
*/
watch(
  [() => pageStore.render, highlightTerm],
  () => {
    nextTick(() => {
      enhanceRenderedContent(pageContents.value, t)
      syncKeywordHighlight()
    })
  },
  { immediate: true }
)

/*
  A protected page asks for its password the moment it arrives: the reader followed a link to read it,
  and making them press a button first would only add a step. Keyed on the page rather than on the
  flag, so dismissing the prompt does not immediately reopen it -- the lock screen's own button is the
  way back in -- while walking to another protected page prompts again.

  Deliberately NOT `immediate`. This component is unmounted and remounted around any route outside the
  page view (a search, the profile, the admin area), and the store it reads is global: an immediate run
  fires against whatever page was on screen BEFORE that detour, so leaving a locked page for the search
  screen and coming back to an unprotected one prompted for the earlier page's password. Every real
  case still fires here, because `pageLoad` clears the flag as it starts and the reply sets it again --
  so a locked page always arrives as a change, mount or no mount.
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
  The rail's Watching section (OpenProject #2649), fetched HERE rather than in `pageStore.pageLoad`.

  It is a second round trip, and the article must not wait on it: the sibling Revision section rides
  the page read precisely because that one costs nothing extra, and this one cannot. So the page
  arrives, draws, and the plates appear a moment later underneath it -- or never, on a page nobody
  watches or one whose watchers the server declines to list.

  Three sources, and each is a real reason to ask again: the page id, obviously; `isWatching`, so the
  reader's own plate appears and disappears as they press the bell rather than at the next navigation;
  and `showSidebar`, which is what makes this cost nothing at all on a site with the rail switched off
  or while the editor is open. Vue coalesces a flush, so a page load moving id and `isWatching`
  together still asks once.

  Same generation guard as `pageLoadGeneration` below and for the same reason: navigating A -> B while
  A's watchers are still in flight must not let A's answer land over B's.
*/
let watchersGeneration = 0

watch(
  [showSidebar, () => pageStore.id, () => pageStore.isWatching],
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
        Silent by design, and the section stays absent. Who watches a page is not something the reader
        asked for, so a toast about it would interrupt them over something they did not do -- and the
        request is refused for entirely ordinary reasons (a page they may not read, a page still
        behind its password) that the view already says out loud elsewhere.
      */
      console.warn(err)
    }
  },
  { immediate: true }
)

/*
  A fragment that changes without the page doing so: a link inside the content, or the reader going
  back to one. The browser tries it natively and gets nowhere when the heading is inside a panel that
  is not open, so the same routine runs here — where the heading is revealed first.
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
 * Escape dismisses an active keyword highlight, same as the close control on its own indicator.
 *
 * A window-level listener rather than one scoped to the indicator itself: the reader did not open
 * find-mode by focusing anything -- it arrived already active, from a graph click -- so there is no
 * natural element for a scoped handler to sit on. `WDialog`'s own Escape handling
 * (`composables/escapeStack.js`) runs on a `document` bubble listener with no `stopPropagation`, so
 * pressing Escape while an unrelated dialog is open both closes that dialog AND dismisses the
 * highlight -- harmless, since dismissing an inactive or already-cleared highlight is a no-op.
 */
function onWindowKeydown(ev) {
  if (ev.key === 'Escape' && showHighlightIndicator.value) {
    dismissHighlight()
  }
}

/*
  Generation guard for the plain page-load branch of the watcher below (OpenProject #1785). The
  watcher is `async` and Vue does not cancel a previous, still-running invocation when `route.path`
  changes again -- so navigating A -> B while A's `pageStore.pageLoad` is still in flight can let A's
  slower response land AFTER B's faster one, stomping B's title/body/tags/permissions with A's stale
  data. A plain incrementing counter, not reactive state: it is only ever read and written from
  inside the watcher's own closures, never from a template.
*/
let pageLoadGeneration = 0

watch(
  () => route.path,
  async (newValue) => {
    // -> Ignore route change (e.g. from page create route fix)
    if (editorStore.ignoreRouteChange) {
      editorStore.$patch({ ignoreRouteChange: false })
      return
    }

    // -> Enter Create Mode?
    if (newValue.startsWith('/_create')) {
      return enterCreateMode(route, { router, t })
    }

    // -> Enter Edit Mode?
    if (newValue.startsWith('/_edit')) {
      return enterEditMode(route, { router })
    }

    // -> Moving to a non-page path? Ignore
    if (newValue.startsWith('/_')) {
      return
    }

    // -> Captured before the first await -- see the counter's own comment above.
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

// METHODS

/**
 * Follow a link inside the page's content without reloading the application.
 *
 * A rendered page is HTML, so its internal links are ordinary anchors: the browser would throw the
 * whole SPA away and build it again to show a page the router can swap in. `routableHref` decides
 * which ones are ours; anything it declines is left to the browser, including a click asking for a
 * new tab.
 */
/**
 * Back to the top of the article on arriving at another page.
 *
 * The article column scrolls, not the window -- the shell around it holds still -- so the router's own
 * `scrollBehavior` has nothing to do: it scrolls the document, which never moved. Left alone, a reader
 * following a link from halfway down one page arrives halfway down the next.
 *
 * Called before the content is swapped rather than after, so the jump happens on the page being left
 * instead of showing the new one at the old offset for a frame. A `#heading` in the URL still wins:
 * `scrollToAnchorWhenReady` runs once the render has settled, and travelling to it from the top is
 * what it is written to do.
 */
function scrollPageToTop() {
  pageScroller.value?.$el?.scrollTo({ top: 0, left: 0 })
}

/**
 * Re-applies (or clears) the keyword highlight against the article that is actually on screen right
 * now, reading `highlightTerm` fresh rather than taking it as an argument -- this is always called
 * from inside the watcher above, after `nextTick`, so the DOM and the term are already in step.
 *
 * Always resets to "no current match" and re-focuses match 0: whether this run is a first
 * activation, a term change, or a re-render with the same term, the old `highlightCurrentIndex`
 * pointed at a `<mark>` element that `applyKeywordHighlight`'s own clear-then-rewrap has already
 * thrown away (see its own header comment) -- keeping it would point navigation at a detached node.
 */
function syncKeywordHighlight() {
  const term = highlightTerm.value
  if (!term) {
    clearKeywordHighlight(pageContents.value)
    highlightMatches.value = []
    highlightCurrentIndex.value = -1
    return
  }

  const { matches } = applyKeywordHighlight(pageContents.value, term)
  highlightMatches.value = matches
  highlightCurrentIndex.value = matches.length > 0 ? 0 : -1
  if (matches.length > 0) {
    focusHighlightMatch(0)
  }
}

/** Marks one match as current and scrolls it roughly to the centre of the article. */
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

/** Wraps around in both directions, same as native find-in-page next/previous. */
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
 * Turns the highlight off while staying on the page: unwraps every `<mark>`, hides the indicator,
 * and strips `?highlight=` from the URL with `router.replace` -- no new history entry, so Back still
 * leaves by however the reader actually arrived rather than bouncing them straight back into
 * find-mode. A graph click must not permanently pin a reader into find-mode once they have said no.
 */
function dismissHighlight() {
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
 * What a relation button links to, as props for `WBtn`.
 *
 * The buttons were rendered with neither, so a relation was decoration: it drew its label and caption
 * and swallowed the click. A target is stored as `PageRelationDialog` leaves it — a rooted path within
 * this wiki (`/guides/upgrading`) or a complete external address — so the two cases are told apart the
 * same way an in-content link is, by `routableHref`, and the router takes the ones that are ours
 * rather than reloading the app to reach them.
 *
 * Nothing at all for a relation with no target: the dialog only requires a label, and an `<a>` with an
 * empty href reloads the current page.
 *
 * @param rel A page relation
 * @returns `{ to }` for a page in this wiki, `{ href }` for an ordinary web address, `{}` for neither
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
  // -> An ordinary web link or nothing: a target is author-supplied, and `javascript:` in an href is
  //    script this page would run on click
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
    A heading on this same page: travelled to rather than jumped at, which is how the contents list
    and an arriving `#heading` already reach one. Through the helper, so a heading inside a closed tab
    is revealed first, and only claimed once it says it found somewhere to go -- a fragment naming
    nothing in the render is left to the browser, as it was.

    The URL still follows, so the address bar can be copied and Back returns to the section before.
    `router.push` rather than assigning `location.hash`, which would jump the page as well -- and since
    a pushed hash sets no target element, marking where the reader landed is the helper's job (see
    `LANDED_CLASS`) rather than `:target`'s.
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
 * Close the contents panel once the reader has picked something out of it.
 *
 * Delegated rather than bound per row: `PageToc` emits only `update:selected`, which does not fire again
 * when the heading already showing is picked a second time — so a click is the thing to listen for, not the
 * selection changing. Any anchor counts, which is what also covers a tag.
 */
function onSidebarClick(ev) {
  if (tocPanelIsOpen.value && ev.target?.closest?.('a')) {
    closeTocPanel()
  }
}

/** Asks for the page's password. Opened on arrival, and again from the lock screen's own button. */
function promptUnlock() {
  dialog({ component: PageUnlockDialog })
}

/**
 * Opens the editor on the page that is not there, at the path that was asked for.
 *
 * The path comes from the store rather than from the route, because the route is where it goes: the
 * editor moves to `/_create/<editor>` and the path travels in the page itself, which is the same way
 * every other New Page button works. Which editor is `pickEditor`'s call -- it asks when the site has
 * more than one active, and answers on its own (no dialog shown) when there is only one real choice.
 */
async function createPage() {
  const editor = await pickEditor(siteStore)
  // -> The picker was dismissed rather than answered: nothing to create yet
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
 * Back out of a path that has no page. `router.back()` alone lands on the wiki's own error screen for
 * a reader who arrived at this URL directly, having nothing to go back to, so that case goes home.
 */
function goBack() {
  if (window.history.state?.back) {
    router.back()
  } else {
    router.push('/')
  }
}
</script>

<style lang="scss">
/*
  Where the contents column stops being able to afford 300px. This view's own threshold, not one of the
  app's -- `_palette.scss` is for the breakpoints the whole app shares, and this one is a function of this
  page's two sidebars. Stated as a `max` value just under 1400px, the way the shared ones are.
*/
$toc-narrow-max: 1399.98px;

/*
  ...and where it stops being a column at all and becomes a panel over the article. The same boundary as
  the 750px `useMinWidth` above, which decides whether the opener is rendered, and as the one `MainLayout`
  uses to stand scroll-to-top down from this corner. All three have to agree.
*/
$toc-overlay-max: 749.98px;

/*
  The column in place of the article: the lock screen, the page that does not exist, and the
  redirection on its way somewhere else. All three are the same shape -- a large faint icon, a
  sentence, and the one button that does something about it -- and share the styling so they cannot
  drift apart. `PageRedirect.vue` draws its own screens with these classes for that reason.
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
    Stated per theme, as everything else in this column is: the article's own colours come from
    `_page-contents.scss`, so a plain block dropped in beside it inherits the document's black and
    goes invisible on the dark surface. The icon below takes its colour from here as well.
  */
  @at-root .body--light & {
    color: $grey-9;
  }
  @at-root .body--dark & {
    color: #fff;
  }
}

/*
  Large and faint. It is the illustration on an otherwise empty column, not something to look at -- the
  sentence under it is what the reader is here to read.
*/
.page-placeholder-icon {
  margin-bottom: 24px;
  font-size: 96px;
  opacity: 0.12;
}

/*
  The trail, above the masthead. Cardinal sets a path in Roboto Mono on the content column's own white,
  ruled off underneath -- so it reads as the page's address rather than as another band of chrome. The
  gradient it used to carry (grey-1 to grey-3 with a heavier rule under it) was a bevel, and the whole
  point of the trail is that it gives way to the page beneath it.
*/
.page-breadcrumbs {
  /*
    38px to match `MainLayout.vue`'s `.sidebar-actions`, the band immediately to the left of this one:
    the two sit at the same vertical position and each rules itself off with its own hairline, so any
    disagreement in height leaves the two rules on different lines and the two grounds meeting at a
    step. Both boxes are `border-box`, so that 1px border is inside the 38px on either side.

    A fixed height at all -- rather than one sized by its own contents through the `py-1`/`sm:py-2`
    pair this used to carry -- because the bar's height otherwise moved with whatever the trail
    happened to hold: a crumb with an icon made it taller than one without.

    `min-height` rather than `height` so a trail long enough to wrap can still grow past the band.
  */
  min-height: 38px;
  font-family: var(--font-mono);
  font-size: 11.5px;

  /*
    The bar sets a background per theme, so it owes a foreground too: the LAST crumb -- the current
    page -- deliberately inherits rather than taking `active-color`, and what it was inheriting in
    dark mode was the document's black.
  */
  @at-root .body--light & {
    background-color: $surface;
    border-bottom: 1px solid $hairline;
    color: $text-caption;
  }
  @at-root .body--dark & {
    background-color: $dark-3;
    border-bottom: 1px solid $hairline-dark;
    color: $text-caption-dark;
  }

  /*
    A point off the trail on a phone, on the bar rather than on the crumbs: `WBreadcrumbs` sets no size
    of its own and its icons are 125% of whatever it inherits, so one declaration here takes the text and
    the icons down together and keeps the two in proportion.

    13px is where it stops. The trail is how a reader gets back out, and it is already the smallest type
    on the screen -- what is wanted is a bar that gives way to the page under it, not one nobody can read.
  */
  @media (max-width: $breakpoint-xs-max) {
    min-height: 30px;
    font-size: 10.5px;
  }
}

/*
  The "last modified" note at the trailing end of the trail, and the draft mark beside it. The bar is
  already mono at 11.5px; this only holds the tone, so the note reads as part of the address rather
  than as a second voice.
*/
.page-breadcrumbs-modified {
  white-space: nowrap;

  @at-root .body--light & {
    color: $text-caption;
  }
  @at-root .body--dark & {
    color: $text-caption-dark;
  }
}

/*
  The masthead. A white plate with the page's icon in a hairline square beside its title, ruled off
  from the article -- the two-stop gradient and the white top edge it used to carry were the same
  bevel the trail above it had, and they are gone for the same reason.

  120px, and the same 120px on every page. What it used to say here was a 96px MINIMUM around a 64px
  icon plate, which sounds fixed and was not: the band was sized by whatever was in it, so a page with
  a description came out at 130px and a page without at 109px, and moving between the two visibly
  shifted the whole article under it. Neither number was the 96px, which is why reading the
  declaration told you nothing -- `Index.pageHeaderHeight.test.js` measures the rendered band in a
  real browser instead.

  The 8px of block padding is what makes 120px reachable rather than aspirational. The text column
  brings its own `p-4`, and 16px here on top of it left 87px for a title-plus-description block that
  needs 96.8 -- the band would have grown past 120 on every page that had a description, which is the
  defect over again. At 8px the budget is 103px and both pages land on exactly 120.

  A MINIMUM still, for exactly one remaining case: a title long enough to wrap. 120px against a
  36px/1.05 title, a description and the padding leaves about a line of slack -- enough for the
  description, not for a second title line -- and a fixed height here is already recorded as having
  cropped one (a fixed 95px, before the minimum replaced it). So the band takes the extra line rather
  than hiding it. That is variance, but with a cause a reader can see in front of them, not one that
  turns on whether an author happened to fill in a field. A description long enough to wrap grows it
  the same way and for the same reason; a description of ordinary length never does.
*/
.page-header {
  min-height: 120px;
  padding-block: 8px;

  /*
    Sized by its contents on a phone instead, which comes out around 96px: the 120px is pitched for a
    64px icon beside 34px display type, and holding it under the halved icon and title of the phone
    layout left a band of empty ground under the description.

    So the variance the desktop band just lost is deliberate down here -- there is no height worth
    holding when everything that would fill it is half the size.
  */
  @media (max-width: $breakpoint-xs-max) {
    min-height: 0;
    padding-block: 10px;
  }

  @at-root .body--light & {
    background-color: $surface;
    border-bottom: 1px solid $hairline;
  }
  @at-root .body--dark & {
    background-color: $dark-3;
    border-bottom: 1px solid $hairline-dark;
  }

  /*
    The page's own title, and the one place in the interface the display face is set at full size:
    Barlow Condensed at 36px/700, which is what lets a long title stay on one line in a bar this
    height. `text-wrap: pretty` keeps a two-line title from leaving one orphaned word.
  */
  &-title {
    font-family: var(--font-display);
    font-size: 36px;
    font-weight: 700;
    line-height: 1.05;
    letter-spacing: normal;
    text-wrap: pretty;

    @at-root .body--light & {
      color: $ink;
    }
    @at-root .body--dark & {
      color: $text-dark;
    }
  }

  /*
    The description under the title: Barlow at 400, not the 500 `text-subtitle2` was giving it. At the
    weight the title carries it read as a second heading rather than as the sentence explaining the
    first one.
  */
  &-subtitle {
    margin-top: 6px;
    font-weight: 400;
    font-size: 14.5px;
    line-height: 1.45;
    letter-spacing: normal;

    @at-root .body--light & {
      color: $text-secondary;
    }
    @at-root .body--dark & {
      color: $text-secondary-dark;
    }
  }
}
/*
  The article and the footer under it, stacked inside the one box that scrolls.

  `flex: 1 0 auto` on the article is what keeps the footer at the BOTTOM of a short page instead of
  leaving it hanging under two lines of content: the article takes the leftover height, and past that
  grows with its own content and pushes the footer out of view until the reader gets there. It must
  not shrink either, or a long article would be squeezed to make room rather than scrolling.
*/
.page-container-scrl {
  display: flex;
  flex-direction: column;
}
/*
  The article's own whitespace. `32px 28px 44px` is the design's measurement, and the extra at the
  foot is what stops the last paragraph sitting on the footer. It replaces a `p-2 sm:p-4` pair
  (8px/16px), which left a rendered page very nearly flush to the column's edges.
*/
.page-container-body {
  flex: 1 0 auto;
  padding: 32px 28px 44px;

  @media (max-width: $breakpoint-xs-max) {
    padding: 20px 16px 32px;
  }

  /*
    The other half of the padding above.

    `--content-bleed` is how far the rule under an h1 reaches BACK through this surface's padding, so
    that it starts at the column's edge rather than at the text -- so it is a statement about this
    surface's padding and has to move with it. 28px here, 16px on a phone.

    On the `.page-contents` element rather than here, because that is where the default is declared and
    a custom property set on the parent would simply be shadowed by it. The editor's preview pane
    carries the class itself and pads differently, so it keeps the default.
  */
  .page-contents {
    --content-bleed: 28px;
  }

  @media (max-width: $breakpoint-xs-max) {
    .page-contents {
      --content-bleed: 16px;
    }
  }
}

/*
  A measure, when the site asks for one. 720px is the measure the design draws
  (`ui-redesign/Cardinal Wiki - Ledger 3x.dc.html`: the article pads 32/28/44 and then holds its text
  to 720px inside that) -- and it holds the text FLUSH to the padded column's leading edge, since the
  mockup writes a bare `max-width: 720px` with no `margin: 0 auto` anywhere in the file. A measure is
  a line length, not a position: the text starts where every other thing on this surface starts, and
  simply stops early. Centring it instead left the article drifting away from the breadcrumbs and
  header above it on a wide window, which is what this setting was reported for.

  On the contents rather than on this box, so the padding above stays the column's and only the text
  is bounded: a page of prose reads at a comfortable measure while the sheet it sits on still fills
  the window.
*/
.page-container-body.is-measured > .page-contents {
  max-width: 720px;
}

/*
  The article column's own ground: white, so it reads as a sheet laid on the paper behind it. Stated
  here rather than left to the body, because the page's ground is `--color-paper` now -- see
  `MainLayout`.
*/
.page-container {
  @at-root .body--light & {
    background-color: $surface;
  }
  @at-root .body--dark & {
    background-color: $dark-3;
  }
}
/*
  The Tags heading's edit toggle. `visibility` is transitioned alongside the opacity so it still fades
  BOTH ways: as a discrete property it flips at the end of the transition when going to hidden, and at
  the start when coming back, which is exactly the timing a fade wants.
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
    The rail's own inset, as the design draws it (`padding: 28px 20px`), rather than a `p-4` on each
    section in the markup. Putting it on the column is what gives the rules between the sections their
    margins for free: a `w-separator` is a child of this box, so it spans the content width and stops
    20px short of both edges instead of running edge to edge across the rail.
  */
  padding: 28px 20px;

  /*
    Narrower once the window is: 300px is pitched for a wide desktop, where it is a tenth of the width, and
    by 1200px it is a quarter of what is left after the nav sidebar. 200px still holds a heading of a few
    words per line -- the contents list wraps rather than truncating (see `PageToc`) -- and hands the
    article the other 100px.

    1400px is this view's own threshold rather than one of the app's `--breakpoint-*`: it is where THIS
    column starts crowding the article, which depends on its own width and the nav's.
  */
  @media (max-width: $toc-narrow-max) {
    flex: 0 0 200px;
  }

  /*
    And below 750px it stops being a column at all: even at 200px it is a third of a 600px window, and an
    article is what the reader came for. It becomes a panel the width of the wide column, parked off the
    right edge and slid in when asked for -- the same shape as the nav drawer on a narrow screen, and for
    the same reason, so the two behave alike from opposite sides.

    `position: fixed` is what takes it out of the row, so the article gets the whole width whether the
    panel is open or not; the reader is never made to choose between the two, only to look at one at a
    time. `transform` is what animates, being the one property that moves a box without laying anything
    out again -- and the panel is out of flow, so there is nothing behind it to reflow anyway.

    Right regardless of `tocPosition`: the opener is in the bottom-RIGHT corner, and a panel arriving from
    the far side of the screen from the button that summoned it reads as something else appearing.

    `right`/`translateX(100%)`/the shadow's negative x-offset below all stay physical rather than
    logical on purpose (OpenProject #1590's physical-positioning triage): this panel is paired with a
    fixed screen corner (the opener, below), not with the reading direction, so none of it should move
    when the locale does.
  */
  @media (max-width: $toc-overlay-max) {
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

  /*
    A hair off the article column's white rather than a grey panel beside it -- the rail holds the
    page's own metadata (contents, tags, revision, watchers), so it belongs to the sheet, and the
    hairline down its leading edge is what separates the two.
  */
  @at-root .body--light & {
    background-color: #fbfcfe;
    border-inline-start: 1px solid $hairline;
  }
  @at-root .body--dark & {
    background-color: $dark-4;
    border-inline-start: 1px solid $hairline-dark;
  }

  // The rules BETWEEN this rail's own sections, which are hairlines like every other rule in the
  // language -- where they used to be a light-on-light / near-black-on-dark pair drawing the bevel
  // between two panels.
  //
  // The original set a background-colour here as well as a border. It never showed: the element is
  // 1px tall with `box-sizing: border-box`, so the content box is 0px and the opaque border covers
  // it completely. Only the border colour is carried across.
  .w-separator {
    --w-hairline-color: #{$hairline};
    /* -> 22px of air on each side, as the design draws them */
    margin-block: 22px;
  }
  @at-root .body--dark & .w-separator {
    --w-hairline-color: #{$hairline-dark};
  }

  /*
    The column is the height of the shell, so its own content scrolls when there is more of it than
    there is room -- a long contents list, in practice. Nothing sticky is involved: the shell holds
    still on its own, and the article beside this scrolls in its own box.
  */
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgb(102 102 102 / 0.5) transparent;
}

/*
  A rail section's heading -- the same mono, uppercase, letter-spaced label the design uses for every
  section marker in the language (`.w-section-header` is the banded version of the same voice). No icon
  beside it: the rail holds four short lists, and a glyph per heading was four pictures competing with
  the one thing in the column that is a picture (the tags' own `#` marks).
*/
.page-sidebar-heading {
  padding-block-end: 12px;
  color: $text-caption;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

.body--dark .page-sidebar-heading {
  color: $text-caption-dark;
}

/*
  The Watching section's run of plates (OpenProject #2649). A flex row rather than a grid: there are
  at most four things in it (three plates and the remainder), and they sit against the inline start
  with the gap the design draws between them.
*/
.page-watchers {
  display: flex;
  align-items: center;
  gap: 8px;
}

/*
  One person, as two letters on a tinted square. Square on purpose -- Cardinal draws no rounded
  avatars, and the rail's tags are square too -- and a hair darker than $tint so a run of plates reads
  as a run of objects on the rail's own near-white ground rather than dissolving into it.

  Barlow Condensed at 10/600, the language's face for a short uppercase chrome label, which is exactly
  what a pair of initials is. `flex: none` because the plate is a fixed 26px and must not be squeezed
  by a long remainder beside it.
*/
.page-watchers-plate {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid $hairline;
  /* -> Between $tint and $hairline; the design's own value, and there is no token at this step */
  background-color: #e9edf5;
  color: $slate;
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}

.body--dark .page-watchers-plate {
  border-color: $hairline-dark;
  background-color: $dark-2;
  color: $text-dark;
}

/* Everybody past the third, in the mono the rail sets every other count and timestamp in. */
.page-watchers-remainder {
  color: $text-caption;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 400;
}

.body--dark .page-watchers-remainder {
  color: $text-caption-dark;
}

/*
  Behind the panel, and under it: the same tint and the same z-index as the nav drawer's scrim, one step
  below the panel it dims. The opener is at z-30 as well and is not rendered while the panel is open, so
  the two never overlap.
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
  The keyword highlight/find indicator (OpenProject #2541). Top-centre, clear of the breadcrumb bar
  and the page header above it -- both are `position: static`, so this is the one element on the
  view actually pinned to the viewport up here.
*/
.keyword-highlight-bar {
  top: 12px;
  /*
    Dead centre of the viewport, not one screen edge or the other -- `left`/`transform: translateX`
    is the plain centring idiom here, with nothing physical about "centre" for a locale to disagree
    with.
  */
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 4px;
  /*
    Logical, not `padding: 4px 6px 4px 12px`: the extra room belongs at the START, next to the count
    text, and the tighter side at the END, next to the close button -- a physical `left`/`right` pair
    would swap sides under RTL, where this row itself flips but a physical padding declaration would
    not follow it.
  */
  padding-block: 4px;
  padding-inline: 12px 6px;
  border-radius: 999px;
  box-shadow: 0 2px 10px rgb(0 0 0 / 0.25);

  @at-root .body--light & {
    background-color: #fff;
    color: $grey-9;
  }
  @at-root .body--dark & {
    background-color: $dark-4;
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
