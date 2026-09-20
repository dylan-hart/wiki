<template>
  <w-layout class="table-editor" container>
    <w-header class="card-header">
      <w-icon name="tabler:table" left size="md" />
      <span>{{ t(`editor.tableEditor.title`) }}</span>
      <w-space />
      <w-btn-group>
        <w-btn
          color="white"
          text-color="text-secondary"
          :label="t(`common.actions.cancel`)"
          :aria-label="t(`common.actions.cancel`)"
          icon="tabler:x"
          @click="close" />
        <w-btn
          color="positive"
          text-color="white"
          :label="state.replace ? t('common.actions.update') : t('common.actions.insert')"
          :aria-label="state.replace ? t('common.actions.update') : t('common.actions.insert')"
          icon="tabler:check"
          @click="insert" />
      </w-btn-group>
    </w-header>
    <w-page-container>
      <w-page class="p-4">
        <!--
          Bled out of the page's own `p-4` on three sides so the band meets the header and both
          edges, and carries no padding of its own: each button's `flush-hover-btn` hover has to
          reach the band's edges, so the buttons stretch to its height (`min-h-11`) and every
          non-button child insets itself. Only the trailing edge takes `pe-4` back.
        -->
        <div class="table-editor-toolbar -mx-4 -mt-4 flex min-h-11 flex-wrap items-stretch pe-4">
          <!-- -> `dense` for the 10px inset the design draws every control in this strip at; the
                  band's `items-stretch` takes over its 28px height -->
          <w-btn
            flat
            dense
            class="flush-hover-btn"
            icon="tabler:plus"
            color="primary"
            :label="t(`editor.tableEditor.addRow`)"
            @click="addRow" />
          <w-btn
            flat
            dense
            class="flush-hover-btn"
            icon="tabler:plus"
            color="primary"
            :label="t(`editor.tableEditor.addColumn`)"
            @click="addColumn" />
          <w-separator vertical />
          <div class="flex items-center gap-2 self-center px-2">
            <w-checkbox v-model="state.headerless" :label="t('editor.tableEditor.headerless')" />
            <w-checkbox v-model="state.compact" :label="t('editor.tableEditor.compact')" />
          </div>
          <!--
            Checkboxes in a menu rather than a `w-select`: three independent switches, not one choice
            from a list, and `WMenu` does not close on a click inside itself, so all three can be set
            in one visit.
          -->
          <w-separator vertical />
          <w-btn
            flat
            dense
            class="flush-hover-btn"
            icon="tabler:palette"
            color="slate"
            :label="t(`editor.tableEditor.styling`)">
            <w-icon name="tabler:chevron-down" />
            <w-menu anchor="bottom left" self="top left" :offset="[0, 4]">
              <div class="flex flex-col gap-3 p-4">
                <w-checkbox
                  v-for="option of STYLE_CLASSES"
                  :key="option.value"
                  v-model="state.classes"
                  :val="option.value"
                  :label="t(option.label)" />
              </div>
            </w-menu>
          </w-btn>
          <w-space />
          <div class="self-center ps-2 text-[11.5px] text-slate dark:text-slate-light">
            {{ t('editor.tableEditor.pasteHint') }}
          </div>
        </div>
        <div class="table-editor-grid mt-4">
          <table>
            <thead>
              <tr class="table-editor-tools">
                <th v-for="(align, colIndex) of state.align" :key="`tool-${colIndex}`">
                  <div class="flex flex-nowrap items-center justify-center gap-1">
                    <!-- -> Slate, not the accent: the alignment is a property of the column rather
                            than an action on it, and the only red here belongs to the delete -->
                    <w-btn
                      flat
                      class="table-editor-toolbtn text-slate-soft dark:text-slate-light"
                      :icon="ALIGN_ICONS[align]"
                      :aria-label="t(`editor.tableEditor.align`)"
                      @click="cycleAlign(colIndex)">
                      <w-tooltip>
                        {{ t('editor.tableEditor.align') }}: {{ t(ALIGN_LABELS[align]) }}
                      </w-tooltip>
                    </w-btn>
                    <w-btn
                      flat
                      class="table-editor-toolbtn table-editor-toolbtn--del"
                      color="negative"
                      icon="tabler:x"
                      :disabled="state.align.length < 2"
                      :aria-label="t(`editor.tableEditor.removeColumn`)"
                      @click="removeColumn(colIndex)">
                      <w-tooltip>{{ t('editor.tableEditor.removeColumn') }}</w-tooltip>
                    </w-btn>
                  </div>
                </th>
                <!-- -> Matches the row-tools column below, so the grid stays square -->
                <th class="table-editor-rowtools" />
              </tr>
              <!-- -> Dropped rather than emptied when headerless: `rows[0]` is then a body row, and
                      is drawn as one below -->
              <tr v-if="!state.headerless">
                <th
                  v-for="(_, colIndex) of state.rows[0]"
                  :key="`head-${colIndex}`"
                  class="table-editor-cellbox">
                  <input
                    v-model="state.rows[0][colIndex]"
                    class="table-editor-cell table-editor-cell--head"
                    type="text"
                    :style="{ textAlign: state.align[colIndex] }"
                    :aria-label="t(`editor.tableEditor.headerCell`, { column: colIndex + 1 })"
                    @paste="onCellPaste(0, colIndex, $event)" />
                </th>
                <th class="table-editor-rowtools" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, rowIndex) of bodyRows" :key="`row-${rowIndex}`">
                <td
                  v-for="(_, colIndex) of row"
                  :key="`cell-${rowIndex}-${colIndex}`"
                  class="table-editor-cellbox">
                  <input
                    v-model="state.rows[rowIndex + rowOffset][colIndex]"
                    class="table-editor-cell"
                    type="text"
                    :style="{ textAlign: state.align[colIndex] }"
                    :aria-label="
                      t(`editor.tableEditor.bodyCell`, { row: rowIndex + 1, column: colIndex + 1 })
                    "
                    @paste="onCellPaste(rowIndex + rowOffset, colIndex, $event)" />
                </td>
                <td class="table-editor-rowtools">
                  <w-btn
                    flat
                    class="table-editor-toolbtn table-editor-toolbtn--del"
                    color="negative"
                    icon="tabler:x"
                    :disabled="bodyRows.length < 2"
                    :aria-label="t(`editor.tableEditor.removeRow`)"
                    @click="removeRow(rowIndex + rowOffset)">
                    <w-tooltip>{{ t('editor.tableEditor.removeRow') }}</w-tooltip>
                  </w-btn>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="w-section-header mt-4">{{ t('editor.tableEditor.markdown') }}</div>
        <!--
          `page-contents` is the content stylesheet, so the preview draws as the page will draw it in
          both themes without this file restating any of it. No margin of its own — the band above
          owns the gap — and the `pre` is the only child, which gives up the block margins content
          puts around a code block.
        -->
        <div class="page-contents">
          <pre>{{ markdown }}</pre>
        </div>
      </w-page>
    </w-page-container>
  </w-layout>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive } from 'vue'
