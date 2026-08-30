<template>
  <div class="editor-markdown" :class="{ 'is-resizing': isDragging }">
    <div class="editor-markdown-main">
      <div class="editor-markdown-sidebar">
        <!-- ------------------------------------------------------- -->
        <!-- SIDE TOOLBAR -->
        <!-- ------------------------------------------------------- -->
        <w-btn icon="mdi:link-variant-plus" padding="sm sm" flat @click="insertLink">
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertLink')
          }}</w-tooltip>
        </w-btn>
        <!-- -> Straight to the File Manager. The menu this replaces offered two other sources: a remote
                URL, which was never implemented, and the clipboard — see `getAssetFromClipboard`, which
                now has no caller. -->
        <w-btn icon="mdi:image-plus-outline" padding="sm sm" flat @click="insertAssets">
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertAssets')
          }}</w-tooltip>
        </w-btn>
        <w-btn icon="mdi:code-json" padding="sm sm" flat>
          <editor-code-block-menu
            :anchor="sideToolbarMenuAnchor"
            :self="sideToolbarMenuSelf"
            @select="insertCodeBlock" />
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertCodeBlock')
          }}</w-tooltip>
        </w-btn>
        <w-btn icon="mdi:table-large-plus" padding="sm sm" flat @click="insertTable">
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertTable')
          }}</w-tooltip>
        </w-btn>
        <w-btn icon="mdi:tab-plus" padding="sm sm" flat @click="insertTabset">
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertTabset')
          }}</w-tooltip>
        </w-btn>
        <w-btn icon="mdi:toy-brick-plus" padding="sm sm" flat @click="insertBlock">
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertBlock')
          }}</w-tooltip>
        </w-btn>
        <w-btn icon="mdi:book-plus" padding="sm sm" flat @click="insertFootnote">
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertFootnote')
          }}</w-tooltip>
        </w-btn>
        <w-btn icon="mdi:emoticon-plus-outline" padding="sm sm" flat>
          <editor-emoji-menu
            :anchor="sideToolbarMenuAnchor"
            :self="sideToolbarMenuSelf"
            @select="insertEmoji" />
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertEmoji')
          }}</w-tooltip>
        </w-btn>
        <!-- -> Icons only: what goes in is a `:mdi:home:` shortcode, and the picker's other tab hands
                back an `img:` URL, which is not something that syntax can say -->
        <w-btn icon="mdi:seed-plus-outline" padding="sm sm" flat>
          <w-menu
            :anchor="sideToolbarMenuAnchor"
            :self="sideToolbarMenuSelf"
            content-class="shadow-7">
            <icon-picker-dialog no-image @update:model-value="insertIcon" />
          </w-menu>
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertIcon')
          }}</w-tooltip>
        </w-btn>
        <w-btn icon="mdi:line-scan" padding="sm sm" flat @click="insertHorizontalBar">
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertHorizontalBar')
          }}</w-tooltip>
        </w-btn>
        <w-space />
        <span class="editor-markdown-type">Markdown</span>
      </div>
      <div class="editor-markdown-mid" ref="editorMidRef">
        <!-- ------------------------------------------------------- -->
        <!-- TOP TOOLBAR -->
        <!-- ------------------------------------------------------- -->
        <div class="editor-markdown-toolbar">
          <w-btn icon="mdi:format-bold" padding="xs sm" flat @click="toggleMarkup({ start: `**` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.bold')
            }}</w-tooltip>
          </w-btn>
          <w-btn
            icon="mdi:format-italic"
            padding="xs sm"
            flat
            @click="toggleMarkup({ start: `*` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.italic')
            }}</w-tooltip>
          </w-btn>
          <w-btn
            icon="mdi:format-strikethrough"
            padding="xs sm"
            flat
            @click="toggleMarkup({ start: `~~` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.strikethrough')
            }}</w-tooltip>
          </w-btn>
          <w-btn icon="mdi:format-header-pound" padding="xs sm" flat>
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.header')
            }}</w-tooltip>
            <w-menu auto-close>
              <w-list separator>
                <w-item v-for="lvl in 6" clickable @click="setHeaderLine(lvl)">
                  <w-item-section side>
                    <w-icon :name="HEADER_ICONS[lvl - 1]" />
                  </w-item-section>
                  <w-item-section>{{
                    t('editor.markup.headerLevel', { level: lvl })
                  }}</w-item-section>
                </w-item>
              </w-list>
            </w-menu>
          </w-btn>
          <w-btn
            icon="mdi:format-subscript"
            padding="xs sm"
            flat
            @click="toggleMarkup({ start: `~` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.subscript')
            }}</w-tooltip>
          </w-btn>
          <w-btn
            icon="mdi:format-superscript"
            padding="xs sm"
            flat
            @click="toggleMarkup({ start: `^` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.superscript')
            }}</w-tooltip>
          </w-btn>
          <w-btn icon="mdi:format-quote-close" padding="xs sm" flat>
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.blockquoteAdmonitions')
            }}</w-tooltip>
            <w-menu auto-close>
              <w-list separator>
                <w-item clickable @click="insertBeforeEachLine({ content: `> ` })">
                  <w-item-section side><w-icon name="mdi:format-quote-close" /></w-item-section>
                  <w-item-section>{{ t('editor.markup.blockquote') }}</w-item-section>
                </w-item>
                <w-item
                  clickable
                  @click="insertBeforeEachLine({ content: `> `, before: `> [!NOTE]` })">
                  <w-item-section side>
                    <!--
                      A colour with a utility behind it. WIcon composes the class from this name, so
                      Tailwind never sees it while scanning and emits only the ones written out in
                      full somewhere in the app -- of the blues, that is this one. Asking for the 7
                      step, as this did, left the icon the colour of the menu text.

                      Nothing above may spell a class out either: the scanner reads comments too, and
                      would generate whatever this explanation quoted.
                    -->
                    <w-icon name="mdi:information-box" color="blue" />
                  </w-item-section>
                  <w-item-section>{{ t('editor.markup.admonitionInfo') }}</w-item-section>
                </w-item>
                <w-item
                  clickable
                  @click="insertBeforeEachLine({ content: `> `, before: `> [!TIP]` })">
                  <w-item-section side>
                    <w-icon name="mdi:check-circle" color="positive" />
                  </w-item-section>
                  <w-item-section>{{ t('editor.markup.admonitionSuccess') }}</w-item-section>
                </w-item>
                <!-- -> The same speech bubble the page draws an IMPORTANT admonition with -->
                <w-item
                  clickable
                  @click="insertBeforeEachLine({ content: `> `, before: `> [!IMPORTANT]` })">
                  <w-item-section side>
                    <w-icon name="mdi:message-alert" color="purple" />
                  </w-item-section>
                  <w-item-section>{{ t('editor.markup.admonitionImportant') }}</w-item-section>
                </w-item>
                <w-item
                  clickable
                  @click="insertBeforeEachLine({ content: `> `, before: `> [!WARNING]` })">
                  <w-item-section side>
                    <w-icon name="mdi:alert-box" color="orange" />
                  </w-item-section>
                  <w-item-section>{{ t('editor.markup.admonitionWarning') }}</w-item-section>
                </w-item>
                <w-item
                  clickable
                  @click="insertBeforeEachLine({ content: `> `, before: `> [!CAUTION]` })">
                  <w-item-section side>
                    <w-icon name="mdi:close-box" color="negative" />
                  </w-item-section>
                  <w-item-section>{{ t('editor.markup.admonitionDanger') }}</w-item-section>
                </w-item>
              </w-list>
            </w-menu>
          </w-btn>
          <w-btn
            icon="mdi:format-list-bulleted"
            padding="xs sm"
            flat
            @click="insertBeforeEachLine({ content: `- ` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.unorderedList')
            }}</w-tooltip>
          </w-btn>
          <w-btn
            icon="mdi:format-list-numbered"
            padding="xs sm"
            flat
            @click="insertBeforeEachLine({ content: `1. ` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.orderedList')
            }}</w-tooltip>
          </w-btn>
          <w-btn icon="mdi:format-list-checks" padding="xs sm" flat>
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.taskList')
            }}</w-tooltip>
            <w-menu auto-close>
              <w-list separator>
                <w-item clickable @click="insertBeforeEachLine({ content: `- [ ] ` })">
                  <w-item-section side><w-icon name="mdi:checkbox-blank-outline" /></w-item-section>
                  <w-item-section>{{ t('editor.markup.taskListUnchecked') }}</w-item-section>
                </w-item>
                <w-item clickable @click="insertBeforeEachLine({ content: `- [x] ` })">
                  <w-item-section side><w-icon name="mdi:checkbox-outline" /></w-item-section>
                  <w-item-section>{{ t('editor.markup.taskListChecked') }}</w-item-section>
                </w-item>
              </w-list>
            </w-menu>
          </w-btn>
          <w-btn icon="mdi:code-tags" padding="xs sm" flat @click="toggleMarkup({ start: '`' })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.inlineCode')
            }}</w-tooltip>
          </w-btn>
          <w-btn
            icon="mdi:keyboard-variant"
            padding="xs sm"
            flat
            @click="toggleMarkup({ start: `<kbd>`, end: `</kbd>` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.keyboardKey')
            }}</w-tooltip>
          </w-btn>
          <!-- -> The only way back once the preview is closed: its own toggle goes with it -->
          <template v-if="!state.previewShown">
            <w-space />
            <w-btn
              icon="mdi:view-split-vertical"
              padding="xs sm"
              flat
              @click="state.previewShown = true">
              <w-tooltip labels anchor="top middle" self="bottom middle">{{
                t('editor.togglePreviewPane')
              }}</w-tooltip>
            </w-btn>
          </template>
        </div>
        <!-- ------------------------------------------------------- -->
        <!-- MONACO EDITOR -->
        <!-- ------------------------------------------------------- -->
        <div class="editor-markdown-editor"><div ref="monacoRef" /></div>
      </div>
      <!--
        The draggable resize divider between the source and preview panes. Only offered while the
        preview is actually open (nothing to drag against otherwise) and at/above the `md` breakpoint
        -- see `canResizePreview`'s doc comment for why dragging is withheld below it.
      -->
      <div
        v-if="canResizePreview"
        class="editor-markdown-divider"
        :class="{ 'is-dragging': isDragging }"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('editor.resizePreviewPane')"
        @pointerdown="onDividerPointerDown"
        @pointermove="onDividerPointerMove"
        @pointerup="onDividerPointerUp"
        @pointercancel="onDividerPointerUp" />
      <transition
        :name="previewEverRevealed ? 'editor-markdown-preview' : 'editor-markdown-preview-initial'">
        <div
          class="editor-markdown-preview"
          ref="previewPaneRef"
          :style="previewInlineStyle"
          v-if="state.previewShown">
          <div class="editor-markdown-preview-toolbar">
            <strong
              ><em>{{ t('editor.renderPreview') }}</em></strong
            >
            <w-separator class="ms-4 me-2" vertical inset />
            <w-btn
              icon="mdi:arrow-vertical-lock"
              padding="xs sm"
              flat
              @click="state.previewScrollSync = !state.previewScrollSync"
              :color="state.previewScrollSync ? `primary` : null">
              <w-tooltip labels anchor="top middle" self="bottom middle">{{
                t('editor.toggleScrollSync')
              }}</w-tooltip>
            </w-btn>
            <w-btn
              icon="mdi:eye-off-outline"
              padding="xs sm"
              flat
              @click="state.previewShown = false">
              <w-tooltip labels anchor="top middle" self="bottom middle">{{
                t('editor.togglePreviewPane')
              }}</w-tooltip>
            </w-btn>
          </div>
          <!--
            The render goes directly into the element carrying `page-contents`, exactly as the page
            view does it. The wrapper div this replaces made the headings grandchildren of that
            element, so content rules written against its direct children -- the page title's rule
            reaching out to the sidebar -- applied on one surface and not the other. Its `ref` was
            never read; the scroll-sync and block loading both use the container.
          -->
          <div
            class="editor-markdown-preview-content page-contents"
            ref="editorPreviewContainerRef"
            v-html="pageStore.render" />
        </div>
      </transition>
    </div>
  </div>
