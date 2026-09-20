<template>
  <div class="editor-markdown" :class="{ 'is-resizing': isDragging }">
    <div class="editor-markdown-main">
      <div
        class="editor-markdown-sidebar"
        ref="sideToolbarRef"
        role="toolbar"
        aria-orientation="vertical"
        :aria-label="t('editor.markup.insertToolbarLabel')"
        @keydown="sideToolbarRoving.onKeydown"
        @focusin="sideToolbarRoving.onFocusin">
        <!--
          A WAI-ARIA APG toolbar (`composables/toolbarRovingTabindex.js`): the whole rail is one Tab
          stop, so Tab goes straight on to the Monaco editor. Each button's `tabindexFor(N)` index
          has to match its position in the DOM.
        -->
        <w-btn
          class="flush-hover-btn"
          icon="tabler:link-plus"
          padding="sm sm"
          flat
          :tabindex="sideToolbarRoving.tabindexFor(0)"
          @click="insertLink">
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertLink')
          }}</w-tooltip>
        </w-btn>
        <w-btn
          class="flush-hover-btn"
          icon="tabler:photo-plus"
          padding="sm sm"
          flat
          :tabindex="sideToolbarRoving.tabindexFor(1)"
          @click="insertAssets">
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertAssets')
          }}</w-tooltip>
        </w-btn>
        <w-btn
          class="flush-hover-btn"
          icon="tabler:json"
          padding="sm sm"
          flat
          :tabindex="sideToolbarRoving.tabindexFor(2)">
          <editor-code-block-menu
            :anchor="sideToolbarMenuAnchor"
            :self="sideToolbarMenuSelf"
            @select="insertCodeBlock" />
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertCodeBlock')
          }}</w-tooltip>
        </w-btn>
        <w-btn
          class="flush-hover-btn"
          icon="tabler:table-plus"
          padding="sm sm"
          flat
          :tabindex="sideToolbarRoving.tabindexFor(3)"
          @click="insertTable">
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertTable')
          }}</w-tooltip>
        </w-btn>
        <w-btn
          class="flush-hover-btn"
          icon="tabler:browser-plus"
          padding="sm sm"
          flat
          :tabindex="sideToolbarRoving.tabindexFor(4)"
          @click="insertTabset">
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertTabset')
          }}</w-tooltip>
        </w-btn>
        <w-btn
          class="flush-hover-btn"
          icon="tabler:puzzle"
          padding="sm sm"
          flat
          :tabindex="sideToolbarRoving.tabindexFor(5)"
          @click="insertBlock">
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertBlock')
          }}</w-tooltip>
        </w-btn>
        <w-btn
          class="flush-hover-btn"
          icon="tabler:book-upload"
          padding="sm sm"
          flat
          :tabindex="sideToolbarRoving.tabindexFor(6)"
          @click="insertFootnote">
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertFootnote')
          }}</w-tooltip>
        </w-btn>
        <w-btn
          class="flush-hover-btn"
          icon="tabler:mood-plus"
          padding="sm sm"
          flat
          :tabindex="sideToolbarRoving.tabindexFor(7)">
          <editor-emoji-menu
            :anchor="sideToolbarMenuAnchor"
            :self="sideToolbarMenuSelf"
            @select="insertEmoji" />
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertEmoji')
          }}</w-tooltip>
        </w-btn>
        <!-- -> `no-image`: the insert is a `:tabler:home:` shortcode, and that syntax cannot carry the
                `img:` URL the picker's other tab hands back -->
        <w-btn
          class="flush-hover-btn"
          icon="tabler:seeding"
          padding="sm sm"
          flat
          :tabindex="sideToolbarRoving.tabindexFor(8)">
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
        <w-btn
          class="flush-hover-btn"
          icon="tabler:scan"
          padding="sm sm"
          flat
          :tabindex="sideToolbarRoving.tabindexFor(9)"
          @click="insertHorizontalBar">
          <w-tooltip labels :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertHorizontalBar')
          }}</w-tooltip>
        </w-btn>
        <w-space />
        <span class="editor-markdown-type">Markdown</span>
      </div>
      <div class="editor-markdown-mid" ref="editorMidRef">
        <!--
          A second toolbar, with its own Tab stop and its own horizontal `topToolbarRoving`. The
          preview-toggle button at the end is the only conditionally-rendered member, so it takes the
          next free index (12) rather than the fixed buttons ahead of it being renumbered.
        -->
        <div
          class="editor-markdown-toolbar"
          ref="topToolbarRef"
          role="toolbar"
          aria-orientation="horizontal"
          :aria-label="t('editor.markup.formattingToolbarLabel')"
          @keydown="topToolbarRoving.onKeydown"
          @focusin="topToolbarRoving.onFocusin">
          <w-btn
            class="flush-hover-btn flush-hover-btn--square"
            icon="tabler:bold"
            padding="xs sm"
            flat
            :tabindex="topToolbarRoving.tabindexFor(0)"
            @click="toggleMarkup({ start: `**` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.bold')
            }}</w-tooltip>
          </w-btn>
          <w-btn
            class="flush-hover-btn flush-hover-btn--square"
            icon="tabler:italic"
            padding="xs sm"
            flat
            :tabindex="topToolbarRoving.tabindexFor(1)"
            @click="toggleMarkup({ start: `*` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.italic')
            }}</w-tooltip>
          </w-btn>
          <w-btn
            class="flush-hover-btn flush-hover-btn--square"
            icon="tabler:strikethrough"
            padding="xs sm"
            flat
            :tabindex="topToolbarRoving.tabindexFor(2)"
            @click="toggleMarkup({ start: `~~` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.strikethrough')
            }}</w-tooltip>
          </w-btn>
          <!--
            A button that opens a menu rather than acting on click carries the design's 9px chevron,
            so a reader can tell it will ask a follow-up. `w-tooltip`/`w-menu` float and contribute no
            box, so the chevron is all the slot adds to the button's layout.
          -->
          <w-btn
            class="flush-hover-btn flush-hover-btn--square"
            icon="tabler:heading"
            padding="xs sm"
            flat
            :tabindex="topToolbarRoving.tabindexFor(3)">
            <w-icon class="editor-markdown-toolbar-caret" name="tabler:chevron-down" size="9px" />
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
            class="flush-hover-btn flush-hover-btn--square"
            icon="tabler:subscript"
            padding="xs sm"
            flat
            :tabindex="topToolbarRoving.tabindexFor(4)"
            @click="toggleMarkup({ start: `~` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.subscript')
            }}</w-tooltip>
          </w-btn>
          <w-btn
            class="flush-hover-btn flush-hover-btn--square"
            icon="tabler:superscript"
            padding="xs sm"
            flat
            :tabindex="topToolbarRoving.tabindexFor(5)"
            @click="toggleMarkup({ start: `^` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.superscript')
            }}</w-tooltip>
          </w-btn>
          <w-separator class="editor-markdown-toolbar-rule" vertical />
          <w-btn
            class="flush-hover-btn flush-hover-btn--square"
            icon="tabler:quote"
            padding="xs sm"
            flat
            :tabindex="topToolbarRoving.tabindexFor(6)">
            <w-icon class="editor-markdown-toolbar-caret" name="tabler:chevron-down" size="9px" />
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.blockquoteAdmonitions')
            }}</w-tooltip>
            <w-menu auto-close>
              <w-list separator>
                <w-item clickable @click="insertBeforeEachLine({ content: `> ` })">
                  <w-item-section side><w-icon name="tabler:quote" /></w-item-section>
                  <w-item-section>{{ t('editor.markup.blockquote') }}</w-item-section>
                </w-item>
                <w-item
                  clickable
                  @click="insertBeforeEachLine({ content: `> `, before: `> [!NOTE]` })">
                  <w-item-section side>
                    <!--
                      Tailwind never sees this class: WIcon composes it from the name, so only the
                      tones written out in full somewhere in the app are emitted -- of the blues,
                      this one. Nothing here may spell a class out either; the scanner reads
                      comments too.
                    -->
                    <w-icon name="tabler:square-rounded-letter-i" color="blue" />
                  </w-item-section>
                  <w-item-section>{{ t('editor.markup.admonitionInfo') }}</w-item-section>
                </w-item>
                <w-item
                  clickable
                  @click="insertBeforeEachLine({ content: `> `, before: `> [!TIP]` })">
                  <w-item-section side>
                    <w-icon name="tabler:circle-check" color="positive" />
                  </w-item-section>
                  <w-item-section>{{ t('editor.markup.admonitionSuccess') }}</w-item-section>
                </w-item>
                <w-item
                  clickable
                  @click="insertBeforeEachLine({ content: `> `, before: `> [!IMPORTANT]` })">
                  <w-item-section side>
                    <w-icon name="tabler:message-exclamation" color="purple" />
                  </w-item-section>
                  <w-item-section>{{ t('editor.markup.admonitionImportant') }}</w-item-section>
                </w-item>
                <w-item
                  clickable
                  @click="insertBeforeEachLine({ content: `> `, before: `> [!WARNING]` })">
                  <w-item-section side>
                    <w-icon name="tabler:alert-square" color="orange" />
                  </w-item-section>
                  <w-item-section>{{ t('editor.markup.admonitionWarning') }}</w-item-section>
                </w-item>
                <w-item
                  clickable
                  @click="insertBeforeEachLine({ content: `> `, before: `> [!CAUTION]` })">
                  <w-item-section side>
                    <w-icon name="tabler:square-x" color="negative" />
                  </w-item-section>
                  <w-item-section>{{ t('editor.markup.admonitionDanger') }}</w-item-section>
                </w-item>
                <w-item
                  clickable
                  @click="insertBeforeEachLine({ content: `> `, before: `> [!QUESTION]` })">
                  <w-item-section side>
                    <w-icon name="tabler:help-circle" color="teal" />
                  </w-item-section>
                  <w-item-section>{{ t('editor.markup.admonitionQuestion') }}</w-item-section>
                </w-item>
              </w-list>
            </w-menu>
          </w-btn>
          <w-btn
            class="flush-hover-btn flush-hover-btn--square"
            icon="tabler:list"
            padding="xs sm"
            flat
            :tabindex="topToolbarRoving.tabindexFor(7)"
            @click="insertBeforeEachLine({ content: `- ` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.unorderedList')
            }}</w-tooltip>
          </w-btn>
          <w-btn
            class="flush-hover-btn flush-hover-btn--square"
            icon="tabler:list-numbers"
            padding="xs sm"
            flat
            :tabindex="topToolbarRoving.tabindexFor(8)"
            @click="insertBeforeEachLine({ content: `1. ` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.orderedList')
            }}</w-tooltip>
          </w-btn>
          <w-btn
            class="flush-hover-btn flush-hover-btn--square"
            icon="tabler:list-check"
            padding="xs sm"
            flat
            :tabindex="topToolbarRoving.tabindexFor(9)">
            <w-icon class="editor-markdown-toolbar-caret" name="tabler:chevron-down" size="9px" />
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.taskList')
            }}</w-tooltip>
            <w-menu auto-close>
              <w-list separator>
                <w-item clickable @click="insertBeforeEachLine({ content: `- [ ] ` })">
                  <w-item-section side><w-icon name="tabler:square" /></w-item-section>
                  <w-item-section>{{ t('editor.markup.taskListUnchecked') }}</w-item-section>
                </w-item>
                <w-item clickable @click="insertBeforeEachLine({ content: `- [x] ` })">
                  <w-item-section side><w-icon name="tabler:checkbox" /></w-item-section>
                  <w-item-section>{{ t('editor.markup.taskListChecked') }}</w-item-section>
                </w-item>
              </w-list>
            </w-menu>
          </w-btn>
          <w-btn
            class="flush-hover-btn flush-hover-btn--square"
            icon="tabler:code"
            padding="xs sm"
            flat
            :tabindex="topToolbarRoving.tabindexFor(10)"
            @click="toggleMarkup({ start: '`' })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.inlineCode')
            }}</w-tooltip>
          </w-btn>
          <w-btn
            class="flush-hover-btn flush-hover-btn--square"
            icon="tabler:keyboard"
            padding="xs sm"
            flat
            :tabindex="topToolbarRoving.tabindexFor(11)"
            @click="toggleMarkup({ start: `<kbd>`, end: `</kbd>` })">
            <w-tooltip labels anchor="top middle" self="bottom middle">{{
              t('editor.markup.keyboardKey')
            }}</w-tooltip>
          </w-btn>
          <template v-if="!state.previewShown">
            <w-space />
            <w-btn
              class="flush-hover-btn flush-hover-btn--square"
              icon="tabler:layout-columns"
              padding="xs sm"
              flat
              :tabindex="topToolbarRoving.tabindexFor(12)"
              @click="state.previewShown = true">
              <w-tooltip labels anchor="top middle" self="bottom middle">{{
                t('editor.togglePreviewPane')
              }}</w-tooltip>
            </w-btn>
          </template>
        </div>
        <div class="editor-markdown-editor"><div ref="monacoRef" /></div>
      </div>
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
            <strong class="editor-markdown-preview-toolbar-title"
              ><em>{{ t('editor.renderPreview') }}</em></strong
            >
            <w-separator class="ms-4 me-2" vertical inset />
            <w-btn
              class="flush-hover-btn flush-hover-btn--square"
              icon="tabler:arrows-vertical"
              padding="xs sm"
              flat
              @click="state.previewScrollSync = !state.previewScrollSync"
              :color="state.previewScrollSync ? `primary` : null">
              <w-tooltip labels anchor="top middle" self="bottom middle">{{
                t('editor.toggleScrollSync')
              }}</w-tooltip>
            </w-btn>
            <w-btn
              class="flush-hover-btn flush-hover-btn--square"
              icon="tabler:eye-off"
              padding="xs sm"
              flat
              @click="state.previewShown = false">
              <w-tooltip labels anchor="top middle" self="bottom middle">{{
                t('editor.togglePreviewPane')
              }}</w-tooltip>
            </w-btn>
          </div>
          <!--
            The render goes straight into the element carrying `page-contents`, as the page view does
            it: a wrapper in between would make the headings grandchildren, so content rules written
            against its direct children would apply on one surface and not the other.
          -->
          <div
            class="editor-markdown-preview-content page-contents"
            ref="editorPreviewContainerRef"
            v-html="previewHtml" />
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