import { useI18n } from 'vue-i18n'

import { ALIGNMENTS, buildTable, parseTable } from '@/helpers/markdownTable'

import { useSiteStore } from '@/stores/site'

/**
 * Opened over an existing table: `{ source, startLine, endLine }`, from the markdown editor's
 * "Edit Table" lens. Empty when the overlay was opened to insert a new one.
 */
const props = defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

/**
 * Handmade rather than a data grid: a markdown table is one-line strings in a grid plus a per-column
 * alignment, and a sortable, virtually-rendered grid component has nowhere to put that alignment.
 * Every editing gesture here is a `splice`.
 */

const siteStore = useSiteStore()

const { t } = useI18n()

const ALIGN_ICONS = {
  left: 'tabler:align-left',
  center: 'tabler:align-center',
  right: 'tabler:align-right'
}

/*
  The UI for the table classes `css/_page-contents.css` defines: a class added there needs a line
  here to be reachable, and a line here naming a rule that does not exist does nothing at all. A
  class an author wrote by hand and that is not listed survives in `state.classes` untouched; it
  simply has no box of its own.
*/
const STYLE_CLASSES = [
  { value: 'table-vertical-middle', label: 'editor.tableEditor.styleVerticalMiddle' },
  { value: 'table-leading-col', label: 'editor.tableEditor.styleLeadingCol' },
  { value: 'table-code-nohighlight', label: 'editor.tableEditor.styleCodeNoHighlight' }
]