</template>

<script setup>
import {
  computed,
  defineAsyncComponent,
  reactive,
  ref,
  shallowRef,
  nextTick,
  onMounted,
  watch,
  onBeforeUnmount
} from 'vue'
import { useI18n } from 'vue-i18n'

import {
  bindCollabEditor,
  collabStatusEffects,
  startCollabSession,
  stopCollabSession
} from '@/composables/collab'
import { dialog } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { useMinWidth } from '@/composables/screen'
import { assetPath } from '@/helpers/assets'
import { blockMarkdown } from '@/helpers/blocks'
import { directionalAnchor } from '@/helpers/directionalAnchor'
import { hasFiles, shouldAcceptDrag, shouldClaimPaste } from '@/helpers/editorFileTransfer'
import {
  resolveEditorFontSize,
  resolveInitialPreviewShown,
  resolveInitialPreviewWidth
} from '@/helpers/editorUserSettings'
import {
  blockOpeningLine,
  blockValues,
  findBlocks,
  hasEditableParams
} from '@/helpers/markdownBlocks'
import { resolveWordMarkup } from '@/helpers/markdownMarkup'
import { findEditableTables } from '@/helpers/markdownTable'

import EditorCodeBlockMenu from '@/components/EditorCodeBlockMenu.vue'
import EditorEmojiMenu from '@/components/EditorEmojiMenu.vue'
import IconPickerDialog from '@/components/IconPickerDialog.vue'
import LinkPickerDialog from '@/components/LinkPickerDialog.vue'

import { useCollabStore } from '@/stores/collab'
import { useCommonStore } from '@/stores/common'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { enhanceRenderedContent } from '@/helpers/renderedContent'

import { debounce } from 'es-toolkit/function'
import * as monaco from 'monaco-editor'
import { Position, Range } from 'monaco-editor'
import { MonacoBinding } from 'y-monaco'
import { MarkdownRenderer } from '@/renderers/markdown'

// STORES

const collabStore = useCollabStore()
const commonStore = useCommonStore()
const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// COMPUTED

/**
 * Whether this edit is shared with whoever else has the page open.
 *
 * Deliberately narrow. A page being created has no id to gather anyone around yet, and a suggestion is
 * one person's private draft of a page they may not write to — the server refuses a room for it, and
 * asking for one anyway would only produce a rejected socket on every keystroke of every suggestion.
 */
const collabEnabled = computed(
  () =>
    siteStore.features.collaborativeEditing &&
    userStore.authenticated &&
    editorStore.mode === 'edit' &&
    Boolean(pageStore.id)
)

/*
  The side toolbar's tooltips and dropdown menus popped OUTWARD, away from the icon column, which
  `App.vue`'s `applyLocale` always put on the reading-start edge of this editor -- so their `anchor`/
  `self` used to be hardcoded to the one physical side that had room: `right` of the button. `WTooltip`
  and `WMenu` place themselves in raw viewport pixels (`composables/anchoredPosition.js`), which knows
  nothing about `direction`, so under `dir="rtl"` the sidebar itself swaps to the other edge (a plain
  flex row already follows the inline axis) but a tooltip still anchored `right` would pop away from
  the editor instead of toward it. `directionalAnchor` mirrors the pair when it is. Read once at
  setup rather than kept reactive: switching the reader's locale mid-edit is not a case this editor
  has to survive gracefully.
*/
const sideToolbarTooltip = directionalAnchor(
  document.documentElement.dir,
  'center right',
  'center left'
)
const sideToolbarTooltipAnchor = sideToolbarTooltip.anchor
const sideToolbarTooltipSelf = sideToolbarTooltip.self
const sideToolbarMenu = directionalAnchor(document.documentElement.dir, 'top right', 'top left')
const sideToolbarMenuAnchor = sideToolbarMenu.anchor
const sideToolbarMenuSelf = sideToolbarMenu.self

// STATE

let editor
let md
/** Where the paste listener ended up, so it can be taken off the same node. See the note in onMounted. */
let pasteCaptureNode = null
/** The "Edit Table" lens provider, which is registered against the language rather than this editor. */
let tableLensProvider = null
/** The "Edit Block Parameters" lens provider, registered the same way. */
let blockLensProvider = null
/**
 * The blocks this site has, as the API describes them — their props included.
 *
 * Read once with the list of disabled ones, since it is the same request. What the lens needs from it
 * is the props: a block whose definition is not here is one this editor cannot offer a form for.
 */
let siteBlocks = []
/**
 * The `debounce()`-wrapped Monaco event handlers registered in `onMounted`, kept only so
 * `onBeforeUnmount` can `cancel()` them. Without this, a debounced call still pending when the
 * component unmounts fires ~500ms later against the already-`dispose()`d editor -- for the
 * cursor-position one, `editor.getPosition()` returns `null` on a disposed instance, and reading
 * `.lineNumber` off it throws (OpenProject #808).
 */
let debouncedContentChange = null
let debouncedCursorPositionChange = null
/**
 * Stop handles for the two collab watchers started in `onMounted`, kept for the same reason as the
 * debounced handlers above: both are created after this hook's first `await` (the settings/blocks
 * fetch), and Vue only auto-binds a `watch()` to the component's effect scope when it is created
 * synchronously during setup -- one created after an `await` is never auto-stopped on unmount, and
 * fires on for the life of the store. Left running past unmount, the `status` watcher calls
 * `editor.updateOptions()` against an editor `onBeforeUnmount` has already `dispose()`d (a console
 * error on every exit from a collab-enabled edit), and the `lastSave` watcher fires once per past
 * mount for a save from another collaborator -- duplicate "saved by X" notifications (OpenProject
 * #942). Explicitly `stop()`ed below instead.
 */
let stopCollabStatusWatch = null
let stopCollabLastSaveWatch = null
/**
 * The pending `editor.focus()` timeout `insertAssetClb` schedules 500ms after an insert, kept so
 * `onBeforeUnmount` can `clearTimeout()` it -- left to fire after unmount it calls `.focus()` on an
 * editor `dispose()` has already torn down (OpenProject #943's related minor).
 */
let insertAssetFocusTimeout = null
const monacoRef = ref(null)
const editorPreviewContainerRef = ref(null)
const editorMidRef = ref(null)
const previewPaneRef = ref(null)

/** Whether the resize divider is currently being dragged -- drives its highlight and the app-wide cursor/selection lockdown while dragging (`.is-resizing` on the component root). */
const isDragging = ref(false)
/**
 * Whether the preview pane has already played its entrance once this mount.
 *
 * Gates which transition name the pane's `<transition>` uses (see the template) -- `false` picks the
 * fast `editor-markdown-preview-initial` variant, timed to match the side nav's own close animation
 * (`WDrawer.vue`'s `0.2s`) since the two happen together the moment the editor opens. Flipped to `true`
 * once, in `onMounted`, after that first reveal has been scheduled -- every later toggle (the toolbar
 * button) then uses the original, slower `editor-markdown-preview` transition, unchanged from before
 * this fix.
 */
const previewEverRevealed = ref(false)

/*
  The active drag's own scratch state. Plain `let`s rather than `reactive`, matching `editor`/`md`/
  `siteBlocks` above -- nothing here is read by the template directly (`state.previewWidth` and
  `isDragging` are what render), so there is nothing reactivity would buy.
*/
/** Pointer clientX at the drag's start. */
let dragStartX = 0
/** `state.previewWidth` resolved to a concrete px number at the drag's start -- see `onDividerPointerDown`. */
let dragStartWidthPx = 0
/** +1 or -1: which way a growing `clientX` should move the width, measured fresh each drag (see `onDividerPointerDown`'s doc comment for why). */
let dragSign = 1
/** The most the preview may grow to in this drag, measured once at pointer-down (see `onDividerPointerDown`). */
let dragMaxWidthPx = Infinity
/** `state.previewWidth` as it was immediately before this drag began -- what a hide-snap restores. */
let previousPreviewWidth = null

/**
 * Blocks this site has switched off, as the tags they are written as.
 *
 * The preview fetches a component for every element it does not recognise, so a disabled block would
 * draw here and then disappear the moment the page was saved — the server strips one that is not
 * enabled out of the render. Naming them lets the preview leave the element undefined, which is what
 * the saved page comes back as: the block gone, the content the author wrote inside it still there.
 *
 * Only what the site lists as off. A tag that is not in the list at all is a child block, which has no
 * switch of its own, or an unknown one — this decides nothing about either.
 */
const disabledBlockTags = ref(new Set())

/*
  Listed rather than built as `mdi:format-header-${lvl}`: a concatenated icon name is invisible to
  the build-time icon scan, so it would ship as six blank squares.
*/
const HEADER_ICONS = [
  'mdi:format-header-1',
  'mdi:format-header-2',
  'mdi:format-header-3',
  'mdi:format-header-4',
  'mdi:format-header-5',
  'mdi:format-header-6'
]

/*
  How the preview follows the caret: the line being edited goes to the TOP of the pane.

  `start` rather than `nearest`, which was tried and is wrong here -- `nearest` leaves a line alone as
  long as it is visible anywhere, so a line sitting on the last row of the pane stays there, with what is
  being written pinned to the bottom edge and nothing after it in view.

  Asking for the top on every caret move costs nothing when the caret stays put: the element is already
  there, so the browser computes the same offset and there is no movement. What used to make this thrash
  was the pane losing its scroll position to the re-render -- see `processContent` -- and animating up
  from the top of the document each time, not the alignment asked for here.

  `inline: 'nearest'` only so that a wide block -- a table, a diagram -- is never scrolled sideways as a
  side effect of following the caret down the page.
*/
const SYNC_SCROLL = { behavior: 'smooth', block: 'start', inline: 'nearest' }

/**
 * Below this width (CSS px) the preview pane reads as broken rather than "small" -- dragging the
 * divider past this point snaps it into the existing hidden state instead of leaving an awkward
 * sliver. Picked from the middle of a reasonable 80-150px range: narrow enough that a deliberately
 * small-but-legible preview is still reachable before the snap, wide enough that "keep dragging and
 * it vanishes" reads as an intentional threshold rather than the pane getting stuck.
 */
const PREVIEW_HIDE_THRESHOLD_PX = 100

/**
 * The source pane never gives up more than this many px to the preview, however far the divider is
 * dragged. 280px is comfortably enough to still read a line of code past Monaco's line-number
 * gutter, and clamping here means every width check below only has to bound the preview's own
 * maximum, not chase "how small can the editor get" as a separate calculation.
 */
const EDITOR_MIN_WIDTH_PX = 280

/**
 * Whether the window is wide enough to open the preview beside the source.
 *
 * 1024 is the app's `md` breakpoint (`css/tailwind.css`). Below it the two panes are half a small window
 * each, and the source is the one being typed into — so the preview starts closed and is opened when
 * wanted, from the toolbar button that takes its place.
 */
const isAtLeastMd = useMinWidth(1024)

