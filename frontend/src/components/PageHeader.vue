<template>
  <div class="page-header flex flex-wrap">
    <!-- PAGE ICON -->
    <!--
      This row is a plain flex row, so under `dir="rtl"` the flex axis itself already reorders the
      icon, the title column and the actions -- the icon lands beside whichever edge is now the
      reading start. What would NOT follow along on its own is the gap between them: `ps-4`/`ms-4`/
      `me-2` (Tailwind's logical spacing utilities) are used in place of `pl-4`/`ml-4`/`mr-2` below so
      that gap stays on the correct side of each element rather than staying physically left/right.
    -->
    <!--
      The page's own icon, set in a square hairline plate rather than standing loose beside the title
      -- Cardinal's masthead is a plate, and the icon is the one thing in it that is a picture rather
      than type, so it gets a frame to sit in.

      The plate is the same box in both states; only what is inside it changes (a button that opens
      the picker while editing, a bare icon while reading), so the masthead's geometry does not shift
      the moment an author starts editing.
    -->
    <div class="flex-none ps-4 flex items-center">
      <div
        class="page-header-icon flex flex-none items-center justify-center border border-hairline bg-paper dark:border-hairline-dark dark:bg-dark-4"
        :style="plateStyle">
        <w-btn
          v-if="isEditing"
          padding="none"
          :size="glyphSize"
          color="accent-fill"
          flat
          :aria-label="t(`editor.props.icon`)"
          :style="{ minHeight: glyphSize, width: glyphSize }">
          <!-- -> The same size the icon has when the page is merely being read; see the branch below -->
          <w-icon :name="pageStore.icon" :size="glyphSize" />
          <!-- -> Not `v-model`: writing the store is only half of what picking an icon means here, and
                  the other half is telling the editor the page changed. See `setIcon`. -->
          <w-menu content-class="shadow-7">
            <icon-picker-dialog :model-value="pageStore.icon" @update:model-value="setIcon" />
          </w-menu>
        </w-btn>
        <w-icon v-else :name="pageStore.icon" :size="glyphSize" color="accent-fill" />
      </div>
    </div>
    <!-- PAGE HEADER -->
    <!--
      In the editor the title and the description are the fields, edited where they sit rather than
      through a button and a popup. They keep the heading type they have when the page is being read:
      what tells an author they can type here is the hover tint and the caret, not a box drawn around
      the text.

      The text is NOT interpolated into the editable elements. Vue would rewrite the text node on every
      keystroke as the store echoes it back, and a rewritten text node puts the caret at the start of
      it. `syncEditable` writes it instead, and only when the two have actually diverged.
    -->
    <!--
      Centred rather than top-aligned: with no description the title is the only line in this column,
      and left at the top it sat above the middle of the icon beside it. A page that has one is taller
      than everything else in the row, so there is nothing to centre and this changes nothing.
    -->
    <div class="min-w-0 flex-1 flex flex-col justify-center p-2 sm:p-4">
      <h1 class="text-h4 page-header-title">
        <span
          v-if="isEditing"
          ref="titleEl"
          class="page-header-editable"
          :class="{ 'is-empty': !pageStore.title }"
          contenteditable="plaintext-only"
          role="textbox"
          aria-multiline="false"
          :aria-label="t(`editor.props.title`)"
          :data-placeholder="t(`editor.props.title`)"
          @input="onEditableInput(`title`, $event)"
          @blur="onEditableBlur(`title`, $event)"
          @keydown.enter.prevent="$event.target.blur()" />
        <span v-else>{{ displayedTitle }}</span>
      </h1>
      <div class="text-subtitle2 page-header-subtitle">
        <span
          v-if="isEditing"
          ref="descriptionEl"
          class="page-header-editable"
          :class="{ 'is-empty': !pageStore.description }"
          contenteditable="plaintext-only"
          role="textbox"
          aria-multiline="false"
          :aria-label="t(`editor.props.shortDescription`)"
          :data-placeholder="t(`editor.props.shortDescription`)"
          @input="onEditableInput(`description`, $event)"
          @blur="onEditableBlur(`description`, $event)"
          @keydown.enter.prevent="$event.target.blur()" />
        <span v-else>{{ pageStore.description }}</span>
      </div>
    </div>
    <!-- PAGE ACTIONS -->
    <!--
      `has-editor-actions` is what keeps this row on a phone, where it is otherwise hidden: what it
      holds while a page is being read is a handful of icons for a wide screen, but while a page is
      being WRITTEN it holds the only way to save or to get back out. See the stylesheet.
    -->
    <div
      class="page-header-actions flex-none p-4 flex items-center justify-end"
      :class="{ 'has-editor-actions': hasEditorActions }">
      <template v-if="!editorStore.isActive">
        <!--
          Whoever is looking at a draft can already see it, so the badge is not gated on being logged
          in the way the actions beside it are: it is telling a reader what they are reading, not
          offering them something to do.
        -->
        <w-badge
          v-if="pageStore.publishState === `draft`"
          class="uppercase"
          color="negative"
          :label="t(`editor.props.draft`)" />
        <!--
          Watching a page is a state of it, so the button IS the state: filled and orange while the
          page is watched, an outline in grey while it is not. Same orange as Edit, because both are
          this reader's own hold on the page rather than decoration.

          `mdi` rather than the `la` this row otherwise uses, because Line Awesome has no filled bell
          to switch TO: its bell and its bell-solid carry an identical body in Iconify, so that pair
          drew one drawing in two colours. (Names left unquoted on purpose — the icon bundler scans
          this file for quoted references and would keep bundling an icon nothing draws.)

          Not offered on a redirection: a watch is an offer to be told when a page's content changes,
          and nobody is reading this one — they are passing through it.
        -->
        <w-btn
          class="ms-4"
          :class="{ 'is-ringing': state.bellRinging }"
          v-if="userStore.authenticated && !isRedirect"
          flat
          dense
          :icon="pageStore.isWatching ? `mdi:bell` : `mdi:bell-outline`"
          :color="pageStore.isWatching ? `accent` : `slate-soft`"
          :aria-label="pageStore.isWatching ? t(`common.page.unwatch`) : t(`common.page.watch`)"
          :aria-pressed="pageStore.isWatching"
          @click="toggleWatch">
          <w-tooltip>
            {{ pageStore.isWatching ? t('common.page.unwatch') : t('common.page.watch') }}
          </w-tooltip>
        </w-btn>
        <w-btn
          class="ms-4"
          v-if="siteStore.theme.showPrintBtn"
          flat
          dense
          icon="la:print"
          color="slate-soft"
          :aria-label="t('common.actions.print')"
          @click="printPage">
          <w-tooltip>{{ t('common.actions.print') }}</w-tooltip>
        </w-btn>
        <!--
          Only for whoever reviews this page: the server answers `canReview` from the approval rules
          and the reviewer's own permissions — with the page itself — so nothing here has to know how
          that is decided, or ask about it.

          An empty queue is grey and an empty tray, sitting with Print as one more thing available
          rather than one more thing to do; something waiting fills the tray and turns it orange, the
          colour this row uses for what belongs to the reader. The count is on the badge either way.

          A redirection takes no suggestions -- see the button below -- so there is never a queue on
          one to review.
        -->
        <w-btn
          class="ms-4"
          v-if="pageStore.canReview && !isRedirect"
          flat
          dense
          :color="pendingCount > 0 ? `accent` : `slate-soft`"
          :aria-label="t(`inbox.pendingReview`)">
          <!--
            The badge is a sibling of the icon, not a child of it: WIcon renders a bare `<svg>` and no
            slot, so anything written inside it is dropped — and an HTML badge could not live inside an
            SVG in any case. It floats against the button, which is the positioned box here.
          -->
          <w-icon :name="pendingCount > 0 ? `mdi:inbox-full` : `la:inbox`" />
          <w-badge v-if="pendingCount > 0" color="accent" text-color="white" floating>
            <strong>{{ pendingCount }}</strong>
          </w-badge>
          <w-tooltip>{{ t('inbox.pendingReview') }}</w-tooltip>
          <!--
            Down from the button's trailing edge, like every other menu hanging off this row: the
            panel is wider than the button and the button sits near the reading-END edge of the
            window (this actions group is the last child of a flex row, so a plain flex reorder is
            what puts it there under either direction) -- aligning their trailing edges is what keeps
            it on screen. `WMenu` places itself in raw viewport pixels and knows nothing about
            `direction` (`composables/anchoredPosition.js`), so the LTR-written "right" pair would pop
            the panel off toward the visual right even once `dir="rtl"` has moved this button to the
            visual left; `reviewMenu` mirrors it via `directionalAnchor`, the same helper
            `EditorMarkdown.vue`'s side toolbar uses for its own hardcoded anchors -- kept reactive
            here (see the script setup comment) since this header, unlike an editor session, outlives
            a single locale.
          -->
          <w-menu
            class="translucent-menu"
            :anchor="reviewMenu.anchor"
            :self="reviewMenu.self"
            auto-close>
            <w-list padding style="min-width: 320px">
              <w-item v-if="pendingCount < 1">
                <w-item-section>
                  <w-item-label caption>{{ t('inbox.reviewNone') }}</w-item-label>
                </w-item-section>
              </w-item>
              <w-item
                v-for="submission of pageStore.pendingSubmissions"
                :key="submission.id"
                clickable
                @click="reviewSubmission(submission)">
                <w-item-section class="items-center" avatar>
                  <w-icon class="text-slate-soft" name="la:file-alt" size="sm" />
                </w-item-section>
                <w-item-section>
                  <w-item-label>
                    {{ submission.author.name || t('inbox.reviewUnknownAuthor') }}
                  </w-item-label>
                  <w-item-label caption>{{ humanizeDate(t, submission.createdAt) }}</w-item-label>
                </w-item-section>
                <w-item-section side v-if="submission.isStale">
                  <w-badge color="warning" rounded>{{ t('inbox.reviewStale') }}</w-badge>
                </w-item-section>
              </w-item>
            </w-list>
          </w-menu>
        </w-btn>
      </template>
      <template v-if="editorStore.isActive">
        <!--
          Persistent, not a toast: `EditorMarkdown.vue` already toasts the terminal `denied` status
          once, but a `disconnected` socket can sit retrying for a good while (a flaky wifi, a proxy
          hiccup) and edits keep being made and kept locally the whole time -- something to glance at
          on and off, not a message that has to be caught in the few seconds it was on screen.
          Clears itself the moment `collabStore.status` moves off `disconnected`, reconnected or not.
        -->
        <div
          v-if="collabStore.status === 'disconnected'"
          class="collab-disconnected me-2 flex items-center gap-1 text-warning"
          role="status"
          aria-live="polite">
          <w-icon name="mdi:wifi-off" size="18px" />
          <span class="text-caption">{{ t('editor.collab.disconnected') }}</span>
        </div>
        <!--
          Whoever else has this page open in an editor. Renders nothing when that is nobody, which is
          also what it renders whenever there is no collaboration session at all.
        -->
        <collab-presence class="me-2" />
        <w-btn
          class="ms-4"
          icon="la:question-circle"
          flat
          color="slate-soft"
          :href="siteStore.docsBase + `/guide/editors/${editorStore.editor}`"
          target="_blank"
          type="a">
          <w-tooltip labels>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
      </template>
      <!--
        Not `v-else-if` on the block below: changes made from the page properties panel put the header
        into the pending state without an editor behind it, and hiding Edit there left no way back into
        the content at all. Ahead of the commit actions so those stay rightmost.
      -->
      <template v-if="!editorStore.isActive && userStore.can(`write:pages`)">
        <!--
          The page's own primary action, and the one filled button on this surface (Cardinal: one
          filled button per surface). Everything else in the row -- watch, print, the review queue,
          the docs link -- is a bare icon in the chrome tone.
        -->
        <w-btn
          class="ms-4"
          unelevated
          icon="la:edit"
          color="accent"
          :label="t(`common.actions.edit`)"
          :aria-label="t(`common.actions.edit`)"
          @click="editPage" />
      </template>
      <!--
        For a reader who may read the page but not change it, and whose groups an approval rule lets
        suggest edits to it. Same place and same shape as Edit, because it is the same intent -- what
        differs is where the result goes.

        Never on a redirection. A suggestion is a rewrite of a page's text put in front of a reviewer,
        and a redirection has no text -- what it has is a target, which is a decision about where a
        path leads rather than a contribution to read. The server still answers `canSuggestEdits` from
        the approval rules, which are written against paths and know nothing about editors; this is
        the one place that asks for it.
      -->
      <template v-else-if="!editorStore.isActive && pageStore.canSuggestEdits && !isRedirect">
        <w-btn
          class="ms-4"
          unelevated
          icon="la:edit"
          color="accent"
          :label="
            pageStore.hasOpenSuggestion
              ? t(`common.actions.continueSuggestion`)
              : t(`common.actions.suggestEdits`)
          "
          :aria-label="
            pageStore.hasOpenSuggestion
              ? t(`common.actions.continueSuggestion`)
              : t(`common.actions.suggestEdits`)
          "
          no-caps
          @click="suggestEdits" />
      </template>
      <template v-if="editorStore.isActive || editorStore.hasPendingChanges">
        <w-btn
          class="ms-2"
          outline
          icon="la:times"
          color="accent"
          :label="
            editorStore.hasPendingChanges ? t(`common.actions.discard`) : t(`common.actions.close`)
          "
          :aria-label="
            editorStore.hasPendingChanges ? t(`common.actions.discard`) : t(`common.actions.close`)
          "
          no-caps
          @click="discardChanges" />
        <w-btn
          class="ms-2"
          v-if="isSuggesting"
          unelevated
          icon="la:paper-plane"
          color="positive"
          :label="t(`common.actions.submitEdits`)"
          :aria-label="t(`common.actions.submitEdits`)"
          :disabled="!editorStore.hasPendingChanges"
          no-caps
          @click="submitSuggestion" />
        <w-btn
          class="ms-2"
          v-else-if="editorStore.mode === `create`"
          unelevated
          icon="la:check"
          color="positive"
          :label="t(`editor.createPage`)"
          :aria-label="t(`editor.createPage`)"
          no-caps
          @click="createPage" />
        <w-btn-group class="ms-2" v-else>
          <w-btn
            unelevated
            icon="la:check"
            color="positive"
            :label="t(`common.actions.saveChanges`)"
            :aria-label="t(`common.actions.saveChanges`)"
            :disabled="!editorStore.hasPendingChanges"
            no-caps
            @click.exact="saveChanges(false)"
            @click.ctrl.exact="saveChanges(true)" />
          <template v-if="editorStore.isActive">
            <w-separator vertical />
            <w-btn
              unelevated
              icon="la:check-double"
              color="positive"
              :aria-label="t(`common.actions.saveAndClose`)"
              :disabled="!editorStore.hasPendingChanges"
              @click="saveChanges(true)">
              <w-tooltip>{{ t(`common.actions.saveAndClose`) }}</w-tooltip>
            </w-btn>
          </template>
        </w-btn-group>
      </template>
    </div>
    <!-- SUGGESTION OUTCOME -->
    <!--
      The return leg `hasOpenSuggestion` alone never gave: that flag only ever goes false once a
      reviewer acts, telling its author nothing about what became of it. `w-full` on a flex-wrap row
      puts this on its own line below the icon/title/actions above, whichever of them wrapped.

      Gated on `!hasOpenSuggestion` -- once this reader has a newer suggestion open on the page, the
      outcome of the one before it is no longer what they are here to see.

      Literal colour classes, like the stale-page banner in `InboxReview.vue`: WBanner has no `color`
      prop, so one would be silently dropped.
    -->
    <w-banner
      v-if="!pageStore.hasOpenSuggestion && pageStore.resolvedSubmission"
      class="w-full mx-4 mb-2 flex-none"
      :class="
        pageStore.resolvedSubmission.status === `approved`
          ? `bg-positive text-white`
          : `bg-negative text-white`
      ">
      {{
        pageStore.resolvedSubmission.status === `approved`
          ? t(`common.page.suggestionResolvedApproved`)
          : t(`common.page.suggestionResolvedDeclined`)
      }}
      <div v-if="pageStore.resolvedSubmission.reason" class="mt-1">
        <strong>{{ t(`common.page.suggestionResolvedReasonLabel`) }}</strong>
        {{ pageStore.resolvedSubmission.reason }}
      </div>
    </w-banner>
  </div>