import { useAesthetic } from '@/composables/aesthetic'
import { dialog } from '@/composables/dialog'
import { useMarkdownCollab } from '@/composables/markdownCollab'
import { notify } from '@/composables/notify'
import {
  EDITOR_MIN_WIDTH_PX,
  PREVIEW_HIDE_THRESHOLD_PX,
  usePreviewResize
} from '@/composables/previewResize'
import { useMinWidth } from '@/composables/screen'
import { useToolbarRovingTabindex } from '@/composables/toolbarRovingTabindex'
import { apiErrorMessage } from '@/helpers/apiError'
import { assetPath } from '@/helpers/assets'
import { blockMarkdown } from '@/helpers/blocks'
import { directionalAnchor } from '@/helpers/directionalAnchor'
import {
  hasFiles,
  pastedFiles,
  shouldAcceptDrag,
  shouldClaimPaste
} from '@/helpers/editorFileTransfer'
import {
  resolveEditorFontSize,
  resolveInitialPreviewShown,
  resolveInitialPreviewWidth
} from '@/helpers/editorUserSettings'
import { htmlToMarkdown } from '@/helpers/htmlToMarkdown'
import { isSameVisibleText } from '@/helpers/htmlVisibleText'
import { log } from '@/helpers/log'
import { defineMonacoThemes, monacoThemeName } from '@/helpers/monacoTheme'
import {
  blockOpeningLine,
  blockValues,
  findBlocks,
  hasEditableParams
} from '@/helpers/markdownBlocks'
import * as insertCmd from '@/helpers/markdownInsert'
import { resolveWordMarkup } from '@/helpers/markdownMarkup'
import { findEditableTables } from '@/helpers/markdownTable'

