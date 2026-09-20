<template>
  <w-menu
    ref="menuRef"
    class="translucent-menu"
    :anchor="props.anchor"
    :self="props.self"
    @show="onShow">
    <div class="code-block-menu">
      <div class="p-2">
        <!-- -> `transparent`: the panel behind this is acrylic, and an opaque field on it reads as a
                slab with the floating label straddling its edge -->
        <w-input
          ref="iptFilter"
          v-model="state.filter"
          dense
          transparent
          clearable
          hide-bottom-space
          :label="t(`editor.codeBlock.filter`)"
          :aria-label="t(`editor.codeBlock.filter`)"
          @keyup:enter="chooseFirst">
          <template #prepend><w-icon name="tabler:search" /></template>
        </w-input>
      </div>
      <w-separator />
      <w-scroll-area class="code-block-menu-list">
        <w-list dense>
          <!--
            Shortlist only while nothing is filtered: with a filter on, two lists to read is worse
            than one, and every one of these is in the list below anyway.
          -->
          <template v-if="!isFiltering">
            <w-item
              v-for="language of COMMON_LANGUAGES"
              :key="`common-${language.id}`"
              clickable
              @click="choose(language.id)">
              <w-item-section>
                <w-item-label>{{ language.label }}</w-item-label>
              </w-item-section>
              <!-- -> A dash for plain text, which goes on the fence as nothing at all -->
              <w-item-section side>
                <div class="text-caption font-robotomono">{{ language.id || '—' }}</div>
              </w-item-section>
            </w-item>
            <w-separator class="my-1" />
          </template>
          <w-item
            v-for="language of filtered"
            :key="language.id"
            clickable
            @click="choose(language.id)">
            <w-item-section>
              <w-item-label>{{ language.label }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <div class="text-caption font-robotomono">{{ language.id }}</div>
            </w-item-section>
          </w-item>
          <div
            v-if="filtered.length < 1"
            class="text-caption p-4 text-center text-black/60 dark:text-white/70">
            {{ t('editor.codeBlock.noResults') }}
          </div>
        </w-list>
      </w-scroll-area>
    </div>
  </w-menu>
</template>

<script setup>
import { computed, nextTick, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

// -> `lib/common`, not the `highlight.js` root: hljs is a module-singleton registry, so this file
//    and `renderers/markdown.js` must import exactly the same module, or this picker offers a
//    language the renderer highlights differently.
import hljs from 'highlight.js/lib/common'

/**
 * The list is asked of hljs at runtime rather than kept as a copy here, so it cannot drift from what
 * the renderer will actually highlight. A language outside that set can still be typed by hand after
 * the fence -- it just renders unhighlighted, as any unrecognized language does.
 */

const props = defineProps({
  anchor: {
    type: String,
    default: 'bottom left'
  },
  self: {
    type: String,
    default: 'top left'
  }
})

const emit = defineEmits(['select'])

const { t } = useI18n()

/**
 * Labelled here rather than taking hljs's own names, which for these read as `Plain text`,
 * `HTML, XML` and `Bash` — precise, and not what someone scanning a shortlist is looking for.
 *
 * Two of the ids are not what the list below would show either: `sh` and `md` are aliases rather
 * than registered ids, and plain text has no id at all — a bare fence is how markdown says "no
 * language", so the menu shows a dash where the others show their id.
 */
const COMMON_LANGUAGES = [
  { id: '', label: 'Plain Text' },
  { id: 'json', label: 'JSON' },
  { id: 'md', label: 'Markdown' },
  { id: 'sh', label: 'Bash Shell' },
  { id: 'xml', label: 'XML' }
]

/** Built once: hljs's registry cannot change at runtime. */
const ALL_LANGUAGES = hljs
  .listLanguages()
  .map((id) => {
    const definition = hljs.getLanguage(id)
    return {
      id,
      label: definition?.name ?? id,
      // -> Searched but never shown: `sh` and `zsh` are how someone looks for Bash
      aliases: definition?.aliases ?? []
    }
  })
  .sort((a, b) => a.label.localeCompare(b.label))

const menuRef = ref(null)
const iptFilter = ref(null)

const state = reactive({
  filter: ''
})

const isFiltering = computed(() => state.filter.trim().length > 0)

const filtered = computed(() => {
  if (!isFiltering.value) {
    return ALL_LANGUAGES
  }
  const needle = state.filter.trim().toLowerCase()
  return ALL_LANGUAGES.filter(
    (language) =>
      language.label.toLowerCase().includes(needle) ||
      language.id.includes(needle) ||
      language.aliases.some((alias) => alias.includes(needle))
  )
})

async function onShow() {
  state.filter = ''
  await nextTick()
  iptFilter.value?.focus()
}

function choose(id) {
  emit('select', id)
  menuRef.value?.hide()
}

function chooseFirst() {
  const first = isFiltering.value ? filtered.value[0] : COMMON_LANGUAGES[0]
  if (first) {
    choose(first.id)
  }
}
</script>

<style scoped>
.code-block-menu {
  width: 300px;
}

.code-block-menu-list {
  height: 320px;
}
</style>