const state = reactive({
  /*
    Starts closed regardless of `isAtLeastMd` -- not a placeholder value to read past, unlike
    `previewWidth` below, but the actual initial state. Opening it is deferred to `onMounted`, once
    `previewWidth` is already resolved too, so the very first time this flips true both values are
    already correct and the pane's entrance transition (see the template's `<transition>` and
    `previewEverRevealed`) animates straight to the right width -- rather than appearing instantly at
    the SCSS fallback (`50vw`) and snapping to the real width a moment later, once the async settings
    fetch resolves, which is what starting `true` here used to produce.
  */
  previewShown: false,
  previewScrollSync: true,
  /*
    `null` until `onMounted` resolves this user's saved width (or the lack of one) through
    `resolveInitialPreviewWidth` -- the same placeholder-then-resolve shape as `previewShown` above.
    Tracked separately from `previewShown` on purpose (requirement: a hide/show cycle keeps the last
    dragged width): `null` means "no custom width, use the responsive 50vw default", a number is a
    pixel width this session or a past one committed by dragging the divider, and it is left alone by
    hiding the pane -- only overwritten by another drag, or restored from a saved value on mount.
  */
  previewWidth: null
})

/**
 * Whether the resize divider is offered at all.
 *
 * Below the `md` breakpoint the preview already defaults shut and, once opened deliberately from the
 * toolbar, takes half of a small window (see `isAtLeastMd` above) -- letting it also be dragged there
 * would let an author shrink the SOURCE pane on the one screen size that can least afford to lose the
 * room. Resizing is therefore an `md`-and-up affordance, matching the preview's own default already
 * being width-dependent.
 */
const canResizePreview = computed(() => state.previewShown && isAtLeastMd.value)

/**
 * The inline style that gives the preview pane a custom width, or `null` to fall back to the SCSS
 * default (a responsive `50vw`, both for the settled width and for the open/close transition -- see
 * `--preview-width`'s use there).
 *
 * Also `null` below the `md` breakpoint even when a custom width IS saved: `canResizePreview` already
 * withholds the divider there, and applying a desktop-sized saved width through CSS alone on a
 * narrower screen would squeeze the source pane exactly as unresizably as dragging one there would.
 */
const previewInlineStyle = computed(() => {
  if (!isAtLeastMd.value || typeof state.previewWidth !== 'number') {
    return null
  }
  return {
    '--preview-width': `${state.previewWidth}px`,
    // -> `flex: 0 0 <px>` replaces the SCSS `-preview` rule's own `flex: 0 1 50%` outright (inline
    //    style always wins), pinning the basis exactly rather than leaving it shrinkable against `-mid`
    flex: `0 0 ${state.previewWidth}px`
  }
})

// METHODS

function insertAssets() {
  siteStore.openFileManager({ insertMode: true })
}

/**
 * What the file manager handed back, as markdown at the cursor.
 *
 * Both kinds go in as paths from the site root: a file through `assetPath`, which is where the
 * reasoning about that form lives, and a page the way the link picker writes one.
 *
 * An image goes in as one and anything else as a link -- a PDF picked from the file manager is a link
 * to a PDF, not a broken picture -- which is the same distinction `insertFilesAsAssets` draws for a
 * file that arrives by drop.
 */
function insertAssetClb(opts) {
  let content = ''
  switch (opts.type) {
    case 'asset': {
      const isImage = opts.mimeType?.startsWith('image/')
      content = `${isImage ? '!' : ''}[${opts.title}](${assetPath(opts.folderPath, opts.fileName)})`
      break
    }
    case 'page': {
      const pagePath = opts.folderPath ? `${opts.folderPath}/${opts.fileName}` : opts.fileName
      content = `[${opts.title}](/${pagePath})`
      break
    }
  }
  insertAtCursor({ content, focus: false })
  clearTimeout(insertAssetFocusTimeout)
  insertAssetFocusTimeout = setTimeout(() => {
    editor.focus()
  }, 500)
}

/**
 * A fenced code block in the chosen language.
 *
 * Wraps the selection when there is one — marking a few lines and picking a language reads as "this is
 * code" — and otherwise opens an empty block with the caret on the line inside it, ready to type.
 *
 * The fence has to start a line of its own, so a cursor sitting mid-sentence breaks out of it first.
 */
function insertCodeBlock(language) {
  const model = editor.getModel()
  const selection = editor.getSelection()
  const selected = model.getValueInRange(selection)
  const startLine = model.getLineContent(selection.startLineNumber)
  const endLine = model.getLineContent(selection.endLineNumber)
  const before = startLine.slice(0, selection.startColumn - 1).trim().length > 0 ? '\n\n' : ''
  const after = endLine.slice(selection.endColumn - 1).trim().length > 0 ? '\n\n' : '\n'
  editor.executeEdits('', [
    {
      range: selection,
      text: `${before}\`\`\`${language}\n${selected}\n\`\`\`${after}`,
      forceMoveMarkers: true
    }
  ])
  if (!selected) {
    // -> Onto the empty line between the fences, which is the only place typing makes sense next
    const openerLine = selection.startLineNumber + (before ? 2 : 0)
    editor.setPosition({ lineNumber: openerLine + 1, column: 1 })
  }
  editor.focus()
}

/**
 * The chosen emoji, as its shortcode.
 *
 * `:tada:` rather than 🎉, because that is what the renderer replaces — see `renderers/markdown.js`,
 * where the emoji plugin's tokens are the only ones handed to twemoji. A raw character would survive
 * into the page and be drawn by whatever font the reader happens to have.
 */
function insertEmoji(shortcode) {
  insertAtCursor({ content: `:${shortcode}:` })
}

/**
 * The picked icon, as the shortcode that draws it — `mdi:home` in, `:mdi:home:` out.
 *
 * The same delimiters an emoji uses, and the same insertion: the two are one syntax as far as the
 * source is concerned, told apart by the colon inside the reference. See `renderers/markdown.js`.
 */
function insertIcon(reference) {
  if (reference) {
    insertAtCursor({ content: `:${reference}:` })
  }
}

function insertBlock() {
  siteStore.$patch({
    overlay: 'BlockPicker'
  })
}

/**
 * The tabset, without going through the picker.
 *
 * A shortcut to picking Tabs from the block list and inserting it as it stands, so the markup is
 * built from the same definition rather than written out a second time here — a change to the block's
 * starter body reaches both. It still asks the server which blocks this site has: a shortcut to a
 * block an administrator switched off would insert something the page cannot draw.
 */
async function insertTabset() {
  try {
    const blocks = (await API_CLIENT.get(`sites/${siteStore.id}/blocks`).json()) ?? []
    const tabs = blocks.find((block) => block.block === `tabs` && block.isEnabled)
    if (!tabs) {
      notify({
        type: 'warning',
        message: t('editor.blockPicker.blockUnavailable')
      })
      return
    }
    insertBlockClb(blockMarkdown(tabs))
  } catch (err) {
    notify({
      type: 'negative',
      message: t('editor.blockPicker.loadFailed'),
      caption: err.message
    })
  }
}

/**
 * The block the picker built, on its own lines.
 *
 * MDC's block syntax only opens a component when `::` starts a line, so a cursor mid-sentence breaks
 * out of it first — the same rule the table follows.
 */
function insertBlockClb(markdown) {
  const position = editor.getPosition()
  const line = editor.getModel().getLineContent(position.lineNumber)
  const before = line.slice(0, position.column - 1).trim().length > 0 ? '\n\n' : ''
  const after = line.slice(position.column - 1).trim().length > 0 ? '\n\n' : '\n'
  insertAtCursor({ content: `${before}${markdown}${after}` })
}

function insertTable() {
  siteStore.$patch({
    overlay: 'TableEditor',
    overlayOpts: {}
  })
}

/**
 * The same overlay, over a table already in the page — what the "Edit Table" lens above one does.
 *
 * The lens carries only the line it was drawn on, and the table is looked up again here rather than
 * taken from the lens: a lens is provided once and then moves with the text, so its argument is a line
 * number from whenever the document last settled. Reading the table back out of the model at the moment
 * of the click is what keeps the range and the source it hands over describing the same thing.
 */
function editTable(line) {
  const tables = findEditableTables(editor.getModel().getValue())
  const table = tables.find((entry) => entry.startLine <= line && line <= entry.endLine)
  if (!table) {
    return
  }
  siteStore.$patch({
    overlay: 'TableEditor',
    overlayOpts: {
      source: table.source,
      startLine: table.startLine,
      endLine: table.endLine
    }
  })
}

/** The block as this site describes it, or undefined for one it does not list. */
function blockDefinition(name) {
  return siteBlocks.find((block) => block.block === name)
}

/**
 * The parameters dialog, over a block already in the page — what the lens above one opens.
 *
 * The block is looked up again here rather than taken from the lens, for the reason `editTable` gives:
 * a lens is provided once and then moves with the text, so the line it carries is from whenever the
 * document last settled. The name it was drawn for is carried along and has to match too — where a
 * table spans lines and can be found by containment, a block's opening line is a single line, and an
 * edit above it would otherwise put a form for one block over another.
 */
function editBlock(line, name) {
  const found = findBlocks(editor.getModel().getValue()).find(
    (entry) => entry.line === line && entry.block === name
  )
  const definition = found && blockDefinition(found.block)
  if (!definition) {
    return
  }
  dialog({
    component: defineAsyncComponent(() => import('./BlockParamsDialog.vue')),
    componentProps: { definition, values: blockValues(found, definition) }
  }).onOk((values) => {
    /*
      The opening line and nothing else, so the body between the fences is left exactly as it was —
      which for a tabset is every tab in it. One undo takes the whole change back, and the caret lands
      on the line that moved rather than wherever it was before the dialog opened.
    */
    const model = editor.getModel()
    editor.executeEdits('block', [
      {
        range: new Range(found.line, 1, found.line, model.getLineMaxColumn(found.line)),
        text: blockOpeningLine(found, definition, values)
      }
    ])
    editor.setPosition(new Position(found.line, 1))
    editor.focus()
  })
}

/**
 * The table the overlay built: over the lines it was read from, or at the cursor when it is a new one.
 *
 * A new table is kept on its own line — a table only parses as one when its first row starts a line, so
 * inserting into the middle of a sentence has to break out of it, and the blank line after is what
 * separates it from whatever the cursor was sitting in front of.
 *
 * An edited one replaces exactly the lines it occupied, so nothing around it moves and one undo takes
 * the whole table back. The cursor lands at the top of it rather than staying wherever it was, which may
 * be inside the text that was just replaced.
 */
function insertTableClb({ markdown, replace = null }) {
  const model = editor.getModel()
  if (replace) {
    editor.executeEdits('table', [
      {
        range: new Range(
          replace.startLine,
          1,
          replace.endLine,
          model.getLineMaxColumn(replace.endLine)
        ),
        text: markdown
      }
    ])
    editor.setPosition(new Position(replace.startLine, 1))
    editor.focus()
    return
  }
  const position = editor.getPosition()
  const line = model.getLineContent(position.lineNumber)
  const before = line.slice(0, position.column - 1).trim().length > 0 ? '\n\n' : ''
  const after = line.slice(position.column - 1).trim().length > 0 ? '\n\n' : '\n'
  insertAtCursor({ content: `${before}${markdown}${after}` })
}

/**
 * Insert a link, from the shared picker.
 *
 * Whatever is selected becomes the link's text, so marking a phrase and pressing the button reads as
 * "make this a link". With nothing selected the picker's own answer supplies it: the title of the page
 * that was chosen, or the URL itself, which is at least something to type over.
 *
 * `{target="_blank"}` is markdown-it-attrs syntax, and `target` is one of the three attributes the
 * stored render is allowed to keep — see `renderers/markdown.js` and `models/rendering.ts`.
 */
/**
 * The number to give the next footnote.
 *
 * Markdown numbers footnotes in the order they are referenced, not by their labels, so these are
 * names rather than positions — but an author reading the source expects them to count up, and two
 * notes sharing a name would collapse into one. Anything the author named themselves is left alone
 * and simply counted past.
 */
