<template>
  <div>
    <!--
      The gap was on the outer element, which is a plain block and has nothing to space: the chips ran
      into each other. Its own wrapping flex row, so the field below still starts on a line of its own.
    -->
    <div class="flex flex-wrap items-center gap-1" v-if="pageStore.tags?.length > 0">
      <!--
        A tag is a hairline box on the surface, not a filled pill: the design gives it a white plate
        with a slate label and puts the accent on the `#` alone
        (`ui-redesign/Cardinal Wiki - Ledger 3x.dc.html`'s Tags rail). Filled slate chips read as five
        buttons, and the accent is reserved for the live edge -- which a tag is not.
      -->
      <w-chip
        class="page-tag"
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
      Entry only: no `use-chips`, because the selection is already shown as the chips above and having
      it in the field as well said the same thing twice. `create` is what lets a tag that does not
      exist yet be typed in; the suggestions are filtered by WSelect itself, from what is typed.
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

// PROPS

const props = defineProps({
  edit: {
    type: Boolean,
    default: false
  }
})

// ROUTER

const router = useRouter()

// STORES

const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  /** Every tag on the site, as suggestions. WSelect narrows these against what is typed. */
  tags: [],
  loading: false
})

// WATCHERS

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
      // -> Suggestions are a convenience: without them the field still adds tags, so this is a warning
      //    rather than a failure, and the spinner must not be left running either way
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

// METHODS

/**
 * Add whatever was typed, as one tag or as several.
 *
 * A comma or a semicolon separates tags, so a list can be pasted in one go. Each new one joins the
 * suggestions too, so re-typing it offers a match rather than looking unknown.
 */
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
 * Browse the site for everything carrying this tag, via the dedicated tag-browse page
 * (OpenProject #987) rather than `/_search`'s `#tag` query token -- a reader following a tag wants a
 * faceted browse they can narrow with further tags, not a text search that happens to start with one.
 *
 * Only reachable in view mode -- WChip emits `click` only while `clickable`, which the editing chips
 * are not, their control being the remove button instead.
 */
function browseTag(tag) {
  router.push({ path: '/_tags', query: { tags: tag } })
}

function removeTag(tag) {
  pageStore.tags = pageStore.tags.filter((t) => t !== tag)
}
</script>

<style lang="scss">
/*
  The tag plate, at the design's own metrics: a hairline box on the surface, 12px Barlow in the
  chrome tone, with the `#` carrying the only colour on it.
*/
.page-tag {
  padding: 3px 8px;
  font-size: 12px;

  border: 1px solid;

  @at-root .body--light & {
    border-color: $hairline;
    background-color: $surface;
    color: $slate;
  }
  @at-root .body--dark & {
    border-color: $hairline-dark;
    background-color: $dark-3;
    color: $text-secondary-dark;
  }
}

.page-tag-hash {
  margin-inline-end: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;

  @at-root .body--light & {
    color: $accent-text;
  }
  @at-root .body--dark & {
    color: $accent-dark;
  }
}
</style>