/* -> Spelled out rather than built from the value: a key assembled at runtime is invisible to the
      translation tooling. */
const ALIGN_LABELS = {
  left: 'editor.tableEditor.alignLeft',
  center: 'editor.tableEditor.alignCenter',
  right: 'editor.tableEditor.alignRight'
}

/*
  `rows[0]` is the header unless `headerless` is set, in which case every row is a body row. Keeping
  the header in the same array as the body makes a column operation one splice per row instead of
  two code paths that have to agree, and makes the Headerless tick reversible: nothing is thrown
  away, the first row just stops being a heading.
*/
const editing = props.overlayOpts?.source
  ? {
      ...parseTable(props.overlayOpts.source),
      replace: {
        startLine: props.overlayOpts.startLine,
        endLine: props.overlayOpts.endLine
      }
    }
  : null

const state = reactive(
  editing ?? {
    align: ['left', 'left', 'left'],
    compact: true,
    headerless: false,
    classes: [],
    otherAttrs: [],
    rows: [
      ['Column 1', 'Column 2', 'Column 3'],
      ['', '', ''],
      ['', '', '']
    ],
    replace: null
  }
)

const rowOffset = computed(() => (state.headerless ? 0 : 1))

const bodyRows = computed(() => state.rows.slice(rowOffset.value))

/* -> Same module that parsed the table being edited: the two directions have to agree, or reopening
      a table would reformat it */
const markdown = computed(() => buildTable(state, { compact: state.compact }))

function cycleAlign(colIndex) {
  const next = (ALIGNMENTS.indexOf(state.align[colIndex]) + 1) % ALIGNMENTS.length
  state.align[colIndex] = ALIGNMENTS[next]
}

function addRow() {
  state.rows.push(state.align.map(() => ''))
}

function removeRow(rowIndex) {
  state.rows.splice(rowIndex, 1)
}

function addColumn() {
  state.align.push('left')
  for (const row of state.rows) {
    row.push('')
  }
}

function removeColumn(colIndex) {
  state.align.splice(colIndex, 1)
  for (const row of state.rows) {
    row.splice(colIndex, 1)
  }
}

function ensureSize(rowCount, colCount) {
  while (state.align.length < colCount) {
    addColumn()
  }
  while (state.rows.length < rowCount) {
    addRow()
  }
}

/**
 * Tab-separated lines are what a spreadsheet puts on the clipboard, so a table copied out of one
 * fills the grid from where it was pasted rather than landing as text in a single cell.
 */
function onCellPaste(rowIndex, colIndex, event) {
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (!text.includes('\t') && !text.includes('\n')) {
    return
  }
  event.preventDefault()
  const grid = text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => line.split('\t'))
  ensureSize(rowIndex + grid.length, colIndex + Math.max(...grid.map((cells) => cells.length)))
  grid.forEach((cells, r) => {
    cells.forEach((cell, c) => {
      state.rows[rowIndex + r][colIndex + c] = cell.trim()
    })
  })
}

function insert() {
  EVENT_BUS.emit('insertTable', { markdown: markdown.value, replace: state.replace })
  close()
}

function close() {
  siteStore.$patch({ overlay: '' })
}

// -> Cleared here rather than in `close`, so it goes whichever way the overlay was left: a table left
//    behind in the options would be edited again the next time the toolbar button opens this overlay
onBeforeUnmount(() => {
  siteStore.overlayOpts = {}
})
</script>

