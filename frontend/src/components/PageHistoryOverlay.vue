<template>
  <w-layout class="page-history" container>
    <w-header class="card-header">
      <w-icon name="tabler:history" left size="md" />
      <span>{{ t('history.title') }}</span>
      <!--
        Centred on the header itself rather than on the space left between the two groups of
        controls, which are nowhere near the same width — hence absolute rather than a pair of
        spacers. Ignores the pointer so it can overlap nothing it would block.
      -->
      <span class="page-history-page">{{ pageStore.title }}</span>
      <w-space />
      <transition name="syncing">
        <w-spinner class="me-4" v-show="state.loading > 0" color="accent" size="20px" />
      </transition>
      <!--
        How the two versions are laid against each other. Up here rather than over the diff, so the
        compare bar below can stay exactly two halves lining up with the editor's own two panes.
      -->
      <!--
        The selected half is filled in the accent and the other left as an outline, which is how the
        design draws every segmented control (`ui-redesign/Cardinal Wiki - Page Properties 3x.dc.html`'s
        publish-state row). It used to be white-on-slate either way, so the pair read as two chrome
        buttons rather than as one control with a state.

        `accent`, not `accent-fill`: this carries a white label, and `#e4676b` under white text is
        2.9:1 -- the fill tone is for a surface with no text on it or with ink over it (see
        `css/tailwind.css`'s own note, and `helpers/accessibility.test.js`, which pins each token
        against the foreground it is actually drawn under).
      -->
      <w-btn-group class="me-6">
        <w-btn
          dense
          :label="t(`history.sideBySide`)"
          padding="0.285em sm"
          :color="state.inline ? `transparent` : `accent`"
          :text-color="state.inline ? `slate` : `white`"
          :outline="state.inline"
          @click="state.inline = false" />
        <w-btn
          dense
          :label="t(`history.inline`)"
          padding="0.285em sm"
          :color="state.inline ? `accent` : `transparent`"
          :text-color="state.inline ? `white` : `slate`"
          :outline="!state.inline"
          @click="state.inline = true" />
      </w-btn-group>
      <w-btn
        icon="tabler:x"
        color="accent-fill"
        dense
        flat
        :aria-label="t(`common.actions.close`)"
        @click="close">
        <w-tooltip anchor="bottom middle" self="top middle">{{
          t(`common.actions.close`)
        }}</w-tooltip>
      </w-btn>
    </w-header>

    <!-- ----------------------------------------------------- -->
    <!-- TIMELINE -->
    <!-- ----------------------------------------------------- -->
    <w-drawer class="page-history-sidebar" :model-value="true" :width="380">
      <w-scroll-area style="height: 100%">
        <div class="page-history-timeline" v-if="state.versions.length > 0">
          <div
            class="page-history-item"
            v-for="(version, idx) of state.versions"
            :key="version.id"
            :class="{ 'is-picked': version.id === state.aId || version.id === state.bId }"
            role="button"
            tabindex="0"
            @click="selectVersion(idx)"
            @keydown.enter="selectVersion(idx)">
            <!-- The subway stop: the line itself is drawn by the item, this is the dot on it. -->
            <div class="page-history-dot" :class="actionStyle(version.action).dot">
              <w-icon :name="actionStyle(version.action).icon" size="15px" />
            </div>
            <div class="page-history-body">
              <div class="flex items-center gap-2">
                <strong>{{ actionLabel(version.action) }}</strong>
                <w-badge v-if="idx === 0" color="primary" rounded>
                  {{ t('history.current') }}
                </w-badge>
              </div>
              <div class="page-history-meta">{{ humanizeDate(t, version.versionDate) }}</div>
              <div class="page-history-meta flex items-center gap-1">
                <span>{{ version.author.name || t('history.unknownAuthor') }}</span>
                <!--
                  #1119: provenance -- did the person actually type this, or did an MCP tool call
                  acting as them? `version.via` comes straight off the `pageHistory` row.
                -->
                <w-badge v-if="version.via === 'mcp'" outline color="slate-pale" rounded>
                  {{ t('history.viaMcp') }}
                  <w-tooltip>{{ t('history.viaMcpHint') }}</w-tooltip>
                </w-badge>
              </div>
              <!-- Where it went, which is the whole point of telling a move apart from an edit. -->
              <div class="page-history-meta" v-if="version.action === `moved`">
                /{{ version.path }}
              </div>
            </div>
            <!--
              Stops the click from also reaching the item, which would move both letters at once.
            -->
            <div class="page-history-pick" @click.stop>
              <w-btn
                flat
                dense
                round
                icon="tabler:dots"
                color="slate-pale"
                :aria-label="t(`history.versionActions`)">
                <w-menu class="translucent-menu" auto-close anchor="bottom left" self="top left">
                  <!--
                    `!min-w-0 !pe-2` on each icon section, and literal colour classes rather than
                    WIcon's `color` prop — both for the same reasons as the profile menu this copies.
                  -->
                  <w-list dense padding style="min-width: 260px">
                    <w-item clickable @click="pick(`a`, version.id)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:square-letter-a" class="text-blue-7" />
                      </w-item-section>
                      <w-item-section>{{ t('history.setAsSource') }}</w-item-section>
                    </w-item>
                    <w-item clickable @click="pick(`b`, version.id)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:square-letter-b" class="text-blue-7" />
                      </w-item-section>
                      <w-item-section>{{ t('history.setAsTarget') }}</w-item-section>
                    </w-item>
                    <w-separator class="my-1" />
                    <w-item clickable @click="viewSource(version)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:code" class="text-blue-7" />
                      </w-item-section>
                      <w-item-section>{{ t('history.viewSource') }}</w-item-section>
                    </w-item>
                    <w-item clickable @click="downloadVersion(version)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:download" class="text-blue-7" />
                      </w-item-section>
                      <w-item-section>{{ t('history.downloadVersion') }}</w-item-section>
                    </w-item>
                    <template v-if="userStore.can(`write:pages`)">
                      <w-separator class="my-1" />
                      <!--
                        Writes over the page, so it reads as the one destructive thing in here — the
                        same red the profile menu gives its one irreversible entry.
                      -->
                      <w-item clickable @click="restoreVersion(version)">
                        <w-item-section avatar class="!min-w-0 !pe-2">
                          <w-icon name="tabler:arrow-back-up" class="text-negative" />
                        </w-item-section>
                        <w-item-section>{{ t('history.restore') }}</w-item-section>
                      </w-item>
                      <w-item clickable @click="branchFrom(version)">
                        <w-item-section avatar class="!min-w-0 !pe-2">
                          <w-icon name="tabler:git-branch" class="text-blue-7" />
                        </w-item-section>
                        <w-item-section>{{ t('history.branchOff') }}</w-item-section>
                      </w-item>
                    </template>
                  </w-list>
                </w-menu>
              </w-btn>
              <!--
                The pair of cursors, as the design draws them: two square mono plates, the one
                holding this letter in the accent and the other in the chrome tone
                (`ui-redesign/Cardinal Wiki - History 3x.dc.html`). `pink-6` was a ramp colour
                standing in for the accent and `dark-3` a panel tone standing in for slate; neither
                is a colour this language has a use for on a control. Both carry a white letter, so
                both take a tone that clears contrast under one -- see the mode toggle above.
              -->
              <w-btn-group class="page-history-pick-group">
                <w-btn
                  dense
                  :label="t(`history.versionLabelA`)"
                  padding="0.285em sm"
                  :color="version.id === state.aId ? `accent` : `slate`"
                  text-color="white"
                  :aria-label="t(`history.pickA`)"
                  @click="pick(`a`, version.id)" />
                <w-btn
                  dense
                  :label="t(`history.versionLabelB`)"
                  padding="0.285em sm"
                  :color="version.id === state.bId ? `accent` : `slate`"
                  text-color="white"
                  :aria-label="t(`history.pickB`)"
                  @click="pick(`b`, version.id)" />
              </w-btn-group>
            </div>
            <!--
              A row of their own, under the buttons rather than beside them: both are prose that runs
              on, and the column left over next to the A/B group is too narrow to read either in.
            -->
            <div
              class="page-history-notes"
              v-if="version.reason || version.changedFields.length > 0">
              <!-- Why, in the author's own words, when the site asks for a reason on save. -->
              <div class="page-history-reason" v-if="version.reason">{{ version.reason }}</div>
              <div class="page-history-fields" v-if="version.changedFields.length > 0">
                {{ t('history.changedFields', { fields: version.changedFields.join(', ') }) }}
              </div>
            </div>
          </div>
          <!-- Older versions than the page fetched at first come in one bite at a time, not by
               scroll -- the timeline is what a reader scans, not what should quietly grow underneath
               them while they're in the middle of doing that. -->
          <div class="page-history-load-more" v-if="state.nextCursor">
            <w-btn
              outline
              dense
              color="slate"
              padding="0.4em md"
              :loading="state.loadingMore"
              @click="loadMore">
              {{ t('history.loadMore') }}
            </w-btn>
          </div>
        </div>
        <div class="p-4 text-grey-5" v-else-if="state.loading < 1">{{ t('history.none') }}</div>
      </w-scroll-area>
    </w-drawer>

    <!-- ----------------------------------------------------- -->
    <!-- DIFF -->
    <!-- ----------------------------------------------------- -->
    <w-page-container>
      <w-page class="page-history-main">
        <div class="p-4 text-grey-5" v-if="state.notice">{{ state.notice }}</div>
        <template v-else-if="state.versions.length > 0">
          <div class="page-history-compare">
            <div class="page-history-side">
              <span class="page-history-letter">A</span>
              <div class="min-w-0">
                <div class="truncate">{{ sideLabel(sideA) }}</div>
                <div class="page-history-meta truncate">{{ sideCaption(sideA) }}</div>
              </div>
              <!-- A literal class, not `color`: that prop builds one at runtime, which Tailwind
                   never emits. `ml-auto` puts it on the seam between the two panes. -->
              <w-icon class="text-grey-6 ml-auto" name="tabler:arrow-right" />
            </div>
            <div class="page-history-side">
              <span class="page-history-letter">B</span>
              <div class="min-w-0">
                <div class="truncate">{{ sideLabel(sideB) }}</div>
                <div class="page-history-meta truncate">{{ sideCaption(sideB) }}</div>
              </div>
            </div>
          </div>
          <!--
            An identical diff looks like a failure otherwise: a metadata-only edit leaves the source
            untouched, and the timeline entry is where what actually changed is listed.
          -->
          <div class="page-history-same" v-if="state.sameContent">
            {{ t('history.sameContent') }}
          </div>
          <!--
            Monaco never sees this pair (see `DIFF_INLINE_CHAR_LIMIT`) -- the container behind it stays
            in the DOM either way, since an editor already mounted on it from an earlier, smaller
            comparison needs somewhere to keep living while it is hidden.
          -->
          <div class="page-history-toolarge" v-if="state.diffTooLarge">
            <w-icon name="tabler:alert-triangle" size="md" />
            <div class="page-history-toolarge-text">{{ t('history.diffTooLarge') }}</div>
            <div class="page-history-toolarge-actions">
              <w-btn outline dense color="slate" :disabled="!sideA" @click="downloadVersion(sideA)">
                {{ t('history.downloadVersionLetter', { letter: 'A' }) }}
              </w-btn>
              <w-btn outline dense color="slate" :disabled="!sideB" @click="downloadVersion(sideB)">
                {{ t('history.downloadVersionLetter', { letter: 'B' }) }}
              </w-btn>
            </div>
          </div>
          <div ref="diffEl" class="page-history-diff" v-show="!state.diffTooLarge" />
        </template>
      </w-page>
    </w-page-container>
  </w-layout>
