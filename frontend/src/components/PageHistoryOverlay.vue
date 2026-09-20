<template>
  <w-layout class="page-history" container>
    <w-header class="card-header">
      <!--
        `accent-dark`, not `accent`: this overlay is drawn on ink in BOTH themes (see the stylesheet
        note below), so the dark ramp's accent is the one that belongs here. Named rather than a
        hex, so `css/tailwind.css` keeps it where the contrast table can see it.
      -->
      <w-icon name="tabler:history" left size="20px" color="accent-dark" />
      <span>{{ t('history.title') }}</span>
      <!--
        Absolute rather than a pair of spacers: the two groups of controls are nowhere near the same
        width, so this centres on the header itself. Pointer-transparent, so it blocks nothing.
      -->
      <span class="page-history-page">{{ pageStore.title }}</span>
      <w-space />
      <transition name="syncing">
        <w-spinner class="me-4" v-show="state.loading > 0" color="accent" size="20px" />
      </transition>
      <!--
        Up here rather than over the diff, so the compare bar below can stay exactly two halves
        lining up with the editor's own two panes.

        `accent`, not `accent-fill`: this carries a white label, and the fill tone is for a surface
        with no text on it or with ink over it -- see `css/tailwind.css` and
        `helpers/accessibility.test.js`, which pins each token against the foreground it is drawn
        under.
      -->
      <w-btn-group class="page-history-toggle me-6">
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
      <!--
        `--color-accent-fill` has no dark-mode override of its own, so left alone this close icon
        draws the light-mode bright tone against a dark ground.
      -->
      <w-btn
        icon="tabler:x"
        :color="dark.isActive ? `accent-dark` : `accent-fill`"
        dense
        flat
        :aria-label="t(`common.actions.close`)"
        @click="close">
        <w-tooltip anchor="bottom middle" self="top middle">{{
          t(`common.actions.close`)
        }}</w-tooltip>
      </w-btn>
    </w-header>

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
            <div class="page-history-dot" :class="actionStyle(version.action).dot">
              <w-icon :name="actionStyle(version.action).icon" size="14px" />
            </div>
            <div class="page-history-body">
              <div class="flex items-center gap-2">
                <strong>{{ actionLabel(version.action) }}</strong>
                <!--
                  `accent`, not `primary`: this carries white text, so it takes the white-text
                  accent role rather than the site's brand colour. The two are the same tone under
                  Ledger and unrelated under Cobalt, so only the second aesthetic tells them apart.
                -->
                <w-badge v-if="idx === 0" color="accent">
                  {{ t('history.current') }}
                </w-badge>
              </div>
              <div class="page-history-meta page-history-time">
                {{ humanizeDate(t, version.versionDate) }}
              </div>
              <div class="page-history-meta flex items-center gap-1">
                <span>{{ version.author.name || t('history.unknownAuthor') }}</span>
                <w-badge v-if="version.via === 'mcp'" outline color="accent">
                  {{ t('history.viaMcp') }}
                  <w-tooltip>{{ t('history.viaMcpHint') }}</w-tooltip>
                </w-badge>
              </div>
              <div class="page-history-meta page-history-path" v-if="version.action === `moved`">
                /{{ version.path }}
              </div>
            </div>
            <!-- Reaching the item too would move both letters at once. -->
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
                    Literal colour classes, not `dark.isActive ? … : …` on WIcon's `color` prop:
                    Tailwind only emits a class it finds literally in the source, so each
                    `text-blue-7` has to carry a written-out `dark:text-blue-4` counterpart.
                  -->
                  <w-list dense padding style="min-width: 260px">
                    <w-item clickable @click="pick(`a`, version.id)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon
                          name="tabler:square-letter-a"
                          class="text-blue-7 dark:text-blue-4" />
                      </w-item-section>
                      <w-item-section>{{ t('history.setAsSource') }}</w-item-section>
                    </w-item>
                    <w-item clickable @click="pick(`b`, version.id)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon
                          name="tabler:square-letter-b"
                          class="text-blue-7 dark:text-blue-4" />
                      </w-item-section>
                      <w-item-section>{{ t('history.setAsTarget') }}</w-item-section>
                    </w-item>
                    <w-separator class="my-1" />
                    <w-item clickable @click="viewSource(version)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:code" class="text-blue-7 dark:text-blue-4" />
                      </w-item-section>
                      <w-item-section>{{ t('history.viewSource') }}</w-item-section>
                    </w-item>
                    <w-item clickable @click="downloadVersion(version)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:download" class="text-blue-7 dark:text-blue-4" />
                      </w-item-section>
                      <w-item-section>{{ t('history.downloadVersion') }}</w-item-section>
                    </w-item>
                    <template v-if="userStore.can(`write:pages`)">
                      <w-separator class="my-1" />
                      <!-- The one destructive entry in here: it writes over the page. -->
                      <w-item clickable @click="restoreVersion(version)">
                        <w-item-section avatar class="!min-w-0 !pe-2">
                          <w-icon name="tabler:arrow-back-up" class="text-negative" />
                        </w-item-section>
                        <w-item-section>{{ t('history.restore') }}</w-item-section>
                      </w-item>
                      <w-item clickable @click="branchFrom(version)">
                        <w-item-section avatar class="!min-w-0 !pe-2">
                          <w-icon name="tabler:git-branch" class="text-blue-7 dark:text-blue-4" />
                        </w-item-section>
                        <w-item-section>{{ t('history.branchOff') }}</w-item-section>
                      </w-item>
                    </template>
                  </w-list>
                </w-menu>
              </w-btn>
              <!--
                Both plates carry a white letter, so each takes a tone that clears contrast under
                white -- the accent for the letter this row holds, chrome for the other.
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
              A sibling of the dot/body/cursors row, not a child of the body column: both are prose
              that runs on, and what is left beside the A/B group is too narrow to read either in.
            -->
            <div
              class="page-history-notes"
              v-if="version.reason || version.changedFields.length > 0">
              <div class="page-history-reason" v-if="version.reason">{{ version.reason }}</div>
              <div class="page-history-fields" v-if="version.changedFields.length > 0">
                {{ t('history.changedFields', { fields: version.changedFields.join(', ') }) }}
              </div>
            </div>
          </div>
          <!-- One bite at a time rather than on scroll: the timeline is what a reader scans, not
               what should quietly grow underneath them while they are doing it. -->
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
                   never emits. -->
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
            untouched, and the timeline entry is where what changed is listed.
          -->
          <div class="page-history-same" v-if="state.sameContent">
            {{ t('history.sameContent') }}
          </div>
          <!--
            Monaco never sees this pair. `v-show`, not `v-if`, on the diff container below: an
            editor already mounted on it from an earlier, smaller comparison needs somewhere to keep
            living while it is hidden.
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