</template>

<script setup>
import { computed, defineAsyncComponent, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { dialog } from '@/composables/dialog'
import { useDirection } from '@/composables/direction'
import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'
import { usePageSaveFlow } from '@/composables/pageSaveFlow'
import { usePathDisplay } from '@/composables/pathDisplay'
import { useMinWidth } from '@/composables/screen'

import { useCollabStore } from '@/stores/collab'
import { useEditorStore } from '@/stores/editor'
import { useFlagsStore } from '@/stores/flags'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import CollabPresence from '@/components/CollabPresence.vue'
import IconPickerDialog from '@/components/IconPickerDialog.vue'
import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDate } from '@/helpers/datetime'
import { directionalAnchor } from '@/helpers/directionalAnchor'

/**
 * How long the bell swings for, in milliseconds. Matches the `w-bell-ring` animation below — the class
 * has to come off once it has played, or the next watch would not play it again.
 */
const BELL_RING_MS = 700

// DIRECTION

const direction = useDirection()

/*
  The review-queue dropdown's `anchor`/`self`, LTR-correct pair mirrored for `dir="rtl"` -- see the
  template comment above the `w-menu` for why a hardcoded "right" pair breaks once this actions group
  has moved to the visual left. Kept reactive off `composables/direction.js` rather than read once:
  this header stays mounted across navigations (it is not remounted per page the way an editor session
  is), so a reader moving between an LTR page and an RTL one in the same visit must flip this too.
*/
const reviewMenu = computed(() =>
  directionalAnchor(direction.isRTL ? 'rtl' : 'ltr', 'bottom right', 'top right')
)

