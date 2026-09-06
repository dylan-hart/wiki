<template>
  <w-page class="inbox-review flex flex-col">
    <!-- ----------------------------------------------------- -->
    <!-- QUEUE -->
    <!-- ----------------------------------------------------- -->
    <template v-if="!state.selected">
      <!--
        `pt-4` on the heading rather than `py-4` on the page, which is where the other sections get it
        from: this page is a flex column whose diff view fills the rest of the card, and padding on the
        container would sit under that too.
      -->
      <div class="w-section-header pt-4">{{ t('inbox.pendingReview') }}</div>
      <div class="p-4">
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
              <w-avatar color="slate" text-color="white" rounded>
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
                <!-- The page moved on after this was written; see `isStale` on the API side. -->
                <w-badge v-if="submission.isStale" color="warning" rounded>
                  {{ t('inbox.reviewStale') }}
                </w-badge>
                <!--
                  Only shown once a rule actually asks for more than one sign-off -- the ordinary
                  single-approver case reads exactly as it always has, with no count anywhere.
                -->
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

    <!-- ----------------------------------------------------- -->
    <!-- ONE SUBMISSION -->
    <!-- ----------------------------------------------------- -->
    <template v-else>
      <div class="flex flex-none flex-wrap items-center gap-2 p-4">
        <w-btn
          class="acrylic-btn"
          flat
          dense
          round
          icon="tabler:arrow-left"
          color="grey"
          :aria-label="t(`inbox.reviewBack`)"
          @click="closeSubmission">
          <w-tooltip>{{ t(`inbox.reviewBack`) }}</w-tooltip>
        </w-btn>
        <div class="min-w-0 flex-1">
          <div class="text-subtitle1">
            <strong>{{ state.selected.page.title }}</strong>
          </div>
          <div class="text-caption text-grey">
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
        <w-badge v-if="state.selected.approvals?.approvalsRequired > 1" color="slate" rounded>
          {{
            t('inbox.reviewApprovalProgress', {
              count: state.selected.approvals.approvalsCount,
              required: state.selected.approvals.approvalsRequired
            })
          }}
        </w-badge>
        <w-btn
          class="acrylic-btn"
          flat
          icon="tabler:external-link"
          color="grey"
          :label="t(`inbox.reviewViewPage`)"
          :href="`/` + state.selected.page.path"
          target="_blank" />
        <w-btn
          class="acrylic-btn"
          flat
          icon="tabler:x"
          color="negative"
          :label="t(`inbox.reviewDecline`)"
          @click="rejectSubmission" />
        <w-btn
          icon="tabler:check"
          color="positive"
          :label="t(`inbox.reviewApprove`)"
          @click="approveSubmission" />
      </div>
      <!--
        A warning rather than a block: the reviewer can see both sides in the diff below and edit the
        result before accepting, which is exactly what a stale suggestion needs.
      -->
      <!-- Literal colour classes: WBanner has no `color` prop, so one would be silently dropped. -->
      <w-banner v-if="state.selected.isStale" class="mx-4 mb-2 flex-none bg-warning text-black">
        {{ t('inbox.reviewStaleHint') }}
      </w-banner>
      <div class="flex-none px-4 pb-2 text-caption text-grey">
        {{ t('inbox.reviewDiffHint') }}
      </div>
      <!-- The diff itself: current page on the left, the suggestion on the right and editable. -->
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

// PROPS

/**
 * Initial state from whoever opened the Inbox overlay onto this tab -- `InboxOverlay.vue` forwards
 * these off `overlayOpts` (`siteStore.openOverlay('Inbox', { tab: 'review', submissionId, from })`,
 * as `PageHeader.vue`'s `reviewSubmission()` does). `fromPage` replaces the old `route.query.from ===
 * 'page'` check now that this screen has no route of its own (OpenProject #2531).
 */
const props = defineProps({
  initialSubmissionId: { type: String, default: null },
  fromPage: { type: Boolean, default: false }
})

// COMPOSABLES

const dark = useDark()

// ROUTER

