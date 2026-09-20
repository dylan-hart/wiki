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
 * Markdown and wysiwyg share `'markdown'` storage (`backend/models/pages.ts#EDITOR_CONTENT_TYPES`),
 * so converting between them never rewrites `content`. What can change is whether the WYSIWYG node
 * set expresses the markdown losslessly, which is what the guard checks: round-trip the stored
 * markdown through a headless copy of that node set, render both texts with the site's own
 * `MarkdownRenderer`, and refuse anything but identical output. The backend route re-checks only
 * that the row is still convertible, so this guard is the whole of the lossiness decision.
 *
 * The extension list below is deliberately a second copy of `EditorWysiwyg.vue`'s rather than an
 * import from it. A headless `Editor` (no `element`) never mounts into the document.
 */

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const commonStore = useCommonStore()
const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()

const { t } = useI18n()

const targetEditor = computed(() => (pageStore.editor === 'wysiwyg' ? 'markdown' : 'wysiwyg'))

const targetEditorName = computed(() => t(`admin.editors.${targetEditor.value}Name`))

const state = reactive({
  checking: true,
  canConvert: false,
  converting: false,
  /** @type {{line: number, before: string, after: string}|null} */
  firstDifference: null
})

let lowlight = null

/** Mirrors `EditorWysiwyg.vue#buildExtensions(null)` -- the two must stay in step. */
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
 * The pass/fail decision is made on rendered HTML; the reader is shown the markdown line instead,
 * which is far more actionable.
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

/** Keeps `runGuard()`'s awaited `ensureConfigs()` from writing into a torn-down component's state. */
let destroyed = false

async function runGuard() {
  // -> `ensureConfigs()`, not a bare check: it also refreshes the glossary terms the extension list
  //    below reads.
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
    // -> `null`, not the `original` default: leaving it would compare equal below and read as a
    //    pass, when in fact the target node set could not parse the content at all.
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
