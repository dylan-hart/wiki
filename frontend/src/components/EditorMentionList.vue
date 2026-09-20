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
 * Mounted by `createPageMentionSuggestion()` (`@/helpers/editorMentions.js`) through TipTap's
 * suggestion `render()` hook, which is what supplies every prop below and drives the lifecycle.
 */

const props = defineProps({
  /** Candidate pages, already mapped to `{ id, label, path, icon }`. */
  items: {
    type: Array,
    default: () => []
  },
  command: {
    type: Function,
    required: true
  },
  loading: {
    type: Boolean,
    default: false
  },
  /** The text typed after `@`. */
  query: {
    type: String,
    default: ''
  }
})

const { t } = useI18n()

const state = reactive({
  selectedIndex: 0
})

// -> Reset rather than carry a cursor position into the previous, differently-sized list
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
 * Exposed rather than emitted: TipTap's `VueRenderer.ref` calls this straight off the mounted
 * instance, and a ProseMirror plugin has no way to receive a Vue event.
 *
 * @param {{ event: KeyboardEvent }} args
 * @returns {boolean} True swallows the key, keeping it from reaching the editor.
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

<style>
/* Kept flat, not nested: a `&-suffix` selector is a Sass concatenation idiom that native CSS
   nesting silently drops. */
.editor-mention-list {
  min-width: 220px;
  max-width: 320px;
  box-shadow:
    0 2px 4px rgba(0, 0, 0, 0.1),
    0 8px 24px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}
.body--light .editor-mention-list {
  background-color: #fff;
  border: 1px solid var(--color-grey-4);
}
.body--dark .editor-mention-list {
  background-color: var(--color-dark-4);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.editor-mention-list-message {
  padding: 10px 14px;
  font-size: 0.85rem;
  opacity: 0.7;
}
</style>
