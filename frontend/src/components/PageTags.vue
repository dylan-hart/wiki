<template>
  <div>
    <!--
      The chips get their own wrapping flex row rather than the outer block's: `gap` needs a flex
      container, and the field below still has to start on a line of its own.
    -->
    <div class="flex flex-wrap items-center gap-1" v-if="pageStore.tags?.length > 0">
      <w-chip
        class="page-tag"
        size="sm"
        dense
        :clickable="!props.edit"
        :removable="props.edit"
        @click="browseTag(tag)"
        @remove="removeTag(tag)"
        v-for="tag of pageStore.tags"
        :key="`tag-` + tag">
        <span class="page-tag-hash" aria-hidden="true">#</span>
        <span>{{ tag }}</span>
      </w-chip>
    </div>
    <!--
      Entry only: no `use-chips`, because the selection is already drawn as the chips above. `create`
      is what lets a tag that does not exist yet be typed in.
    -->
    <w-select
      class="mt-4"
      v-if="props.edit"
      v-model="pageStore.tags"
      :options="state.tags"
      dense
      options-dense
      use-input
      create
      multiple
      hide-dropdown-icon
      @create="createTag"
      :placeholder="t(`editor.props.tagsPlaceholder`)"
      :aria-label="t(`editor.props.tags`)"
      :loading="state.loading" />
  </div>
</template>

<script setup>
import { reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import { notify } from '@/composables/notify'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { apiErrorMessage } from '@/helpers/apiError'

const props = defineProps({
  edit: {
    type: Boolean,
    default: false
  }
})

const router = useRouter()

const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()

const { t } = useI18n()

const state = reactive({
  tags: [],
  loading: false
})

pageStore.$subscribe(() => {
  if (props.edit) {
    editorStore.markDirty()
  }
})

watch(
  () => props.edit,
  async (newValue) => {
    if (!newValue) {
      return
    }
    state.loading = true
    try {
      await siteStore.fetchTags()
      state.tags = siteStore.tags.map((t) => t.tag)
    } catch (err) {
      // -> Suggestions are a convenience: the field still adds tags without them, so warn rather
      //    than fail
      notify({
        type: 'warning',
        message: t('editor.props.tagsFailed'),
        caption: apiErrorMessage(err)
      })
    } finally {
      state.loading = false
    }
  },
  { immediate: true }
)

/** Commas and semicolons separate tags, so a whole list can be pasted in one go. */
function createTag(val) {
  const tags = val
    .split(/[,;]+/)
    .map((v) => v.trim())
    .filter(Boolean)
  if (tags.length === 0) {
    return
  }

  const nextSelection = pageStore.tags.slice()
  for (const tag of tags) {
    if (!state.tags.includes(tag)) {
      state.tags.push(tag)
    }
    if (!nextSelection.includes(tag)) {
      nextSelection.push(tag)
    }
  }
  pageStore.tags = nextSelection
}

/**
 * The dedicated tag-browse page rather than `/_search`'s `#tag` query token: a reader following a tag
 * wants a faceted browse they can narrow with further tags, not a text search that starts with one.
 */
function browseTag(tag) {
  router.push({ path: '/_tags', query: { tags: tag } })
}

function removeTag(tag) {
  pageStore.tags = pageStore.tags.filter((t) => t !== tag)
}
</script>

<style>
/* A hairline box on the surface rather than a filled pill, with the `#` carrying the only colour. */
.page-tag {
  padding: 3px 8px;
  font-size: 12px;

  border: 1px solid;

  .body--light & {
    border-color: var(--color-hairline);
    background-color: var(--color-surface);
    color: var(--color-slate);
  }
  .body--dark & {
    border-color: var(--color-hairline-dark);
    background-color: var(--color-dark-3);
    color: var(--color-text-secondary-dark);
  }

  /*
    Cobalt draws a tag as a filled pill rather than Ledger's hairline outline; the radius already
    comes from `WChip`'s own unconditional `--radius-pill`. Additive rather than a swap of the rule
    above: Ledger's `--color-tag-chip-bg` default is `transparent`, so rewriting the base rule in
    terms of the token would visibly change Ledger.

    Cobalt's filled tint needs `font-weight: 500` to keep the label legible, where Ledger's outline
    reads fine at 400. Declared here rather than left to `tailwind.css`'s shared
    `body.body--cobalt .w-chip` rule because `PageTags.test.js` mounts this component with no
    `tailwind.css` loaded.
  */
  body.body--cobalt & {
    border-color: var(--color-tag-chip-border);
    background-color: var(--color-tag-chip-bg);
    color: var(--color-tag-chip-text);
    font-weight: 500;
  }
}

.page-tag-hash {
  margin-inline-end: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;

  .body--light & {
    color: var(--color-accent);
  }
  .body--dark & {
    color: var(--color-accent-dark);
  }

  /*
    Cobalt's filled pill carries no `#` at all, not merely a recoloured one. `aria-hidden="true"` on
    the span already keeps it out of the accessibility tree either way, so hiding it loses nothing.
  */
  body.body--cobalt & {
    display: none;
  }
}
</style>