function nextFootnoteLabel(text) {
  let highest = 0
  for (const [, label] of text.matchAll(/\[\^([^\]\s]+)\]/g)) {
    if (/^\d+$/.test(label)) {
      highest = Math.max(highest, Number.parseInt(label, 10))
    }
  }
  return String(highest + 1)
}

/**
 * A footnote: the marker where the cursor is, and the note itself at the foot of the source.
 *
 * Both halves in one `executeEdits` call, because either alone is broken — a marker with no note
 * renders as literal text, and a note nothing refers to renders as nothing at all — and one call is
 * one undo step, so a single Ctrl+Z removes both rather than leaving the other stranded.
 *
 * The two edit ranges are computed from the same pre-edit snapshot, which collides them into one
 * when the cursor sits exactly at the document's end: that is where `insertFootnote` itself always
 * leaves the cursor afterwards (see below), so it is also where the cursor already is on every
 * repeated click with no typing in between. Two edits at an identical range would otherwise be
 * inserted concatenated with no separation — `[^1][^1]: ` instead of a properly delimited marker and
 * note. Detected explicitly as `cursorAtEnd` and folded into one edit instead of two, so the ranges
 * never collide to begin with. The cursor ends on the note, since writing it is what the author was
 * about to do; the marker is already where they left it.
 */
function insertFootnote() {
  const model = editor.getModel()
  const label = nextFootnoteLabel(model.getValue())
  const cursor = editor.getPosition()
  const lastLine = model.getLineCount()
  const lastLineLength = model.getLineContent(lastLine).length
  const cursorAtEnd = cursor.lineNumber === lastLine && cursor.column === lastLineLength + 1

  const marker = `[^${label}]`
  /*
    -> On a line of its own at the end, one blank line clear of whatever the page ends with. When the
       cursor is at that end, the marker itself is what the line will end with once inserted, so the
       gap is always needed there even if the line was empty beforehand.
  */
  const lead = cursorAtEnd || lastLineLength > 0 ? `\n\n` : ``
  const note = `${lead}[^${label}]: `

  editor.executeEdits(
    '',
    cursorAtEnd
      ? [
          {
            range: new Range(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column),
            text: `${marker}${note}`,
            forceMoveMarkers: true
          }
        ]
      : [
          {
            range: new Range(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column),
            text: marker,
            forceMoveMarkers: true
          },
          {
            range: new Range(lastLine, lastLineLength + 1, lastLine, lastLineLength + 1),
            text: note,
            forceMoveMarkers: true
          }
        ]
  )

  const noteLine = model.getLineCount()
  editor.setPosition({ lineNumber: noteLine, column: model.getLineContent(noteLine).length + 1 })
  editor.revealLineInCenterIfOutsideViewport(noteLine)
  editor.focus()
}

function insertLink() {
  dialog({ component: LinkPickerDialog }).onOk(({ href, openInNewTab, title }) => {
    const selection = editor.getSelection()
    const selected = editor.getModel().getValueInRange(selection)
    const label = selected || title || href
    const attributes = openInNewTab ? '{target="_blank"}' : ''
    /*
      One edit for both cases: a selection is replaced, and an empty selection -- which is all a bare
      cursor is -- inserts. `insertAtCursor` cannot do the first, since it builds its own empty range.
    */
    editor.executeEdits('', [
      {
        range: selection,
        text: `[${label}](${href})${attributes}`,
        forceMoveMarkers: true
      }
    ])
    editor.focus()
  })
}

/**
 * Set current line as header
 */
