<template>
  <w-page class="inbox-review flex flex-col">
    <template v-if="!state.selected">
      <div class="w-section-header">{{ t('inbox.pendingReview') }}</div>
      <!--
        No top padding: the band already trails the rhythm's 14px below itself, so a `pt-4` here
        would stack a second gap on top of it.
      -->
      <div class="px-4 pb-4">
        <div class="text-body2">{{ t('inbox.pendingReviewInfo') }}</div>
        <w-banner
          v-if="state.submissions.length < 1 && state.loading < 1"
          class="mt-6"
          :class="dark.isActive ? `bg-dark-4 text-grey-4` : `bg-grey-2 text-grey-8`">
          {{ t('inbox.reviewNone') }}
        </w-banner>
        <w-list v-else class="mt-6" bordered separator>
          <w-item
            v-for="submission of state.submissions"
            :key="submission.id"
            clickable
            @click="openSubmission(submission)">
            <w-item-section avatar>
              <w-avatar identity="plate" color="slate" text-color="white">
                <w-icon name="tabler:file-text" />
              </w-avatar>
            </w-item-section>
            <w-item-section>
              <w-item-label>
                <strong>{{ submission.page.title }}</strong>
              </w-item-label>
              <w-item-label caption>/{{ submission.page.path }}</w-item-label>
              <w-item-label caption>
                <i18n-t keypath="inbox.reviewSubmittedBy" scope="global">
                  <template #author>
                    <strong>{{ authorLabel(submission) }}</strong>
                  </template>
                  <template #date>{{ humanizeDate(t, submission.createdAt) }}</template>
                </i18n-t>
              </w-item-label>
            </w-item-section>
            <w-item-section side>
              <div class="flex items-center gap-3">
                <w-badge v-if="submission.author.isGuest" color="grey-7" rounded>
                  {{ t('inbox.reviewGuest') }}
                </w-badge>
                <w-badge v-if="submission.isStale" color="warning" rounded>
                  {{ t('inbox.reviewStale') }}
                </w-badge>
                <w-badge v-if="submission.approvals?.approvalsRequired > 1" color="slate" rounded>
                  {{
                    t('inbox.reviewApprovalProgress', {
                      count: submission.approvals.approvalsCount,
                      required: submission.approvals.approvalsRequired
                    })
                  }}
                </w-badge>
                <w-icon name="tabler:chevron-right" color="grey" />
              </div>
            </w-item-section>
          </w-item>
        </w-list>
      </div>
    </template>

    <template v-else>
      <!--
        Every control on the toolbar is an icon-only square, its label on `aria-label` plus a
        tooltip: labels at three different widths shove the title and the count chip around as the
        wording changes, and a labelled Approve/Decline pair reads as a form's footer.
      -->
      <div class="flex flex-none flex-wrap items-center gap-2 px-4 py-3.5">
        <w-btn
          class="inbox-square-btn"
          outline
          padding="none"
          color="slate-soft"
          :aria-label="t(`inbox.reviewBack`)"
          @click="closeSubmission">
          <w-icon name="tabler:arrow-left" size="15px" />
          <w-tooltip>{{ t(`inbox.reviewBack`) }}</w-tooltip>
        </w-btn>
        <!-- -> Below `180px` the byline wraps to three lines. -->
        <div class="min-w-[180px] flex-1">
          <div class="inbox-review-title">{{ state.selected.page.title }}</div>
          <div class="inbox-review-byline">
            <i18n-t keypath="inbox.reviewSubmittedBy" scope="global">
              <template #author>
                <strong>{{ state.selected.author.name || t('inbox.reviewUnknownAuthor') }}</strong>
              </template>
              <template #date>{{ humanizeDate(t, state.selected.createdAt) }}</template>
            </i18n-t>
            <template v-if="state.selected.author.email">
              &middot; {{ state.selected.author.email }}
            </template>
          </div>
        </div>
        <!--
          An outlined mono chip rather than a badge: a filled slate pill beside four hairline
          squares reads as a fifth control.
        -->
        <span v-if="state.selected.approvals?.approvalsRequired > 1" class="inbox-review-count">
          {{
            t('inbox.reviewApprovalProgress', {
              count: state.selected.approvals.approvalsCount,
              required: state.selected.approvals.approvalsRequired
            })
          }}
        </span>
        <w-btn
          class="inbox-square-btn"
          outline
          padding="none"
          color="slate-soft"
          :aria-label="t(`inbox.reviewViewPage`)"
          :href="`/` + state.selected.page.path"
          target="_blank">
          <w-icon name="tabler:external-link" size="15px" />
          <w-tooltip>{{ t(`inbox.reviewViewPage`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="inbox-square-btn inbox-square-btn--negative"
          outline
          padding="none"
          color="accent"
          :aria-label="t(`inbox.reviewDecline`)"
          @click="rejectSubmission">
          <w-icon name="tabler:x" size="15px" />
          <w-tooltip>{{ t(`inbox.reviewDecline`) }}</w-tooltip>
        </w-btn>
        <!--
          The one filled control on the row: approving is what this screen is for. `positive-fill`,
          not `positive`, is the half of the fill/text split that carries a white glyph.
        -->
        <w-btn
          class="inbox-square-btn"
          padding="none"
          color="positive-fill"
          text-color="white"
          :aria-label="t(`inbox.reviewApprove`)"
          @click="approveSubmission">
          <w-icon name="tabler:check" size="15px" />
          <w-tooltip>{{ t(`inbox.reviewApprove`) }}</w-tooltip>
        </w-btn>
      </div>
      <!--
        A warning rather than a block: the reviewer can see both sides in the diff below and edit
        the result before accepting.

        Literal colour classes -- WBanner has no `color` prop, so one would be silently dropped --
        and `ink` rather than black, which is not a foreground Cardinal uses anywhere.
      -->
      <w-banner v-if="state.selected.isStale" class="mx-4 mb-2 flex-none bg-warning-fill text-ink">
        {{ t('inbox.reviewStaleHint') }}
      </w-banner>
      <div class="inbox-review-hint flex-none px-4 pb-2">
        {{ t('inbox.reviewDiffHint') }}
      </div>
      <!--
        Monaco draws no header over its panes, so nothing else on screen says which half is the
        page and which the suggestion, or that only one of them can be typed into. Two equal cells
        over an editor whose `renderSideBySide` is fixed on, so they line up with what they name.
      -->
      <div class="inbox-review-diff-heads flex-none">
        <div class="inbox-review-diff-head">
          <span>{{ t('inbox.reviewDiffCurrent') }}</span>
          <span class="inbox-review-diff-state">{{ t('inbox.reviewDiffReadOnly') }}</span>
        </div>
        <div class="inbox-review-diff-head">
          <span>{{ t('inbox.reviewDiffSuggestion') }}</span>
          <span class="inbox-review-diff-state inbox-review-diff-state--editable">{{
            t('inbox.reviewDiffEditable')
          }}</span>
        </div>
      </div>
      <div ref="diffEl" class="inbox-review-diff" />
    </template>

    <w-inner-loading :showing="state.loading > 0" />
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import * as monaco from 'monaco-editor'

import { useAesthetic } from '@/composables/aesthetic'
import { defineMonacoThemes, monacoThemeName } from '@/helpers/monacoTheme'

import { MarkdownRenderer } from '@/renderers/markdown'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { confirm, dialog } from '@/composables/dialog'

import { useEditorStore } from '@/stores/editor'
import { useSiteStore } from '@/stores/site'
import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDate } from '@/helpers/datetime'

import InboxDeclineDialog from '@/components/InboxDeclineDialog.vue'

/**
 * This screen has no route of its own: `InboxOverlay.vue` forwards both off the overlay's
 * `overlayOpts`, so `fromPage` stands in for what a `route.query.from` would otherwise carry.
 */
const props = defineProps({
  initialSubmissionId: { type: String, default: null },
  fromPage: { type: Boolean, default: false }
})

const dark = useDark()

// -> Only for leaving the overlay to view the underlying page; every other transition here is local
//    state (`selectedId`), not a route.
const router = useRouter()

const editorStore = useEditorStore()
const siteStore = useSiteStore()

const { t } = useI18n()

const aesthetic = useAesthetic()

useMeta(() => ({
  title: t('inbox.pendingReview')
}))

/** Null is the queue; an id is that submission's diff. */
const selectedId = ref(props.initialSubmissionId)

const state = reactive({
  loading: 0,
  submissions: [],
  selected: null
})

const diffEl = ref(null)

/*
  Outside `state` deliberately: Monaco's own objects are large and self-managing, so making them
  reactive buys nothing and costs a lot.
*/
let diffEditor = null
let originalModel = null
let modifiedModel = null

watch(selectedId, loadSubmission)

// -> The container only exists once a submission is open, so the editor is built after that render
watch(
  () => state.selected?.id,
  async (id) => {
    if (!id) {
      disposeEditor()
      return
    }
    await nextTick()
    mountEditor()
  }
)

async function load() {
  state.loading++
  try {
    // -> The markdown renderer is configured per site, and that configuration arrives with the
    //    editor configs. `ensureConfigs()` rather than a bare `configIsLoaded` check: it also
    //    refreshes the glossary terms, which the rest of the config being loaded says nothing about
    await editorStore.ensureConfigs()
    state.submissions =
      (await API_CLIENT.get(`sites/${siteStore.id}/approvals/submissions`).json()) ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('inbox.reviewLoadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
}

/**
 * Driven by `selectedId` rather than by the click that got here, so that opening the overlay
 * straight onto a submission behaves exactly like picking it off the queue.
 */
async function loadSubmission(id) {
  if (!id) {
    state.selected = null
    return
  }
  state.loading++
  try {
    state.selected = await API_CLIENT.get(
      `sites/${siteStore.id}/approvals/submissions/${id}`
    ).json()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('inbox.reviewLoadFailed'),
      caption: apiErrorMessage(err)
    })
    // -> Resolved by somebody else already, or never this reviewer's to see
    state.selected = null
    selectedId.value = null
  }
  state.loading--
}

function openSubmission(submission) {
  selectedId.value = submission.id
}

function shortId(id) {
  return String(id).replace(/-/g, '').slice(-6)
}

/**
 * A guest is named only by what they typed into the submission form, which can be blank or land on
 * another guest's exact words -- there is no account to tell two apart by. Two such rows for the
 * same page otherwise render byte-identical, down to the minute, so the colliding ones (and only
 * those) fold in a fragment of the submission id, which is guaranteed to differ.
 */
function authorLabel(submission) {
  const name = submission.author.name || submission.author.email || t('inbox.reviewUnknownAuthor')
  if (!submission.author.isGuest) {
    return name
  }
  const collides = state.submissions.some(
    (other) =>
      other.id !== submission.id &&
      other.page.id === submission.page.id &&
      other.author.isGuest &&
      (other.author.name || other.author.email || t('inbox.reviewUnknownAuthor')) === name
  )
  return collides ? `${name} #${shortId(submission.id)}` : name
}

/**
 * Back to the local queue, unless the reviewer never came through it: with `fromPage` the overlay
 * was opened by a page's own review button, and returning them to an inbox they did not open would
 * strand them a section away from what they were reading.
 */
function leaveReview() {
  if (props.fromPage && state.selected?.page?.path !== undefined) {
    const pagePath = `/${state.selected.page.path}`
    siteStore.$patch({ overlay: '' })
    router.push(pagePath)
    return
  }
  selectedId.value = null
}

function closeSubmission() {
  leaveReview()
}

/**
 * Left is the page as it stands, read-only; right is the suggestion, editable, so a stale or
 * nearly-right suggestion is still usable. What lands on the page is whatever the right-hand model
 * says at that moment, which is why approving reads the model rather than the loaded value.
 */
function mountEditor() {
  if (!diffEl.value || !state.selected) {
    return
  }
  disposeEditor()

  /*
    Defined again here because the markdown editor may never have mounted. The base tones must match
    the other Monaco surfaces': the theme ID is shared, so whichever call site defines it last wins
    for the whole process. The diff tints below them are this screen's own -- the status fills, not
    Monaco's default green/red, which belong to a different palette.

    Literal hex rather than `var(--color-*)`: `defineTheme()` reads `colors` as plain hex/rgba and
    never resolves a custom property, so these are re-typed against `css/tailwind.css` and pinned by
    this file's theme test.
  */
  defineMonacoThemes(monaco, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#14171f',
      'editor.foreground': '#c3cee2',
      'editor.lineHighlightBackground': '#171b24',
      'editorLineNumber.foreground': '#3f4a63',
      'editorGutter.background': '#171b24',
      'editorCursor.foreground': '#e4676b',
      'diffEditor.insertedLineBackground': '#5f9c862e',
      'diffEditor.removedLineBackground': '#e4676b29',
      'diffEditor.border': '#ffffff1f'
    }
  })

  originalModel = monaco.editor.createModel(state.selected.pageContent ?? '', 'markdown')
  modifiedModel = monaco.editor.createModel(state.selected.content ?? '', 'markdown')

  diffEditor = monaco.editor.createDiffEditor(diffEl.value, {
    automaticLayout: true,
    // -> Small enough that two readable columns fit into half an overlay each
    fontSize: 12.5,
    lineHeight: 24,
    fontFamily: "'Roboto Mono', Consolas, 'Liberation Mono', Courier, monospace",
    // -> Fixed on: an inline diff of prose reads as a jumble of half-lines, and the pane headings
    //    above only line up with the halves they name side by side
    renderSideBySide: true,
    originalEditable: false,
    readOnly: false,
    scrollBeyondLastLine: false,
    theme: monacoThemeName(aesthetic.current),
    wordWrap: 'on'
  })
  diffEditor.setModel({ original: originalModel, modified: modifiedModel })
}