// PATH DISPLAY

const { isActive: pathDisplayActive, humanize } = usePathDisplay()

/**
 * The reading-mode heading text (Feature #2574/#2578) -- `pageStore.title` unchanged when the site's
 * path-display setting is off, or the humanized last segment of `pageStore.path` when it's on. A
 * deliberate override of whatever title the page was actually saved with, not a fallback for a page
 * with no title -- see the parent Feature's own scope note. Only the reading-mode `v-else` span
 * reads this; the `contenteditable` field beside it (shown while editing) still binds
 * `pageStore.title` directly, since editing a page's real title must never be short-circuited by
 * this display-only setting.
 */
const displayedTitle = computed(() => {
  if (!pathDisplayActive.value) {
    return pageStore.title
  }
  const segments = pageStore.path.split('/')
  return humanize(segments[segments.length - 1])
})

// STORES

const collabStore = useCollabStore()
const editorStore = useEditorStore()
const flagsStore = useFlagsStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()

// I18N

const { t } = useI18n()

// COMPUTED

/**
 * At or above the `sm` breakpoint (`css/tailwind.css`), which is this app's phone boundary — below it
 * the header is compacted, since a 64px icon and a 34px title over a row of icons is most of a phone
 * screen before the page has said anything.
 */
const isAtLeastSm = useMinWidth(600)
const isPhoneViewport = computed(() => !isAtLeastSm.value)