</template>

<script setup>
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch
} from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import { fileSave } from 'browser-fs-access'

import { MarkdownRenderer } from '@/renderers/markdown'

import { confirm, dialog } from '@/composables/dialog'
import { tooLargeToDiffInline, useMonacoDiff } from '@/composables/monacoDiff'
import { notify } from '@/composables/notify'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDate } from '@/helpers/datetime'
import { localizedPagePath } from '@/helpers/pagePaths'

// PROPS

/**
 * `MainOverlayDialog.vue` forwards `siteStore.overlayOpts` to every overlay it mounts as this prop
 * (OpenProject #2530). Declared here even though this overlay opens with no initial state to read --
 * without a declared prop, the value would fall through onto this component's DOM root instead.
 */
defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

/**
 * Everything that ever happened to a page, and the difference between any two moments of it.
 *
 * The timeline is the record; A and B are a pair of cursors over it. They are deliberately not "the
 * selected item" — comparing a version against the one immediately before it is only the most common
 * question, not the only one, so clicking an entry sets that up and the two letters then move
 * independently. What the right-hand side shows is always A on the left and B on the right, whichever
 * way round in time they happen to be.
 */

// STORES

const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  loading: 0,
  /** Newest first, as the API returns them: the first entry is the page as it stands. */
  versions: [],
  /**
   * The route's own paging cursor -- the history is keyset-paginated (OpenProject #1859), so
   * `state.versions` starts as just the first page rather than the page's whole history. Null once
   * there is nothing older left to fetch.
   */
  nextCursor: null,
  /** Separate from `loading`: fetching an older page shouldn't reshow the header's syncing spinner. */
  loadingMore: false,
  /** The left-hand side. Null against the very first version, where there is nothing to compare to. */
  aId: null,
  /** The right-hand side. Never null once there is any history at all. */
  bId: null,
  /** Shown in place of the diff when there is nothing to show one of. */
  notice: '',
  /** Set alongside the models rather than computed: the fetched sources are held outside `state`. */
  sameContent: false,
  /** Set alongside the models, for the same reason: whether this pair was too large to hand to Monaco. */
  diffTooLarge: false,
  /** One column with the changes marked in place, rather than the two-column default. */
  inline: false
})