function disposeEditor() {
  diffEditor?.dispose()
  originalModel?.dispose()
  modifiedModel?.dispose()
  diffEditor = null
  originalModel = null
  modifiedModel = null
}

function reviewedContent() {
  return modifiedModel ? modifiedModel.getValue() : (state.selected?.content ?? '')
}

/**
 * Rendered here for the same reason the editor renders on every save: the markdown pipeline is a
 * frontend one, and the server would otherwise need a headless browser most instances lack.
 *
 * @throws When the source will not render -- approving would publish HTML that does not match it.
 */
function renderReviewed(content) {
  const md = new MarkdownRenderer(editorStore.editors.markdown ?? {})
  // -> The page the suggestion is against, so a relative image resolves against that page's folder
  return md.render(content, { pagePath: state.selected?.page?.path ?? '' })
}

/**
 * Another reviewer resolved this submission between it being opened and acted on. Retrying would
 * 404 again, so the dead selection is dropped and the queue behind it refreshed.
 */
async function recoverFromGoneSubmission() {
  state.selected = null
  selectedId.value = null
  await load()
}

function approveSubmission() {
  confirm({
    title: t('inbox.reviewApprove'),
    message: t('inbox.reviewApproveConfirm', { page: state.selected.page.title }),
    cancel: true,
    okLabel: t('inbox.reviewApprove')
  }).onOk(async () => {
    state.loading++
    try {
      const content = reviewedContent()
      const resp = await API_CLIENT.post(
        `sites/${siteStore.id}/approvals/submissions/${state.selected.id}/approve`,
        { json: { content, render: renderReviewed(content) } }
      ).json()
      // -> False while a multi-approver rule still wants more sign-offs: the page was not written,
      //    so the ordinary "applied" toast would lie. Compared against `false` so a response
      //    without the field reads as finalized
      if (resp.finalized === false) {
        notify({
          type: 'positive',
          message: t('inbox.reviewApprovePending', {
            count: resp.approvalsCount,
            required: resp.approvalsRequired
          })
        })
      } else {
        notify({
          type: 'positive',
          message: t('inbox.reviewApproveSuccess')
        })
      }
      // -> Refreshed before leaving, so the queue behind is right wherever this goes next
      await load()
      leaveReview()
    } catch (err) {
      if (err.response?.status === 409) {
        /*
          409 means the page moved since the GET that computed this diff. Reloading both sides
          brings back fresh `pageContent` and `isStale: true`, which is what prompts the reviewer to
          reconcile -- a toast alone leaves them nothing to act on.
        */
        notify({
          type: 'warning',
          message: t('inbox.reviewApproveStale'),
          caption: apiErrorMessage(err)
        })
        await loadSubmission(state.selected.id)
        /*
          The id watcher only remounts when `state.selected.id` CHANGES, and it has not -- this is
          the same submission reloaded -- so the models are rebuilt explicitly, or the editor goes
          on showing the page content from before the conflicting write.
        */
        mountEditor()
      } else {
        notify({
          type: 'negative',
          message: t('inbox.reviewApproveFailed'),
          caption: apiErrorMessage(err)
        })
        if (err.response?.status === 404) {
          await recoverFromGoneSubmission()
        }
      }
    }
    state.loading--
  })
}