import EditorCodeBlockMenu from '@/components/EditorCodeBlockMenu.vue'
import EditorEmojiMenu from '@/components/EditorEmojiMenu.vue'
import IconPickerDialog from '@/components/IconPickerDialog.vue'
import LinkPickerDialog from '@/components/LinkPickerDialog.vue'

import { useCommonStore } from '@/stores/common'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { enhanceRenderedContent } from '@/helpers/renderedContent'

import { debounce } from 'es-toolkit/function'
import * as monaco from 'monaco-editor'
import { Position, Range } from 'monaco-editor'
import { MarkdownRenderer, sanitizeForPreview } from '@/renderers/markdown'

const commonStore = useCommonStore()
const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

/*
  Monaco is the one surface the token layer cannot reach: `defineTheme()` takes plain hex strings and
  never resolves a CSS custom property, so a live aesthetic change has to be applied by switching
  between the two themes defined at mount rather than by re-resolving a variable.
*/
const aesthetic = useAesthetic()

watch(
  () => aesthetic.current,
  (value) => {
    if (editor) {
      monaco.editor.setTheme(monacoThemeName(value))
    }
  }
)

const { t } = useI18n()

/*
  `WTooltip`/`WMenu` position themselves in raw viewport pixels (`composables/anchoredPosition.js`),
  which knows nothing about `direction`, so a pair hardcoded to `right` would pop away from the editor
  under `dir="rtl"` -- where the sidebar itself has swapped edges. Read once at setup rather than kept
  reactive: switching locale mid-edit is not a case this editor has to survive gracefully.
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

let editor
let md
let pasteCaptureNode = null
let tableLensProvider = null
let blockLensProvider = null
let siteBlocks = []
/**
 * Kept only so `onBeforeUnmount` can `cancel()` them: a debounced call still pending at unmount fires
 * ~500ms later against the already-`dispose()`d editor, where `editor.getPosition()` returns `null`
 * and the cursor handler throws reading `.lineNumber` off it.
 */
let debouncedContentChange = null
let debouncedCursorPositionChange = null
/** Cleared at unmount: left to fire, it calls `.focus()` on an editor `dispose()` has torn down. */
let insertAssetFocusTimeout = null
const monacoRef = ref(null)
const editorPreviewContainerRef = ref(null)
const editorMidRef = ref(null)
const previewPaneRef = ref(null)

const sideToolbarRef = ref(null)
const topToolbarRef = ref(null)
const sideToolbarRoving = useToolbarRovingTabindex(sideToolbarRef, { orientation: 'vertical' })
const topToolbarRoving = useToolbarRovingTabindex(topToolbarRef, { orientation: 'horizontal' })

/**
 * `false` picks the pane's fast `-initial` entrance transition, timed to match the side nav's own
 * `0.2s` close since the two happen together the moment the editor opens. Flipped once in `onMounted`
 * so every later toggle uses the slower `editor-markdown-preview` one.
 */
const previewEverRevealed = ref(false)

/**
 * The preview fetches a component for every element it does not recognise, so a disabled block would
 * draw here and then vanish on save. Naming them lets the preview leave the element undefined, which
 * is what the saved page comes back as. Only what the site lists as off -- a tag absent from the list
 * is a child block or an unknown one, and this decides nothing about either.
 */
const disabledBlockTags = ref(new Set())

/*
  Listed rather than built as `tabler:h-${lvl}`: a concatenated icon name is invisible to
  the build-time icon scan, so it would ship as six blank squares.
*/
const HEADER_ICONS = [
  'tabler:h-1',
  'tabler:h-2',
  'tabler:h-3',
  'tabler:h-4',
  'tabler:h-5',
  'tabler:h-6'
]

/*
  `block: 'start'`, not `nearest`: `nearest` leaves a line alone as long as it is visible anywhere, so a
  line on the last row stays pinned to the bottom edge with nothing after it in view. `inline: 'nearest'`
  keeps a wide block -- a table, a diagram -- from being scrolled sideways as a side effect.
*/
const SYNC_SCROLL = { behavior: 'smooth', block: 'start', inline: 'nearest' }

/**
 * 1024 is the app's `md` breakpoint (`css/tailwind.css`). Below it each pane is half a small window and
 * the source is the one being typed into, so the preview starts closed and is opened on request.
 */
const isAtLeastMd = useMinWidth(1024)

const state = reactive({
  /*
    Opening it is deferred to `onMounted`, once `previewWidth` has resolved too, so that the pane's
    entrance transition animates straight to the right width instead of appearing at the CSS `50vw`
    fallback and snapping once the async settings fetch lands.
  */
  previewShown: false,
  previewScrollSync: true,
  /*
    `null` means "no custom width, use the responsive 50vw default"; a number is a pixel width
    committed by dragging the divider. Tracked separately from `previewShown` so a hide/show cycle
    keeps the last dragged width -- only another drag or a saved value on mount overwrites it.
  */
  previewWidth: null,
  /*
    Set by `flushEditorContent` when it skips `processContent` because the preview pane is closed: the
    content sync still has to run so a save never reads stale `pageStore.content`, but re-running the
    markdown-it/KaTeX/highlight.js pipeline for a preview nobody can see is waste.
    `flushStaleRenderIfNeeded` clears it the moment a current render is actually needed.
  */
  renderIsStale: false
})

const { isDragging, onDividerPointerDown, onDividerPointerMove, onDividerPointerUp } =
  usePreviewResize({ state, previewPaneRef, editorMidRef })

const { start: startCollab, stop: stopCollab } = useMarkdownCollab()

/**
 * Resizing is an `md`-and-up affordance: below it, dragging would let an author shrink the source pane
 * on the one screen size that can least afford to lose the room.
 */
const canResizePreview = computed(() => state.previewShown && isAtLeastMd.value)

/**
 * `null` falls back to the stylesheet's responsive `50vw`. Also `null` below `md` even when a custom
 * width IS saved: applying a desktop-sized width there would squeeze the source pane exactly as
 * unresizably as dragging one would, which `canResizePreview` already withholds.
 */
const previewInlineStyle = computed(() => {
  if (!isAtLeastMd.value || typeof state.previewWidth !== 'number') {
    return null
  }
  return {
    '--preview-width': `${state.previewWidth}px`,
    // -> Inline style beats the `-preview` rule's own `flex: 0 1 50%`, pinning the basis exactly
    //    rather than leaving it shrinkable against `-mid`
    flex: `0 0 ${state.previewWidth}px`
  }
})