/**
 * How each kind of change reads on the line. Both halves are literals on purpose: an icon name built
 * at runtime is not inlined by the icon generator, and a class built at runtime is not emitted by
 * Tailwind.
 */
const ACTION_STYLES = {
  created: { icon: 'tabler:plus', dot: 'bg-positive' },
  updated: { icon: 'tabler:pencil', dot: 'bg-blue-7' },
  moved: { icon: 'tabler:share', dot: 'bg-warning' },
  deleted: { icon: 'tabler:trash', dot: 'bg-negative' }
}
const ACTION_FALLBACK = { icon: 'tabler:circle', dot: 'bg-grey-7' }

// REFS

const diffEl = ref(null)

/*
  The diff editor itself lives in `composables/monacoDiff.js` -- mounting it, feeding it a pair of
  texts and tearing it down are all its concern; which two versions to compare, and how to fetch
  them, is this overlay's.
*/
const { showDiff, setInline, disposeModels, disposeEditor } = useMonacoDiff(diffEl, {
  isInline: () => state.inline
})

/** The versions whose source has been fetched, keyed by id. Kept out of `state` for the same reason. */
const contents = new Map()

/** Guards against an out-of-order fetch: only the newest comparison may touch the editor. */
let applyToken = 0

// COMPUTED

const sideA = computed(() => state.versions.find((v) => v.id === state.aId) ?? null)
const sideB = computed(() => state.versions.find((v) => v.id === state.bId) ?? null)