/**
 * The page icon, halved on a phone.
 *
 * Bound rather than left to a media query: `WIcon` renders `size` as an inline `font-size`, which no
 * stylesheet can outrank without `!important`.
 */
/*
  The plate and the glyph inside it. The plate is the 64px square the design draws (halved on a
  phone, along with everything else in this row); the glyph is a little over half of it, which is
  what leaves the frame reading as a frame rather than as a border drawn round an icon.
*/
const plateSize = computed(() => (isPhoneViewport.value ? '36px' : '64px'))
const glyphSize = computed(() => (isPhoneViewport.value ? '20px' : '34px'))
const plateStyle = computed(() => ({ width: plateSize.value, height: plateSize.value }))

/**
 * Whether this row holds an editor's own controls — Save, Discard, Submit — rather than only the
 * actions offered to a reader. Those must survive the phone layout: the properties panel puts the
 * header into the pending state with no editor open, so `isActive` alone is not the question.
 */
const hasEditorActions = computed(() => editorStore.isActive || editorStore.hasPendingChanges)

/**
 * Suggesting an edit rather than making one: the editor is open on a submission, and everything about
 * the page other than its content is out of scope.
 */
const isSuggesting = computed(() => editorStore.isActive && editorStore.mode === 'suggest')

/**
 * Editing the page itself, which is what makes the icon, title and description editable in place.
 * Excludes suggest mode, where those are page properties the submitter has no say over.
 */
