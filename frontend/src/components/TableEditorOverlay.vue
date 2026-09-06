<template>
  <w-layout class="table-editor" container>
    <w-header class="card-header">
      <!-- -> The design's own glyph: a stroked table grid, not the colour asset this used to draw.
              `img:/_assets/icons/color-data-grid.svg` was the last colour icon left in any overlay
              header, and it read as a sticker beside the tracked uppercase title -->
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
        <!-- -> "Update" when the overlay was opened over a table that is already in the page: the
                button says what pressing it does, and what it does is replace that one -->
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
          The design's own toolbar band (`ui-redesign/Cardinal Wiki - Table Editor 3x.dc.html`): the
          page tint, ruled off underneath -- the same recipe the `Markdown` heading below draws with,
          which is what makes the two read as a pair of markers rather than as two inventions.

          It used to be a translucent black (white in dark mode) on the reasoning that the overlay's
          panel was a GRADIENT and no fixed colour could sit level with both ends of it. That panel is
          flat now (`MainLayout.vue`'s `.main-overlay > .w-dialog-panel`), so the premise is gone and
          the design's flat tint is simply what it says.

          Bled out of the page's padding on three sides so it meets the header and both edges, which is
          what makes it read as a toolbar under the title bar rather than as a panel floating in the
          page; `px-4` then puts its contents back on the page's own inset.
        -->
        <div class="table-editor-toolbar -mx-4 -mt-4 flex flex-wrap items-center gap-2 px-4 py-2">
          <!-- -> `dense`, which is `WBtn`'s 28px band on a 10px inset -- the height and inset the
                  design draws every control in this strip at -->
          <w-btn
            dense
            icon="tabler:plus"
            color="primary"
            :label="t(`editor.tableEditor.addRow`)"
            @click="addRow" />
          <w-btn
            dense
            icon="tabler:plus"
            color="primary"
            :label="t(`editor.tableEditor.addColumn`)"
            @click="addColumn" />
          <!--
            Three groups in one strip, ruled apart: what the table holds, what its markdown looks like,
            and what the page does with it. A rule rather than more space -- at this density the gap that
            would read as a break is wide enough to look like a missing control.

            The two options here both change the markdown under the grid as they are ticked, which is the
            only feedback either of them has. Headerless comes first, since it changes the grid as well.

            The breathing room is the RULE's own 4px each side, past the row's 8px gap, which is how the
            design spaces it -- 12px either way, symmetrically. The `ms-2`/`mx-2` this replaces put 16px
            on the checkbox side of each rule and 8px on the button side, so the two groups sat at
            different distances from the same divider.
          -->
          <w-separator vertical />
          <w-checkbox v-model="state.headerless" :label="t('editor.tableEditor.headerless')" />
          <w-checkbox v-model="state.compact" :label="t('editor.tableEditor.compact')" />
          <!--
            The classes the content stylesheet gives a table, which go under it as a `markdown-it-attrs`
            line — see `css/_page-contents.scss`, where each of the three is defined. Last in the strip
            and in its own colour: the only control here that opens something rather than doing something.

            A menu of checkboxes rather than a `w-select`: these are not one choice from a list, they are
            three independent switches, and a select would read as "pick a style" and then have to explain
            why two are ticked. `WCheckbox` binds a value within an array, which is exactly this shape, and
            `WMenu` does not close on a click inside itself, so all three can be set in one visit.
          -->
          <w-separator vertical />
          <w-btn dense icon="tabler:palette" color="slate" :label="t(`editor.tableEditor.styling`)">
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
          <!-- -> A hint, not a label: the design sets it a step below the checkbox labels beside it
                  (11.5px against 12.5px) and in the chrome slate rather than a wash of the ink -->
          <div class="text-[11.5px] text-slate dark:text-slate-light">
            {{ t('editor.tableEditor.pasteHint') }}
          </div>
        </div>
        <!--
          A plain table of plain inputs, which is what a markdown table is: a grid of one-line strings
          plus an alignment per column. The row above the header holds each column's tools -- its
          alignment, which is the only formatting the syntax can carry, and its delete.
        -->
        <div class="table-editor-grid mt-4">
          <table>
            <thead>
              <tr class="table-editor-tools">
                <th v-for="(align, colIndex) of state.align" :key="`tool-${colIndex}`">
                  <!-- -> Centred over the column rather than pushed to its edges: at the edges the
                          delete button reads as belonging to the boundary between two columns -->
                  <div class="flex flex-nowrap items-center justify-center gap-1">
                    <!-- -> Chrome, so the design strokes it in the icon slate rather than in the
                            accent: the alignment is a property of the column, not an action on it,
                            and the only red in this row belongs to the delete beside it -->
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
              <!-- -> Gone entirely when the table is headerless, rather than emptied: `rows[0]` is a
                      body row in that case, and it is shown as one below -->
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
                  <!-- -> Set the way the column is set: the alignment is the one thing about a table
                          the syntax can carry, so the grid may as well show it rather than describe it -->
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
        <!--
          The markdown itself, because that is what gets inserted and it is worth seeing before it lands
          in the page. Headed the way the block picker heads its own markdown.

          `-mx-4` gives back the page's own padding, so the band `w-section-header` trails reaches the
          panel's edges instead of stopping short of them — and the class's own 16px leaves the heading
          text at the same inset the rest of the page keeps.

          `mt-4`, which is the 16px the design leaves between the grid and the band. It was `mt-6`.
        -->
        <div class="w-section-header -mx-4 mt-4">{{ t('editor.tableEditor.markdown') }}</div>
        <!--
          Drawn as the page will draw it: `page-contents` is the content stylesheet, so the preview is
          a code block, not a panel of its own invention — one that follows the site's own code surface,
          in both themes, without this file restating any of it.

          No margin of its own: the band's own `margin-block-end` is the gap. The `mt-4` that used to be
          here was defending against a faint shadow the heading trailed 13px below itself, which it
          stopped drawing when Cardinal made it a bordered strip — with the `mt-4` still in place the gap
          came to 28px where the design draws 16. The band's 12px is the closer of the two, and the
          remaining 4px is `.w-section-header`'s own rhythm rather than this screen's (OpenProject #2631).

          The `pre` is the only child, which is what gives up the block margins content puts around a
          code block.
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

// PROPS

/**
 * Initial state from whoever opened this overlay (the markdown editor's "Edit Table" lens
 * `$patch({ overlay: 'TableEditor', overlayOpts: {...} })`), forwarded here by
 * `MainOverlayDialog.vue` (OpenProject #2530). `editing` below reads this prop, not
 * `siteStore.overlayOpts` directly.
 */
const props = defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

/**
 * Builds a markdown table and hands it to the editor.
 *
 * Handmade rather than a data grid. A markdown table is a small thing — one-line strings in a grid,
 * plus a per-column alignment, which is the only formatting the syntax carries — and the library this
 * replaces (`tabulator-tables`) is a sortable, filterable, virtually-rendered spreadsheet whose model
 * has no place to put that alignment. Every editing gesture here is a `splice`.
 *
 * Opened over a table that is already in the page — from the "Edit Table" lens in the markdown editor,
 * which passes its source and the lines it occupies — the same grid edits that table instead, and the
 * result goes back over those lines rather than in at the cursor.
 *
 * The editor receives the result over the event bus, the same way the File Manager hands back an asset.
 */

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

const ALIGN_ICONS = {
  left: 'tabler:align-left',
  center: 'tabler:align-center',
  right: 'tabler:align-right'
}

/*
  The classes the Styling menu offers, and what each one does to a table. Every one of them is defined in
  `css/_page-contents.scss` -- this list is the UI for those rules, so a class added there needs a line
  here to be reachable, and a line here naming a class that is not there does nothing at all.

  A class an author wrote by hand that is not in this list is left alone rather than stripped: it stays in
  `state.classes` and goes back out with the table, it simply has no box of its own to tick.
*/
const STYLE_CLASSES = [
  { value: 'table-vertical-middle', label: 'editor.tableEditor.styleVerticalMiddle' },
  { value: 'table-leading-col', label: 'editor.tableEditor.styleLeadingCol' },
  { value: 'table-code-nohighlight', label: 'editor.tableEditor.styleCodeNoHighlight' }
]

/* -> Spelled out rather than built from the value: a key assembled at runtime is invisible to the
      translation tooling, the same way a concatenated icon name is invisible to the icon scanner. */
const ALIGN_LABELS = {
  left: 'editor.tableEditor.alignLeft',
  center: 'editor.tableEditor.alignCenter',
  right: 'editor.tableEditor.alignRight'
}

// DATA

/*
  `rows[0]` is the header, unless `headerless` is set -- in which case it is simply the first row, and
  every row is a body row. Keeping the header in the same array as the body is what makes a column
  operation one splice per row instead of two code paths that have to agree, and it is also what makes
  the Headerless tick reversible: nothing is thrown away, the first row just stops being a heading.

  A starter table when there is nothing to edit; the table that was there when there is. `replace` holds
  the lines it came from, and is what turns this from an insert into an update -- see `insert`.
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

// COMPUTED

/** Where the body starts in `rows`: after the header, or at the top when there is none. */
const rowOffset = computed(() => (state.headerless ? 0 : 1))

const bodyRows = computed(() => state.rows.slice(rowOffset.value))

/* -> Written by `helpers/markdownTable`, which is also what read the table being edited: the two
      directions have to agree, or reopening a table would reformat it */
const markdown = computed(() => buildTable(state, { compact: state.compact }))

// METHODS

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

/** Grow the table until (rowIndex, colIndex) exists. */
function ensureSize(rowCount, colCount) {
  while (state.align.length < colCount) {
    addColumn()
  }
  while (state.rows.length < rowCount) {
    addRow()
  }
}

/**
 * A paste of more than one cell fills the grid from where it was pasted, growing the table to fit.
 *
 * Tab-separated lines are what a spreadsheet puts on the clipboard, so a table copied out of one lands
 * here as a table rather than as a wall of text in a single cell. A paste with no tabs and no newlines
 * is an ordinary paste and is left to the field.
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

/*
  The result, and where it goes: over the lines the table came from, or in at the cursor when it came
  from nowhere. The editor is the one holding the document, so it does the placing -- this only says
  which of the two it is.
*/
function insert() {
  EVENT_BUS.emit('insertTable', { markdown: markdown.value, replace: state.replace })
  close()
}

function close() {
  siteStore.$patch({ overlay: '' })
}

// -> Cleared here rather than in `close`, so it goes whichever way the overlay was left: a table left
//    behind in the options would be edited again the next time the toolbar button opens this
onBeforeUnmount(() => {
  siteStore.overlayOpts = {}
})
</script>

<style lang="scss">
.table-editor {
  /*
    Nothing here sits on a `w-card`, and that is where the app's dark text colour comes from -- so the
    overlay has to state its own or everything that merely inherits `color` stays black on the dark
    panel: the cell inputs (`color: inherit`, deliberately, so they follow the surface), the `Markdown`
    heading and the Compact checkbox's label. Same reason `BlockPickerOverlay` states it.

    The ground goes with it. The design draws this overlay's panel in `$paper` with its cells in
    `$surface` (`ui-redesign/Cardinal Wiki - Table Editor 3x.dc.html`), and the app paints the panel
    `$surface` instead (`MainLayout.vue`'s `.main-overlay > .w-dialog-panel`) -- so white cells would
    have nothing to read against. Stated here because it is this screen's own surface; it BELONGS on
    that shared rule, where the File Manager design asks for the same `$paper`, and this line should be
    deleted rather than kept in step when that question is answered.
  */
  @at-root .body--light & {
    color: $ink;
    background-color: $paper;
  }
  @at-root .body--dark & {
    color: #fff;
  }

  /*
    The toolbar band under the title bar: the page tint ruled off underneath, which is the same recipe
    `.w-section-header` draws the `Markdown` heading below with.
  */
  &-toolbar {
    @at-root .body--light & {
      background-color: $tint;
      border-bottom: 1px solid $hairline;
    }
    @at-root .body--dark & {
      background-color: $dark-2;
      border-bottom: 1px solid $hairline-dark;
    }

    /*
      The design's divider is a 22px tick in the fainter separator tone with 4px of air each side --
      not a rule the full height of the row. `WSeparator` stretches to its flex line by default and
      paints the generic hairline, so both are pinned here rather than by widening its props: this is
      the only place in the app that wants a short vertical tick inside a control strip.
    */
    .w-separator {
      align-self: center;
      height: 22px;
      margin-inline: 4px;
      --w-hairline-color: #{$rule};

      @at-root .body--dark & {
        --w-hairline-color: #{$border-dark};
      }
    }
  }

  &-grid {
    overflow-x: auto;

    table {
      border-collapse: collapse;
    }
  }

  /*
    A cell is a white plate on the panel's paper, edged in the language's one border colour. Both the
    ground and the edge are STATED rather than inherited: the grid is the thing being edited, so it
    reads as a sheet laid on the page rather than as lines drawn over it.

    Carried as a class on the cells that hold an input, rather than as a `th, td` rule inside the grid.
    The two chrome columns -- the tools row above the head and the row-tools column down the side --
    are `th`/`td` too, and a rule reaching every cell in the table had to be undone for both of them,
    which is where `.table-editor-rowtools`'s `!important`s came from. Naming the data cells instead
    leaves the chrome cells unstyled, which is what they want to be.
  */
  &-cellbox {
    padding: 0;
    border: 1px solid $hairline;
    background-color: $surface;

    @at-root .body--dark & {
      border-color: $hairline-dark;
      background-color: $dark-3;
    }

    /*
      Banding, as the design draws it. `#f8f9fc` has no token of its own -- it is the same half-step
      below white that `WInput`/`WSelect` paint a read-only field in, and is written as a literal there
      too. Dark takes the recessed rung of the ramp against the panel rung above.
    */
    @at-root tbody > tr:nth-child(even) > & {
      background-color: #f8f9fc;
    }
    @at-root .body--dark tbody > tr:nth-child(even) > & {
      background-color: $dark-4;
    }
  }

  /* -> The tools row is chrome, not content: no border under the buttons, tighter than a data row */
  &-tools {
    th {
      padding: 2px 4px;
    }
  }

  &-rowtools {
    width: 32px;
    padding: 0 2px;
    text-align: center;
  }

  /*
    Each column and row tool is a 24x22 plate with a 14px glyph in it -- a hit target sized to the tools
    row rather than to a button band, which is what the design draws and what keeps the row 22px tall
    next to a 28px toolbar. `WBtn` writes its `min-height` and `padding` INLINE, off its own font size,
    so the plate has to out-specify them.
  */
  &-toolbtn {
    width: 24px;
    min-width: 24px;
    height: 22px;
    min-height: 22px !important;
    padding: 0 !important;
    font-size: 14px;
    /* -> A plate holding one glyph and no text: `WBtn`'s 1.715em leading would make it 24px tall */
    line-height: 1;

    /* -> The X reads a size larger than the align rules at the same box, so the design draws it 13px */
    &--del {
      font-size: 13px;
    }
  }

  &-cell {
    display: block;
    width: 200px;
    padding: 7px 9px;
    background-color: transparent;
    color: inherit;
    font-size: 14px;
    outline: none;

    /*
      The focused cell takes the tint and turns its edge slate. The ring is an `outline` on the INPUT
      rather than a border on the cell: `border-collapse: collapse` picks one winner per shared edge, so
      recolouring a single cell's border is not reliable. The cell is unpadded, so the input's border box
      is the cell's content box -- an outline at offset 0 lands exactly over the collapsed border.
    */
    &:focus {
      background-color: $tint;
      outline: 1px solid $slate;

      @at-root .body--dark & {
        background-color: $dark-2;
        outline-color: $slate-light;
      }
    }

    /* -> The header row is what a reader sees in bold, so it reads that way here too */
    &--head {
      font-weight: 600;
    }
  }
}
</style>