// WATCHERS

watch(() => [state.aId, state.bId], applyDiff)

watch(() => state.inline, setInline)

// METHODS

function close() {
  siteStore.$patch({ overlay: '' })
}

function actionStyle(action) {
  return ACTION_STYLES[action] ?? ACTION_FALLBACK
}

function actionLabel(action) {
  return ACTION_STYLES[action] ? t(`history.action.${action}`) : action
}

function sideLabel(version) {
  return version ? humanizeDate(t, version.versionDate) : t('history.emptyPage')
}

/** Who, and why if they said — the same line the timeline entry carries, on one row. */
function sideCaption(version) {
  if (!version) {
    return ''
  }
  const author =
    version.via === 'mcp'
      ? t('history.viaMcpAuthor', { author: version.author.name || t('history.unknownAuthor') })
      : version.author.name || t('history.unknownAuthor')
  return version.reason ? `${author} — ${version.reason}` : author
}

/**
 * What one entry changed: itself as B, and whatever came before it as A.
 *
 * The oldest entry has nothing before it, so A goes empty and the diff shows the page arriving.
 */
function selectVersion(idx) {
  state.bId = state.versions[idx]?.id ?? null
  state.aId = state.versions[idx + 1]?.id ?? null
}

/**
 * Move one of the two letters onto a version.
 *
 * The pair can never land on the same entry, so a letter arriving where the other one sits displaces
 * it: normally to the position being vacated, which is a straight swap. The one case that cannot swap
 * is A landing on B while A is nowhere — comparing against the empty page — and there B steps to the
 * next newer entry instead, or the click does nothing if there is no such entry.
 */
