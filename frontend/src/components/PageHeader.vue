<template>
  <div class="page-header flex flex-wrap">
    <!--
      Logical spacing utilities rather than physical ones: the flex axis already reorders this row
      under `dir="rtl"`, but a physical gap would stay on the side it names instead of following
      whichever element just moved.
    -->
    <!--
      The plate is the same box whether the page is being read or edited; only its contents change,
      so the masthead's geometry does not shift the moment an author starts editing. Its ground,
      edge, radius and glyph come from `--page-header-icon-*` rather than utilities, because it sits
      INSIDE the masthead and has to follow whichever aesthetic the masthead is drawn in.
    -->
    <div class="flex-none ps-4 flex items-center">
      <div class="page-header-icon flex flex-none items-center justify-center" :style="plateStyle">
        <i class="page-header-icon__marks" aria-hidden="true" />
        <w-btn
          v-if="isEditing"
          padding="none"
          :size="glyphSize"
          flat
          :aria-label="t(`editor.props.icon`)"
          :style="{ minHeight: glyphSize, width: glyphSize }">
          <w-icon :name="pageStore.icon" :size="glyphSize" />
          <w-menu content-class="shadow-7">
            <icon-picker-dialog :model-value="pageStore.icon" @update:model-value="setIcon" />
          </w-menu>
        </w-btn>
        <w-icon v-else :name="pageStore.icon" :size="glyphSize" />
      </div>
    </div>
    <!--
      The editable spans are deliberately not interpolated: Vue would rewrite the text node on every
      keystroke as the store echoes it back, putting the caret at its start. `syncEditable` writes
      them instead, and only when element and store have actually diverged.
    -->
    <!--
      Centred rather than top-aligned: with no description the title is this column's only line, and
      at the top it sat above the middle of the icon beside it.
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
        <span v-else ref="titleDisplayEl">{{ displayedTitle }}</span>
      </h1>
      <div class="page-header-subtitle">
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
    <!--
      `has-editor-actions` keeps this row on a phone, where it is otherwise hidden: while a page is
      being read it holds a handful of icons, but while one is being WRITTEN it holds the only way
      to save or to get back out.
    -->
    <!--
      The `tabindex` guards below: while the page is being edited Tab must flow title ->
      description -> the editor's own content, and this row sits between them in DOM order. The
      buttons that never render while `isEditing` can be true need no such guard.
    -->
    <div
      class="page-header-actions flex-none p-4 flex items-center justify-end"
      :class="{ 'has-editor-actions': hasEditorActions }">
      <template v-if="!editorStore.isActive">
        <!--
          Not gated on being logged in the way the actions beside it are: whoever is looking at a
          draft can already see it, and this only tells them what they are reading.
        -->
        <w-badge
          v-if="pageStore.publishState === `draft`"
          color="negative"
          :label="t(`editor.props.draft`)" />
        <w-btn
          class="ms-4"
          :class="{ 'is-ringing': state.bellRinging, 'is-watching': pageStore.isWatching }"
          v-if="userStore.authenticated && !isRedirect"
          flat
          :icon="pageStore.isWatching ? `tabler:bell-filled` : `tabler:bell`"
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
          icon="tabler:printer"
          :aria-label="t('common.actions.print')"
          @click="printPage">
          <w-tooltip>{{ t('common.actions.print') }}</w-tooltip>
        </w-btn>
      </template>
      <template v-if="editorStore.isActive">
        <!--
          Persistent, not a toast: a disconnected socket can sit retrying for a good while while
          edits keep being made and kept locally -- something to glance at on and off, not a message
          that has to be caught in the few seconds it was on screen.
        -->
        <div
          v-if="collabStore.status === 'disconnected'"
          class="collab-disconnected me-2 flex items-center gap-1 text-warning"
          role="status"
          aria-live="polite">
          <w-icon name="tabler:wifi-off" size="18px" />
          <span class="text-caption">{{ t('editor.collab.disconnected') }}</span>
        </div>
        <collab-presence class="me-2" />
        <w-btn
          class="ms-4"
          icon="tabler:help-circle"
          flat
          color="slate-soft"
          :href="siteStore.docsBase + `/guide/editors/${editorStore.editor}`"
          target="_blank"
          type="a"
          :tabindex="isEditing ? -1 : undefined">
          <w-tooltip labels>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
      </template>
      <!--
        Not `v-else-if` on the block below: changes made from the page properties panel put the
        header into the pending state without an editor behind it, and hiding Edit there would leave
        no way back into the content at all. Ahead of the commit actions so those stay rightmost.
      -->
      <template v-if="!editorStore.isActive && userStore.can(`write:pages`)">
        <!--
          The one filled button on this surface, per Cardinal's one-filled-button-per-surface rule;
          everything else in the row is a bare icon in the chrome tone.
        -->
        <w-btn
          class="ms-4"
          icon="tabler:edit"
          color="accent"
          :label="t(`common.actions.edit`)"
          :aria-label="t(`common.actions.edit`)"
          @click="editPage" />
      </template>
      <!--
        Never on a redirection: a suggestion is a rewrite of a page's text, and a redirection has no
        text. The server answers `canSuggestEdits` from approval rules written against paths, which
        know nothing about editors, so the editor check belongs here.
      -->
      <template v-else-if="!editorStore.isActive && pageStore.canSuggestEdits && !isRedirect">
        <w-btn
          class="ms-4"
          icon="tabler:edit"
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
          @click="suggestEdits" />
      </template>
      <template v-if="editorStore.isActive || editorStore.hasPendingChanges">
        <w-btn
          class="ms-2"
          outline
          icon="tabler:x"
          color="accent"
          :label="
            editorStore.hasPendingChanges ? t(`common.actions.discard`) : t(`common.actions.close`)
          "
          :aria-label="
            editorStore.hasPendingChanges ? t(`common.actions.discard`) : t(`common.actions.close`)
          "
          :tabindex="isEditing ? -1 : undefined"
          @click="discardChanges" />
        <w-btn
          class="ms-2"
          v-if="isSuggesting"
          icon="tabler:send"
          color="positive"
          :label="t(`common.actions.submitEdits`)"
          :aria-label="t(`common.actions.submitEdits`)"
          :disabled="!editorStore.hasPendingChanges"
          @click="submitSuggestion" />
        <w-btn
          class="ms-2"
          v-else-if="editorStore.mode === `create`"
          icon="tabler:check"
          color="positive"
          :label="t(`editor.createPage`)"
          :aria-label="t(`editor.createPage`)"
          :tabindex="isEditing ? -1 : undefined"
          @click="createPage" />
        <w-btn-group class="ms-2" v-else>
          <w-btn
            icon="tabler:check"
            color="positive"
            :label="t(`common.actions.saveChanges`)"
            :aria-label="t(`common.actions.saveChanges`)"
            :disabled="!editorStore.hasPendingChanges"
            :tabindex="isEditing ? -1 : undefined"
            @click.exact="saveChanges(false)"
            @click.ctrl.exact="saveChanges(true)" />
          <template v-if="editorStore.isActive">
            <w-separator vertical />
            <w-btn
              icon="tabler:checks"
              color="positive"
              :aria-label="t(`common.actions.saveAndClose`)"
              :disabled="!editorStore.hasPendingChanges"
              :tabindex="isEditing ? -1 : undefined"
              @click="saveChanges(true)">
              <w-tooltip>{{ t(`common.actions.saveAndClose`) }}</w-tooltip>
            </w-btn>
          </template>
        </w-btn-group>
      </template>
    </div>
    <!--
      Gated on `!hasOpenSuggestion`: once this reader has a newer suggestion open on the page, the
      outcome of the one before it is no longer what they are here to see. `w-full` on a flex-wrap
      row puts this on its own line, whichever of the parts above wrapped.

      Literal colour classes because `WBanner` has no `color` prop, which would be silently dropped.
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

