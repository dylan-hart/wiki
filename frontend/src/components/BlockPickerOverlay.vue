<template>
  <w-layout container>
    <w-header class="card-header">
      <w-icon name="tabler:square-plus" left size="md" />
      <span>{{ t('editor.blockPicker.title') }}</span>
      <w-space />
      <w-btn-group>
        <w-btn
          color="white"
          text-color="text-secondary"
          :label="t(`common.actions.cancel`)"
          :aria-label="t(`common.actions.cancel`)"
          icon="tabler:x"
          @click="close" />
        <!--
          -> Insert is this screen's primary action, so it takes the accent, not the source's green

          `accent` (#c14a52), not the brighter `accent-fill` (#e4676b): the label over it is white,
          and only the darker of the two tones clears 4.5:1 under white. See the live-edge note at
          the top of `css/_theme.scss` for which tone belongs on which surface.
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
        <!-- ----------------------- -->
        <!-- The blocks -->
        <!-- ----------------------- -->
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
                  class="block-picker-card"
                  :class="{ 'is-selected': state.selected?.id === block.id }"
                  @click="select(block)">
                  <span class="block-picker-plate">
                    <w-icon
                      :name="`img:/_assets/icons/ultraviolet-${block.isCustom ? 'plugin' : block.icon}.svg`"
                      size="21px" />
                  </span>
                  <div class="min-w-0 flex-1 text-left">
                    <div class="block-picker-name">
                      <strong>{{ block.name }}</strong>
                      <!-- -> The same italic purple tag `AdminBlocks.vue` gives an uploaded block -->
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
                    The corner marks that say this card is the chosen one. Out of flow and faded in
                    rather than added, so a card occupies exactly the same box selected or not --
                    see the `&-card` rule below for why nothing here may change its size.
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
        <!-- ----------------------- -->
        <!-- Its properties -->
        <!-- ----------------------- -->
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
                <!-- -> The markup itself, since that is what lands in the page -->
                <div class="w-section-header mt-6">{{ t('editor.blockPicker.markdown') }}</div>
                <!-- The same 16px all round, so it sits inside the panel the way the fields do -->
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
 * Picks a block and what to give it, and hands the editor the MDC markup for it.
 *
 * Only metadata is used here — the name, the icon, and the props the block declares. The component
 * itself is never imported: a block's code is fetched when its tag turns up in a page (see
 * `commonStore.loadBlocks`), and a picker that pulled in every block to show a list of them would
 * defeat that.
 *
 * `::block-name{prop="value"}` is MDC block syntax, which the renderer turns into
 * `<block-name prop="value">` — the element the component registers itself as.
 */

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()
const { blockText } = useBlockLocale()

// DATA

const state = reactive({
  blocks: [],
  selected: null,
  /** Field values for the selected block, by prop name. */
  values: {},
  isLoading: false
})

// COMPUTED

/** Only blocks this site has switched on: the rest cannot render, so offering them is a trap. */
const blocks = computed(() => state.blocks.filter((block) => block.isEnabled))

const markdown = computed(() => (state.selected ? blockMarkdown(state.selected, state.values) : ''))

// -> A required prop with nothing in it would insert a block that cannot draw anything
const canInsert = computed(
  () => Boolean(state.selected) && blockPropsFilled(state.selected, state.values)
)

// METHODS