function pick(slot, id) {
  const idx = state.versions.findIndex((v) => v.id === id)
  if (slot === 'a') {
    if (state.bId === id) {
      const displaced = state.aId ?? state.versions[idx - 1]?.id
      if (!displaced) {
        return
      }
      state.bId = displaced
    }
    state.aId = id
  } else {
    if (state.aId === id) {
      state.aId = state.bId
    }
    state.bId = id
  }
}

/**
 * A version's source, fetched once.
 *
 * Cached because the two letters walk back and forth over the same handful of entries, and because a
 * version is immutable — there is no state in which a second fetch would answer differently.
 */
async function loadVersion(id) {
  if (!id) {
    return null
  }
  if (contents.has(id)) {
    return contents.get(id)
  }
  const version = await API_CLIENT.get(
    `sites/${siteStore.id}/pages/${pageStore.id}/history/${id}`
  ).json()
  contents.set(id, version)
  return version
}

/** What a version's source is saved as, by the format it was written in. */
const FILE_TYPES = {
  markdown: { ext: 'md', mime: 'text/markdown' },
  html: { ext: 'html', mime: 'text/html' }
}

/**
 * The format a version was written in — which decides how it colours, how it renders and what it
 * downloads as. Taken from the version rather than from the page, since the page may have been
 * converted since.
 */
function contentTypeOf(version) {
  return version?.meta?.contentType || version?.meta?.editor || pageStore.editor || 'markdown'
}

/** A version with its source, with the spinner and the error report the menu actions all want. */
async function withVersion(version) {
  state.loading++
  try {
    return await loadVersion(version.id)
  } catch (err) {
    notify({
      type: 'negative',
      message: t('history.loadFailed'),
      caption: apiErrorMessage(err)
    })
    return null
  } finally {
    state.loading--
  }
}

/**
 * The HTML for a version's source, produced here for the same reason every save produces it here:
 * the markdown pipeline is a frontend one, and the server would otherwise have to drive a headless
 * browser — an extension most instances do not install.
 */
async function renderOf(version, content) {
  if (contentTypeOf(version) !== 'markdown') {
    return content
  }
  // -> The renderer is configured per site (line breaks, typographer, …), and that configuration
  //    arrives with the editor configs rather than on its own
  if (!editorStore.configIsLoaded) {
    await editorStore.fetchConfigs()
  }
  // -> Rendered as the page it is a version of, so a relative image in it resolves the way it does
  //    in the page view rather than against the site root
  return new MarkdownRenderer(editorStore.editors.markdown ?? {}).render(content, {
    pagePath: pageStore.path
  })
}

async function viewSource(version) {
  const full = await withVersion(version)
  if (!full) {
    return
  }
  dialog({
    component: defineAsyncComponent(() => import('./PageVersionSourceDialog.vue')),
    componentProps: {
      content: full.content ?? '',
      date: humanizeDate(t, full.versionDate)
    }
  })
}

async function downloadVersion(version) {
  const full = await withVersion(version)
  if (!full) {
    return
  }
  const type = FILE_TYPES[contentTypeOf(full)] ?? { ext: 'txt', mime: 'text/plain' }
  // -> Named for the page and the moment, since a folder of `page.md` files says nothing
  const name = full.path.split('/').at(-1) || 'page'
  const stamp = full.versionDate.slice(0, 19).replace(/[:T]/g, '-')
  try {
    /*
      A bare MIME type, with no `;charset=` on it: the save picker uses this as an `accept` key and
      rejects a type carrying parameters outright. Nothing is lost by dropping it — a Blob built from
      a JS string is UTF-8 already.
    */
    await fileSave(new Blob([full.content ?? ''], { type: type.mime }), {
      fileName: `${name}-${stamp}.${type.ext}`,
      extensions: [`.${type.ext}`]
    })
  } catch (err) {
    // -> Dismissing the file picker is not a failure
    if (err.name !== 'AbortError') {
      notify({ type: 'negative', message: t('history.downloadFailed'), caption: err.message })
    }
  }
}

/**
 * Put this version's source back on the page.
 *
 * The source only: the page keeps the title, tags and settings it has now. Restoring those too would
 * quietly undo everything done since, and a reader asking for an old version back is asking for the
 * text. Nothing is lost either way — this is an ordinary edit, so it becomes a version of its own
 * with the current state recorded in it.
 */