import { useDark } from '@/composables/dark'
import { confirm, dialog } from '@/composables/dialog'
import { tooLargeToDiffInline, useMonacoDiff } from '@/composables/monacoDiff'
import { notify } from '@/composables/notify'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDate } from '@/helpers/datetime'
import { duplicatedPageProps } from '@/helpers/duplicatedPageProps'
import { localizedPagePath } from '@/helpers/pagePaths'

/**
 * `MainOverlayDialog.vue` forwards `siteStore.overlayOpts` to every overlay it mounts as this prop.
 * Declared here even though this overlay reads no initial state: undeclared, the value would fall
 * through onto this component's DOM root instead.
 */
defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

/**
 * A and B are a pair of cursors over the timeline, deliberately not "the selected item" — comparing
 * a version against the one immediately before it is only the most common question, not the only
 * one, so clicking an entry sets that up and the two letters then move independently. A always
 * draws on the left, whichever way round in time the pair happens to be.
 */

const dark = useDark()

const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const router = useRouter()

const { t } = useI18n()

const state = reactive({
  loading: 0,
  /** Newest first, as the API returns them: entry 0 is the page as it stands. */
  versions: [],
  /** Keyset paging cursor; null once there is nothing older left to fetch. */
  nextCursor: null,
  /** Separate from `loading`: fetching an older page shouldn't reshow the header's syncing spinner. */
  loadingMore: false,
  /** Null against the very first version, where there is nothing to compare to. */
  aId: null,
  /** Never null once there is any history at all. */
  bId: null,
  notice: '',
  /** Set alongside the models rather than computed: the fetched sources are held outside `state`. */
  sameContent: false,
  diffTooLarge: false,
  inline: false
})

/**
 * The icon names are literals on purpose: one built at runtime is not inlined by the icon generator.
 *
 * The dot classes are this component's own rather than Tailwind utilities: each `bg-*` utility
 * resolves through a token tier the design does not draw here, and a utility carries no glyph ink,
 * so the fill and the ink over it live together as one rule in the stylesheet.
 */
const ACTION_STYLES = {
  created: { icon: 'tabler:plus', dot: 'is-created' },
  updated: { icon: 'tabler:pencil', dot: 'is-updated' },
  moved: { icon: 'tabler:share', dot: 'is-moved' },
  deleted: { icon: 'tabler:trash', dot: 'is-deleted' }
}
const ACTION_FALLBACK = { icon: 'tabler:circle', dot: 'is-other' }