// -> Only for leaving the overlay to view the underlying page (see `leaveReview` below) -- every
//    other transition here is local state (`selectedId`), not a route.
const router = useRouter()

// STORES

const editorStore = useEditorStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('inbox.pendingReview')
}))

// DATA

/**
 * Which submission is open, replacing the old `route.params.submissionId` now that this screen is
 * `InboxOverlay` content rather than a routed `/_inbox/review/:submissionId?` page (OpenProject
 * #2531). Null is the queue; a real id is one submission's diff.
 */
const selectedId = ref(props.initialSubmissionId)

const state = reactive({
  loading: 0,
  submissions: [],
  /** The submission being reviewed, with both sides of the diff. Null while the queue is showing. */
  selected: null
})

// REFS

const diffEl = ref(null)

/*
  The Monaco instances, deliberately outside `state`: they are large objects with their own internals,
  and making them reactive buys nothing and costs a lot.
*/
let diffEditor = null
let originalModel = null
let modifiedModel = null

// WATCHERS

// -> `selectedId` says which submission is open, so everything follows from it -- including
//    arriving on one directly, which is what opening the overlay with `initialSubmissionId` does
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

// METHODS

async function load() {
  state.loading++
  try {
    // -> The markdown renderer is configured per site (line breaks, typographer, and so on), and that
    //    configuration comes with the editor configs rather than on its own
    if (!editorStore.configIsLoaded) {
      await editorStore.fetchConfigs()
    }
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
 * The submission `selectedId` names, or none.
 *
 * Driven by `selectedId` rather than by the click that got here, so that opening the overlay
 * straight onto one (`initialSubmissionId`) behaves exactly like picking it off the queue -- and so
 * the back button walks out of one.
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
    // -> Reviewed by somebody else already, or never this reviewer's to see. Back to the queue.
    state.selected = null
    selectedId.value = null
  }
  state.loading--
}

function openSubmission(submission) {
  selectedId.value = submission.id
}

/** A short, stable fragment of a submission's id -- the one thing guaranteed to differ between two. */
function shortId(id) {
  return String(id).replace(/-/g, '').slice(-6)
}

/**
 * How a submission's author reads in the queue.
 *
 * A guest is only ever named by what they typed into the submission form, which can be blank, or
 * land on the exact same words as another guest's -- there is no account to tell them apart by
 * otherwise. Left alone, two such rows for the same page render byte-identical: same title, same
 * path, same "Suggested by Unknown on <date>" down to the minute -- nothing but a click proves they
 * are two different suggestions and not one rendered twice. Folding in a fragment of the submission's
 * own id, which is guaranteed to differ, but only for the rows that actually collide keeps a page
 * with a single guest submission -- or one where guests already read as distinct -- exactly as it did
 * before.
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
 * Where leaving a review goes -- called once a submission is resolved (approved/declined) or the
 * reviewer presses Back.
 *
 * Back to the local queue view, unless the reviewer never came through it: `fromPage` is set when
 * the overlay was opened by the review button on a page view (`PageHeader.vue`'s
 * `reviewSubmission()`), and returning them to an inbox they did not open would strand them a
 * section away from what they were reading -- so this leaves the overlay entirely and follows them
 * back to the page instead.
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
 * The diff, as the reviewer works on it.
 *
 * Left is the page as it stands, read-only. Right is the suggestion, and is not: the reviewer can
 * adjust it before accepting, which is what makes a stale or nearly-right suggestion usable. What
 * ends up on the page is whatever the right-hand model says at that moment, which is why approving
 * reads the model rather than the value that was loaded.
 */
