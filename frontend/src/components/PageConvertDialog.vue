<template>
  <w-dialog v-model="dialogVisible" :aria-label="t('pageConvertDialog.title')" @hide="onDialogHide">
    <w-card style="width: 520px; max-width: 90vw">
      <w-card-section class="card-header">
        <w-icon name="tabler:replace" size="sm" class="me-2" />
        <span>{{ t('pageConvertDialog.title') }}</span>
      </w-card-section>
      <w-separator />
      <w-card-section>
        <div v-if="state.checking" class="flex items-center gap-2">
          <w-spinner size="20px" />
          <span>{{ t('pageConvertDialog.checking', { editor: targetEditorName }) }}</span>
        </div>
        <div v-else-if="state.canConvert" class="text-body2">
          {{ t('pageConvertDialog.safeToConvert', { editor: targetEditorName }) }}
        </div>
        <div v-else class="text-body2">
          <div class="text-negative">
            {{ t('pageConvertDialog.refused', { editor: targetEditorName }) }}
          </div>
          <div v-if="state.firstDifference" class="mt-3">
            <div class="text-caption text-grey">
              {{ t('pageConvertDialog.firstDifferenceLine', { line: state.firstDifference.line }) }}
            </div>
            <pre class="page-convert-diff-line page-convert-diff-before">{{
              state.firstDifference.before
            }}</pre>
            <pre class="page-convert-diff-line page-convert-diff-after">{{
              state.firstDifference.after
            }}</pre>
          </div>
        </div>
      </w-card-section>
      <w-separator />
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(state.canConvert ? `common.actions.cancel` : `common.actions.close`)"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
        <w-btn
          v-if="state.canConvert"
          :label="t('pageConvertDialog.convert')"
          color="primary"
          padding="xs md"
          :loading="state.converting"
          @click="convert" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import {
  withStyleSpanMarkdown,
  withStyleSpanRenderMarkdown,
  withTextAlignMarkdown
} from '@/helpers/wysiwygStyleAttrs'
import { createPageMentionSuggestion } from '@/helpers/editorMentions'

import { createBlockLoader, WikiBlock } from '@/editor/wysiwyg'
import {
  GithubAlert,
  FootnoteReference,
  FootnoteDefinition,
  TexMath,
  IconShortcode,
  GlossaryTermHighlight
} from '@/editor/wysiwyg'

import { MarkdownRenderer } from '@/renderers/markdown'

import { useCommonStore } from '@/stores/common'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { Color } from '@tiptap/extension-color'
import FontFamily from '@tiptap/extension-font-family'
import { Heading } from '@tiptap/extension-heading'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import { Markdown } from '@tiptap/markdown'
import Mention from '@tiptap/extension-mention'
import { Paragraph } from '@tiptap/extension-paragraph'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle } from '@tiptap/extension-text-style'
import Typography from '@tiptap/extension-typography'
import { common, createLowlight } from 'lowlight'

/**
 * Editor conversion dialog with a render-equality guard (OpenProject #3399).
 *
 * Reachable from the page actions "..." menu for a page currently in the `markdown` or `wysiwyg`
 * editor (`PageActionsCol.vue`), converting it to whichever of the two it is NOT currently in.
 * Markdown and wysiwyg have shared `'markdown'` storage since #3395
 * (`backend/models/pages.ts#EDITOR_CONTENT_TYPES`), so converting between them never rewrites
 * `content` -- what can genuinely change is whether the WYSIWYG editor's own Tiptap node set can
 * losslessly express it, which is exactly what the guard below checks: parse the page's stored
 * markdown into a headless copy of that same node set, serialize it back out, and render BOTH the
 * original and the round-tripped markdown with the site's own `MarkdownRenderer` (the identical
 * pipeline `EditorMarkdown.vue`/`renderers/headless.js` use). Identical output either way is safe
 * to flip; anything else is refused, with the first differing markdown line shown, rather than
 * silently converted (the backend route this calls trusts that this check already ran and re-checks
 * only that the row is still in a convertible state -- see `backend/models/pages.ts#convertEditor`).
 *
 * The extension set below mirrors `EditorWysiwyg.vue`'s own (non-collaborative) `buildExtensions()`
 * -- deliberately a second copy rather than an import from that component, which this dialog reads
 * but does not touch (this round's batch coordination note, OpenProject #3399/#3405). A headless
 * `Editor` (no `element` given) never mounts into the document -- see `@tiptap/core`'s own test
 * suite for the same construction with no DOM.
 */

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// STORES

const commonStore = useCommonStore()
const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// COMPUTED

/** The editor this page will move TO -- the other one of the pair, whichever it is in now. */
const targetEditor = computed(() => (pageStore.editor === 'wysiwyg' ? 'markdown' : 'wysiwyg'))

const targetEditorName = computed(() => t(`admin.editors.${targetEditor.value}Name`))