const diffEl = ref(null)

const { showDiff, setInline, disposeModels, disposeEditor } = useMonacoDiff(diffEl, {
  isInline: () => state.inline
})

/** Fetched sources by id, deliberately outside reactive `state`. */
const contents = new Map()

/** Guards against an out-of-order fetch: only the newest comparison may touch the editor. */
let applyToken = 0

const sideA = computed(() => state.versions.find((v) => v.id === state.aId) ?? null)
const sideB = computed(() => state.versions.find((v) => v.id === state.bId) ?? null)

watch(() => [state.aId, state.bId], applyDiff)

watch(() => state.inline, setInline)

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

/** The oldest entry has nothing before it, so A goes empty and the diff shows the page arriving. */
function selectVersion(idx) {
  state.bId = state.versions[idx]?.id ?? null
  state.aId = state.versions[idx + 1]?.id ?? null
}

/**
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

/** Cached: the two letters walk back and forth, and a version is immutable once written. */
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

const FILE_TYPES = {
  markdown: { ext: 'md', mime: 'text/markdown' },
  html: { ext: 'html', mime: 'text/html' }
}

/** From the version, not the page: the page may have been converted to another format since. */
function contentTypeOf(version) {
  return version?.meta?.contentType || version?.meta?.editor || pageStore.editor || 'markdown'
}

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
 * Rendered on the client, as every save is: the markdown pipeline is a frontend one, and rendering
 * it server-side would mean driving a headless browser.
 */
async function renderOf(version, content) {
  if (contentTypeOf(version) !== 'markdown') {
    return content
  }
  // -> `ensureConfigs()`, not a bare loaded-check: it also refreshes the glossary term list even
  //    when the rest of the per-site renderer config is already loaded
  await editorStore.ensureConfigs()
  // -> `pagePath` so a relative image resolves as it does in the page view, not against the site root
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
  const name = full.path.split('/').at(-1) || 'page'
  const stamp = full.versionDate.slice(0, 19).replace(/[:T]/g, '-')
  try {
    /*
      A bare MIME type, with no `;charset=` on it: the save picker uses this as an `accept` key and
      rejects a type carrying parameters outright. Nothing is lost — a Blob built from a JS string
      is UTF-8 already.
    */
    await fileSave(new Blob([full.content ?? ''], { type: type.mime }), {
      fileName: `${name}-${stamp}.${type.ext}`,
      extensions: [`.${type.ext}`]
    })
  } catch (err) {
    // -> Dismissing the file picker is not a failure
    if (err.name !== 'AbortError') {
      notify({
        type: 'negative',
        message: t('history.downloadFailed'),
        caption: apiErrorMessage(err)
      })
    }
  }
}

/**
 * The source only: the page keeps the title, tags and settings it has now, since restoring those
 * too would quietly undo everything done since. Nothing is lost either way — this is an ordinary
 * edit, so it becomes a version of its own with the current state recorded in it.
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
      // -> The restore is itself a version, so both the page behind this overlay and the timeline
      //    are out of date
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

/** For a version worth keeping but not worth reverting to: a duplicate of the page as it was. */
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
          //    another locale, and a version is a record of what the page WAS
          locale: full.locale || pageStore.locale,
          editor: full.meta?.editor || pageStore.editor,
          content,
          render: await renderOf(full, content),
          description: '',
          ...duplicatedPageProps({ ...full.meta, ...full.meta?.config }),
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