function rejectSubmission() {
  dialog({ component: InboxDeclineDialog }).onOk(async ({ reason } = {}) => {
    state.loading++
    try {
      const resp = await API_CLIENT.post(
        `sites/${siteStore.id}/approvals/submissions/${state.selected.id}/reject`,
        // -> The route's `reason` is optional but typed as a plain string, not nullable, so a blank
        //    one is left out of the body entirely rather than sent as `null`
        reason ? { json: { reason } } : undefined
      ).json()
      notify({
        type: 'positive',
        message: t('inbox.reviewDeclineSuccess')
      })
      await load()
      leaveReview()
    } catch (err) {
      notify({
        type: 'negative',
        message: t('inbox.reviewDeclineFailed'),
        caption: apiErrorMessage(err)
      })
      if (err.response?.status === 404) {
        await recoverFromGoneSubmission()
      }
    }
    state.loading--
  })
}

onMounted(() => {
  load()
  loadSubmission(selectedId.value)
})

onBeforeUnmount(disposeEditor)
</script>

<style>
/*
  Selectors are flat: a `&-suffix` is Sass string concatenation, not valid native CSS nesting, and
  the browser silently drops such a rule rather than failing on it.

  The type is written out rather than taken from the Material ramp: 15px/600 title and an 11.5px
  mono byline are neither of them a rung of it. Mono is the point -- who suggested this and when is
  metadata, and metadata is mono everywhere in the language.
*/
.inbox-review-title {
  color: var(--color-ink);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
}
.body--dark .inbox-review-title {
  color: var(--color-text-dark);
}
.inbox-review-byline {
  color: var(--color-text-caption);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.5;
}
.inbox-review-byline strong {
  color: var(--color-slate);
  font-weight: 500;
}
.body--dark .inbox-review-byline {
  color: var(--color-text-caption-dark);
}
.body--dark .inbox-review-byline strong {
  color: var(--color-slate-light);
}
.inbox-review-hint {
  color: var(--color-text-caption);
  font-size: 11.5px;
  line-height: 1.5;
}
.body--dark .inbox-review-hint {
  color: var(--color-text-caption-dark);
}
.inbox-review {
  /*
    `#5f78a8` is the chip's designed edge, a hair off `var(--color-slate-soft)`, and stays a
    literal: one chip on one screen is not a palette entry. Cobalt wants `#1e2a5e` for the text,
    but that is a light-ground tone with no Cobalt-dark counterpart, so slate stays for both.
  */
}
.inbox-review-count {
  border: 1px solid #5f78a8;
  color: var(--color-slate);
  flex: none;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.14em;
  padding: 3px 7px;
  text-transform: uppercase;
  white-space: nowrap;
}
.body--dark .inbox-review-count {
  border-color: var(--color-border-dark);
  color: var(--color-slate-light);
}
.inbox-review {
  /*
    The strip naming Monaco's panes sits on the diff's own ground, not the page's: it reads as the
    top row of the code well rather than as the bottom of the light toolbar above it.
  */
}
.inbox-review-diff-heads {
  background-color: var(--color-dark-4);
  border-top: 1px solid var(--color-hairline);
  display: flex;
}
.body--dark .inbox-review-diff-heads {
  border-top-color: var(--color-hairline-dark);
}
.inbox-review-diff-head {
  align-items: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  color: var(--color-slate-light);
  display: flex;
  flex: 1 1 0;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  gap: 12px;
  justify-content: space-between;
  letter-spacing: 0.18em;
  min-width: 0;
  padding: 6px 12px;
  text-transform: uppercase;
}
.inbox-review-diff-head:first-child {
  border-inline-end: 1px solid rgba(255, 255, 255, 0.12);
}
.inbox-review {
  /*
    A tone down from the pane name it qualifies, and the accent on the editable half only -- the
    language's mark for the live edge, here the one pane a reviewer can type into.
  */
}
.inbox-review-diff-state {
  color: var(--color-text-caption-dark);
  letter-spacing: 0.14em;
  white-space: nowrap;
}
.inbox-review-diff-state--editable {
  color: var(--color-accent-dark);
}
.inbox-review {
  /*
    Whatever is left under the header rather than a fixed height: this page sits in a card that
    already fills the viewport, so a pixel height would overflow it or leave a gap under it. The
    floor has to stay under half a short viewport, which is what the overlay can give it.
  */
}
.inbox-review-diff {
  flex: 1 1 auto;
  min-height: 260px;
}
</style>