// STATE

const state = reactive({
  checking: true,
  canConvert: false,
  converting: false,
  /** @type {{line: number, before: string, after: string}|null} */
  firstDifference: null
})

let lowlight = null

/**
 * The same (non-collaborative) extension list `EditorWysiwyg.vue#buildExtensions(null)` builds --
 * see this file's own header comment for why it is a second copy rather than a shared import.
 */
function buildExtensions() {
  lowlight ??= createLowlight(common)
  return [
    StarterKit.configure({
      codeBlock: false,
      link: false,
      blockquote: false,
      paragraph: false,
      heading: false,
      undoRedo: { depth: 500 }
    }),
    CodeBlockLowlight.configure({ lowlight }),
    withTextAlignMarkdown(Paragraph),
    withTextAlignMarkdown(Heading),
    Color,
    FootnoteReference,
    FootnoteDefinition,
    GithubAlert,
    GlossaryTermHighlight.configure({
      terms: editorStore.editors.markdown?.glossaryTerms ?? []
    }),
    IconShortcode,
    TexMath,
    FontFamily,
    withStyleSpanRenderMarkdown(Highlight).configure({ multicolor: true }),
    Image,
    Link.configure({ openOnClick: false, protocols: ['blob'] }),
    Mention.configure({ suggestion: createPageMentionSuggestion(siteStore) }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    withStyleSpanMarkdown(TextStyle),
    Typography,
    WikiBlock.configure({ loadBlock: createBlockLoader(commonStore, siteStore) }),
    Markdown
  ]
}

/**
 * The first source line at which two markdown texts diverge -- shown to the reader as "here is
 * what the WYSIWYG editor's round trip would change", which is a great deal more actionable than
 * the rendered HTML the pass/fail decision itself is made from.
 */
function firstDifferingLine(a, b) {
  const linesA = (a ?? '').split('\n')
  const linesB = (b ?? '').split('\n')
  const max = Math.max(linesA.length, linesB.length)
  for (let i = 0; i < max; i++) {
    if (linesA[i] !== linesB[i]) {
      return { line: i + 1, before: linesA[i] ?? '', after: linesB[i] ?? '' }
    }
  }
  return null
}

/** Set once the dialog unmounts, so `runGuard()`'s awaited `ensureConfigs()` cannot write into a
 *  torn-down component's state after the fact. */
let destroyed = false

/**
 * The render-equality guard itself: parse the page's current markdown into a headless copy of the
 * WYSIWYG editor's node set, serialize it back out, and compare what the site's own markdown
 * renderer makes of each. Runs once, on open.
 */
async function runGuard() {
  // -> `ensureConfigs()`, not a bare check: also refreshes the glossary term list this dialog's
  //    extension list reads, same as `ImportBatchPageDialog.vue`/`PageHistoryOverlay.vue`.
  await editorStore.ensureConfigs()
  if (destroyed) {
    return
  }

  const original = pageStore.content ?? ''
  let roundTripped = original
  let headless = null
  try {
    headless = new Editor({
      extensions: buildExtensions(),
      content: original,
      contentType: 'markdown',
      editable: false
    })
    roundTripped = headless.getMarkdown()
  } catch {
    // -> Could not even be parsed into the target node set -- definitely not safe to convert. `null`
    //    rather than leaving `roundTripped` at its `original` default: that would compare equal below
    //    and wrongly read as a pass.
    roundTripped = null
  } finally {
    headless?.destroy()
  }

  const md = new MarkdownRenderer(editorStore.editors.markdown ?? {})
  const originalRender = md.render(original, { pagePath: pageStore.path })
  const roundTrippedRender =
    roundTripped === null ? null : md.render(roundTripped, { pagePath: pageStore.path })

  state.canConvert = roundTrippedRender !== null && originalRender === roundTrippedRender
  state.firstDifference = state.canConvert ? null : firstDifferingLine(original, roundTripped ?? '')
  state.checking = false
}

// METHODS

async function convert() {
  state.converting = true
  try {
    await pageStore.convertEditor({ id: pageStore.id, editor: targetEditor.value })
    notify({ type: 'positive', message: t('pageConvertDialog.convertSuccess') })
    onDialogOK()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('pageConvertDialog.convertFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.converting = false
}

// LIFECYCLE

onMounted(() => {
  runGuard()
})
onBeforeUnmount(() => {
  destroyed = true
})
</script>

<style scoped>
.page-convert-diff-line {
  margin: 0.25rem 0;
  padding: 0.5rem;
  white-space: pre-wrap;
  word-break: break-word;
  border-radius: 4px;
  font-size: 0.85em;
}

.page-convert-diff-before {
  background: color-mix(in srgb, var(--color-negative) 12%, transparent);
}

.page-convert-diff-after {
  background: color-mix(in srgb, var(--color-positive) 12%, transparent);
}
</style>
