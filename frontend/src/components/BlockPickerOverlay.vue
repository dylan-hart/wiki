<template>
  <w-layout container>
    <w-header class="card-header">
      <w-icon name="tabler:square-plus" left size="md" />
      <span>{{ t('editor.blockPicker.title') }}</span>
      <w-space />
      <w-btn-group class="block-picker-actions">
        <w-btn
          color="white"
          text-color="text-secondary"
          :label="t(`common.actions.cancel`)"
          :aria-label="t(`common.actions.cancel`)"
          icon="tabler:x"
          @click="close" />
        <!--
          The accent rather than the source's green, since insert is this screen's primary action --
          and `accent`, not the brighter `accent-fill`, because only the darker of the two tones
          clears 4.5:1 under the white label.
        -->
        <w-btn
          color="accent"
          text-color="white"
          :label="t(`editor.blockPicker.insert`)"
          :aria-label="t(`editor.blockPicker.insert`)"
          icon="tabler:check"
          :disabled="!canInsert"
          @click="insert" />
      </w-btn-group>
    </w-header>
    <w-page-container>
      <w-page class="block-picker flex flex-nowrap items-stretch">
        <div class="block-picker-catalog">
          <w-scroll-area style="height: 100%">
            <div class="p-4">
              <w-inner-loading :showing="state.isLoading" size="32px" />
              <div
                v-if="!state.isLoading && blocks.length < 1"
                class="text-caption p-6 text-center text-black/60 dark:text-white/70">
                {{ t('editor.blockPicker.noBlocks') }}
              </div>
              <div class="block-picker-grid">
                <button
                  v-for="block of blocks"
                  :key="block.id"
                  type="button"
                  class="block-picker-card rounded-card shadow-card"
                  :class="{ 'is-selected': state.selected?.id === block.id }"
                  @click="select(block)">
                  <!--
                    The definition's own Iconify reference, never a name assembled by concatenation:
                    a built name is invisible to `scripts/generate-icons.mjs` and draws nothing. A
                    custom block brings no in-repo definition to trust, so it gets one fallback glyph.
                  -->
                  <span class="block-picker-plate rounded-card shadow-card">
                    <w-icon :name="block.isCustom ? 'tabler:puzzle' : block.icon" size="21px" />
                  </span>
                  <div class="min-w-0 flex-1 text-left">
                    <div class="block-picker-name">
                      <strong>{{ block.name }}</strong>
                      <em v-if="block.isCustom" class="text-purple">
                        {{ t('admin.blocks.custom') }}
                      </em>
                    </div>
                    <div class="block-picker-description">
                      {{ blockText(block.block, 'description', block.description) }}
                    </div>
                    <div class="block-picker-tag">&lt;block-{{ block.block }}&gt;</div>
                  </div>
                  <!--
                    Out of flow and faded in rather than added on selection, so a card occupies
                    exactly the same box in both states and nothing reflows.
                  -->
                  <i class="block-picker-mark block-picker-mark-tl" aria-hidden="true" />
                  <i class="block-picker-mark block-picker-mark-tr" aria-hidden="true" />
                  <i class="block-picker-mark block-picker-mark-bl" aria-hidden="true" />
                  <i class="block-picker-mark block-picker-mark-br" aria-hidden="true" />
                </button>
              </div>
            </div>
          </w-scroll-area>
        </div>
        <div class="block-picker-form">
          <w-scroll-area style="height: 100%">
            <!-- A section header draws its own horizontal inset, so this pads vertically only -->
            <div class="py-4">
              <div v-if="!state.selected" class="block-picker-empty">
                <w-icon name="tabler:square-minus" size="38px" />
                <p>{{ t('editor.blockPicker.selectHint') }}</p>
              </div>
              <template v-else>
                <div class="w-section-header">{{ state.selected.name }}</div>
                <block-props-form
                  class="px-4 pt-4"
                  :block="state.selected.block"
                  :fields="state.selected.props"
                  :values="state.values" />
                <div class="w-section-header mt-6">{{ t('editor.blockPicker.markdown') }}</div>
                <pre class="block-picker-output m-4">{{ markdown }}</pre>
              </template>
            </div>
          </w-scroll-area>
        </div>
      </w-page>
    </w-page-container>
  </w-layout>
</template>