/**
 * Must match the `w-bell-ring` animation's duration below: the class has to come off once it has
 * played, or the next watch would not replay it.
 */
const BELL_RING_MS = 700

const { isActive: pathDisplayActive, humanize } = usePathDisplay()

/**
 * A deliberate override of whatever title the page was saved with when the site's path-display
 * setting is on, not a fallback for a page with no title. Read only by the reading-mode span: the
 * `contenteditable` field beside it binds `pageStore.title` directly, since editing a page's real
 * title must never be short-circuited by a display-only setting.
 */
const displayedTitle = computed(() => {
  if (!pathDisplayActive.value) {
    return pageStore.title
  }
  const segments = pageStore.path.split('/')
  return humanize(segments[segments.length - 1])
})

const collabStore = useCollabStore()
const editorStore = useEditorStore()
const flagsStore = useFlagsStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const router = useRouter()

const { t } = useI18n()

/**
 * 600px is the `sm` breakpoint in `css/tailwind.css`; the media query at the foot of this file
 * compacts the header on the same boundary.
 */
const isAtLeastSm = useMinWidth(600)
const isPhoneViewport = computed(() => !isAtLeastSm.value)

/**
 * Sized in JS rather than by a media query: `WIcon` renders `size` as an inline `font-size`, which
 * no stylesheet can outrank without `!important`.
 */