<style>
.table-editor {
  /* The page pads itself 16px (`<w-page class="p-4">`) and a section band is full-bleed, so it needs
     that inset given back; declared beside the padding it cancels so the two cannot drift apart. */
  --w-section-bleed: 16px;
  /*
    Nothing here sits on a `w-card`, which is where the app's dark text colour comes from, so the
    overlay states its own -- otherwise everything that merely inherits `color` (the cell inputs, the
    `Markdown` heading, the checkbox labels) stays black on the dark panel. The ground goes with it:
    the shared panel rule paints `var(--color-surface)`, which the cells also take, so they would
    have nothing to read against.
  */
}
.body--light .table-editor {
  color: var(--color-ink);
  background-color: var(--color-paper);
}
.body--dark .table-editor {
  color: #fff;
}
.table-editor {
  /*
    Cobalt's button-group rule (`ui-iteration/README.md` Part 2): adjacent buttons take a gap and
    each keeps its own radius, rather than `WBtnGroup`'s default Ledger seam -- so the seam is
    switched off below, or it would show through the gap. A local copy of a rule that belongs in
    `WBtnGroup`; reconcile if a shared mechanism ships.
  */
}
.body--cobalt .table-editor .card-header .w-btn-group {
  gap: 8px;
}
.body--cobalt .table-editor .card-header .w-btn-group > .w-btn:not(:last-child) {
  border-inline-end: none;
}
.table-editor {
  /* The page tint ruled off underneath -- the same recipe `.w-section-header` draws the `Markdown`
     heading below with, so the two read as a pair. */
}
.body--light .table-editor-toolbar {
  background-color: var(--color-tint);
  border-bottom: 1px solid var(--color-hairline);
}
.body--dark .table-editor-toolbar {
  background-color: var(--color-dark-2);
  border-bottom: 1px solid var(--color-hairline-dark);
}
.table-editor-toolbar {
  /*
    A short tick, not a rule the full height of the row: `WSeparator` stretches to its flex line and
    paints the generic hairline, both pinned here rather than by widening its props, since this is
    the only place in the app that wants a vertical tick inside a control strip.
  */
}
.table-editor-toolbar .w-separator {
  align-self: center;
  height: 22px;
  margin-inline: 4px;
  --w-hairline-color: var(--color-rule);
}
.body--dark .table-editor-toolbar .w-separator {
  --w-hairline-color: var(--color-border-dark);
}
.table-editor-grid {
  overflow-x: auto;
}
.table-editor-grid table {
  border-collapse: collapse;
}
.table-editor {
  /*
    A class on the cells that hold an input, not a `th, td` rule inside the grid: the two chrome
    columns -- the tools row above the head and the row-tools column down the side -- are `th`/`td`
    too, and a rule reaching every cell would have to be undone for both of them.
  */
}
.table-editor-cellbox {
  padding: 0;
  border: 1px solid var(--color-hairline);
  background-color: var(--color-surface);
}
.body--dark .table-editor-cellbox {
  border-color: var(--color-hairline-dark);
  background-color: var(--color-dark-3);
}
.table-editor-cellbox {
  /*
    Row banding sits at the bottom of this block instead: the band is the cell's ANCESTOR, so the
    selector cannot hang off this class. `#f8f9fc` there has no token of its own -- it is the
    half-step below white `WInput`/`WSelect` paint a read-only field in.
  */
}
.table-editor {
  /* -> The tools row is chrome, not content: no border under the buttons, tighter than a data row */
}
.table-editor-tools th {
  padding: 2px 4px;
}
.table-editor-rowtools {
  width: 32px;
  padding: 0 2px;
  text-align: center;
}
.table-editor {
  /* -> A hit target sized to the tools row rather than to a button band. `WBtn` writes its
          `min-height` and `padding` INLINE, off its font size, so these have to out-specify them */
}
.table-editor-toolbtn {
  width: 24px;
  min-width: 24px;
  height: 22px;
  min-height: 22px !important;
  padding: 0 !important;
  font-size: 14px;
  /* -> A plate holding one glyph and no text: `WBtn`'s own leading would make it taller than 22px */
  line-height: 1;
  /* -> The X reads a size larger than the align glyphs at the same box, so it is set smaller */
}
.table-editor-toolbtn--del {
  font-size: 13px;
}
.table-editor-cell {
  display: block;
  width: 200px;
  padding: 7px 9px;
  background-color: transparent;
  color: inherit;
  font-size: 14px;
  outline: none;
  /*
    The focus ring is an `outline` on the INPUT rather than a border on the cell: `border-collapse:
    collapse` picks one winner per shared edge, so recolouring a single cell's border is not
    reliable. The cell is unpadded, so an outline at offset 0 lands over the collapsed border.
  */
}
.table-editor-cell:focus {
  background-color: var(--color-tint);
  outline: 1px solid var(--color-slate);
}
.body--dark .table-editor-cell:focus {
  background-color: var(--color-dark-2);
  outline-color: var(--color-slate-light);
}
.table-editor-cell {
  /* -> Bold, the way the rendered page draws a header row */
}
.table-editor-cell--head {
  font-weight: 600;
}
.table-editor {
  /*
    Cobalt draws the grid as a single plate rather than as individually bordered cells on a collapsed
    table: `border-collapse: separate` with a 2px gap, the plate itself tinted and bordered, so what
    is each cell's own hairline elsewhere is the plate ground showing through the gap.

    Scoped `body.body--cobalt` -- a type selector plus the aesthetic class, matching `tailwind.css`'s
    own convention -- so these rules outrank the generic `.body--dark .table-editor-cell:focus` rule
    above: a same-shape `.body--cobalt` selector would tie with it under Cobalt dark, leaving the
    winner to source order rather than intent.
  */
}
body.body--cobalt .table-editor-grid table {
  border-collapse: separate;
  border-spacing: 2px;
  background-color: var(--color-tint);
  border-radius: var(--radius-card);
  padding: 2px;
  border: 1px solid var(--color-hairline);
}
body.body--cobalt .table-editor {
  /* -> The plate's own border-spacing gap, filled with its tint, is what separates cells here, so
          the per-cell hairline goes */
}
body.body--cobalt .table-editor-cellbox {
  border: 0;
}
body.body--cobalt .table-editor {
  /*
    A half-step lighter than the plate, toward the page ground: `#eef2ff` sits between the plate's
    `#e6edff` and the page's `#f2f5ff`. Its dark counterpart is the last rule in this block.
  */
}
body.body--cobalt .table-editor th.table-editor-cellbox {
  background-color: #eef2ff;
}
body.body--cobalt .table-editor {
  /* -> Both chrome strips sit on the page ground rather than staying transparent, so they read as
          surround rather than as part of the plate */
}
body.body--cobalt .table-editor-tools th,
body.body--cobalt .table-editor-rowtools {
  background-color: var(--color-paper);
}
body.body--cobalt .table-editor {
  /* -> `border-collapse: separate` leaves no shared, collapsed edge to work around, so the focus
          ring can sit directly on the input instead of as an outline over that edge */
}
body.body--cobalt .table-editor-cell:focus {
  background-color: var(--color-surface);
  outline: none;
  box-shadow: inset 0 0 0 2px var(--color-accent-strong);
}
.table-editor {
  /*
    Cobalt dark's one departure from the light rules above: there is no Cobalt-dark design for this
    screen to measure a header tint against, so it takes the ramp's analogous "one rung more raised
    than the plate" rung rather than an invented literal.
  */
}
body.body--cobalt.body--dark .table-editor th.table-editor-cellbox {
  background-color: var(--color-dark-3);
}

tbody > tr:nth-child(even) > .table-editor-cellbox {
  background-color: #f8f9fc;
}
.body--dark tbody > tr:nth-child(even) > .table-editor-cellbox {
  background-color: var(--color-dark-4);
}
</style>