function restoreVersion(version) {
  confirm({
    title: t('history.restore'),
    message: [
      t('history.restoreConfirm', { date: humanizeDate(t, version.versionDate) }),
      t('history.restoreConfirmHint')
    ],
    caption: t('history.versionId', { id: version.id }),
    cancel: true,
    color: 'negative',
    okLabel: t('history.restore')
  }).onOk(async () => {
    const full = await withVersion(version)
    if (!full) {
      return
    }
    state.loading++
    try {
      const content = full.content ?? ''
      const resp = await API_CLIENT.patch(`sites/${siteStore.id}/pages/${pageStore.id}`, {
        json: {
          content,
          render: await renderOf(full, content),
          reasonForChange: t('history.restoreReason', { date: humanizeDate(t, full.versionDate) })
        }
      }).json()
      if (!resp?.page?.id) {
        throw new Error(resp?.message || t('common.error.unexpected'))
      }
      notify({ type: 'positive', message: t('history.restoreSuccess') })
      // -> The page behind this overlay is now out of date, and so is the timeline: the restore is
      //    itself a version, and it is the one worth landing on
      await pageStore.pageLoad({ id: pageStore.id })
      await load()
    } catch (err) {
      notify({
        type: 'negative',
        message: t('history.restoreFailed'),
        caption: apiErrorMessage(err)
      })
    } finally {
      state.loading--
    }
  })
}

/**
 * Start a new page from this version, leaving this one alone.
 *
 * What to do with an old version that is worth keeping but not worth reverting to. The same path
 * picker as duplicating a page, because that is what this is — a duplicate of a page as it was.
 */
function branchFrom(version) {
  dialog({
    component: defineAsyncComponent(() => import('./TreeBrowserDialog.vue')),
    componentProps: {
      mode: 'duplicatePage',
      folderPath: '',
      itemId: pageStore.id,
      itemTitle: version.title,
      itemFileName: pageStore.path,
      locale: pageStore.locale
    }
  }).onOk(async (target) => {
    const full = await withVersion(version)
    if (!full) {
      return
    }
    state.loading++
    try {
      const content = full.content ?? ''
      const resp = await API_CLIENT.post(`sites/${siteStore.id}/pages`, {
        json: {
          path: target.path,
          title: target.title,
          // -> The version's own locale, not the page's current one: a move can re-home a page into
          //    another locale, so the two genuinely disagree for any version recorded before such a
          //    move, and a version is a record of what the page WAS.
          locale: full.locale || pageStore.locale,
          editor: full.meta?.editor || pageStore.editor,
          content,
          render: await renderOf(full, content),
          description: full.meta?.description ?? '',
          icon: full.meta?.icon ?? '',
          tags: full.meta?.tags ?? [],
          // -> A version that was scheduled carries dates this new page has not got, and the API
          //    rightly refuses that combination
          publishState: full.meta?.publishState === 'published' ? 'published' : 'draft',
          reasonForChange: t('history.branchReason', { date: humanizeDate(t, full.versionDate) })
        }
      }).json()
      const page = resp?.page
      if (!page?.id) {
        throw new Error(resp?.message || t('common.error.unexpected'))
      }
      notify({ type: 'positive', message: t('history.branchSuccess') })
      close()
      router.push(localizedPagePath(page.path, page.locale, siteStore.localeRouting))
    } catch (err) {
      notify({
        type: 'negative',
        message: t('history.branchFailed'),
        caption: apiErrorMessage(err)
      })
    } finally {
      state.loading--
    }
  })
}

/** The format the page was written in at the time, which is what colours the two sides. */
function languageOf(version) {
  const type = contentTypeOf(version)
  if (type === 'html') {
    return 'html'
  }
  // -> A redirect's content is `{kind, target, showInterstitial}` as JSON (see `helpers/pageRedirect.
  //    js`), not prose -- coloured as markdown, a target such as `/foo_bar` reads as broken emphasis
  //    syntax rather than as the path it is. JSON is what it actually is, and Monaco already knows it.
  if (type === 'redirect') {
    return 'json'
  }
  return 'markdown'
}