const plateSize = computed(() => (isPhoneViewport.value ? '36px' : '64px'))
const glyphSize = computed(() => (isPhoneViewport.value ? '20px' : '34px'))
const plateStyle = computed(() => ({ width: plateSize.value, height: plateSize.value }))

/**
 * The editor's own controls must survive the phone layout, and the properties panel can put the
 * header into the pending state with no editor open, so `isActive` alone is not the question.
 */
const hasEditorActions = computed(() => editorStore.isActive || editorStore.hasPendingChanges)

const isSuggesting = computed(() => editorStore.isActive && editorStore.mode === 'suggest')

/** Excludes suggest mode: a submitter has no say over the page's icon, title or description. */
const isEditing = computed(() => editorStore.isActive && !isSuggesting.value)

/**
 * True of a redirection being read, edited or created alike, since `pageCreate` puts the editor on
 * the page store as well. What it takes out of this row is everything addressed to a READER —
 * watching the page, suggesting a change to it — since nobody stays on a redirection long enough
 * for those to mean anything. The title, the icon and Edit belong to whoever maintains it and stay.
 */
const isRedirect = computed(() => pageStore.editor === 'redirect')

const state = reactive({
  bellRinging: false
})

const titleEl = ref(null)
const descriptionEl = ref(null)

/**
 * Exposed so `Index.vue` can run its keyword-highlight pass over the title too: the title lives in
 * a separate DOM subtree from `.page-contents`, so a `?highlight=` term would otherwise miss it.
 */
const titleDisplayEl = ref(null)

defineExpose({ titleDisplayEl })

/*
  `immediate` covers arriving with the editor already open, where the fields appear in the same tick
  as this runs.
*/
watch(
  () => isEditing.value,
  (editing) => editing && seedEditables(),
  { immediate: true }
)

/*
  The properties panel edits both of these and a save replaces the whole page, so the field follows.
  A change that came FROM the field is already in the element, and `syncEditable` leaves it alone.
*/
watch(
  () => pageStore.title,
  (title) => syncEditable(titleEl.value, title)
)
watch(
  () => pageStore.description,
  (description) => syncEditable(descriptionEl.value, description)
)

/**
 * Writing `textContent` collapses the selection to the node's start, so it is only done when the
 * element and the store have actually diverged — which is never mid-keystroke, since the keystroke
 * is where the store's value came from.
 */
function syncEditable(el, value) {
  if (el && el.textContent !== (value ?? '')) {
    el.textContent = value ?? ''
  }
}

async function seedEditables() {
  await nextTick()
  syncEditable(titleEl.value, pageStore.title)
  syncEditable(descriptionEl.value, pageStore.description)
}

/**
 * Bound through the event rather than `v-model`: `v-model` would write the store alone, leaving the
 * editor undirtied. An icon is part of the page, so changing it is an unsaved change.
 */
function setIcon(icon) {
  pageStore.icon = icon
  editorStore.markDirty()
}