<script setup>
import { computed, onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'

import { notify } from '@/composables/notify'
import { useBlockLocale } from '@/composables/blockLocale'
import { apiErrorMessage } from '@/helpers/apiError'
import { blockMarkdown, blockPropsFilled, propDefault } from '@/helpers/blocks'

import BlockPropsForm from '@/components/BlockPropsForm.vue'

import { useSiteStore } from '@/stores/site'

/**
 * `MainOverlayDialog.vue` forwards `siteStore.overlayOpts` to every overlay it mounts. Declared even
 * though this overlay reads none of it -- an undeclared prop falls through onto the DOM root.
 */
defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

/**
 * Only block metadata is used here. A block's component is never imported: its code is fetched when
 * its tag turns up in a page (`commonStore.loadBlocks`), and a picker that pulled in every block to
 * list them would defeat that.
 *
 * `::block-name{prop="value"}` is MDC block syntax, which the renderer turns into
 * `<block-name prop="value">` — the element the component registers itself as.
 */

const siteStore = useSiteStore()

const { t } = useI18n()
const { blockText } = useBlockLocale()

const state = reactive({
  blocks: [],
  selected: null,
  values: {},
  isLoading: false
})

/** Only blocks this site has switched on: the rest cannot render, so offering them is a trap. */
const blocks = computed(() => state.blocks.filter((block) => block.isEnabled))

const markdown = computed(() => (state.selected ? blockMarkdown(state.selected, state.values) : ''))

// -> A required prop with nothing in it would insert a block that cannot draw anything
const canInsert = computed(
  () => Boolean(state.selected) && blockPropsFilled(state.selected, state.values)
)

function select(block) {
  state.selected = block
  // -> The site's configured default ahead of the block's own, so the form shows what inserting it
  //    right now would actually do
  state.values = Object.fromEntries(
    block.props.map((prop) => [prop.name, propDefault(block, prop)])
  )
}

function insert() {
  EVENT_BUS.emit('insertBlock', markdown.value)
  close()
}

function close() {
  siteStore.$patch({ overlay: '' })
}

onMounted(async () => {
  state.isLoading = true
  try {
    state.blocks = (await API_CLIENT.get(`sites/${siteStore.id}/blocks`).json()) ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('editor.blockPicker.loadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.isLoading = false
})
</script>

<style>
/*
  Under Cobalt adjacent buttons take a gap and each keeps its own radius, so `WBtnGroup`'s default
  seam (a hairline `border-inline-end` on every button but the last) is switched off here -- left on,
  it shows through the gap.

  A dedicated class rather than nesting under `.card-header .w-btn-group`: the header sits outside
  `<w-page-container>`, so `.card-header` is a sibling of `.block-picker`, not a descendant, and
  there is no ancestor wrapper to scope a nested rule against.
*/
.block-picker-actions {
  .body--cobalt & {
    gap: 8px;

    > .w-btn:not(:last-child) {
      border-inline-end: none;
    }
  }
}
/* These selectors stay flat: a `&-suffix` concatenation is a Sass idiom, and native CSS nesting
   silently drops such a rule rather than matching it. */
.block-picker {
  height: 100%;
  padding: 0;
  /*
    Nothing here sits on a `w-card`, which is where the app's text colour comes from, so the panels
    below state it themselves -- otherwise everything inheriting `color` stays black on dark.
  */
}
.body--light .block-picker {
  color: var(--color-text-body);
}
.body--dark .block-picker {
  color: var(--color-text-dark);
}
.block-picker {
  /*
    Both panels state their own background rather than inheriting whatever sits behind the overlay:
    paper catalog against tinted strip is only legible relative to each other. The catalog takes the
    room; the properties column is fixed, since it stops being more readable past field width.
  */
}
.block-picker-catalog {
  flex: 1 1 480px;
  min-width: 300px;
  height: 100%;
}
.body--light .block-picker-catalog {
  background-color: var(--color-surface);
}
.body--dark .block-picker-catalog {
  background-color: var(--color-dark-5);
}
.block-picker-form {
  flex: 0 0 340px;
  min-width: 280px;
  height: 100%;
}
.body--light .block-picker-form {
  background-color: var(--color-tint);
  border-inline-start: 1px solid var(--color-hairline);
}
.body--dark .block-picker-form {
  background-color: var(--color-dark-3);
  border-inline-start: 1px solid var(--color-hairline-dark);
}
.block-picker {
  /*
    Two columns at most, however wide the overlay gets: a track asking for half the row (less its
    share of the gap) can only ever fit twice, while the 280px floor takes over on a panel too
    narrow for two of them and drops the grid to a single column.
  */
}
.block-picker-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(max(280px, 50% - 6px), 1fr));
}
.block-picker {
  /*
    The constraint to preserve if these rules are ever touched: selection must cost no layout. An
    unselected card already carries the 1px border a selected one merely recolours, the extra weight
    is an INSET shadow (which cannot affect layout), and the corner marks are absolutely positioned
    -- so a card's box is identical in both states and nothing on screen moves as selection travels.
    A border that appeared on selection, or a thicker one, would widen the card and reflow the row;
    `blockPickerLayout.test.js` measures exactly this in a real browser.
  */
}
.block-picker-card {
  position: relative;
  display: flex;
  flex-wrap: nowrap;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  background-color: var(--color-surface);
  border: 1px solid var(--color-hairline);
  color: inherit;
  text-align: start;
  cursor: pointer;
  transition:
    border-color 0.15s var(--ease-standard),
    box-shadow 0.15s var(--ease-standard);
}
.block-picker-card:hover {
  border-color: var(--color-rule);
}
.block-picker-card.is-selected,
.block-picker-card.is-selected:hover {
  border-color: var(--color-accent-fill);
  box-shadow: inset 0 0 0 1px var(--color-accent-fill);
}
.body--dark .block-picker-card {
  background-color: var(--color-dark-3);
  border-color: var(--color-hairline-dark);
}
.body--dark .block-picker-card:hover {
  border-color: var(--color-border-dark);
}
.body--dark .block-picker-card.is-selected,
.body--dark .block-picker-card.is-selected:hover {
  border-color: var(--color-accent-dark);
  box-shadow: inset 0 0 0 1px var(--color-accent-dark);
}
.block-picker {
  /* The glyph's plate -- the same material as a settings row's. */
}
.block-picker-plate {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--color-hairline);
  background-color: var(--color-surface);
  color: var(--color-slate-soft);
}
.is-selected > .block-picker-plate {
  border-color: var(--color-accent-fill);
  background-color: var(--color-accent-wash);
  color: var(--color-accent);
}
.body--dark .block-picker-plate {
  border-color: var(--color-hairline-dark);
  background-color: var(--color-dark-4);
  color: var(--color-slate-light);
}
.body--dark .is-selected > .block-picker-plate {
  border-color: var(--color-accent-dark);
  background-color: var(--color-accent-wash-dark);
  color: var(--color-accent-dark);
}
.block-picker {
  /*
    The marks sit 4px clear of the card and so overhang it; the catalog's 16px inset and the grid's
    12px gap both absorb that, and being out of flow they push nothing aside.

    `display: var(--corner-marks)` is `block` under Ledger and `none` under Cobalt, which draws no
    registration marks anywhere -- the same construction `Login.vue`/`NavEditMenu.vue` use.
  */
}
.block-picker-mark {
  position: absolute;
  display: var(--corner-marks);
  width: 7px;
  height: 7px;
  opacity: 0;
  /* -> One property so each corner states only WHICH two of its edges it draws, not in what tone */
  --mark-tone: var(--color-accent-fill);
  transition: opacity 0.15s var(--ease-standard);
}
.is-selected > .block-picker-mark {
  opacity: 1;
}
.body--dark .block-picker-mark {
  --mark-tone: var(--color-accent-dark);
}
.block-picker-mark-tl {
  top: -4px;
  inset-inline-start: -4px;
  border-top: 1px solid var(--mark-tone);
  border-inline-start: 1px solid var(--mark-tone);
}
.block-picker-mark-tr {
  top: -4px;
  inset-inline-end: -4px;
  border-top: 1px solid var(--mark-tone);
  border-inline-end: 1px solid var(--mark-tone);
}
.block-picker-mark-bl {
  bottom: -4px;
  inset-inline-start: -4px;
  border-bottom: 1px solid var(--mark-tone);
  border-inline-start: 1px solid var(--mark-tone);
}
.block-picker-mark-br {
  bottom: -4px;
  inset-inline-end: -4px;
  border-bottom: 1px solid var(--mark-tone);
  border-inline-end: 1px solid var(--mark-tone);
}
.block-picker-name {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  font-size: 13.5px;
  font-weight: 600;
}
.body--light .block-picker-name {
  color: var(--color-ink);
}
.block-picker-name em {
  font-size: 11.5px;
  font-weight: 400;
}
.block-picker-description {
  font-size: 12.5px;
  line-height: 1.5;
}
.body--light .block-picker-description {
  color: var(--color-text-secondary);
}
.body--dark .block-picker-description {
  color: var(--color-text-secondary-dark);
}
.block-picker {
  /*
    The tag name is what actually lands in the page, so it is the one line on the card that follows
    the selection into the accent.
  */
}
.block-picker-tag {
  padding-top: 4px;
  font-family: 'Roboto Mono', Consolas, 'Liberation Mono', Courier, monospace;
  font-size: 11px;
  font-weight: 500;
}
.body--light .block-picker-tag {
  color: var(--color-text-caption);
}
.body--dark .block-picker-tag {
  color: var(--color-text-caption-dark);
}
.is-selected .block-picker-tag {
  color: var(--color-accent);
}
.body--dark .is-selected .block-picker-tag {
  color: var(--color-accent-dark);
}
.block-picker {
  /* The empty state, until a block is picked. */
}
.block-picker-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 44px 24px;
  text-align: center;
}
.block-picker-empty .w-icon {
  color: var(--color-slate-faint);
}
.block-picker-empty p {
  max-width: 240px;
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
}
.body--light .block-picker-empty {
  color: var(--color-text-secondary);
}
.body--dark .block-picker-empty {
  color: var(--color-text-secondary-dark);
}
.block-picker {
  /* The generated markup, drawn as a quotation of the page rather than as another field. */
}
.block-picker-output {
  padding: 11px 12px;
  border-inline-start: 2px solid var(--color-accent-fill);
  background-color: var(--color-ink);
  color: var(--color-text-dark);
  font-family: 'Roboto Mono', Consolas, 'Liberation Mono', Courier, monospace;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.body--dark .block-picker-output {
  background-color: var(--color-dark-6);
}
</style>