const isEditing = computed(() => editorStore.isActive && !isSuggesting.value)

/** How many suggestions are waiting on this page, which is what the review badge counts. */
const pendingCount = computed(() => pageStore.pendingSubmissions.length)

/**
 * Whether this is a redirection — one being read, edited or created alike, since `pageCreate` puts the
 * editor on the page store as well.
 *
 * What it takes out of this row is everything addressed to a READER of the page: watching it,
 * suggesting a change to it, and reviewing the suggestions. Nobody stays on a redirection long enough
 * for any of those to mean anything. The title, the icon and Edit stay, because those belong to
 * whoever maintains it.
 */
const isRedirect = computed(() => pageStore.editor === 'redirect')

// DATA

const state = reactive({
  /**
   * Whether the bell is mid-swing. Set for as long as the animation runs and cleared afterwards, so
   * that watching a page again a minute later rings it again — a class left on plays once and never
   * plays a second time.
   */
  bellRinging: false
})

// REFS

/** The two in-place fields, which only exist while the page itself is being edited. */
const titleEl = ref(null)
const descriptionEl = ref(null)

// WATCHERS

/*
  Opening the editor is what mounts the two fields, so it is also what fills them. `immediate` covers
  arriving with the editor already open, where the elements appear in the same tick as this runs.
*/
watch(
  () => isEditing.value,
  (editing) => editing && seedEditables(),
  { immediate: true }
)