function onEditableInput(field, event) {
  // -> Clearing the field leaves a browser-inserted `<br>` behind, which adds nothing to the text
  //    but does hold a second line open under the placeholder
  if (event.target.textContent === '' && event.target.innerHTML !== '') {
    event.target.innerHTML = ''
  }
  pageStore[field] = event.target.textContent
  editorStore.markDirty()
}

/*
  Tidied on the way out rather than as it is typed: collapsing whitespace under the caret would move
  it while someone is still going.
*/
function onEditableBlur(field, event) {
  const tidied = event.target.textContent.replace(/\s+/g, ' ').trim()
  if (tidied !== pageStore[field]) {
    pageStore[field] = tidied
    editorStore.markDirty()
  }
  syncEditable(event.target, tidied)
}

const { discardChanges, saveChanges } = usePageSaveFlow({
  isSuggesting,
  processPendingAssets
})

async function createPage() {
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
      editorStore.clearPendingAssets()
      router.replace('/')
    } catch (err) {
      notify({
        type: 'negative',
        message: t('common.page.homepageCreateFailed'),
        caption: apiErrorMessage(err)
      })
    }
    loading.hide()
    return
  }

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
      editorStore.clearPendingAssets()
    } catch (err) {
      notify({
        type: 'negative',
        message: t('common.page.createFailed'),
        caption: apiErrorMessage(err)
      })
    }
    loading.hide()
  })
}

/**
 * Resolves `true` when the caller may proceed with the save/create it was about to do, `false` when
 * the upload was cancelled or failed. Resolves rather than rejecting on cancel: no call site awaits
 * this inside a try/catch, and `dialog()`'s `.onCancel(cb)` passes no argument, so rejecting would
 * surface as an unhandled rejection with no message.
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

async function suggestEdits() {
  loading.show()
  try {
    await pageStore.pageSuggest()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('common.page.suggestFailed'),
      caption: apiErrorMessage(err)
    })
  }
  loading.hide()
}

/**
 * A guest is asked who they are first: nothing else records that, and a reviewer has to be able to
 * answer them.
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
    // -> What was typed is a suggestion waiting for a reviewer, not a version of the page, so the
    //    editor must not stay open on it
    editorStore.$patch({
      isActive: false,
      editor: '',
      mode: 'edit'
    })
    editorStore.clearPendingAssets()
    await pageStore.pageLoad({ id: pageStore.id })
    notify({
      type: 'positive',
      message: t('common.page.suggestSubmitted'),
      // -> Only an account can be matched to a suggestion afterwards, so only a logged-in author is
      //    told they can come back to it
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
 * The bell rings on the way IN only: the swing says the page will now tell you about itself, and
 * replaying it for switching that off would say the opposite with the same gesture.
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
      caption: apiErrorMessage(err)
    })
  }
}
</script>

<style scoped>
/*
  One equal target box for every button in this row, so a reader aiming at any of them aims at the
  same size. Written as a child combinator rather than a class, so a button added later inherits it;
  `>` deliberately stops at the row's own children, leaving the save/save-and-close pair inside
  `w-btn-group` alone -- a group is one control with its own internal seam.

  `!important` because `WBtn` writes `min-height` and `padding` as INLINE styles, which no class
  beats on specificity alone.
*/
.page-header-actions > .w-btn {
  min-height: 2.572em !important;
  padding: 0 1.12em !important;
}

/*
  The secondary actions' own plate, through the `--page-header-action-*` tokens: Ledger leaves them
  bare icons in the chrome tone, while Cobalt needs a plate, since a chrome-tone glyph on its
  saturated band is not legible.

  Matched on the flat buttons only -- Edit takes no `flat` and paints itself as this row's one
  accent fill, and a labelled button (Save, Close) keeps `WBtn`'s own treatment.
*/
.page-header-actions > .w-btn.w-btn--flat {
  background-color: var(--page-header-action-bg);
  color: var(--page-header-action-fg);
  border-radius: var(--radius-control);
}

/*
  The watched state as a class rather than `WBtn`'s `color` prop: that prop writes an inline colour
  on the button root, which always beats the rule above and would drag the unwatched state off
  `--page-header-action-fg` with it. Written one class more specific than that rule, so it wins on
  specificity rather than on source order.
*/
.page-header-actions > .w-btn.w-btn--flat.is-watching {
  color: var(--color-accent);
}