/**
 * `pageStore.render` itself stays exactly what `md.render()` produced -- that is the payload `pageSave`
 * sends, and the server re-derives its own sanitized copy from it, so mutating the store value would
 * only lose the save/preview distinction. Gated on the same page-scoped `write:scripts`/`write:styles`
 * permissions the save is about to be sanitized against.
 */
const previewHtml = computed(() =>
  sanitizeForPreview(pageStore.render, {
    scripts: userStore.pagePermissions.includes('write:scripts'),
    styles: userStore.pagePermissions.includes('write:styles')
  })
)

const insertAtCursor = (opts) => insertCmd.insertAtCursor(editor, opts)
const insertCodeBlock = (language) => insertCmd.insertCodeBlock(editor, language)
const insertBlockClb = (markdown) => insertCmd.insertBlockClb(editor, markdown)
const insertTableClb = (opts) => insertCmd.insertTableClb(editor, opts)
const insertFootnote = () => insertCmd.insertFootnote(editor)
const setHeaderLine = (lvl, focus) => insertCmd.setHeaderLine(editor, lvl, focus)
const getHeaderLevel = () => insertCmd.getHeaderLevel(editor)
const insertBeforeEachLine = (opts) => insertCmd.insertBeforeEachLine(editor, opts)
const insertHorizontalBar = () => insertCmd.insertHorizontalBar(editor)
const continueList = () => insertCmd.continueList(editor)

function insertAssets() {
  siteStore.openFileManager({ insertMode: true })
}

/**
 * An image goes in as one, anything else as a link: a picked PDF is a link to a PDF, not a broken
 * picture. Same distinction `insertFilesAsAssets` draws for a drop.
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
 * `:tada:` rather than 🎉: only the emoji plugin's own tokens are handed to twemoji
 * (`renderers/markdown.js`), so a raw character would survive into the page and be drawn by whatever
 * font the reader happens to have.
 */
function insertEmoji(shortcode) {
  insertAtCursor({ content: `:${shortcode}:` })
}

/**
 * `tabler:home` in, `:tabler:home:` out — the same delimiters an emoji uses, the two told apart by
 * the colon inside the reference (`renderers/markdown.js`).
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
 * Built from the block's own definition rather than written out a second time here, so a change to
 * its starter body reaches both paths. The server is still asked which blocks this site has: a
 * shortcut to a block an administrator switched off would insert something the page cannot draw.
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
      caption: apiErrorMessage(err)
    })
  }
}

function insertTable() {
  siteStore.$patch({
    overlay: 'TableEditor',
    overlayOpts: {}
  })
}

/**
 * The table is looked up again here rather than taken from the lens: a lens is provided once and then
 * moves with the text, so its line argument is from whenever the document last settled. Reading the
 * model at click time is what keeps the range and the source it hands over describing one thing.
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

function blockDefinition(name) {
  return siteBlocks.find((block) => block.block === name)
}

/**
 * Looked up again rather than taken from the lens, for the reason `editTable` gives. The block name is
 * matched as well as the line: a table spans lines and can be found by containment, but a block's
 * opening line is a single line, and an edit above it would put one block's form over another.
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
      The opening line and nothing else, so the body between the fences is left exactly as it was --
      which for a tabset is every tab in it. One edit, so one undo takes the whole change back.
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
 * `{target="_blank"}` is markdown-it-attrs syntax, and `target` is one of the few attributes the stored
 * render is allowed to keep (`renderers/markdown.js`, `models/rendering.ts`).
 */