/*
  Changed from somewhere else -- the properties panel edits both of these, and a save replaces the whole
  page -- so the field follows. A change that came FROM the field is already in the element and
  `syncEditable` leaves it alone.
*/
watch(
  () => pageStore.title,
  (title) => syncEditable(titleEl.value, title)
)
watch(
  () => pageStore.description,
  (description) => syncEditable(descriptionEl.value, description)
)

// METHODS

/**
 * Put a value into a contenteditable without disturbing a caret that is already in it.
 *
 * Writing `textContent` replaces the node's text and collapses the selection to its start, so it is
 * only done when the element and the store have actually diverged — which is never mid-keystroke,
 * since the keystroke is where the store's value came from.
 */
function syncEditable(el, value) {
  if (el && el.textContent !== (value ?? '')) {
    el.textContent = value ?? ''
  }
}

/** Both fields, from the store. Call after they mount; they do not exist outside the editor. */
async function seedEditables() {
  await nextTick()
  syncEditable(titleEl.value, pageStore.title)
  syncEditable(descriptionEl.value, pageStore.description)
}

/**
 * The icon picked from the header.
 *
 * The same two steps the title and the description take below, and for the same reason: an icon is part
 * of the page, so changing it has to leave the editor holding an unsaved change. Bound through the event
 * rather than `v-model` because that wrote the store and nothing else -- Save Changes stayed disabled
 * until something else was edited, and closing the editor threw the new icon away without a word.
 */
function setIcon(icon) {
  pageStore.icon = icon
  editorStore.markDirty()
}

function onEditableInput(field, event) {
  // -> Clearing the field leaves a browser-inserted `<br>` behind, which contributes nothing to the
  //    text but does hold a second line open under the placeholder
  if (event.target.textContent === '' && event.target.innerHTML !== '') {
    event.target.innerHTML = ''
  }
  pageStore[field] = event.target.textContent
  // -> What the tag editor and the properties panel do for their own edits: the header is a place a
  //    page gets changed, so it owes the same "unsaved changes" signal
  editorStore.markDirty()
}

/*
  Tidied on the way out rather than as it is typed: a pasted line break or a run of spaces has no
  business in a title, but collapsing them under the caret would move it while someone is still going.
*/
function onEditableBlur(field, event) {
  const tidied = event.target.textContent.replace(/\s+/g, ' ').trim()
  if (tidied !== pageStore[field]) {
    pageStore[field] = tidied
    editorStore.markDirty()
  }
  syncEditable(event.target, tidied)
}

/*
  The save/discard/conflict/undo cluster, lifted out whole (`composables/pageSaveFlow.js`). It still
  needs the two answers only this header has -- whether the open editor is a suggestion, and whether
  the page's pending asset renames could be committed -- and registers the save-conflict watch
  itself, in this component's own effect scope.
*/
const { discardChanges, saveChanges } = usePageSaveFlow({
  isSuggesting,
  processPendingAssets
})

async function createPage() {
  // Handle home page creation flow
  if (pageStore.path === 'home') {
    if (!(await processPendingAssets())) {
      return
    }
    loading.show()
    try {
      await pageStore.pageSave()
      notify({
        type: 'positive',
        message: t('common.page.homepageCreateSuccess')
      })
      editorStore.$patch({
        isActive: false
      })
      router.replace('/')
    } catch (err) {
      notify({
        type: 'negative',
        message: t('common.page.homepageCreateFailed'),
        caption: err.message
      })
    }
    loading.hide()
    return
  }

  // All other pages
  dialog({
    component: defineAsyncComponent(() => import('../components/TreeBrowserDialog.vue')),
    componentProps: {
      mode: 'savePage',
      folderPath: '',
      itemTitle: pageStore.title,
      itemFileName: pageStore.path,
      locale: pageStore.locale
    }
  }).onOk(async ({ path, title }) => {
    if (!(await processPendingAssets())) {
      return
    }

    loading.show()
    try {
      pageStore.$patch({
        title,
        path
      })
      await pageStore.pageSave()
      notify({
        type: 'positive',
        message: t('common.page.createSuccess')
      })
      editorStore.$patch({
        isActive: false
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('common.page.createFailed'),
        caption: err.message
      })
    }
    loading.hide()
  })
}