async function applyDiff() {
  const token = ++applyToken
  state.loading++
  try {
    const [a, b] = await Promise.all([loadVersion(state.aId), loadVersion(state.bId)])
    // -> A newer comparison started while this one was in flight, and owns the editor now
    if (token !== applyToken) {
      return
    }

    state.sameContent = Boolean(a && b && a.content === b.content)
    state.diffTooLarge = tooLargeToDiffInline(a, b)

    if (state.diffTooLarge) {
      // -> Neither version reaches Monaco: the pane is left empty (hidden behind the notice in the
      //    template) and downloading each side is the one thing offered instead.
      disposeModels()
      return
    }

    await showDiff({
      original: { text: a?.content ?? '', language: languageOf(a ?? b) },
      modified: { text: b?.content ?? '', language: languageOf(b) },
      isStale: () => token !== applyToken
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('history.loadFailed'),
      caption: apiErrorMessage(err)
    })
  } finally {
    state.loading--
  }
}

async function load() {
  state.loading++
  state.notice = ''
  try {
    const res = await API_CLIENT.get(`sites/${siteStore.id}/pages/${pageStore.id}/history`).json()
    state.versions = res?.items ?? []
    state.nextCursor = res?.nextCursor ?? null
    // -> The timeline says so itself; repeating it in the diff pane would say it twice
    if (state.versions.length < 1) {
      return
    }
    // -> The live version against the one before it: the change the page is carrying right now
    state.bId = state.versions[0].id
    state.aId = state.versions[1]?.id ?? null
  } catch (err) {
    const caption = apiErrorMessage(err)
    state.notice = caption
    notify({
      type: 'negative',
      message: t('history.loadFailed'),
      caption
    })
  } finally {
    state.loading--
  }
}

/**
 * Fetch the next, older page of the timeline and append it.
 *
 * Appended, not replacing `state.versions`: `selectVersion`/`pick` index into that array directly,
 * and the already-picked A/B letters must stay put while more history arrives underneath them.
 */
async function loadMore() {
  if (!state.nextCursor || state.loadingMore) {
    return
  }
  state.loadingMore = true
  try {
    const res = await API_CLIENT.get(`sites/${siteStore.id}/pages/${pageStore.id}/history`, {
      searchParams: { cursor: state.nextCursor }
    }).json()
    state.versions.push(...(res?.items ?? []))
    state.nextCursor = res?.nextCursor ?? null
  } catch (err) {
    notify({
      type: 'negative',
      message: t('history.loadMoreFailed'),
      caption: apiErrorMessage(err)
    })
  } finally {
    state.loadingMore = false
  }
}

// MOUNTED

onMounted(load)

onBeforeUnmount(disposeEditor)
</script>

<style lang="scss">
/** The subway line: its colour, and the radius of the turn it makes at the end. */
$timeline-line: $hairline-dark;
$timeline-turn: 16px;