function languageOf(version) {
  const type = contentTypeOf(version)
  if (type === 'html') {
    return 'html'
  }
  // -> A redirect's content is JSON (`helpers/pageRedirect.js`), not prose: coloured as markdown, a
  //    target such as `/foo_bar` reads as broken emphasis syntax rather than as the path it is
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
      // -> Neither version reaches Monaco; release the previous pair so the hidden editor is not
      //    left holding a stale diff
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
    // -> No notice: the timeline already says so, and the diff pane would say it twice
    if (state.versions.length < 1) {
      return
    }
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

onMounted(load)

onBeforeUnmount(disposeEditor)
</script>

<style>
/*
  Selectors are written flat rather than with `&-suffix` nesting: that is Sass string concatenation,
  which native CSS nesting does not support -- the browser silently drops such a rule.

  Every tone the palette names is read as a `var(--color-*)` custom property rather than a fixed
  value: the custom property is what `css/tailwind.css` swaps per aesthetic, so a frozen tone would
  render the same under Cobalt as under Ledger.
*/
.page-history {
  /* -> The header is the positioning context for the page title below */
}
.page-history .card-header {
  position: relative;
}
.page-history {
  /*
    -> `left`/`translateX(-50%)` stay physical on purpose: this centers the title over the whole
       header regardless of reading direction -- not a reading-direction lean. Allowlisted in
       `frontend/src/logicalSpacing.test.js` for that reason.
  */
}
.page-history-page {
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
  /*
    -> `.card-header` (`css/_base.css`) uppercases a dialog's title band, and this span sits inside
       that band: without the override it would shout the page's own title back, which the design
       sets as the author wrote it.
  */
  text-transform: none;
}
.page-history {
  /*
    This overlay is drawn on INK in both themes, and is the only screen in the app that is: a diff is
    code, and code is read on a dark ground here the way it is in the editor. So the tones below are
    the dark ramp stated directly rather than through a theme branch -- panel for the timeline
    column, the recessed tone for the diff beside it.
  */
}
.page-history-sidebar {
  background-color: var(--color-dark-4);
  color: var(--color-text-dark);
  border-inline-end: 1px solid var(--color-hairline-dark);
}
.page-history-main {
  display: flex;
  flex-direction: column;
  background-color: var(--color-dark-5);
  color: var(--color-text-dark);
  /* -> The grid cell already has a height; this claims it so the diff can fill what is left */
  height: 100%;
  min-height: 0;
}
.page-history {
  /* The timeline rule is drawn once by the list, not per item. */
}
.page-history-timeline {
  position: relative;
  padding: 1rem 0;
  /*
    The line and the quarter turn it makes at the end are ONE border of ONE box -- the trailing and
    bottom edges of an invisible rectangle, joined by a corner radius -- rather than a straight
    element meeting a curved one. Two elements cannot be made to match under fractional display
    scaling: each snaps to the device pixel grid from its own layout box, so one lands on a whole
    device pixel while the other straddles two and the seam shows as a change of thickness. As a
    single border the browser rasterises the straight stretch and the curve as one path.

    The box's trailing edge sits under the middle of the dots: 1rem of padding, half of the 28px
    dot, half of the 2px line.
  */
}
.page-history-timeline::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  inset-inline-start: 0;
  width: calc(1rem + 14px + 1px);
  border-inline-end: 2px solid var(--color-hairline-dark);
  border-bottom: 2px solid var(--color-hairline-dark);
  border-end-end-radius: 16px;
}
.page-history-item {
  position: relative;
  display: flex;
  /* -> Wraps so the notes below can claim a row of their own; no row gap, since they bring their
        own margin */
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0 0.75rem;
  padding: 0.75rem 1rem;
  cursor: pointer;
}
.page-history-item:hover {
  background-color: var(--color-dark-2);
}
.page-history-item {
  /*
    An inset shadow rather than a `border-left`: a border is part of the box, so it would push the
    row's contents across and take a picked entry's dot off the line while the unpicked ones stay
    on it.

    `--color-accent-fill`, not `--color-primary`: this is an UNTEXTED highlight -- a wash plus an
    inset bar, the same pairing the file manager's selected row and the site's active-nav item use
    -- not a fill carrying text. `color-mix()` derives the wash from that same token rather than
    adding a second, undeclared one, as `_base.css`'s `.header-nav-btn:hover` does.
  */
}
.page-history-item.is-picked {
  background-color: color-mix(in srgb, var(--color-accent-fill) 16%, transparent);
  box-shadow: inset 3px 0 0 var(--color-accent-fill);
}
.page-history {
  /*
    Ringed in the timeline column's own ground (`--color-dark-4`, not the diff pane's
    `--color-dark-5`) so the line behind it reads as passing UNDER the dot rather than through it.
    Any other tone draws a visible halo instead of disappearing.
  */
}
.page-history-dot {
  flex: 0 0 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 0 3px var(--color-dark-4);
}
.page-history {
  /*
    Every dot is a fill, so the glyph over it takes whichever ink clears it: white on the two darker
    fills, `--color-ink` on the two bright ones -- the rule `css/tailwind.css` states for every
    `-fill` tone.

    #5f78a8 is a literal because the palette has no name for it: it is the only tone on this screen
    that is neither chrome nor a status. Naming it is a job for the token pass, not for this file.
  */
}
.page-history-dot.is-created {
  background-color: var(--color-positive-fill);
  color: #fff;
}
.page-history-dot.is-updated {
  background-color: #5f78a8;
  color: #fff;
}
.page-history-dot.is-moved {
  background-color: var(--color-warning-fill);
  color: var(--color-ink);
}
.page-history-dot.is-deleted {
  background-color: var(--color-negative-fill);
  color: var(--color-ink);
}
.page-history {
  /* -> An action this build has no name for: chrome, so it reads as unclassified, not a status */
}
.page-history-dot.is-other {
  background-color: var(--color-slate-soft);
  color: #fff;
}
.page-history-body {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 0.85rem;
  line-height: 1.35;
}
.page-history-meta {
  font-size: 0.75rem;
  color: var(--color-text-secondary-dark);
}
.page-history {
  /*
    One tone across all three metadata lines, but not one typeface: the timestamp and the
    destination path are mono, the author's name is the proportional face beside them.
  */
}
.page-history-time {
  margin-top: 2px;
  font-family: var(--font-mono);
}
.page-history-path {
  font-family: var(--font-mono);
  font-size: 0.72rem;
}
.page-history {
  /* -> `WBadge` is already mono/9px/600; the casing and the tracking are what it does not do. */
}
.page-history-item .w-badge {
  text-transform: uppercase;
  letter-spacing: 0.14em;
}
.page-history {
  /* -> Indented to sit under the entry's text rather than under its dot */
}
.page-history-notes {
  flex: 0 0 100%;
  min-width: 0;
  padding-inline-start: calc(28px + 0.75rem);
}
.page-history-reason {
  margin-top: 0.25rem;
  font-size: 0.78rem;
  font-style: italic;
  color: var(--color-text-dark);
  word-break: break-word;
}
.page-history {
  /* -> Mono, like every other list of machine names in this language */
}
.page-history-fields {
  margin-top: 0.25rem;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--color-text-caption-dark);
  word-break: break-word;
}
.page-history-pick {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.page-history-load-more {
  display: flex;
  justify-content: center;
  padding: 0.5rem 1rem 1rem;
}
.page-history-compare {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  /* -> No gap: each side owns exactly half the width, and its own padding keeps the two apart */
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--color-hairline-dark);
  font-size: 0.85rem;
}
.page-history {
  /* -> Half each, so B starts on the divider between the editor's two panes rather than wherever
        the row's other contents happen to leave it */
}
.page-history-side {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex: 0 0 50%;
  min-width: 0;
  padding: 0 1rem;
}
.page-history {
  /* -> `--color-accent`, not `--color-primary`: a white letter needs the white-text accent role,
        the same distinction the "Current" badge above draws. */
}
.page-history-letter {
  flex: 0 0 24px;
  height: 24px;
  background-color: var(--color-accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 12px;
}
.page-history-pick-group .w-btn {
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 11px;
}
.page-history {
  /*
    Cobalt only: a Cobalt `w-btn` is individually rounded (`--radius-control`), so
    `WBtnGroup.vue`'s touching-squares layout -- zero gap, a seam hairline between buttons -- draws
    two rounded plates overlapping into a lens shape at the seam, with a hairline rule running
    through them besides. The design draws a real gap between two separately rounded plates
    instead, with no line between them at all.

    The selector below out-specifies `WBtnGroup.vue`'s own
    `.w-btn-group[data-v-*] > .w-btn:not(:last-child)` (its `[data-v-*]` scope attribute and this
    rule's leading `body` type selector both count once the class tally ties), so no `!important`
    is needed.
  */
}
body.body--cobalt .page-history-toggle {
  gap: 10px;
}
body.body--cobalt .page-history-pick-group {
  gap: 4px;
}
body.body--cobalt .page-history-toggle .w-btn:not(:last-child),
body.body--cobalt .page-history-pick-group .w-btn:not(:last-child) {
  border-inline-end: none;
}
.page-history-same {
  flex: 0 0 auto;
  padding: 0.5rem 1rem;
  font-size: 0.8rem;
  color: var(--color-text-secondary-dark);
  background-color: var(--color-dark-2);
}
.page-history {
  /* -> Takes the diff pane's place rather than sitting alongside it, unlike `-same` above: there is
        no partial diff underneath this one to also show. */
}
.page-history-toolarge {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 2rem;
  text-align: center;
  color: var(--color-text-secondary-dark);
}
.page-history-toolarge-text {
  max-width: 32rem;
  font-size: 0.9rem;
}
.page-history-toolarge-actions {
  display: flex;
  gap: 0.75rem;
}
.page-history-diff {
  flex: 1 1 auto;
  min-height: 0;
}
</style>