function select(block) {
  state.selected = block
  // -> Started at the site's configured default where there is one, else the block's own — so the
  //    form shows what inserting it now would actually do
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

// MOUNTED

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

<style lang="scss">
.block-picker {
  height: 100%;
  padding: 0;

  /*
    Nothing here sits on a `w-card`, and that is where the app's dark text colour comes from -- so the
    panels have to state it themselves or everything inheriting `color` stays black on a dark surface.
  */
  @at-root .body--light & {
    color: $text-body;
  }
  @at-root .body--dark & {
    color: var(--color-text-dark);
  }

  /*
    The catalog is paper and the properties panel is the tinted strip beside it, ruled off with the
    one hairline between them -- the pairing the design draws, and the same relationship a settings
    card's header strip has to its rows. Stated outright rather than left to whatever sits behind
    the overlay, since the two panels are only legible relative to each other.

    The proportions are the design's own: the catalog takes the room, the panel is a fixed 340px
    column that stops growing once the fields in it are wide enough to read.
  */
  &-catalog {
    flex: 1 1 480px;
    min-width: 300px;
    height: 100%;

    @at-root .body--light & {
      background-color: var(--color-surface);
    }
    @at-root .body--dark & {
      background-color: var(--color-dark-5);
    }
  }

  &-form {
    flex: 0 0 340px;
    min-width: 280px;
    height: 100%;

    @at-root .body--light & {
      background-color: var(--color-tint);
      border-left: 1px solid var(--color-hairline);
    }
    @at-root .body--dark & {
      background-color: var(--color-dark-3);
      border-left: 1px solid var(--color-hairline-dark);
    }
  }

  /*
    Two columns at most, however wide the overlay gets: a card carries a name, a sentence and a tag
    name, so it reads better wide than tiled. The `max()` is what caps the count -- a track asking
    for half the row (less its share of the gap) can only ever fit twice -- while the 280px floor
    takes over on a panel too narrow for two of them and drops the grid to a single column.
  */
  &-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fill, minmax(max(280px, calc(50% - 6px)), 1fr));
  }

  /*
    -> A card is the whole hit target, so the icon and the text are both part of choosing it

    A Cardinal card is a line drawing, so being the chosen one has to be drawn in line weight: 2.x
    rang the picked card with a coloured glow, which this surface cannot wear. Selection is the
    hairline recoloured to the accent, doubled by an INSET shadow of the same tone, plus the four
    corner marks and a tinted icon plate.

    Every part of that is deliberate about geometry, and this is the constraint to preserve if these
    rules are ever touched: an unselected card already carries a 1px border, a selected one carries
    the same 1px border in a different colour, the extra weight is painted inside the existing
    bounds by an inset shadow (which cannot affect layout at all), and the corner marks are
    absolutely positioned. So a card's box is identical in both states and NOTHING on the screen
    moves as selection travels from one card to another. A border that appeared on selection, or a
    thicker one, would widen the card and reflow the row -- see `blockPickerLayout.test.js`, which
    measures exactly this in a real browser.
  */
  &-card {
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

    &:hover {
      border-color: var(--color-rule);
    }

    &.is-selected,
    &.is-selected:hover {
      border-color: var(--color-accent-fill);
      box-shadow: inset 0 0 0 1px var(--color-accent-fill);
    }

    @at-root .body--dark & {
      background-color: var(--color-dark-3);
      border-color: var(--color-hairline-dark);

      &:hover {
        border-color: var(--color-border-dark);
      }

      &.is-selected,
      &.is-selected:hover {
        border-color: var(--color-accent-dark);
        box-shadow: inset 0 0 0 1px var(--color-accent-dark);
      }
    }
  }

  /* The 40px hairline plate the glyph sits in -- the same material as a settings row's plate. */
  &-plate {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border: 1px solid var(--color-hairline);
    background-color: var(--color-surface);
    color: var(--color-slate-soft);

    .is-selected > & {
      border-color: var(--color-accent-fill);
      background-color: var(--color-accent-wash);
      color: var(--color-accent);
    }

    @at-root .body--dark & {
      border-color: var(--color-hairline-dark);
      background-color: var(--color-dark-4);
      color: var(--color-slate-light);
    }

    @at-root .body--dark .is-selected > & {
      border-color: var(--color-accent-dark);
      background-color: var(--color-accent-wash-dark);
      color: var(--color-accent-dark);
    }
  }

  /*
    Two adjacent 1px rules per corner, sitting 4px clear of the card. They overhang the card, which
    the catalog's own 16px inset and the grid's 12px gap both absorb -- nothing clips them and
    nothing is pushed aside, since they are out of flow.
  */
  &-mark {
    position: absolute;
    width: 7px;
    height: 7px;
    opacity: 0;
    /* -> One property so each corner states only WHICH two of its edges it draws, not in what tone */
    --mark-tone: var(--color-accent-fill);
    transition: opacity 0.15s var(--ease-standard);

    .is-selected > & {
      opacity: 1;
    }

    @at-root .body--dark & {
      --mark-tone: var(--color-accent-dark);
    }
  }

  &-mark-tl {
    top: -4px;
    left: -4px;
    border-top: 1px solid var(--mark-tone);
    border-left: 1px solid var(--mark-tone);
  }

  &-mark-tr {
    top: -4px;
    right: -4px;
    border-top: 1px solid var(--mark-tone);
    border-right: 1px solid var(--mark-tone);
  }

  &-mark-bl {
    bottom: -4px;
    left: -4px;
    border-bottom: 1px solid var(--mark-tone);
    border-left: 1px solid var(--mark-tone);
  }

  &-mark-br {
    bottom: -4px;
    right: -4px;
    border-bottom: 1px solid var(--mark-tone);
    border-right: 1px solid var(--mark-tone);
  }

  &-name {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-wrap: wrap;
    font-size: 13.5px;
    font-weight: 600;

    @at-root .body--light & {
      color: $ink;
    }

    em {
      font-size: 11.5px;
      font-weight: 400;
    }
  }

  &-description {
    font-size: 12.5px;
    line-height: 1.5;

    @at-root .body--light & {
      color: $text-secondary;
    }
    @at-root .body--dark & {
      color: var(--color-text-secondary-dark);
    }
  }

  /*
    The tag name is what actually lands in the page, so it is the one line on the card that follows
    the selection into the accent -- the card's own confirmation of what it is about to insert.
  */
  &-tag {
    padding-top: 4px;
    font-family: 'Roboto Mono', Consolas, 'Liberation Mono', Courier, monospace;
    font-size: 11px;
    font-weight: 500;

    @at-root .body--light & {
      color: $text-caption;
    }
    @at-root .body--dark & {
      color: var(--color-text-caption-dark);
    }

    .is-selected & {
      color: var(--color-accent);
    }

    @at-root .body--dark .is-selected & {
      color: var(--color-accent-dark);
    }
  }

  /* Nothing picked yet: a faint outline of the shape a block leaves, and the sentence saying so. */
  &-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 44px 24px;
    text-align: center;

    .w-icon {
      color: var(--color-slate-faint);
    }

    p {
      max-width: 240px;
      margin: 0;
      font-size: 13.5px;
      line-height: 1.6;
    }

    @at-root .body--light & {
      color: $text-secondary;
    }
    @at-root .body--dark & {
      color: var(--color-text-secondary-dark);
    }
  }

  /*
    The generated markup, drawn as the design draws it: an ink slab with the accent down its leading
    edge. It reads as a quotation of the page rather than another field, which is what it is.
  */
  &-output {
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

    @at-root .body--dark & {
      background-color: var(--color-dark-6);
    }
  }
}
</style>