function insertLink() {
  dialog({ component: LinkPickerDialog }).onOk(({ href, openInNewTab, title }) => {
    const selection = editor.getSelection()
    const selected = editor.getModel().getValueInRange(selection)
    const label = selected || title || href
    const attributes = openInNewTab ? '{target="_blank"}' : ''
    /*
      One edit for both cases: a selection is replaced, and an empty selection -- which is all a bare
      cursor is -- inserts. `insertAtCursor` cannot do the first: it builds its own empty range.
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
  // -> One entry per null-word edit below, passed to `executeEdits` only when every edit in this call
  //    needed one: a mixed multi-cursor batch falls back to Monaco's own placement rather than
  //    silently dropping the cursors this array doesn't know about.
  const cursors = []

  for (const selection of editor.getSelections()) {
    const selectedText = editor.getModel().getValueInRange(selection)
    if (!selectedText) {
      const wordObj = editor.getModel().getWordAtPosition(selection.getPosition())
      const { text, atCursor } = resolveWordMarkup({ start, end, word: wordObj?.word ?? null })
      if (atCursor) {
        // No word under the cursor: insert the empty markers and land the caret between them, so the
        // author can type straight into them.
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
 * Must finish before the first preview is drawn: a component only has to be fetched once to be defined
 * for the rest of the session, so a list that arrives after the first render is too late to keep a
 * disabled block from drawing.
 */
async function loadSiteBlocks() {
  try {
    siteBlocks = (await API_CLIENT.get(`sites/${siteStore.id}/blocks`).json()) ?? []
    disabledBlockTags.value = new Set(
      siteBlocks.filter((block) => !block.isEnabled).map((block) => `block-${block.block}`)
    )
  } catch (err) {
    /*
      Left empty, drawing everything. A too-generous preview is the better failure: the server strips
      a disabled block on save either way, so the cost is a preview that flatters the page, against
      hiding blocks the site really does have.
    */
    log.warn('editor', 'could not read which blocks this site has enabled', err)
  }
}

/**
 * A disabled block is left undefined, so without this it draws as its own contents and reads as broken
 * rather than as switched off.
 *
 * Written into the preview's DOM rather than into the render: `pageStore.render` is what `pageSave`
 * sends, so a notice added there would be saved into the page. The preview is rebuilt from that string
 * on every keystroke, so this is simply re-applied each time and nothing has to be cleaned up.
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
 * The caret beats "whichever panel was open before": an author writing inside the second panel is
 * saying plainly which one they are looking at.
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
    A render that throws must not become a render that is empty: `pageSave` sends whatever is in the
    store and the server replaces the stored HTML with it, so patching a failed render in would blank
    the published page. Loud, because the preview is then showing something other than the source.
  */
  let html
  try {
    // -> A relative image in the source is relative to the folder the page sits in, which while
    //    editing is whatever the path field says right now
    html = md.render(newContent, { pagePath: pageStore.path })
  } catch (err) {
    log.error('editor', 'could not render the Markdown preview', err)
    notify({
      type: 'negative',
      message: t('editor.renderFailed'),
      caption: apiErrorMessage(err)
    })
    return
  }

  const container = editorPreviewContainerRef.value
  /*
    `v-html` does not patch: it throws every child away and rebuilds them, on every keystroke. Two
    things must be carried across by hand. Scroll position, because an emptied box clamps `scrollTop`
    to zero and the cursor handler then animates back down from the top on every keystroke. And which
    tab is open, because a block is a custom element and a rebuilt one starts from its defaults --
    carried by position, since the source order of the blocks is what survives an edit, not the
    elements.
  */
  const scrollTop = container?.scrollTop ?? 0
  const openTabs = [...(container?.querySelectorAll('block-tabs') ?? [])].map(
    (el) => el.active ?? 0
  )

  pageStore.$patch({
    render: html
  })
  nextTick(async () => {
    /*
      Callers that do not go through `flushEditorContent` can reach here with the pane closed: the
      post-init render, and the `previewShown` watcher's catch-up landing before Vue has mounted the
      pane's `v-if` in the same tick. The render is already stored either way.
    */
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
      The panels have to be settled before the scroll position goes back, and a block applies its open
      panel on its own update, a microtask later. Restoring first restores against a layout about to
      change by the height of a whole panel: the browser clamps the position against the shorter
      document, then scroll anchoring hands back a different one again as the real panel opens.
    */
    await Promise.all(tabsets.map((el) => el.updateComplete ?? Promise.resolve()))
    container.scrollTop = scrollTop
    // -> Keyed on the tag, so a repeat of the same element is only resolved once. The value carries
    //    `isCustom`/`id` when the tag matches a block this site has, which is how `loadBlocks()` tells
    //    a custom block's per-site import URL from a built-in's flat one; a tag matching nothing goes
    //    in as the bare string and is treated as a built-in guess.
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
        Asked again once the definitions land: setting `active` on a not-yet-upgraded element stores a
        value Lit will pick up, but nothing has read or hidden the panels, so on the first render of a
        page whose blocks are still being fetched the tab is only actually opened here.
      */
      commonStore.loadBlocks([...pendingBlocks.values()]).then(syncPreviewTabs)
    }
    // -> The render was just replaced, so the copy buttons went with it
    enhanceRenderedContent(container, t)
  })
}

/**
 * Nothing is uploaded here: each file becomes a pending asset behind a `blob:` URL, and
 * `UploadPendingAssetsDialog` sends them on save and rewrites those URLs, so the editor shows the
 * image immediately and the page never stores a blob URL.
 *
 * `generateUniqueName` is set only by the paste call site: every browser names a clipboard-pasted file
 * "image.png" regardless of source, where a dropped file's name is real user intent worth keeping.
 */
function insertFilesAsAssets(files, { generateUniqueName = false } = {}) {
  const markup = files.map((file) => {
    const blobUrl = editorStore.addPendingAsset(file, { generateUniqueName })
    return `${file.type.startsWith('image/') ? '!' : ''}[${file.name}](${blobUrl})`
  })
  // -> One per line: two images on the same line is rarely what was meant by dropping two files
  insertAtCursor({ content: markup.join('\n') })
}

/**
 * The async other half of `htmlToMarkdown`, which is synchronous and so hands back
 * `![alt](pending-image:N)` placeholders rather than fetching an embedded image's bytes itself.
 * `fetch` turns all three `src` shapes -- `data:`, `blob:` and `http(s):` -- into bytes uniformly. A
 * `src` that cannot be retrieved (cross-origin CORS, a `blob:` from a navigated-away tab) drops just
 * that one image.
 */
async function resolvePendingImages(markdown, images) {
  let content = markdown
  await Promise.all(
    images.map(async ({ token, src, alt }) => {
      const placeholder = `![${alt}](${token})`
      let replacement = ''
      try {
        const response = await fetch(src)
        if (!response.ok) {
          throw new Error(`Failed to fetch pasted image: ${response.status}`)
        }
        const blob = await response.blob()
        const blobUrl = editorStore.addPendingAsset(blob)
        replacement = `![${alt}](${blobUrl})`
      } catch {
        replacement = ''
      }
      // -> `token` is unique per call (see `htmlToMarkdown`), so this can only match the placeholder
      //    it was generated for
      content = content.split(placeholder).join(replacement)
    })
  )
  return content
}

/*
  Both branches take the paste over completely -- `stopPropagation` as well as `preventDefault`,
  because this runs in capture ABOVE the editor: letting it travel on would hand the same paste to
  Monaco's own paste-as feature (files) or its default plain-text insert (HTML), which would answer it
  a second time in its own way. Both calls happen before any `await` below, so the paste is still
  claimed synchronously even though resolving embedded images is not.
*/
async function onEditorPaste(event) {
  if (shouldClaimPaste(event.clipboardData)) {
    event.preventDefault()
    event.stopPropagation()
    insertFilesAsAssets(pastedFiles(event.clipboardData), { generateUniqueName: true })
    return
  }
  const html = event.clipboardData?.getData?.('text/html') ?? ''
  if (html.trim().length === 0) {
    return
  }
  // -> Monaco's own "copy with syntax highlighting" ALSO writes a `text/html` payload alongside
  //    `text/plain` on every ordinary in-editor copy, with nothing above to tell that apart from a
  //    genuine external rich paste. Monaco colors the source without restructuring it, so a
  //    same-editor round trip reduces to the identical visible text and is left to the browser's own
  //    plain-text paste instead of being converted.
  const text = event.clipboardData?.getData?.('text/plain') ?? ''
  if (isSameVisibleText(html, text)) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  const { markdown, images } = htmlToMarkdown(html)
  const content = images.length > 0 ? await resolvePendingImages(markdown, images) : markdown
  insertAtCursor({ content })
}

/*
  A drop has to be claimed twice: `dragover` is what tells the browser this is a valid target --
  without it there is no drop at all, just the browser navigating away to the file.
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
  insertFilesAsAssets(pastedFiles(event.dataTransfer))
}

/**
 * Targeted edits rather than `setValue`: replacing the model wholesale reads as "everything was
 * deleted and everything was typed again", throwing away the undo history and the caret -- and in a
 * collaborative session landing on everyone else as exactly that.
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
 * Deliberately leaves `contentLoaded` and `lastChangeTimestamp` alone: those say an edit happened,
 * which is not true of a save running this on a page nobody has touched since it loaded --
 * `pageSave()`'s own guard is what a wrongly-forced `contentLoaded` would defeat.
 *
 * With the preview closed the render is skipped rather than deferred, and `renderIsStale` records
 * that `content` has moved on since the last one so `flushStaleRenderIfNeeded` can catch it up.
 */
function flushEditorContent() {
  const value = editor.getValue()
  pageStore.content = value
  if (!state.previewShown) {
    state.renderIsStale = true
    return
  }
  processContent(value)
}

function flushStaleRenderIfNeeded() {
  if (!state.renderIsStale) {
    return
  }
  processContent(pageStore.content)
  state.renderIsStale = false
}

/**
 * Registered as `editorStore.contentFlusher`, which `pageSave()` calls synchronously before reading
 * the store, so a save cannot land inside the 500ms debounce window. `pageSave()`'s body is built from
 * `render`, not `content`, so the stale render has to be caught up too or an unrendered edit ships the
 * previous save's HTML under this one's markdown.
 */
function flushEditorContentForSave() {
  flushEditorContent()
  flushStaleRenderIfNeeded()
}

watch(
  () => state.previewShown,
  (shown) => {
    if (shown) {
      flushStaleRenderIfNeeded()
    }
  }
)

onMounted(async () => {
  editorStore.$patch({
    hideSideNav: true
  })

  /*
    Read before Monaco is created so font size, preview state and preview width all apply from the
    first paint. `App.vue` prefetches these at session start so the entrance transition below need not
    wait on a round trip; the fetch here is only the fallback for a click that beats the prefetch.
  */
  const userSettingsPromise =
    editorStore.userSettings.markdown !== undefined
      ? Promise.resolve(editorStore.userSettings.markdown)
      : editorStore.fetchUserSettings('markdown').catch((err) => {
          log.warn('editor', 'could not read the Markdown editor settings', err)
          return {}
        })

  const [, userSettings = {}] = await Promise.all([loadSiteBlocks(), userSettingsPromise])

  state.previewShown = resolveInitialPreviewShown(userSettings, isAtLeastMd.value)
  /*
    Clamped here because `previewInlineStyle` only withholds a custom width below `md`; it does not
    shrink an oversized one to fit a narrower-but-still-`md` window (a width saved on a wide monitor,
    reopened on a 1024px one). Subtracts `EDITOR_MIN_WIDTH_PX` the way the drag's own live clamp does,
    just against the viewport -- there is nothing measured to clamp against this early in the mount.
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
    `nextTick`, so this lands after Vue has processed the `previewShown` flip above and that entrance
    still picks the fast `-initial` transition.
  */
  nextTick(() => {
    previewEverRevealed.value = true
  })

  md = new MarkdownRenderer(editorStore.editors.markdown)

  /*
    Both aesthetics' themes, from this one Ledger definition: `defineMonacoThemes` derives Cobalt's by
    mapping each tone onto the role's Cobalt answer (`helpers/monacoTheme.js`), so the editor's shape
    -- which rung the text sits on, the gutter a step below it -- is stated once and holds under
    either.
  */
  defineMonacoThemes(monaco, {
    base: 'vs-dark',
    inherit: true,
    /*
      The design's own markdown ramp rather than `vs-dark`'s inherited blues and oranges, which are a
      different application's palette showing through.

      Token names are Monarch's, from `monaco-editor`'s markdown grammar: a heading is `keyword`
      (which is also a list marker), a blockquote is `comment`, a fence's ``` line is `string`, the
      body inside one is `variable.source`, and an inline `code` span is `variable`. A theme rule
      matches by token PREFIX, so the bare names here cover the `.md` postfix the grammar appends.
    */
    rules: [
      { token: 'keyword', foreground: 'f08287' },
      { token: 'comment', foreground: '8ea6cf' },
      { token: 'string', foreground: '8792ab' },
      { token: 'variable.source', foreground: '9aa6bd' },
      { token: 'variable', foreground: 'a9b7d0' }
    ],
    /*
      Cardinal's own dark ramp: the text ground sits on the recessed rung with the line-number gutter
      at ink BELOW it, which is the way round both design files draw a code surface.

      Literal hex rather than `var(--color-*)` of necessity -- `defineTheme()` reads `colors` as plain
      hex/rgba strings and never resolves a CSS custom property. Re-typed from `css/tailwind.css` and
      pinned by `EditorMarkdown.theme.test.js`.
    */
    colors: {
      'editor.background': '#171b24',
      'editor.foreground': '#c3cee2',
      'editor.lineHighlightBackground': '#1e2431',
      'editorLineNumber.foreground': '#3f4a63',
      'editorLineNumber.activeForeground': '#c14a52',
      'editorGutter.background': '#14171f',
      'editorCursor.foreground': '#e4676b',
      /* -> The "Edit table" / "Edit block parameters" lenses, drawn in the positive tone */
      'editorCodeLens.foreground': '#3f7a66'
    }
  })

  // Allow `*` in word pattern for quick styling (toggle bold/italic without selection)
  // original https://github.com/microsoft/vscode/blob/3e5c7e2c570a729e664253baceaf443b69e82da6/extensions/markdown-basics/language-configuration.json#L55
  monaco.languages.setLanguageConfiguration('markdown', {
    wordPattern:
      /([*_]{1,2}|~~|`+)?[\p{Alphabetic}\p{Number}\p{Nonspacing_Mark}]+(_+[\p{Alphabetic}\p{Number}\p{Nonspacing_Mark}]+)*\1/gu
  })

  editor = monaco.editor.create(monacoRef.value, {
    automaticLayout: true,
    cursorBlinking: 'blink',
    fontSize: resolveEditorFontSize(userSettings),
    /*
      Written out because Monaco otherwise falls back to its own generic monospace stack, not this
      app's `--font-mono`. `lineHeight` is a ratio: Monaco treats anything under 8 as a multiplier of
      `fontSize` rather than a pixel value. Both mirror `composables/monacoDiff.js`.
    */
    fontFamily: "'Roboto Mono', Consolas, 'Liberation Mono', Courier, monospace",
    lineHeight: 1.85,
    formatOnType: true,
    language: 'markdown',
    lineNumbersMinChars: 4,
    padding: { top: 10, bottom: 10 },
    scrollBeyondLastLine: false,
    tabSize: 2,
    theme: monacoThemeName(aesthetic.current),
    value: pageStore.content,
    wordWrap: 'on'
  })

  /*
    A code lens rather than a context-menu action: the offer has to be visible to be found. It appears
    only over the tables the overlay can actually hold (`findEditableTables`) -- offering it over a
    table with a multi-line cell or a rowspan would be offering to flatten it.

    The PROVIDER is per-language and process-wide, so it has to be disposed with the component or a
    second visit to the editor draws every lens twice.
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
    The same idea for a block's parameters, which are a list of quoted attributes on one line. It
    appears only over a block this editor holds a definition for: a child block -- a `::block-tab`
    inside a tabset -- is left out of the list the API answers with, having no switch of its own.
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
    // TODO: this only swallows the browser's own save dialog -- Ctrl+S never reaches `pageSave()`,
    //       and nothing else in the app binds it. Wire it up or drop the action.
    run(ed) {}
  })

  debouncedContentChange = debounce((ev) => {
    editorStore.markDirty()
    // -> What the author has typed IS the source, whatever the load did or did not deliver; see
    //    the guard in `pageSave`
    pageStore.contentLoaded = true
    flushEditorContent()
  }, 500)
  editor.onDidChangeModelContent(debouncedContentChange)

  debouncedCursorPositionChange = debounce((ev) => {
    if (!state.previewScrollSync || !state.previewShown) {
      return
    }
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
    Paste is CAPTURED on the element ABOVE the editor, and that is the whole trick: Monaco's own
    paste-as feature (`CopyPasteController`) listens in the capture phase on the editor's container and
    calls `stopImmediatePropagation()` for every paste it claims, files included, so a listener on that
    container or below it is never reached in either phase. Capture runs outside-in, so one level up
    goes first.
  */
  pasteCaptureNode = monacoRef.value.parentElement ?? monacoRef.value
  pasteCaptureNode.addEventListener('paste', onEditorPaste, true)
  monacoRef.value.addEventListener('dragover', onEditorDragOver)
  monacoRef.value.addEventListener('drop', onEditorDrop)

  startCollab(editor)

  /*
    Monaco is a lazy chunk and everything above this line is async, so this can land well after the
    editor has visibly mounted. Focusing unconditionally would steal focus from wherever the author
    has moved in that window -- typing into the Title field mid-init lost every keystroke to the
    editor. A fresh mount's `document.activeElement` is `<body>`, so that is the one case to claim.
  */
  if (document.activeElement === document.body) {
    editor.focus()
  }

  nextTick(() => {
    processContent(pageStore.content)
  })

  EVENT_BUS.on('insertAsset', insertAssetClb)
  EVENT_BUS.on('insertTable', insertTableClb)
  EVENT_BUS.on('insertBlock', insertBlockClb)
  EVENT_BUS.on('reloadEditorContent', reloadEditorContent)

  editorStore.contentFlusher = flushEditorContentForSave
})

onBeforeUnmount(() => {
  EVENT_BUS.off('insertAsset', insertAssetClb)
  EVENT_BUS.off('insertTable', insertTableClb)
  EVENT_BUS.off('insertBlock', insertBlockClb)
  EVENT_BUS.off('reloadEditorContent', reloadEditorContent)
  pasteCaptureNode?.removeEventListener('paste', onEditorPaste, true)
  monacoRef.value?.removeEventListener('dragover', onEditorDragOver)
  monacoRef.value?.removeEventListener('drop', onEditorDrop)
  // -> Only if it is still this instance's, so a second mount's registration is not torn down by the
  //    first's unmount in whatever order the two settle
  if (editorStore.contentFlusher === flushEditorContentForSave) {
    editorStore.contentFlusher = null
  }
  // -> Registered against the markdown language, not this editor, so nothing else takes them down
  tableLensProvider?.dispose()
  blockLensProvider?.dispose()
  debouncedContentChange?.cancel()
  debouncedCursorPositionChange?.cancel()
  clearTimeout(insertAssetFocusTimeout)
  // -> Before the editor goes: the collab watchers still reach for it and the binding holds the model
  stopCollab()
  if (editor) {
    editor.dispose()
  }
})
</script>

<style>
@charset "UTF-8";
/*
  TODO: this component's own chrome -- both toolbar bands, the source pane's frame, the preview pane's
  -- still reads bare Ledger colour values rather than the `--color-*`/`--radius-*` tokens Cobalt
  overrides, so it stays Ledger-flavoured under Cobalt. Legible, but off-language; a full pass is
  dozens of call sites. The render preview itself is fine: it inherits `_page-contents.css` through
  its `page-contents` class.
*/
.editor-markdown {
  /*
    Percentage heights all the way down rather than a viewport calc (`100vh` minus every fixed-height
    bar above this one), which needed a new hardcoded term -- exactly right -- every time a bar was
    added or resized above it. `Index.vue`'s `.page-container` already hands its row a definite height
    via `items-stretch`, so inheriting is enough.
  */
  height: 100%;
  min-height: 0;
  /*
    Pointer capture already keeps a drag tracking once the pointer leaves the divider -- the
    `is-resizing` rules below are only about what the pointer looks like, and about stopping Monaco
    or the preview text from being selected as it sweeps across them mid-drag.
  */
}
.editor-markdown.is-resizing {
  cursor: col-resize;
}
.editor-markdown.is-resizing * {
  cursor: col-resize !important;
  user-select: none !important;
}
.editor-markdown-main {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
}
.editor-markdown-mid {
  /*
    The same value the Monaco theme paints behind the text, so nothing shows through as a different
    dark while Monaco is still measuring itself.
  */
  background-color: var(--color-dark-4);
  flex: 1 1 50%;
  display: block;
  height: 100%;
  position: relative;
  /*
    The seam facing the preview pane, in the border tone rather than the accent: Cardinal reserves the
    accent for the live edge, and a permanent red rule down the middle of the editor is not one.
    Logical, so it mirrors with the panes under `dir="rtl"`.
  */
  border-inline-end: 5px solid var(--color-hairline);
  /*
    Monaco writes its measured width in pixels onto its own elements, so this item's automatic
    min-content min-width pins it to the full width it took while the preview was closed -- bringing
    the preview back then leaves it whatever the flex line has left over, and Monaco never
    re-measures because its container never shrinks. Zero lets the basis decide instead.
  */
  min-width: 0;
}
.editor-markdown-editor {
  display: block;
  /* -> Whatever `-toolbar` above it is tall; the two move together or Monaco overflows the column */
  height: calc(100% - 40px);
  position: relative;
}
.editor-markdown-editor > div {
  height: 100%;
}
.editor-markdown {
  /* -> The rail's label, set in Cardinal's chrome overline */
}
.editor-markdown-type {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  padding: 12px 0;
  color: var(--color-text-caption);
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}
.editor-markdown-divider {
  flex: 0 0 auto;
  width: 9px;
  height: 100%;
  position: relative;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
  /*
    `-mid`'s own `border-inline-end` is already the seam's permanent line, so the `::after` below is
    a highlight on top of it only while the divider is grabbed or hovered -- not a second, always-on
    stripe beside it.
  */
}
.editor-markdown-divider::after {
  content: '';
  position: absolute;
  inset-block: 0;
  inset-inline-start: 3px;
  width: 3px;
  background-color: var(--color-primary);
  opacity: 0;
  transition: opacity 0.15s ease;
}
.editor-markdown-divider:hover::after,
.editor-markdown-divider.is-dragging::after {
  opacity: 0.6;
}
.editor-markdown-preview {
  flex: 0 1 50%;
  position: relative;
  height: 100%;
  overflow: hidden;
  /*
    Paper, not a grey: the preview sits on the same ground the article column uses, so what an author
    sees beside the source is the page as it will actually be read.
  */
}
.body--light .editor-markdown-preview {
  background-color: var(--color-surface);
}
.body--dark .editor-markdown-preview {
  background-color: var(--color-dark-3);
}
.editor-markdown-preview {
  /*
    `previewInlineStyle` sets `--preview-width` only once a width has actually been dragged or loaded
    from a saved one, so the `50vw` fallback written into every use of it below is what a reader who
    has never touched the divider gets.
  */
}
.editor-markdown-preview-enter-active,
.editor-markdown-preview-leave-active {
  transition: max-width 0.5s ease;
  max-width: var(--preview-width, 50vw);
}
.editor-markdown-preview-enter-active .editor-markdown-preview-content,
.editor-markdown-preview-leave-active .editor-markdown-preview-content {
  width: var(--preview-width, 50vw);
  overflow: hidden;
}
.editor-markdown-preview-enter-from,
.editor-markdown-preview-leave-to {
  max-width: 0;
}
.editor-markdown-preview {
  /*
    The pane's one-time entrance (`previewEverRevealed`), on `WDrawer.vue`'s own `0.2s` and curve so
    the side nav sliding away and this opening read as one movement. `opacity` is added on top of
    `max-width` only here: this variant opens onto a still-resolving layout, where a border, shadow or
    the toolbar's ground could otherwise read as a sliver of "something" at the start.
  */
}
.editor-markdown-preview-initial-enter-active,
.editor-markdown-preview-initial-leave-active {
  transition:
    max-width 0.2s var(--ease-standard),
    opacity 0.2s var(--ease-standard);
  max-width: var(--preview-width, 50vw);
}
.editor-markdown-preview-initial-enter-active .editor-markdown-preview-content,
.editor-markdown-preview-initial-leave-active .editor-markdown-preview-content {
  width: var(--preview-width, 50vw);
  overflow: hidden;
}
.editor-markdown-preview-initial-enter-from,
.editor-markdown-preview-initial-leave-to {
  max-width: 0;
  opacity: 0;
}
.editor-markdown-preview {
  /*
    The pane's header gets no ground of its own: it is the paper the render sits on, ruled off by a
    hairline, the way page chrome is separated everywhere else in Cardinal.
  */
}
.editor-markdown-preview-toolbar {
  color: var(--color-slate);
  height: 40px;
  display: flex;
  align-items: center;
  padding: 0 12px;
}
.body--light .editor-markdown-preview-toolbar {
  background-color: var(--color-surface);
  border-bottom: 1px solid var(--color-hairline);
}
.body--dark .editor-markdown-preview-toolbar {
  background-color: var(--color-dark-3);
  border-bottom: 1px solid var(--color-hairline-dark);
  color: var(--color-text-secondary-dark);
}
.editor-markdown-preview-toolbar {
  /*
    `align-self: stretch` sizes each button to the band, so its hover fills the whole content height
    with no gap; `min-height: 0` clears WBtn's taller default, and needs `!important` because WBtn
    writes that default as an inline style.
  */
}
.editor-markdown-preview-toolbar .w-btn {
  align-self: stretch;
  min-height: 0 !important;
}
.editor-markdown-preview-toolbar {
  /*
    Only the face is stated: colour comes from `-toolbar`'s own `color` above, which already resolves
    per aesthetic.
  */
}
.editor-markdown-preview-toolbar-title {
  font: italic 600 12px var(--font-sans);
}
.editor-markdown-preview-content {
  height: calc(100% - 40px);
  overflow-y: scroll;
  padding: 22px 24px;
  max-width: calc(var(--preview-width, 50vw) - 57px);
}
.editor-markdown-preview-content > div {
  outline: none;
}
.editor-markdown-preview-content p.line {
  overflow-wrap: break-word;
}
.editor-markdown-preview-content {
  /*
    This pane is half a screen wide, not a full reading column, so its type runs a shade smaller than
    the published article's. Everything but size already comes out right by inheriting
    `_page-contents.css` through the shared `page-contents` class, so only `font-size` is restated --
    combined with `.page-contents` for specificity over that file rather than relying on load order.
  */
}
.editor-markdown-preview-content.page-contents h2 {
  font-size: 25px;
}
.editor-markdown-preview-content.page-contents p {
  font-size: 15px;
  line-height: 1.7;
}
.editor-markdown-preview-content.page-contents {
  /* -> `pre`'s own code stays at the shared file's size; only an inline span shrinks here */
}
.editor-markdown-preview-content.page-contents :not(pre) > code {
  font-size: 13.5px;
  color: var(--color-slate);
}
.editor-markdown-preview-content.page-contents {
  /*
    The GitHub-alert label reads as a flat mono eyebrow in one neutral tone here, unlike the published
    article's hue-per-kind title (`_page-contents.css`'s `.alert-title`, keyed to `--alert-hue`).
  */
}
.editor-markdown-preview-content.page-contents .alert-title {
  font: 600 9.5px/normal var(--font-mono);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
}
.editor-markdown-preview-content {
  /*
    Editor-only: the server strips a disabled block on save, so no reader meets one. Built from the
    admonition palette `.page-contents` already declares, which is what covers both themes without a
    rule of its own here.
  */
}
.editor-markdown-preview-content [data-block-disabled] {
  display: block;
  margin: 1rem 0;
  padding: 0.75rem 1rem;
  border-inline-start: 4px solid var(--content-danger);
  background-color: var(--content-danger-wash);
  color: var(--content-ink-muted);
}
.editor-markdown-preview-content .block-disabled-notice {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  color: var(--content-danger);
  font-size: 0.85rem;
  font-weight: 600;
  /* -> The glyph below is drawn as a mask so it takes this colour rather than one of its own */
}
.editor-markdown-preview-content .block-disabled-notice::before {
  content: '';
  flex: 0 0 auto;
  width: 1.1rem;
  height: 1.1rem;
  background-color: currentColor;
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M13 14h-2V9h2m0 9h-2v-2h2M1 21h22L12 2z'/%3E%3C/svg%3E");
  mask-repeat: no-repeat;
  mask-size: contain;
}
.editor-markdown-preview-content {
  /* -> Spacing under the notice, above whatever the author wrote inside the disabled block */
}
.editor-markdown-preview-content [data-block-disabled] > .block-disabled-notice + * {
  margin-top: 0.5rem;
}
.editor-markdown-preview-content .tabset {
  background-color: var(--color-teal-7);
  color: var(--color-teal-2) !important;
  padding: 5px 12px;
  font-size: 14px;
  font-weight: 500;
  font-style: italic;
}
.editor-markdown-preview-content .tabset::after {
  display: none;
}
.editor-markdown-preview-content .tabset-header {
  background-color: var(--color-teal-5);
  color: #fff !important;
  padding: 5px 12px;
  font-size: 14px;
  font-weight: 500;
  margin-top: 0 !important;
}
.editor-markdown-preview-content .tabset-header::after {
  display: none;
}
.editor-markdown-preview-content .tabset-content {
  border-inline-start: 5px solid var(--color-teal-5);
  background-color: var(--color-teal-1);
  padding: 0 15px 15px;
  overflow: hidden;
  /* -> This panel's dark-mode tint is the unnested `.body--dark` rule at the foot of this block */
}
.editor-markdown {
  /*
    The markup bar is chrome, so it is the continuous light slate the rest of the app's chrome is --
    tinted strip, hairline underneath, slate glyphs. The accent is reserved for the live edge, not
    spent across the top of the screen an author spends the most time on.
  */
}
.editor-markdown-toolbar {
  height: 40px;
  padding: 0 8px;
  display: flex;
  align-items: center;
}
.body--light .editor-markdown-toolbar {
  background-color: var(--color-tint);
  border-bottom: 1px solid var(--color-hairline);
  color: var(--color-slate);
}
.body--dark .editor-markdown-toolbar {
  background-color: var(--color-dark-2);
  border-bottom: 1px solid var(--color-hairline-dark);
  color: var(--color-text-secondary-dark);
}
.editor-markdown-toolbar {
  /*
    `align-self: stretch` sizes each button to the band, so its hover fills the whole content height.
    `WBtn`'s default min-height is taller than the band and would overflow it -- invisibly, until a
    flat button's hover fill paints that overflow -- and `min-height: 0` needs `!important` because
    `WBtn` sets that default as an inline style. Scoped here: every other caller keeps the default.
  */
}
.editor-markdown-toolbar .w-btn {
  align-self: stretch;
  min-height: 0 !important;
}
.editor-markdown-toolbar {
  /* -> The chevron on a menu-opening button: the fainter of the two icon tones */
}
.editor-markdown-toolbar-caret {
  margin-inline-start: 1px;
  color: var(--color-slate-soft);
}
.body--dark .editor-markdown-toolbar-caret {
  color: var(--color-slate-light);
}
.editor-markdown-toolbar {
  /*
    A 20px group rule, not a full-height divider. The colour goes through `--w-hairline-color`
    because `.w-hairline` paints its line on an `::after` and is itself transparent
    (`css/tailwind.css`); `WSeparator`'s own `self-stretch`/`h-auto` are Tailwind utilities, which
    this unlayered rule outranks without `!important`.
  */
}
.editor-markdown-toolbar-rule {
  height: 20px;
  margin: 0 5px;
  align-self: center;
  --w-hairline-color: var(--color-hairline);
}
.body--dark .editor-markdown-toolbar-rule {
  --w-hairline-color: var(--color-hairline-dark);
}
.editor-markdown {
  /*
    The insert rail, light slate like the toolbar beside it and ruled off by the same hairline: the
    two together read as one continuous piece of chrome wrapping the dark editor.
  */
}
.editor-markdown-sidebar {
  width: 48px;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-items: center;
  padding: 8px 0;
}
.body--light .editor-markdown-sidebar {
  background-color: var(--color-tint);
  border-inline-end: 1px solid var(--color-hairline);
  color: var(--color-slate);
}
.body--dark .editor-markdown-sidebar {
  background-color: var(--color-dark-2);
  border-inline-end: 1px solid var(--color-hairline-dark);
  color: var(--color-text-secondary-dark);
}
.editor-markdown-sidebar {
  /*
    A 34px cell spanning the rail's whole width, so its hover reaches both long edges:
    `align-self: stretch` overrides the rail's `align-items: center`, which the caption below still
    uses. `!important` because both the button's padding and `WBtn`'s min-height are inline styles.
  */
}
.editor-markdown-sidebar .w-btn {
  align-self: stretch;
  min-height: 34px !important;
  padding: 0 !important;
}
/*
  Unnested, and at the foot of the block rather than beside the rule it overrides, because
  `.body--dark` sits in front of the whole selector. `composables/dark.js` is the one source of truth
  for dark mode and is what toggles that class on `<body>`.
*/
.body--dark .editor-markdown-preview-content .tabset-content {
  background-color: color-mix(in srgb, var(--color-teal-5) 10%, transparent);
}
</style>