function setHeaderLine(lvl, focus = true) {
  const curLine = editor.getPosition().lineNumber
  let lineContent = editor.getModel().getLineContent(curLine)
  const lineLength = lineContent.length
  if (lineContent.startsWith('#')) {
    lineContent = lineContent.replace(/^(#+ )/, '')
  }
  lineContent = '#'.repeat(lvl) + ' ' + lineContent
  editor.executeEdits('', [
    {
      range: new Range(curLine, 1, curLine, lineLength + 1),
      text: lineContent,
      forceMoveMarkers: true
    }
  ])
  if (focus) {
    editor.focus()
  }
}

/**
 * Get the header lever of the current line
 */
function getHeaderLevel() {
  const curLine = editor.getPosition().lineNumber
  const lineContent = editor.getModel().getLineContent(curLine)
  let lvl = 0
  const result = lineContent.match(/^(#+) /)
  if (result) {
    lvl = (result?.[1] ?? '').length
  }
  return lvl
}

/**
 * Insert content at cursor
 */
function insertAtCursor({ content, focus = true }) {
  const cursor = editor.getPosition()
  editor.executeEdits('', [
    {
      range: new Range(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column),
      text: content,
      forceMoveMarkers: true
    }
  ])
  if (focus) {
    editor.focus()
  }
}

/**
 * Insert content after current line
 */
function insertAfter({ content, newLine, focus = true }) {
  const curLine = editor.getPosition().lineNumber
  const lineLength = editor.getModel().getLineContent(curLine).length
  editor.executeEdits('', [
    {
      range: new Range(curLine, lineLength + 1, curLine, lineLength + 1),
      text: newLine ? `\n\n${content}\n` : `\n${content}`,
      forceMoveMarkers: true
    }
  ])
  if (focus) {
    editor.focus()
    editor.revealLineInCenterIfOutsideViewport(editor.getPosition().lineNumber)
  }
}

const TASK_LIST_MARKER_RE = /^(\s*)-\s\[([ xX])\]\s/
const ORDERED_LIST_MARKER_RE = /^(\s*)(\d+)([.)])\s/
const UNORDERED_LIST_MARKER_RE = /^(\s*)([-*+])\s/

function detectListMarker(lineContent) {
  let match = lineContent.match(TASK_LIST_MARKER_RE)
  if (match) {
    return { type: 'task', indent: match[1], markerLength: match[0].length }
  }
  match = lineContent.match(ORDERED_LIST_MARKER_RE)
  if (match) {
    return {
      type: 'ordered',
      indent: match[1],
      markerLength: match[0].length,
      number: Number.parseInt(match[2], 10),
      delimiter: match[3]
    }
  }
  match = lineContent.match(UNORDERED_LIST_MARKER_RE)
  if (match) {
    return { type: 'unordered', indent: match[1], markerLength: match[0].length, bullet: match[2] }
  }
  return null
}

function nextMarkerText(detected) {
  switch (detected.type) {
    case 'task':
      return '- [ ] '
    case 'ordered':
      return `${detected.number + 1}${detected.delimiter} `
    default:
      return `${detected.bullet} `
  }
}

function fallbackToDefaultEnter() {
  editor.trigger('keyboard', 'type', { text: '\n' })
}

function continueList() {
  const selections = editor.getSelections()
  if (selections.length !== 1 || !selections[0].isEmpty()) {
    fallbackToDefaultEnter()
    return
  }

  const selection = selections[0]
  const line = selection.startLineNumber
  const column = selection.startColumn
  const lineContent = editor.getModel().getLineContent(line)
  const detected = detectListMarker(lineContent)

  // -> A regex match doesn't mean the CURSOR is past the marker -- Enter pressed ahead of or
  //    inside the marker itself (e.g. column 1, before the leading whitespace) isn't
  //    continuation. Without this guard the split below would duplicate the marker onto the line
  //    it pushes down, since "text before the cursor" would be empty and "text at/after the
  //    cursor" would be the whole original marker-and-content line.
  if (!detected || column < detected.markerLength + 1) {
    fallbackToDefaultEnter()
    return
  }

  const remainder = lineContent.slice(detected.markerLength)

  if (remainder.length === 0) {
    const lineMaxColumn = editor.getModel().getLineMaxColumn(line)
    editor.executeEdits('wikijs.continueList', [
      { range: new Range(line, 1, line, lineMaxColumn), text: '', forceMoveMarkers: true }
    ])
    return
  }

  const marker = detected.indent + nextMarkerText(detected)
  editor.executeEdits('wikijs.continueList', [
    { range: new Range(line, column, line, column), text: `\n${marker}`, forceMoveMarkers: true }
  ])
}

/**
 * Insert content before current line
 *
 * `before` is a line of its own, put above the first of them — the `> [!NOTE]` that opens an
 * admonition. It rides along in that line's own edit rather than as an insertion of its own, so no
 * two edits in the batch start at the same position.
 */
function insertBeforeEachLine({ content, before, focus = true }) {
  const edits = []
  for (const selection of editor.getSelections()) {
    const lineCount = selection.endLineNumber - selection.startLineNumber + 1
    const lines = Array.from({ length: lineCount }, (_, l) => l + selection.startLineNumber)
    for (const line of lines) {
      let lineContent = editor.getModel().getLineContent(line)
      const lineLength = lineContent.length
      if (lineContent.startsWith(content)) {
        lineContent = lineContent.substring(content.length)
      }
      const opening = before && line === lines[0] ? `${before}\n` : ''
      edits.push({
        range: new Range(line, 1, line, lineLength + 1),
        text: `${opening}${content}${lineContent}`,
        forceMoveMarkers: true
      })
    }
  }

  editor.executeEdits('', edits)

  if (focus) {
    editor.focus()
  }
}

/**
 * Insert an Horizontal Bar
 */
function insertHorizontalBar() {
  insertAfter({ content: '---', newLine: true })
}

/**
 * Pointer-down on the resize divider: begins tracking a drag, VS Code pane-resize style -- live
 * visual tracking on move (`onDividerPointerMove`), committed on release (`onDividerPointerUp`).
 *
 * Pointer capture is what lets a fast drag keep tracking correctly even once the pointer has moved
 * off the (deliberately narrow) divider itself and over the editor or preview pane -- without it,
 * `pointermove` would stop firing on this element the moment the cursor left its few px of width.
 *
 * The direction a growing `clientX` should move the width in is measured fresh from where the
 * divider actually sits relative to the preview pane, rather than assumed from `document.dir` the
 * way `sideToolbarTooltip` above does for a fixed anchor -- a resize divider's physical side of its
 * pane is exactly what a flex-row mirror under `dir="rtl"` swaps, so asking the DOM directly is what
 * keeps this correct in both directions without a parallel branch to keep in sync.
 */
function onDividerPointerDown(ev) {
  if (!previewPaneRef.value || !editorMidRef.value) {
    return
  }
  ev.currentTarget.setPointerCapture(ev.pointerId)
  const previewRect = previewPaneRef.value.getBoundingClientRect()
  const midRect = editorMidRef.value.getBoundingClientRect()
  const dividerRect = ev.currentTarget.getBoundingClientRect()

  dragStartX = ev.clientX
  previousPreviewWidth = state.previewWidth
  dragStartWidthPx = state.previewWidth ?? previewRect.width
  dragSign = previewRect.left < dividerRect.left ? 1 : -1
  /*
    Both panes' current widths, combined, are exactly the space the two of them have to split between
    them -- independent of the sidebar or the viewport, and stable for the length of one drag (the
    window is not expected to be resized mid-drag).
  */
  dragMaxWidthPx = Math.max(
    PREVIEW_HIDE_THRESHOLD_PX,
    midRect.width + previewRect.width - EDITOR_MIN_WIDTH_PX
  )
  isDragging.value = true
}

/** Live drag tracking: applies the new width immediately, clamped to this drag's own bounds. */
function onDividerPointerMove(ev) {
  if (!isDragging.value) {
    return
  }
  const delta = (ev.clientX - dragStartX) * dragSign
  state.previewWidth = Math.min(Math.max(dragStartWidthPx + delta, 0), dragMaxWidthPx)
}

/**
 * Pointer-up (or -cancel): commits the drag.
 *
 * A release at or above the hide threshold persists the new width. A release below it hands off to
 * the existing hidden state (the same `previewShown = false` the toolbar's own hide button sets)
 * instead of leaving an awkward sliver, restoring `previewWidth` to the width the pane actually had
 * before this drag (`previousPreviewWidth`) rather than leaving it at the small in-drag value --
 * otherwise the close animation would shrink from that sliver instead of the pane's real size.
 *
 * That restore is written to the DOM directly, synchronously, in the same turn as flipping
 * `previewShown` -- not through the reactive `state.previewWidth` binding a moment earlier, and not
 * deferred to after the close transition (`@after-leave`) the way this used to work. Two things rule
 * those out:
 *
 * - Writing `state.previewWidth` here and letting Vue's own render pick it up does nothing for the
 *   *leaving* element: once `previewShown` is false in the same update, the pane's `v-if` branch is
 *   absent from the new vnode tree, so Vue never re-patches its style from the new state -- it just
 *   tears down the DOM node as last rendered (still at the small in-drag width). Deferring the
 *   restore to `@after-leave` used to work around exactly that, at the cost of the underlying value
 *   staying wrong, invisibly, for the whole close animation.
 * - Splitting the restore into its own render first (e.g. an `await nextTick()` before the flip)
 *   would let Vue patch the big width onto the still-open pane, but does not guarantee no paint lands
 *   between that patch and the leave starting -- which would show the exact pop-then-shut this snap
 *   exists to avoid: a static hold at the full width before it starts shrinking.
 *
 * Setting the inline style imperatively and flipping `previewShown` in the same synchronous call
 * sidesteps both: the DOM already reflects the real width by the time Vue's `<transition>` captures
 * its leave-active starting point, with no intervening render for the browser to paint.
 */
function onDividerPointerUp() {
  if (!isDragging.value) {
    return
  }
  isDragging.value = false
  if (state.previewWidth < PREVIEW_HIDE_THRESHOLD_PX) {
    if (previewPaneRef.value && typeof previousPreviewWidth === 'number') {
      previewPaneRef.value.style.setProperty('--preview-width', `${previousPreviewWidth}px`)
      previewPaneRef.value.style.flex = `0 0 ${previousPreviewWidth}px`
    }
    state.previewWidth = previousPreviewWidth
    state.previewShown = false
  } else {
    persistPreviewWidth(state.previewWidth)
  }
}

/**
 * Saves this user's chosen preview width the same way `EditorMarkdownUserSettingsOverlay` saves font
 * size and preview-shown -- a full replace of `users/profile/editor-settings/markdown` (see that
 * overlay's `save()`).
 *
 * The merge base is `editorStore.userSettings.markdown`, not this component's own live `previewShown`
 * / font size: those are session-only here (this component never saves either on its own, only the
 * settings overlay's explicit Save does), so writing them out from this path would start silently
 * persisting a toggle the user never asked to persist. `fetchUserSettings` populates the store field
 * on mount, and the settings overlay patches it too on its own successful save, so either order --
 * drag then open settings, or open settings then drag -- reads the other's latest write rather than
 * stomping it.
 */
async function persistPreviewWidth(px) {
  const payload = { ...editorStore.userSettings.markdown, previewWidth: px }
  try {
    const resp = await API_CLIENT.put('users/profile/editor-settings/markdown', {
      json: payload
    }).json()
    if (resp?.ok) {
      editorStore.$patch({
        userSettings: { ...editorStore.userSettings, markdown: payload }
      })
    }
  } catch (err) {
    console.warn(`Could not save the Markdown editor's preview width: ${err.message}`)
  }
}

/**
 * Toggle Markup at selection
 */
async function toggleMarkup({ start, end }) {
  if (!end) {
    end = start
  }
  if (!editor.getSelection()) {
    return notify({
      type: 'negative',
      message: t('editor.markup.noSelectionError')
    })
  }

  const edits = []
  // -> Cursor position to land on after the edit, one per null-word edit below (OpenProject #800).
  //    Parallel to `edits` only in that both grow together; passed to `executeEdits` as-is only
  //    when every edit in this call needed one, so a mixed multi-cursor batch (some selections
  //    landing on a real word, others not) falls back to Monaco's own default cursor placement
  //    rather than silently dropping the cursors this array doesn't know about.
  const cursors = []

  for (const selection of editor.getSelections()) {
    const selectedText = editor.getModel().getValueInRange(selection)
    if (!selectedText) {
      const wordObj = editor.getModel().getWordAtPosition(selection.getPosition())
      const { text, atCursor } = resolveWordMarkup({ start, end, word: wordObj?.word ?? null })
      if (atCursor) {
        // No word under the cursor -- empty line/document, or adjacent to non-word markup with
        // nothing inside it. Insert the empty markers at the cursor and land the caret between
        // them, so the author can type straight into them instead of hitting a TypeError.
        const cursorRange = new Range(
          selection.startLineNumber,
          selection.startColumn,
          selection.endLineNumber,
          selection.endColumn
        )
        edits.push({ range: cursorRange, text })
        cursors.push(
          new monaco.Selection(
            selection.startLineNumber,
            selection.startColumn + start.length,
            selection.startLineNumber,
            selection.startColumn + start.length
          )
        )
      } else {
        const wordRange = new Range(
          selection.startLineNumber,
          wordObj.startColumn,
          selection.endLineNumber,
          wordObj.endColumn
        )
        edits.push({ range: wordRange, text })
      }
    } else if (selectedText.startsWith(start) && selectedText.endsWith(end)) {
      edits.push({
        range: selection,
        text: selectedText.substring(start.length, selectedText.length - end.length)
      })
    } else {
      edits.push({ range: selection, text: `${start}${selectedText}${end}` })
    }
  }

  editor.executeEdits('', edits, cursors.length === edits.length ? cursors : undefined)
}

/**
 * Read the blocks this site has, once, before the first preview is drawn.
 *
 * Order matters more than it looks: a component only has to be fetched once to be defined for the
 * rest of the session, so a list that arrives after the first render is too late to keep a disabled
 * block from drawing. The lens over a block wants the same list a moment later, and asking twice for
 * it would be asking the same question twice.
 */
async function loadSiteBlocks() {
  try {
    siteBlocks = (await API_CLIENT.get(`sites/${siteStore.id}/blocks`).json()) ?? []
    disabledBlockTags.value = new Set(
      siteBlocks.filter((block) => !block.isEnabled).map((block) => `block-${block.block}`)
    )
  } catch (err) {
    /*
      Left empty, which draws everything as it did before. The preview being too generous is the
      better failure: the server strips a disabled block on save either way, so the cost is a preview
      that flatters the page, against hiding blocks the site really does have. The lens is the other
      way round — with no definitions to build a form from, it simply does not appear.
    */
    console.warn(`Could not read which blocks this site has enabled: ${err.message}`)
  }
}

/**
 * Say why a block is sitting there doing nothing.
 *
 * A disabled block is left undefined, so it draws as its own contents and otherwise says nothing —
 * which reads as a block that is broken rather than one that is switched off. The notice names the
 * reason and what saving will do about it; what the author wrote stays underneath, because that is
 * what the saved page keeps once the server has stripped the element.
 *
 * Written into the preview's DOM rather than into the render, which is deliberate: `pageStore.render`
 * is what `pageSave` sends, and a notice added to it would be a notice saved into the page. The
 * preview is rebuilt from that string on every keystroke, so this is re-applied each time and nothing
 * has to be cleaned up — the same footing `enhanceRenderedContent` works on.
 */
function markDisabledBlock(el) {
  if (el.dataset.blockDisabled !== undefined) {
    return
  }
  el.dataset.blockDisabled = ''
  const notice = document.createElement('p')
  notice.className = 'block-disabled-notice'
  notice.textContent = t('editor.blockNotEnabled')
  el.prepend(notice)
}

/**
 * Open the tabset panel the caret is in.
 *
 * Which is the useful answer, and a different question from "which panel was open before": an author
 * writing inside the second panel of a tabset is telling us plainly which one they are looking at. The
 * source line is matched against the panel ranges of the same parse that built the preview -- see
 * `getTabAtLine` -- and the panel is opened through the block's own `active` property.
 *
 * Silent about everything it does not find: a caret outside every tabset leaves them all as they were,
 * and so does a render that has not landed yet.
 */
function syncPreviewTabs() {
  const container = editorPreviewContainerRef.value
  if (!container) {
    return
  }
  const at = md.getTabAtLine(editor.getPosition().lineNumber)
  if (!at) {
    return
  }
  const tabset = container.querySelectorAll('block-tabs')[at.tabset]
  if (tabset) {
    tabset.active = at.tab
  }
}

function processContent(newContent) {
  /*
    A render that throws must not become a render that is empty.

    `pageSave` sends whatever is in the store, and the server replaces the stored HTML with it -- so
    patching a failed render in blanks the published page, and patching nothing keeps the last good
    one. Loud rather than silent, because the preview is then showing something other than the source.
  */
  let html
  try {
    // -> The page's own path, because a relative image in the source is relative to the folder it
    //    sits in -- and it is being edited, so it is whatever the path field says right now
    html = md.render(newContent, { pagePath: pageStore.path })
  } catch (err) {
    console.error(err)
    notify({
      type: 'negative',
      message: t('editor.renderFailed'),
      caption: err.message
    })
    return
  }

  const container = editorPreviewContainerRef.value
  /*
    Two things about the preview have to survive the patch, because `v-html` does not patch anything --
    it throws every child away and builds them again, on every keystroke.

    Where the reader had scrolled to is the first. An emptied box has nowhere to be scrolled to, so its
    `scrollTop` is clamped to zero; the cursor handler then animated back down from the top of the
    document to the line being typed, over and over, which is what made the preview appear to fly about
    while typing in a long page.

    Which tab is open is the second. A block is a custom element with state of its own, and a rebuilt one
    starts again from its defaults -- so typing in the second panel of a tabset kept throwing the author
    back to the first. Carried across by position: the source order of the blocks is what survives an
    edit, not the elements. See `active` in `blocks/block-tabs`.
  */
  const scrollTop = container?.scrollTop ?? 0
  const openTabs = [...(container?.querySelectorAll('block-tabs') ?? [])].map(
    (el) => el.active ?? 0
  )

  pageStore.$patch({
    render: html
  })
  nextTick(async () => {
    // -> With the preview pane closed there is no DOM to attend to. The render is stored either way, so
    //    the store still holds what a save would send
    if (!container) {
      return
    }
    const tabsets = [...container.querySelectorAll('block-tabs')]
    for (const [index, el] of tabsets.entries()) {
      // -> Left alone when it is the default anyway, so nothing is set on a block that never had a state
      if (openTabs[index]) {
        el.active = openTabs[index]
      }
    }
    // -> After the carry-across, so that the tabset being written in wins over what it had open before
    syncPreviewTabs()
    /*
      The panels have to be settled BEFORE the position goes back, and that means waiting for them: a
      block applies its open panel on its own update, a microtask later.

      Restoring first is restoring against a layout that is about to change, and the change is the height
      of a whole panel. With a rebuilt tabset showing its first panel, a position inside a taller one is
      past the end of a shorter document, so the browser clamps it -- and then scroll anchoring hands back
      a different position again as the real panel opens. Measured at 800px of drift on a short-first,
      tall-second tabset, which the caret sync then animated back from on every keystroke.
    */
    await Promise.all(tabsets.map((el) => el.updateComplete ?? Promise.resolve()))
    container.scrollTop = scrollTop
    // -> Keyed on the tag, so a repeat of the same element in the preview is only resolved once. The
    //    value carries `isCustom`/`id` off `siteBlocks` when the tag matches a block this site has --
    //    what `loadBlocks()` needs to tell a custom block's per-site import URL from a built-in's flat
    //    one. A tag that matches nothing there (an unknown element, or the list not having loaded yet)
    //    is passed as the bare string, which `loadBlocks()` treats as a built-in guess -- the same
    //    generous-preview fallback `loadSiteBlocks()` above already documents.
    const pendingBlocks = new Map()
    for (const block of container.querySelectorAll(':not(:defined)')) {
      const tag = block.tagName.toLowerCase()
      // -> Left undefined on purpose, so the preview shows what saving is about to leave behind
      if (disabledBlockTags.value.has(tag)) {
        markDisabledBlock(block)
        continue
      }
      if (!pendingBlocks.has(tag)) {
        const record = siteBlocks.find((b) => b.elementTag === tag)
        pendingBlocks.set(tag, record ? { tag, isCustom: record.isCustom, id: record.id } : tag)
      }
    }
    if (pendingBlocks.size > 0) {
      /*
        Asked again once the definitions land. A block that has not been upgraded yet is a plain unknown
        element: setting `active` on it puts a value somewhere Lit will pick up, but nothing has read the
        panels or hidden any of them, so the tab the author is in is only actually opened here -- on the
        first render of a page whose blocks are being fetched for the first time.
      */
      commonStore.loadBlocks([...pendingBlocks.values()]).then(syncPreviewTabs)
    }
    // -> The render was just replaced, so the copy buttons went with it
    enhanceRenderedContent(container, t)
  })
}

/**
 * Take files the author brought in — pasted or dropped — and write markdown for them at the cursor.
 *
 * Nothing is uploaded here. Each one becomes a pending asset held against a `blob:` URL that the
 * markdown points at, and `UploadPendingAssetsDialog` sends them on save and rewrites those URLs to
 * wherever they actually landed. So the editor shows the image immediately and the page never stores a
 * blob URL.
 *
 * An image goes in as one, anything else as a link with its file name for text — a dropped PDF is a
 * link to a PDF, not a broken picture. The name is the image's alt text as well, which is both what the
 * handler this replaces did and better than nothing for a reader who cannot see it.
 *
 * `generateUniqueName` is passed straight through to `editorStore.addPendingAsset` -- see its own doc
 * comment (OpenProject #806 follow-up). Only the paste call site below sets it: every browser names a
 * clipboard-pasted file "image.png" regardless of source, where a dropped file's name is real user
 * intent worth keeping.
 */
function insertFilesAsAssets(files, { generateUniqueName = false } = {}) {
  const markup = files.map((file) => {
    const blobUrl = editorStore.addPendingAsset(file, { generateUniqueName })
    return `${file.type.startsWith('image/') ? '!' : ''}[${file.name}](${blobUrl})`
  })
  // -> One per line: two images on the same line is rarely what was meant by dropping two files
  insertAtCursor({ content: markup.join('\n') })
}

/*
  Pasting a file inserts it; pasting anything else is left alone. See `shouldClaimPaste` for the
  text-wins-over-an-accompanying-image decision -- pulled out to `helpers/editorFileTransfer.js` so it
  is unit-testable without a real clipboard event.
*/
function onEditorPaste(event) {
  if (!shouldClaimPaste(event.clipboardData)) {
    return
  }
  /*
    Taken over completely. `stopPropagation` as well as `preventDefault`, because this runs in capture
    ABOVE the editor: letting it travel on would hand the same files to Monaco's paste-as feature, which
    would answer the paste a second time in its own way.
  */
  event.preventDefault()
  event.stopPropagation()
  insertFilesAsAssets([...event.clipboardData.files], { generateUniqueName: true })
}

/*
  A drop has to be claimed twice: `dragover` is what tells the browser this is a valid target -- without
  it there is no drop at all, just the browser navigating away to the file -- and `drop` is where it
  arrives. See `shouldAcceptDrag` for why this cannot just check `hasFiles`.
*/
function onEditorDragOver(event) {
  if (!shouldAcceptDrag(event.dataTransfer)) {
    return
  }
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
}

function onEditorDrop(event) {
  if (!hasFiles(event.dataTransfer)) {
    return
  }
  event.preventDefault()
  // -> Dropped text lands where it was dropped, and so should a file: the cursor moves to meet it
  const target = editor.getTargetAtClientPoint(event.clientX, event.clientY)
  if (target?.position) {
    editor.setPosition(target.position)
  }
  insertFilesAsAssets([...event.dataTransfer.files])
}

/**
 * Rewrite text that was already in the editor — the blob URLs of pending assets, once the upload has
 * given them real paths.
 *
 * Done as targeted edits rather than by putting the whole page back with `setValue`. Replacing the
 * model wholesale reads as "everything was deleted and everything was typed again", which throws away
 * the undo history and the caret, and in a collaborative session would land on everyone else as
 * exactly that — their own unsaved sentences deleted and retyped by someone who only uploaded an
 * image.
 */
function reloadEditorContent({ replacements = [] } = {}) {
  const model = editor.getModel()
  const edits = []
  for (const { from, to } of replacements) {
    // -> Literal, case-sensitive, whole-string matching: these are URLs, not patterns
    for (const match of model.findMatches(from, false, false, true, null, false)) {
      edits.push({ range: match.range, text: to })
    }
  }
  if (edits.length > 0) {
    editor.executeEdits('assets', edits)
  }
}

/**
 * Copy the editor's current text into the store right now, rather than on the usual 500ms debounce.
 *
 * Shared by the change handler below, on every debounced edit, and by `editorStore.contentFlusher`,
 * which `pageSave()` calls synchronously before it reads `content` -- see the call site there for why
 * a save can otherwise land inside that debounce window. Deliberately leaves `contentLoaded` and
 * `lastChangeTimestamp` alone: those describe an actual edit having happened, which is true every time
 * the change handler below calls this, but is not true of a save that runs this on a page nobody has
 * touched since it loaded -- `pageSave()`'s own guard is what a wrongly-forced `contentLoaded` would
 * defeat.
 */
function flushEditorContent() {
  const value = editor.getValue()
  pageStore.content = value
  processContent(value)
}

/**
 * Puts up the resolution dialog once `pageSave()` has flagged a save the server refused because
 * somebody else saved first (`editorStore.saveConflict`, the page snapshot the 409 came back with --
 * see `stores/page.js`).
 *
 * Offers two ways out: adopt the server's version wholesale, or re-issue the save with the server's
 * `updatedAt` as the new baseline -- an informed overwrite, now that this author has been told there
 * was something to overwrite, rather than the blind one `expectedUpdatedAt` exists to prevent.
 *
 * Either choice recovers this author's edit one way or another -- discard adopts the server's content
 * in its place, overwrite forces this author's own content through as the new version -- so a 409
 * is never a dead end (OpenProject #838, upstream requarks/wiki #2256). Nothing here is lost if the
 * overwrite's own `pageSave()` hits a second conflict, either: the 409 handler in `stores/page.js`
 * sets `editorStore.saveConflict` again, which re-triggers the `watch` below and puts this same
 * dialog back up with the newer snapshot -- the editor's content itself is never touched by a
 * refusal, only ever replaced by an explicit "Discard" choice.
 *
 * A "Discard" choice is itself still recoverable (OpenProject #2073): the author's pending content is
 * stashed in `editorStore.discardedContent` right before it is overwritten, and the toast that
 * follows offers it straight back via `undoDiscard()` below.
 */
function resolveSaveConflict(snapshot) {
  dialog({
    component: defineAsyncComponent(() => import('./PageSaveConflictDialog.vue')),
    componentProps: { authorName: snapshot.authorName }
  })
    .onOk(async (action) => {
      if (action === 'discard') {
        editorStore.stashDiscardedContent(pageStore.content)
        pageStore.$patch({
          title: snapshot.title,
          content: snapshot.content,
          contentLoaded: true,
          updatedAt: snapshot.updatedAt
        })
        editor.setValue(snapshot.content)
        processContent(pageStore.content)
        // -> Adopting the server's copy leaves nothing of this author's pending; see `hasPendingChanges`
        const now = Temporal.Now.instant()
        editorStore.$patch({ lastChangeTimestamp: now, lastSaveTimestamp: now })
        notify({
          type: 'warning',
          message: t('editor.collab.saveConflict.discarded'),
          // -> Longer than the 5s default: this toast is the only remaining route back to the
          //    author's discarded text, so it should still be there a moment after a quick glance.
          timeout: 10000,
          action: {
            label: t('editor.collab.saveConflict.undoDiscard'),
            onClick: undoDiscard
          }
        })
      } else if (action === 'overwrite') {
        pageStore.updatedAt = snapshot.updatedAt
        try {
          await pageStore.pageSave()
          notify({
            type: 'positive',
            message: t('editor.collab.saveConflict.saveSuccess')
          })
        } catch (err) {
          notify({
            type: 'negative',
            message: t('editor.collab.saveConflict.saveFailed'),
            caption: err.message
          })
        }
      }
    })
    .onDismiss(() => {
      editorStore.saveConflict = null
    })
}

/**
 * Restores the author's own content after a save-conflict "Discard" replaced it with the server's
 * snapshot -- the undo action offered on the toast `resolveSaveConflict` raises right after
 * (OpenProject #2073). Puts the stashed copy back into `pageStore.content` and the live Monaco model
 * the same way discard itself does (`editor.setValue`), then clears the stash so a stray second
 * click -- the toast is already gone by then, but nothing stops calling this directly -- has nothing
 * left to restore.
 */
function undoDiscard() {
  const content = editorStore.discardedContent
  if (content === null) {
    return
  }
  pageStore.$patch({ content, contentLoaded: true })
  editor.setValue(content)
  processContent(content)
  editorStore.clearDiscardedContent()
}

watch(
  () => editorStore.saveConflict,
  (snapshot) => {
    if (snapshot) {
      resolveSaveConflict(snapshot)
    }
  }
)

// MOUNTED

onMounted(async () => {
  // -> Setup Editor View
  editorStore.$patch({
    hideSideNav: true
  })

  /*
    This user's saved Markdown editor preferences -- font size, whether the preview pane opens, and its
    saved width -- read before Monaco is created so all three apply from the first paint. Normally
    already sitting in the store by now: `App.vue`'s boot flow prefetches them in the background as
    soon as the session starts, well ahead of any "Edit" click, specifically so the preview's entrance
    transition below can start in step with the side nav's own close animation instead of both waiting
    on a network round trip neither has any real reason to share a deadline with. Only actually fetched
    here as a fallback for whoever beats that prefetch -- a guest who just signed in, or simply a click
    fast enough to win the race -- so this mount never depends on the prefetch having finished. A user
    who has never saved any preference (or a request that fails) resolves to an empty object, which
    `resolveEditorFontSize` / `resolveInitialPreviewShown` / `resolveInitialPreviewWidth` all treat as
    "no preference", not as an error to surface.

    Run alongside `loadSiteBlocks()` below rather than after it -- awaiting the two in sequence, as
    before, just adds their times together for no reason; neither depends on the other's result, and
    `loadSiteBlocks()` still finishes well before the first preview render at the end of this hook.
  */
  const userSettingsPromise =
    editorStore.userSettings.markdown !== undefined
      ? Promise.resolve(editorStore.userSettings.markdown)
      : editorStore.fetchUserSettings('markdown').catch((err) => {
          console.warn(`Could not read Markdown editor settings: ${err.message}`)
          return {}
        })

  const [, userSettings = {}] = await Promise.all([loadSiteBlocks(), userSettingsPromise])

  state.previewShown = resolveInitialPreviewShown(userSettings, isAtLeastMd.value)
  /*
    Clamped against the viewport right here rather than left to `previewInlineStyle`'s own bounds:
    that computed only ever withholds the whole custom width below `md`, it does not shrink an
    oversized one back down to fit a narrower-but-still-`md` window (e.g. a width saved on a wide
    monitor, reopened on a 1024px one). `EDITOR_MIN_WIDTH_PX` is subtracted the same way the drag's
    own live clamp does it (`onDividerPointerDown`), just against the viewport instead of the two
    panes' measured widths -- nothing to measure yet this early in the mount.
  */
  const resolvedWidth = resolveInitialPreviewWidth(userSettings)
  state.previewWidth =
    resolvedWidth === null
      ? null
      : Math.min(
          resolvedWidth,
          Math.max(PREVIEW_HIDE_THRESHOLD_PX, window.innerWidth - EDITOR_MIN_WIDTH_PX)
        )
  /*
    Left `false` through this render, so the `previewShown` flip just above -- the pane's one and only
    entrance this mount, if it opens at all -- is still the fast `-initial` transition (see the ref's
    own doc comment) when Vue processes it. `nextTick` is what lands this AFTER that, not before: it
    resolves once the DOM update from the current synchronous batch is done, which is what keeps a
    later, unrelated toggle-button click (a wholly separate reactive flush) from ever racing this into
    reading `true` early and picking the wrong transition for the entrance itself.
  */
  nextTick(() => {
    previewEverRevealed.value = true
  })

  md = new MarkdownRenderer(editorStore.editors.markdown)

  // -> Define Monaco Theme
  monaco.editor.defineTheme('wikijs', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#070a0d',
      'editor.lineHighlightBackground': '#0d1117',
      'editorLineNumber.foreground': '#546e7a',
      'editorGutter.background': '#0d1117'
    }
  })

  // Allow `*` in word pattern for quick styling (toggle bold/italic without selection)
  // original https://github.com/microsoft/vscode/blob/3e5c7e2c570a729e664253baceaf443b69e82da6/extensions/markdown-basics/language-configuration.json#L55
  monaco.languages.setLanguageConfiguration('markdown', {
    wordPattern:
      /([*_]{1,2}|~~|`+)?[\p{Alphabetic}\p{Number}\p{Nonspacing_Mark}]+(_+[\p{Alphabetic}\p{Number}\p{Nonspacing_Mark}]+)*\1/gu
  })

  // -> Initialize Monaco Editor
  editor = monaco.editor.create(monacoRef.value, {
    automaticLayout: true,
    cursorBlinking: 'blink',
    // cursorSmoothCaretAnimation: true,
    fontSize: resolveEditorFontSize(userSettings),
    formatOnType: true,
    language: 'markdown',
    lineNumbersMinChars: 4,
    padding: { top: 10, bottom: 10 },
    scrollBeyondLastLine: false,
    tabSize: 2,
    theme: 'wikijs',
    value: pageStore.content,
    wordWrap: 'on'
  })

  /*
    "Edit Table" over every table in the page, which opens the table editor on that table.

    A code lens rather than a context-menu action: the offer has to be visible to be found, and a table
    in markdown source is exactly the thing an author does not want to edit by hand. It appears only over
    the tables the overlay can actually hold -- `findEditableTables` says which -- because offering it
    over a table with a multi-line cell or a rowspan would be offering to flatten it.

    The command is registered on this editor rather than globally (`monaco.editor.registerCommand`),
    which is what gives `editor.addCommand` an id to hand the lens. The PROVIDER is per-language and
    process-wide, so it has to be disposed with the component or a second visit to the editor would draw
    every lens twice.
  */
  const editTableCommand = editor.addCommand(0, (_accessor, line) => editTable(line))
  tableLensProvider = monaco.languages.registerCodeLensProvider('markdown', {
    provideCodeLenses(model) {
      return {
        lenses: findEditableTables(model.getValue()).map((table) => ({
          range: new Range(table.startLine, 1, table.startLine, 1),
          command: {
            id: editTableCommand,
            title: t('editor.markup.editTable'),
            arguments: [table.startLine]
          }
        })),
        dispose() {}
      }
    }
  })

  /*
    "Edit Block Parameters" over every block in the page, for the same reason the table has one: what
    a block was given is a list of quoted attributes on one line, which is a poor thing to edit by
    hand and an easy thing to offer a form for.

    It appears only over a block this editor holds a definition for and that has something to fill in.
    A child block -- a `::block-tab` inside a tabset -- is one it never does: those are left out of
    the list the API answers with, having no switch of their own to be listed against.
  */
  const editBlockCommand = editor.addCommand(0, (_accessor, line, block) => editBlock(line, block))
  blockLensProvider = monaco.languages.registerCodeLensProvider('markdown', {
    provideCodeLenses(model) {
      return {
        lenses: findBlocks(model.getValue())
          .filter((found) => hasEditableParams(blockDefinition(found.block)))
          .map((found) => ({
            range: new Range(found.line, 1, found.line, 1),
            command: {
              id: editBlockCommand,
              title: t('editor.markup.editBlock'),
              arguments: [found.line, found.block]
            }
          })),
        dispose() {}
      }
    }
  })

  // -> Define Formatting Actions
  editor.addAction({
    contextMenuGroupId: 'markdown.extension.editing',
    contextMenuOrder: 0,
    id: 'markdown.extension.editing.toggleBold',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB],
    label: 'Toggle bold',
    precondition: '',
    run(ed) {
      toggleMarkup({ start: '**' })
    }
  })

  editor.addAction({
    contextMenuGroupId: 'markdown.extension.editing',
    contextMenuOrder: 0,
    id: 'markdown.extension.editing.toggleItalic',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
    label: 'Toggle italic',
    precondition: '',
    run(ed) {
      toggleMarkup({ start: '*' })
    }
  })

  editor.addAction({
    id: 'markdown.extension.editing.increaseHeaderLevel',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.RightArrow],
    label: 'Increase Header Level',
    precondition: '',
    run(ed) {
      let lvl = getHeaderLevel()
      if (lvl >= 6) {
        lvl = 5
      }
      setHeaderLine(lvl + 1)
    }
  })
  editor.addAction({
    id: 'markdown.extension.editing.decreaseHeaderLevel',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow],
    label: 'Decrease Header Level',
    precondition: '',
    run(ed) {
      let lvl = getHeaderLevel()
      if (lvl <= 1) {
        lvl = 2
      }
      setHeaderLine(lvl - 1)
    }
  })

  editor.addAction({
    id: 'markdown.extension.editing.continueList',
    keybindings: [monaco.KeyCode.Enter],
    label: 'Continue List',
    precondition: 'editorTextFocus && !suggestWidgetVisible && !renameInputVisible',
    run(ed) {
      continueList()
    }
  })

  editor.addAction({
    id: 'save',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
    label: 'Save',
    precondition: '',
    run(ed) {}
  })

  // -> Handle content change
  debouncedContentChange = debounce((ev) => {
    editorStore.$patch({
      lastChangeTimestamp: Temporal.Now.instant()
    })
    // -> What the author has typed IS the source, whatever the load did or did not deliver; see
    //    the guard in `pageSave`
    pageStore.contentLoaded = true
    flushEditorContent()
  }, 500)
  editor.onDidChangeModelContent(debouncedContentChange)

  // -> Handle cursor movement
  debouncedCursorPositionChange = debounce((ev) => {
    if (!state.previewScrollSync || !state.previewShown) {
      return
    }
    // -> Moving the caret into another panel opens it, the same as typing in one does
    syncPreviewTabs()
    const currentLine = editor.getPosition().lineNumber
    if (currentLine < 3) {
      editorPreviewContainerRef.value.scrollTo({ top: 0, behavior: 'smooth' })
    } else {
      const exactEl = editorPreviewContainerRef.value.querySelector(`[data-line='${currentLine}']`)
      if (exactEl) {
        exactEl.scrollIntoView(SYNC_SCROLL)
      } else {
        const closestLine = md.getClosestPreviewLine(currentLine)
        if (closestLine) {
          const closestEl = editorPreviewContainerRef.value.querySelector(
            `[data-line='${closestLine}']`
          )
          if (closestEl) {
            closestEl.scrollIntoView(SYNC_SCROLL)
          }
        }
      }
    }
  }, 500)
  editor.onDidChangeCursorPosition(debouncedCursorPositionChange)

  /*
    Files arriving by paste or by drop.

    Paste is CAPTURED on the element above the editor, and that is the whole trick. Monaco's own
    paste-as feature (`CopyPasteController`) listens in the capture phase on the editor's container and
    calls `stopImmediatePropagation()` for every paste it claims -- which includes any paste carrying
    files. A listener on that container or below it, in either phase, is simply never reached. Capture
    runs outside-in, so one level up goes first and can decide before Monaco sees it.

    The drop half replaces a listener that could not fire either, for a different reason: without
    `dragover` claiming the target, the browser treats a file dropped on a page as a navigation and
    opens it, and the drop event never reaches anything here.
  */
  pasteCaptureNode = monacoRef.value.parentElement ?? monacoRef.value
  pasteCaptureNode.addEventListener('paste', onEditorPaste, true)
  monacoRef.value.addEventListener('dragover', onEditorDragOver)
  monacoRef.value.addEventListener('drop', onEditorDrop)

  // -> Live collaboration

  if (collabEnabled.value) {
    /*
      "Someone else already has this open" -- said once, before the collab session below has even
      asked to connect. `pageStore.activeEditors` came with the page itself (`viewer.activeEditors` on
      `GET .../pages/:id`, task 546), read off whatever room `core/collab.ts` already has for it on
      this instance -- so this can be shown immediately, without waiting on a socket.
    */
    if (pageStore.activeEditors.count > 0) {
      notify({
        type: 'info',
        message: t('editor.collab.activeEditors', pageStore.activeEditors.count, {
          count: pageStore.activeEditors.count
        })
      })
    }

    /*
      Read-only until the shared document has arrived, and only that first time.

      The binding below starts by making the editor say what the document says, so anything typed
      before it exists is about to be overwritten -- by an empty document, if the sync has not landed
      yet. The session gives up after a few seconds (a proxy that does not forward websocket upgrades
      is the usual reason) and the editor is released as an ordinary one, so this cannot strand an
      author in a page they are unable to type in.
    */
    editor.updateOptions({ readOnly: true })
    startCollabSession({ siteId: siteStore.id, pageId: pageStore.id })

    stopCollabStatusWatch = watch(
      () => collabStore.status,
      (status) => {
        const effects = collabStatusEffects(status, collabStore.hasSynced)
        if (effects.shouldBindEditor) {
          bindCollabEditor((ytext, awareness) => {
            const model = editor.getModel()
            if (!model) {
              return null
            }
            return new MonacoBinding(ytext, model, new Set([editor]), awareness)
          })
        }
        editor.updateOptions({ readOnly: effects.readOnly })
        if (effects.notifyDenied) {
          notify({
            type: 'warning',
            message: t('editor.collab.notAllowed')
          })
        }
      }
    )

    /*
      Somebody else saved the page. The editor state has already been put back to "nothing pending" by
      the session -- this is only so that the author is told why their Save button went quiet.
    */
    stopCollabLastSaveWatch = watch(
      () => collabStore.lastSave,
      (lastSave) => {
        if (lastSave && lastSave.authorId !== userStore.id) {
          notify({
            type: 'positive',
            message: t('editor.collab.savedBy', { name: lastSave.authorName })
          })
        }
      }
    )
  }

  // -> Post init

  editor.focus()

  nextTick(() => {
    processContent(pageStore.content)
  })

  EVENT_BUS.on('insertAsset', insertAssetClb)
  EVENT_BUS.on('insertTable', insertTableClb)
  EVENT_BUS.on('insertBlock', insertBlockClb)
  EVENT_BUS.on('reloadEditorContent', reloadEditorContent)

  // -> See `flushEditorContent` and `pageSave()` in `stores/page.js` for why this exists
  editorStore.contentFlusher = flushEditorContent
})

onBeforeUnmount(() => {
  EVENT_BUS.off('insertAsset', insertAssetClb)
  EVENT_BUS.off('insertTable', insertTableClb)
  EVENT_BUS.off('insertBlock', insertBlockClb)
  EVENT_BUS.off('reloadEditorContent', reloadEditorContent)
  pasteCaptureNode?.removeEventListener('paste', onEditorPaste, true)
  monacoRef.value?.removeEventListener('dragover', onEditorDragOver)
  monacoRef.value?.removeEventListener('drop', onEditorDrop)
  // -> Only clear it if it is still this instance's -- guards against a second mount's registration
  //    being torn down by the first's unmount in whatever order they settle in
  if (editorStore.contentFlusher === flushEditorContent) {
    editorStore.contentFlusher = null
  }
  // -> Registered against the markdown language, not this editor, so nothing else takes it down
  tableLensProvider?.dispose()
  blockLensProvider?.dispose()
  // -> A pending debounced call left uncancelled fires ~500ms after unmount, against an editor that
  //    `dispose()` (below) has already torn down -- `editor.getPosition()` on a disposed instance
  //    returns `null`, and the cursor handler crashed reading `.lineNumber` off it (OpenProject #808).
  debouncedContentChange?.cancel()
  debouncedCursorPositionChange?.cancel()
  clearTimeout(insertAssetFocusTimeout)
  // -> Stopped before `stopCollabSession()` below patches `collabStore.status` to `off` -- these were
  //    started after `onMounted`'s first `await` so Vue never auto-bound them to this component's
  //    effect scope, and left running they fire past unmount against a disposed editor (OpenProject
  //    #942).
  stopCollabStatusWatch?.()
  stopCollabLastSaveWatch?.()
  // -> Before the editor goes: the binding is holding the model, and leaving the room is what takes
  //    this author's avatar out of everyone else's header
  stopCollabSession()
  if (editor) {
    editor.dispose()
  }
})
</script>

<style lang="scss">
@use 'sass:color';

.editor-markdown {
  /*
    Percentage heights all the way down rather than a viewport calc (`100vh` minus every fixed-height
    bar above this one), which is what this used to be and had to grow a new hardcoded term -- and get
    it exactly right -- every time a bar was added or resized above it (most recently the breadcrumb
    bar staying mounted through editing, OpenProject #813). `Index.vue`'s `.page-container` already
    hands its row a definite height via `items-stretch`, which is what lets the reading column's own
    scroll area just say `height: 100%` (`w-scroll-area class="page-container-scrl" style="height:
    100%"`) -- this is the editor doing the same thing, so it inherits whatever is above it instead of
    restating it.
  */
  height: 100%;
  min-height: 0;

  /*
    While the divider is being dragged (`isDragging`, see `onDividerPointerDown`/`onDividerPointerUp`).
    Pointer capture already keeps the drag tracking correctly once the pointer leaves the divider's
    own few px -- this is only about what the pointer LOOKS like, and stopping Monaco or the preview
    text from being selected as it sweeps across them mid-drag.
  */
  &.is-resizing {
    cursor: col-resize;
    * {
      cursor: col-resize !important;
      user-select: none !important;
    }
  }
  &-main {
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
  }
  &-mid {
    background-color: $dark-6;
    flex: 1 1 50%;
    display: block;
    height: 100%;
    position: relative;
    /*
      The seam facing the preview pane, which is the next flex item in `-main` -- always the one
      after this in reading order, whichever physical side that mirrors to under `dir="rtl"`.
    */
    border-inline-end: 5px solid $primary;
    /*
      Monaco writes its measured width in pixels onto its own elements, so this item's automatic
      min-width -- min-content, i.e. whatever Monaco last laid itself out at -- pins it to the full
      width it took while the preview was closed. Bringing the preview back then leaves it the few
      pixels the flex line has left over, and Monaco never re-measures because its container never
      shrinks. Zero lets the basis decide instead.
    */
    min-width: 0;
  }
  &-editor {
    display: block;
    height: calc(100% - 32px);
    position: relative;

    > div {
      height: 100%;
    }
  }
  &-type {
    writing-mode: vertical-rl;
    text-orientation: mixed;
    padding-bottom: 1rem;
    color: rgba(255, 255, 255, 0.4);
    font-weight: 500;
  }
  &-divider {
    flex: 0 0 auto;
    width: 9px;
    height: 100%;
    position: relative;
    cursor: col-resize;
    // -> Pointer capture (see `onDividerPointerDown`) keeps the drag tracking correctly once the
    //    pointer leaves this narrow strip; this stops a fast drag from also selecting text in Monaco
    //    or the preview as the pointer crosses over them along the way.
    touch-action: none;
    user-select: none;

    /*
      Invisible until interacted with. `-mid`'s own `border-inline-end` just before this is already
      the seam's permanent visual line -- this only adds a highlight on top of it while the divider is
      actually being grabbed or hovered, rather than shipping a second, always-on stripe beside it.
    */
    &::after {
      content: '';
      position: absolute;
      inset-block: 0;
      inset-inline-start: 3px;
      width: 3px;
      border-radius: 2px;
      background-color: $primary;
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    &:hover::after,
    &.is-dragging::after {
      opacity: 0.6;
    }
  }
  &-preview {
    flex: 0 1 50%;
    position: relative;
    height: 100%;
    overflow: hidden;

    @at-root .body--light & {
      background-color: $grey-2;
    }
    @at-root .body--dark & {
      background-color: $dark-6;
    }
    // @include until($tablet) {
    //   display: none;
    // }
    /*
      `-enter-from` is the Vue 3 name; as `-enter` it matched nothing, so the pane animated shut but
      snapped open. The inner selector was stale in the same way -- the content class is
      `-preview-content` -- which left the render reflowing for the length of the transition.
    */
    /*
      `var(--preview-width, 50vw)`: the custom-property fallback is what keeps this transition (and
      the settled `-content` max-width below) behaving exactly as before for anyone who has never
      dragged the divider -- `previewInlineStyle` only ever sets the property once a width has
      actually been dragged or loaded from a saved one, and leaves it unset (falling through to the
      `50vw` written here) otherwise.
    */
    &-enter-active,
    &-leave-active {
      transition: max-width 0.5s ease;
      max-width: var(--preview-width, 50vw);
      .editor-markdown-preview-content {
        width: var(--preview-width, 50vw);
        overflow: hidden;
      }
    }
    &-enter-from,
    &-leave-to {
      max-width: 0;
    }
    /*
      The pane's one-time entrance (see `previewEverRevealed`'s doc comment in the script), timed to
      `WDrawer.vue`'s own `0.2s` close so the two read as one movement -- the side nav sliding away on
      the left as this opens on the right. `opacity` is added on top of `max-width` here, unlike the
      toggle-button transition above: a genuinely empty pane has nothing left to paint at `max-width: 0`
      regardless, but this variant also covers whatever the pane is opening ONTO A STILL-RESOLVING
      layout, where a border, shadow or the toolbar's own background could otherwise read as a sliver of
      "something" at the very start of the animation. `var(--ease-standard)` for the same reason as the
      timing: it is the curve the side nav itself moves on.
    */
    &-initial-enter-active,
    &-initial-leave-active {
      transition:
        max-width 0.2s var(--ease-standard),
        opacity 0.2s var(--ease-standard);
      max-width: var(--preview-width, 50vw);
      .editor-markdown-preview-content {
        width: var(--preview-width, 50vw);
        overflow: hidden;
      }
    }
    &-initial-enter-from,
    &-initial-leave-to {
      max-width: 0;
      opacity: 0;
    }
    &-toolbar {
      color: $grey-8;
      height: 32px;
      display: flex;
      align-items: center;
      padding: 0 1rem;

      @at-root .body--light & {
        background-color: $grey-3;
      }
      @at-root .body--dark & {
        background-color: $dark-2;
        color: $grey-6;
      }
    }
    &-content {
      height: calc(100% - 32px);
      overflow-y: scroll;
      padding: 1rem;
      max-width: calc(var(--preview-width, 50vw) - 57px);
      // -ms-overflow-style: none;
      // &::-webkit-scrollbar {
      //   width: 0px;
      //   background: transparent;
      // }
      > div {
        outline: none;
      }
      p.line {
        overflow-wrap: break-word;
      }
      /*
        A block this site has switched off, marked by `markDisabledBlock`. Editor-only styling: the
        server strips the element on save, so no reader ever meets one of these.

        Built from the admonition palette `.page-contents` already declares -- the preview pane
        carries that class, so both themes are covered by the tokens rather than by a rule here.
      */
      [data-block-disabled] {
        display: block;
        margin: 1rem 0;
        padding: 0.75rem 1rem;
        border-left: 4px solid var(--content-danger);
        border-radius: 3px;
        background-color: var(--content-danger-wash);
        color: var(--content-ink-muted);
      }
      .block-disabled-notice {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        margin: 0;
        color: var(--content-danger);
        font-size: 0.85rem;
        font-weight: 600;

        /* -> `mdi:alert`, drawn as a mask so it takes the colour above rather than one of its own */
        &::before {
          content: '';
          flex: 0 0 auto;
          width: 1.1rem;
          height: 1.1rem;
          background-color: currentColor;
          mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M13 14h-2V9h2m0 9h-2v-2h2M1 21h22L12 2z'/%3E%3C/svg%3E");
          mask-repeat: no-repeat;
          mask-size: contain;
        }
      }
      /* -> Whatever the author wrote inside, which is what the saved page is left holding */
      [data-block-disabled] > .block-disabled-notice + * {
        margin-top: 0.5rem;
      }
      .tabset {
        background-color: $teal-7;
        color: $teal-2 !important;
        padding: 5px 12px;
        font-size: 14px;
        font-weight: 500;
        border-radius: 5px 0 0 0;
        font-style: italic;
        &::after {
          display: none;
        }
        &-header {
          background-color: $teal-5;
          color: #fff !important;
          padding: 5px 12px;
          font-size: 14px;
          font-weight: 500;
          margin-top: 0 !important;
          &::after {
            display: none;
          }
        }
        &-content {
          border-left: 5px solid $teal-5;
          background-color: $teal-1;
          padding: 0 15px 15px;
          overflow: hidden;
          @at-root .theme--dark & {
            background-color: rgba($teal-5, 0.1);
          }
        }
      }
    }
  }
  &-toolbar {
    background-color: $primary;
    /*
      Continues the sidebar's own dark stripe up under the top toolbar, so the two read as one band
      down the reading-start edge. `-inline-start`, not `-left`: the sidebar is the first item in
      `-main`'s flex row, so it is always the one this toolbar sits beside on that edge, in LTR or RTL.
    */
    border-inline-start: 60px solid color.adjust($primary, $lightness: -5%);
    color: #fff;
    height: 32px;
    // -> Flex so the preview toggle can be pushed to the far inline-end by `w-space`
    display: flex;
    align-items: center;

    /*
      `w-btn`'s own default min-height (2.572em, ~36px at this button's inherited 14px font-size --
      see `WBtn.vue`'s `styles` computed) is taller than this toolbar's fixed 32px band regardless of
      the `padding="xs sm"` passed here, since that prop only overrides `padding`, never `minHeight`.
      Centered by `align-items: center` above, the button box then overflows top and bottom, which is
      invisible until a flat button's own `hover:bg-current/10` fill paints that overflow. `!important`
      is required because `WBtn` sets `min-height` as an inline style, which otherwise beats any
      selector here. Scoped to this toolbar's own buttons -- `WBtn.vue` keeps its default for every
      other caller.
    */
    .w-btn {
      min-height: 24px !important;
    }
  }
  &-sidebar {
    background-color: $dark-4;
    border-top: 32px solid color.adjust($primary, $lightness: -10%);
    color: #fff;
    width: 56px;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: center;
    padding: 12px 0;
  }
}
</style>