function mountEditor() {
  if (!diffEl.value || !state.selected) {
    return
  }
  disposeEditor()

  // -> The markdown editor's theme, defined again here because that component may never have mounted
  monaco.editor.defineTheme('cardinaljs', {
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

  originalModel = monaco.editor.createModel(state.selected.pageContent ?? '', 'markdown')
  modifiedModel = monaco.editor.createModel(state.selected.content ?? '', 'markdown')

  diffEditor = monaco.editor.createDiffEditor(diffEl.value, {
    automaticLayout: true,
    fontSize: 14,
    // -> Side by side: this screen exists to compare the two, and an inline diff of prose reads as a
    //    jumble of half-lines
    renderSideBySide: true,
    originalEditable: false,
    readOnly: false,
    scrollBeyondLastLine: false,
    theme: 'cardinaljs',
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

/** What the reviewer settled on: the right-hand side of the diff as it stands now. */
function reviewedContent() {
  return modifiedModel ? modifiedModel.getValue() : (state.selected?.content ?? '')
}

/**
 * The HTML for what is being approved, produced here for the same reason the editor produces it on
 * every save: the markdown pipeline is a frontend one. Without it the server would have to drive a
 * headless browser, which is an extension most instances do not install.
 *
 * @throws When the source will not render, which is worth stopping for -- approving would otherwise
 *         publish a page whose HTML does not match its source.
 */
function renderReviewed(content) {
  const md = new MarkdownRenderer(editorStore.editors.markdown ?? {})
  // -> The page the suggestion is against, so a relative image in it resolves against that page's
  //    folder -- this HTML is what the page will be published with
  return md.render(content, { pagePath: state.selected?.page?.path ?? '' })
}

/**
 * `loadSubmission`'s own recovery, reused here: another reviewer resolved this submission first --
 * approved or declined it -- between when this reviewer opened it and when they acted on it.
 * Retrying the same action would just 404 again, so the dead selection is dropped and the queue
 * behind it refreshed, rather than leaving a row here that can never succeed a second time.
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
      // -> `finalized` is false the moment a rule asks for more than one sign-off and this reviewer
      //    is not the last one in: the page was not written, so leaving with the ordinary "applied"
      //    toast would be a straightforward lie. `finalized` defaults true for a server predating this
      //    field, which is also right: no such server ever answered anything else.
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
      // -> Refreshed before leaving, so the queue behind is right whether or not that is where this
      //    goes; on the way to a page the reload is what the page's own review button will read
      await load()
      leaveReview()
    } catch (err) {
      if (err.response?.status === 409) {
        /*
          Distinguishable from an ordinary failure: the page moved since this reviewer's own GET
          computed the diff, and the server refused to write over whatever changed in between. Reload
          both sides against the page as it stands now instead of showing a toast the reviewer has no
          way to act on -- `loadSubmission` re-fetches the same id, so `state.selected` comes back with
          fresh `pageContent` and `isStale: true`, which is what re-prompts them to reconcile.
        */
        notify({
          type: 'warning',
          message: t('inbox.reviewApproveStale'),
          caption: apiErrorMessage(err)
        })
        await loadSubmission(state.selected.id)
        /*
          The id watcher above only remounts the diff editor when `state.selected.id` CHANGES -- and it
          has not, since this is the same submission reloaded. Rebuilt explicitly so the editor's two
          models actually reflect what was just re-fetched, rather than going on showing the page
          content from before the conflicting write.
        */
        mountEditor()
      } else {
        notify({
          type: 'negative',
          message: t('inbox.reviewApproveFailed'),
          caption: apiErrorMessage(err)
        })
        if (err.response?.status === 404) {
          // -> Somebody else already resolved it; see `recoverFromGoneSubmission` above.
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
        // -> The reject route's `reason` body field is optional and typed as a plain string, not
        //    nullable, so a blank reason is left out of the body entirely rather than sent as `null`.
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
        // -> Somebody else already resolved it; see `recoverFromGoneSubmission` above.
        await recoverFromGoneSubmission()
      }
    }
    state.loading--
  })
}

// MOUNTED

onMounted(() => {
  load()
  // -> Whatever the overlay was opened onto, which is nothing at all for the queue itself
  loadSubmission(selectedId.value)
})

onBeforeUnmount(disposeEditor)
</script>

<style lang="scss">
.inbox-review {
  /*
    The diff takes whatever is left under the header rather than a fixed height: this page sits in a
    card that already fills the viewport, so a height in pixels would either overflow it or leave a
    gap under it.
  */
  &-diff {
    flex: 1 1 auto;
    min-height: 400px;
    border-top: 1px solid rgba(#fff, 0.1);
  }
}
</style>