/**
 * Uploads whatever assets are pending, if any. Resolves `true` when the caller may proceed with the
 * save/create it was about to do, `false` when the upload was cancelled or failed and the caller
 * should stop instead.
 *
 * Resolves rather than rejecting on cancel: `dialog()`'s `.onCancel(cb)` invokes `cb` with no
 * argument (`composables/dialog.js`'s `closeDialog`), so `.onCancel(reject)` used to reject this
 * promise with `undefined` as the reason -- every one of the three call sites below awaits this
 * outside a try/catch (their own enclosing handlers are not awaited by whatever triggered them
 * either), so a cancelled/failed upload surfaced as an unhandled promise rejection with no message
 * (OpenProject #945).
 */
async function processPendingAssets() {
  if (!(editorStore.pendingAssets?.length > 0)) {
    return true
  }
  return new Promise((resolve) => {
    dialog({
      component: defineAsyncComponent(() => import('../components/UploadPendingAssetsDialog.vue')),
      persistent: true
    })
      .onOk(() => resolve(true))
      .onCancel(() => resolve(false))
  })
}

async function editPage() {
  loading.show()
  await pageStore.pageEdit()
  loading.hide()
}

/**
 * Open the editor on an edit suggestion. Picks up the reader's own pending suggestion if they have
 * one, which the server decides -- see `pageSuggest`.
 */
async function suggestEdits() {
  loading.show()
  try {
    await pageStore.pageSuggest()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('common.page.suggestFailed'),
      caption: err.message
    })
  }
  loading.hide()
}

/**
 * Send the suggestion, asking a guest who they are first: nothing else records that, and a reviewer
 * has to be able to answer them.
 */
async function submitSuggestion() {
  if (!userStore.authenticated) {
    dialog({
      component: defineAsyncComponent(() => import('../components/SuggestionGuestDialog.vue'))
    }).onOk((guest) => submitSuggestionCommit(guest))
    return
  }
  submitSuggestionCommit()
}

async function submitSuggestionCommit(guest = {}) {
  loading.show()
  try {
    await pageStore.pageSubmitSuggestion(guest)
    // -> Back to the page as everyone else sees it: what was typed is now a suggestion waiting for a
    //    reviewer, not a version of the page, so leaving the editor open on it would be a lie
    editorStore.$patch({
      isActive: false,
      editor: '',
      mode: 'edit'
    })
    await pageStore.pageLoad({ id: pageStore.id })
    notify({
      type: 'positive',
      message: t('common.page.suggestSubmitted'),
      // -> Only an account can be matched to a suggestion afterwards, so only a logged in author is
      //    told they can come back to it; for a guest that would be a promise nothing here can keep
      caption: userStore.authenticated
        ? t('common.page.suggestSubmittedHint')
        : t('common.page.suggestSubmittedHintGuest')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('common.page.suggestSubmitFailed'),
      caption: apiErrorMessage(err)
    })
  }
  loading.hide()
}

function printPage() {
  window.print()
}

/**
 * Open one suggestion for review, remembering where it was opened from.
 *
 * `from: 'page'` is what sends the reviewer back here when they are done, rather than to the inbox
 * queue they never came through -- read by `InboxReview.vue`'s `fromPage` prop, forwarded off
 * `overlayOpts` by `InboxOverlay.vue` (OpenProject #2531 converted the Inbox from routed `/_inbox/*`
 * pages to a `MainOverlayDialog` entry).
 */
function reviewSubmission(submission) {
  siteStore.openOverlay('Inbox', { tab: 'review', submissionId: submission.id, from: 'page' })
}

/**
 * Watch the page, or stop watching it.
 *
 * The bell rings on the way IN only: a swing is the page announcing that it will now tell you about
 * itself, and playing the same flourish for switching that off would say the opposite thing with the
 * same gesture. The store moves before the request answers, so the icon flips under the pointer.
 */