.page-history {
  /* -> The header is the positioning context for the page title below */
  .card-header {
    position: relative;
  }

  /*
    -> `left`/`translateX(-50%)` stay physical on purpose (OpenProject #1601's repo-wide pass): this
       centers the title over the whole header regardless of reading direction, the same centering
       trick as `WSignal.vue`/`ErrorGeneric.vue` -- not a reading-direction lean. See
       `frontend/src/logicalSpacing.test.js`.
  */
  &-page {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    /* -> Never wide enough to reach either group of controls; a long title is cut instead */
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
    font-size: 0.8rem;
    opacity: 0.6;
  }

  /*
    This overlay is drawn on INK in both themes -- the design's own choice, and the only screen in
    the app that is (`ui-redesign/Cardinal Wiki - History 3x.dc.html`). A diff is code, and code is
    read on a dark ground here the way it is in the editor; the light theme has nothing to say about
    it. So the tones below are Cardinal's dark ramp stated directly rather than through a theme
    branch: panel for the timeline column, the recessed tone for the diff beside it.
  */
  &-sidebar {
    background-color: $dark-4;
    color: $text-dark;
    border-inline-end: 1px solid $hairline-dark;
  }

  &-main {
    display: flex;
    flex-direction: column;
    /* -> Ink, a step BELOW the timeline rail beside it: the diff is the recessed half of the pair */
    background-color: $dark-5;
    color: $text-dark;
    /* -> The grid cell already has a height; this claims it so the diff can fill what is left */
    height: 100%;
    min-height: 0;
  }

  /* The subway line: one continuous rule behind the dots, drawn by the list rather than the items. */
  &-timeline {
    position: relative;
    padding: 1rem 0;

    /*
      The line: down behind the dots, then a quarter turn out to the leading edge rather than
      stopping in mid-air.

      Both halves are ONE border of ONE box -- the trailing and bottom edges of an invisible
      rectangle, joined by a corner radius -- rather than a straight element meeting a curved one.
      Two elements cannot be made to match under fractional display scaling: each snaps to the device
      pixel grid from its own layout box, so at 125% or 150% one lands on a whole device pixel and the
      other straddles two, and the seam shows as a change of thickness. As a single border there is
      nothing to line up: the browser rasterises the straight stretch and the curve as one path.

      The box's trailing edge sits under the middle of the dots: 1rem of padding, half of the 28px
      dot, half of the 2px line. OpenProject #1601: `inset-inline-start`/`border-inline-end`/
      `border-end-end-radius`, so the turn follows the dots to the leading edge under RTL too.
    */
    &::before {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      inset-inline-start: 0;
      width: calc(1rem + 14px + 1px);
      border-inline-end: 2px solid $timeline-line;
      border-bottom: 2px solid $timeline-line;
      border-end-end-radius: $timeline-turn;
    }
  }

  &-item {
    position: relative;
    display: flex;
    /* -> Wraps so the notes below can claim a row of their own; no row gap, since they bring their
          own margin */
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0 0.75rem;
    padding: 0.75rem 1rem;
    cursor: pointer;

    &:hover {
      background-color: $dark-2;
    }

    /*
      An inset shadow rather than a `border-left`, which is what this was: a border is part of the
      box, so it pushed the row's contents 3px across and took the dot of every picked entry off the
      line while the unpicked ones stayed on it.
    */
    &.is-picked {
      background-color: rgba($primary, 0.16);
      box-shadow: inset 3px 0 0 $primary;
    }
  }

  &-dot {
    flex: 0 0 28px;
    height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: $text-dark;
    /* -> A ring in the sidebar's own colour, so the line appears to pass behind the dot */
    box-shadow: 0 0 0 3px $dark-5;
  }

  &-body {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 0.85rem;
    line-height: 1.35;
  }

  &-meta {
    font-size: 0.75rem;
    color: $text-secondary-dark;
  }

  /* -> Full width, indented to sit under the entry's text rather than under its dot */
  &-notes {
    flex: 0 0 100%;
    min-width: 0;
    padding-inline-start: calc(28px + 0.75rem);
  }

  &-reason {
    margin-top: 0.25rem;
    font-size: 0.78rem;
    font-style: italic;
    color: $text-dark;
    word-break: break-word;
  }

  &-fields {
    margin-top: 0.25rem;
    font-size: 0.7rem;
    color: $text-caption-dark;
    word-break: break-word;
  }

  &-pick {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  &-load-more {
    display: flex;
    justify-content: center;
    padding: 0.5rem 1rem 1rem;
  }

  &-compare {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    /* -> No gap: each side owns exactly half the width, and its own padding keeps the two apart */
    padding: 0.75rem 0;
    border-bottom: 1px solid $hairline-dark;
    font-size: 0.85rem;
  }

  /* -> Half each, so B starts on the divider between the editor's two panes rather than wherever
        the row's other contents happen to leave it */
  &-side {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex: 0 0 50%;
    min-width: 0;
    padding: 0 1rem;
  }

  /* -> The accent under a white letter, and the mono the design sets both cursors in */
  &-letter {
    flex: 0 0 24px;
    height: 24px;
    background-color: $primary;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 12px;
  }

  &-pick-group .w-btn {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 11px;
  }

  &-same {
    flex: 0 0 auto;
    padding: 0.5rem 1rem;
    font-size: 0.8rem;
    color: $text-secondary-dark;
    background-color: $dark-2;
  }

  /* -> Takes the diff pane's own place rather than sitting alongside it, unlike `-same` above: there
        is no partial diff underneath this one to also show. */
  &-toolarge {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 2rem;
    text-align: center;
    color: $text-secondary-dark;
  }

  &-toolarge-text {
    max-width: 32rem;
    font-size: 0.9rem;
  }

  &-toolarge-actions {
    display: flex;
    gap: 0.75rem;
  }

  &-diff {
    flex: 1 1 auto;
    min-height: 0;
  }
}
</style>