/*
  The phone layout of this row. Unlayered scoped rules, so they beat the `text-h4` utility without
  needing `!important`; the size is written as a value rather than as `text-h5` so it lives beside
  the breakpoint that asks for it.

  The reader actions go entirely: icons squeezed against the edge of a row with no room for the
  title as it is, and nothing among them that is not reachable elsewhere. An editor already open
  keeps its controls, or there would be no way to save or leave it.
*/
@media (max-width: 599.98px) {
  .page-header-title {
    font-size: 1.5rem;
    line-height: 2rem;
  }

  .page-header-actions:not(.has-editor-actions) {
    display: none;
  }
}

/*
  On the icon rather than the button, so the ripple, the hover tint and the hit area all stay where
  they are while only the drawing moves; `transform-origin` at the top centre swings it from its
  mounting instead of spinning it about its middle. `:deep` because `WBtn` renders the icon and a
  scoped rule would not reach into it.
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

@media (prefers-reduced-motion: reduce) {
  .is-ringing :deep(svg) {
    animation: none;
  }
}

/* -> `position: relative` is the corner marks' containing block. */
.page-header-icon {
  position: relative;
  background-color: var(--page-header-icon-bg);
  border: var(--page-header-icon-border);
  border-radius: var(--page-header-icon-radius);
  color: var(--page-header-icon-fg);
}

/*
  Ledger's plate and glyph are both light-mode values, so the dark theme swaps them here rather than
  through a second value on the tokens: Cobalt's plate is the same translucent white well carrying a
  white glyph in BOTH themes, which is why it is excluded instead.
*/
.body--dark:not(.body--cobalt) .page-header-icon {
  background-color: var(--color-dark-4);
  border-color: var(--color-hairline-dark);
  color: var(--color-accent-dark);
}

/* -> Hidden under Cobalt through the token rather than a Cobalt-only rule; its plate is bounded by
   its own radius instead. */
.page-header-icon__marks {
  display: var(--corner-marks);
}

/*
  One absolutely-positioned box whose four corners are painted by pairs of background gradients: a
  pseudo-element would give two corners at most, and four real nodes would put decoration in the
  accessibility tree.
*/
.page-header-icon__marks {
  position: absolute;
  inset: -5px;
  pointer-events: none;
  background:
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 0 0 / 7px 1px no-repeat,
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 0 0 / 1px 7px no-repeat,
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 100% 0 / 7px 1px no-repeat,
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 100% 0 / 1px 7px no-repeat,
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 0 100% / 7px 1px no-repeat,
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 0 100% / 1px 7px no-repeat,
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 100% 100% / 7px 1px no-repeat,
    linear-gradient(var(--color-slate-soft), var(--color-slate-soft)) 100% 100% / 1px 7px no-repeat;
}

/*
  No border and no focus ring: at rest each heading has to read exactly as it does when the page is
  being read, which is the whole point of editing it where it sits. What says "type here" is the
  hover tint, the caret and the placeholder below.

  The padding is cancelled by an equal negative margin, so the text keeps the position it has
  outside the editor and only the tint is inset from it.
*/
.page-header-editable {
  display: inline-block;
  padding: 0 4px;
  margin: 0 -4px;
  outline: none;
  cursor: text;
  transition: background-color 0.15s var(--ease-standard);

  &:hover {
    background-color: rgb(0 0 0 / 0.06);
  }
  &:focus {
    background-color: rgb(0 0 0 / 0.09);
  }

  .body--dark & {
    &:hover {
      background-color: rgb(255 255 255 / 0.08);
    }
    &:focus {
      background-color: rgb(255 255 255 / 0.12);
    }
  }
}

/*
  Keyed off the store rather than `:empty`, which a cleared field can fail: the browser leaves a
  `<br>` behind and the element stops counting as empty even though it looks it.
*/
.page-header-editable.is-empty::before {
  content: attr(data-placeholder);
  opacity: 0.4;
  pointer-events: none;
  user-select: none;
}
</style>