async function toggleWatch() {
  const watching = !pageStore.isWatching
  if (watching) {
    state.bellRinging = true
    setTimeout(() => {
      state.bellRinging = false
    }, BELL_RING_MS)
  }
  try {
    await pageStore.pageWatch(watching)
  } catch (err) {
    notify({
      type: 'negative',
      message: t(watching ? 'common.page.watchFailed' : 'common.page.unwatchFailed'),
      caption: err.message
    })
  }
}
</script>

<style scoped lang="scss">
/*
  The phone layout of this row.

  The title comes down from `text-h4`, which is a 34px display size written for a header the width of a
  desktop window: at 390px a title of any length wrapped, and the description under it was pushed out of
  the bar. 24px is the same step `text-h5` takes, chosen as a value rather than as that class so the size
  lives beside the breakpoint that asks for it.

  The text column's padding halves with it, which is most of what brings the bar's own height down --
  `pages/Index.vue` takes the fixed 95px off on the same breakpoint, so what is left of it is this
  column. Horizontal too, and deliberately: at 8px the title lines up with the article underneath, which
  now pads by the same amount.

  And the actions go, all of them -- Watch, Print, the review queue, Edit -- because they are icons
  squeezed against the right edge of a row that has no room for the title as it is. Nothing is lost that
  is not reachable elsewhere: Print is the browser's own menu, and a page is edited on a machine with a
  keyboard. An editor already open keeps its controls, or there would be no way to save or leave it.

  Unlayered scoped rules, so they beat the `text-h4` utility without needing `!important`.
*/
@media (max-width: $breakpoint-xs-max) {
  .page-header-title {
    font-size: 1.5rem;
    line-height: 2rem;
  }

  .page-header-actions:not(.has-editor-actions) {
    display: none;
  }
}

/*
  The bell swinging as a page starts being watched.

  On the icon inside the button rather than on the button itself, so the ripple, the hover tint and the
  hit area all stay where they are while only the drawing moves. `transform-origin` at the top centre
  is what makes it swing from its mounting instead of spinning about its middle.

  `:deep`, because the icon is rendered by `WBtn` and a scoped rule would not reach into it.
*/
.is-ringing :deep(svg) {
  animation: w-bell-ring 0.7s ease-in-out;
  transform-origin: top center;
}

@keyframes w-bell-ring {
  0% {
    transform: rotate(0);
  }
  15% {
    transform: rotate(18deg);
  }
  30% {
    transform: rotate(-14deg);
  }
  45% {
    transform: rotate(10deg);
  }
  60% {
    transform: rotate(-7deg);
  }
  75% {
    transform: rotate(4deg);
  }
  100% {
    transform: rotate(0);
  }
}

/* -> A swinging bell says nothing the colour change does not; for a reader who asked for less motion
   it is noise with a vestibular cost, so it simply does not swing. */
@media (prefers-reduced-motion: reduce) {
  .is-ringing :deep(svg) {
    animation: none;
  }
}

/*
  The two headings, while they are also the fields.

  No border and no focus ring: at rest each one has to read exactly as it does when the page is being
  read, which is the whole point of editing them where they sit. What says "type here" is the hover
  tint, the caret, and -- while a field is empty -- the placeholder below.

  The padding is cancelled by an equal negative margin, so the text keeps the position it has outside
  the editor and only the tint is inset from it.
*/
.page-header-editable {
  display: inline-block;
  padding: 0 4px;
  margin: 0 -4px;
  border-radius: 4px;
  outline: none;
  cursor: text;
  transition: background-color 0.15s var(--ease-standard);

  &:hover {
    background-color: rgb(0 0 0 / 0.06);
  }
  &:focus {
    background-color: rgb(0 0 0 / 0.09);
  }

  @at-root .body--dark & {
    &:hover {
      background-color: rgb(255 255 255 / 0.08);
    }
    &:focus {
      background-color: rgb(255 255 255 / 0.12);
    }
  }
}

/*
  Keyed off the store rather than `:empty`, which a cleared field can fail: the browser leaves a `<br>`
  behind and the element stops counting as empty even though it looks it.
*/
.page-header-editable.is-empty::before {
  content: attr(data-placeholder);
  opacity: 0.4;
  /* -> Decoration: it must not be selectable, and it must never end up in the value */
  pointer-events: none;
  user-select: none;
}
</style>
