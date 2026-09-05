<template>
  <div class="editor-mention-list">
    <div v-if="loading" class="editor-mention-list-message">{{ t('editor.mention.loading') }}</div>
    <div v-else-if="!query" class="editor-mention-list-message">
      {{ t('editor.mention.prompt') }}
    </div>
    <div v-else-if="items.length < 1" class="editor-mention-list-message">
      {{ t('editor.mention.noResults') }}
    </div>
    <w-list v-else dense padding>
      <w-item
        v-for="(item, index) of items"
        :key="item.id"
        clickable
        :active="index === state.selectedIndex"
        active-class="text-primary"
        @mouseenter="state.selectedIndex = index"
        @click="select(index)">
        <w-item-section v-if="item.icon" side>
          <w-icon :name="item.icon" size="sm" />
        </w-item-section>
        <w-item-section>
          <w-item-label>{{ item.label }}</w-item-label>
          <w-item-label v-if="item.path" caption class="font-robotomono"
            >/{{ item.path }}</w-item-label
          >
        </w-item-section>
      </w-item>
    </w-list>
  </div>
</template>

<script setup>
import { reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * The `@` mention popover for `EditorWysiwyg.vue`, mounted by `createPageMentionSuggestion()`
 * (`@/helpers/editorMentions.js`) through TipTap's suggestion `render()` hook -- see that file for
 * where `items`, `command`, `loading` and `query` come from and how this component's lifecycle is
 * driven. Not used anywhere else, the way `EditorEmojiMenu.vue` / `EditorCodeBlockMenu.vue` are only
 * for their one caller.
 */

const props = defineProps({
  /** Candidate pages for the current query, already mapped to `{ id, label, path, icon }`. */
  items: {
    type: Array,
    default: () => []
  },
  /** Confirms a selection; TipTap turns this into the mention node's `id`/`label` attributes. */
  command: {
    type: Function,
    required: true
  },
  /** True from the moment a query is dispatched until `items()` resolves. */
  loading: {
    type: Boolean,
    default: false
  },
  /** The text typed after `@`. Empty until the reader types something past the trigger character. */
  query: {
    type: String,
    default: ''
  }
})

const { t } = useI18n()

const state = reactive({
  selectedIndex: 0
})

// -> A fresh result set starts highlighted on its first row, rather than keeping whatever index the
//    previous (longer or shorter) list happened to have the cursor on.
watch(
  () => props.items,
  () => {
    state.selectedIndex = 0
  }
)

function select(index) {
  const item = props.items[index]
  if (item) {
    props.command(item)
  }
}

/**
 * Driven by `createPageMentionSuggestion()`'s `render().onKeyDown`, which forwards every keydown
 * while the popover is open. Exposed rather than emitted: TipTap's `VueRenderer.ref` reads this
 * straight off the mounted instance (`component.ref?.onKeyDown(props)`), there is no event bus
 * between a ProseMirror plugin and a Vue component for it to emit through.
 *
 * @param {{ event: KeyboardEvent }} args
 * @returns {boolean} Whether the key was handled -- swallows it from reaching the editor when true.
 */
function onKeyDown({ event }) {
  if (props.items.length < 1) {
    return false
  }
  if (event.key === 'ArrowDown') {
    state.selectedIndex = (state.selectedIndex + 1) % props.items.length
    return true
  }
  if (event.key === 'ArrowUp') {
    state.selectedIndex = (state.selectedIndex - 1 + props.items.length) % props.items.length
    return true
  }
  if (event.key === 'Enter') {
    select(state.selectedIndex)
    return true
  }
  return false
}

defineExpose({ onKeyDown })
</script>

<style lang="scss">
.editor-mention-list {
  min-width: 220px;
  max-width: 320px;
  box-shadow:
    0 2px 4px rgba(0, 0, 0, 0.1),
    0 8px 24px rgba(0, 0, 0, 0.15);
  overflow: hidden;

  @at-root .body--light & {
    background-color: #fff;
    border: 1px solid $grey-4;
  }
  @at-root .body--dark & {
    background-color: $dark-4;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  &-message {
    padding: 10px 14px;
    font-size: 0.85rem;
    opacity: 0.7;
  }
}
</style>
