<template>
  <div class="editor-redirect">
    <w-scroll-area style="height: 100%">
      <div class="editor-redirect-form">
        <w-card class="pb-2">
          <w-card-header>{{ t('editor.redirect.title') }}</w-card-header>
          <w-item>
            <blueprint-icon icon="tabler:file-plus" />
            <w-item-section>
              <w-item-label>{{ t('editor.redirect.pageTitle') }}</w-item-label>
              <w-item-label caption>{{ t('editor.redirect.pageTitleHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <!-- The same title the header edits in place: both write the store, so the two
                   behave as one field with two places to type it. -->
              <w-input
                dense
                hide-bottom-space
                :model-value="pageStore.title"
                :aria-label="t(`editor.redirect.pageTitle`)"
                @update:model-value="setTitle" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="tabler:player-track-next" />
            <w-item-section>
              <w-item-label>{{ t('editor.redirect.target') }}</w-item-label>
              <w-item-label caption>{{ t('editor.redirect.targetHint') }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-btn
                class="acrylic-btn"
                flat
                icon="tabler:folder-open"
                color="primary"
                padding="xs md"
                :label="t(`editor.redirect.choose`)"
                @click="chooseTarget" />
            </w-item-section>
          </w-item>
          <!-- Indented under the row above rather than made a row of its own: it is that row's
               answer, and the icon is the only place page-vs-URL shows. -->
          <div class="editor-redirect-field">
            <div class="text-body2 font-robotomono editor-redirect-target" v-if="state.target">
              <w-icon
                class="me-2"
                :name="state.kind === `url` ? `tabler:world` : `tabler:file-text`"
                size="sm" />
              {{ state.target }}
            </div>
            <div class="text-caption opacity-60" v-else>
              {{ t('editor.redirect.noTargetSelected') }}
            </div>
          </div>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="tabler:clock-play" />
            <w-item-section>
              <w-item-label>{{ t('editor.redirect.showInterstitial') }}</w-item-label>
              <w-item-label caption>{{ t('editor.redirect.showInterstitialHint') }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-toggle
                :model-value="state.showInterstitial"
                :aria-label="t(`editor.redirect.showInterstitial`)"
                @update:model-value="setShowInterstitial" />
            </w-item-section>
          </w-item>
        </w-card>
        <!-- Spells out what a reader arriving here gets, and is where a half-filled form is
             reported -- the server refuses that save anyway, so this warns before it is tried. -->
        <div
          class="editor-redirect-summary"
          :class="isFollowable(state) ? `is-ready` : `is-incomplete`">
          <w-icon :name="isFollowable(state) ? `tabler:info-circle` : `tabler:alert-triangle`" />
          <div class="ps-3">
            <template v-if="!isFollowable(state)">
              {{ t('editor.redirect.summaryIncomplete') }}
            </template>
            <template v-else-if="state.showInterstitial">
              {{ t('editor.redirect.summaryInterstitial', { target: state.target }) }}
            </template>
            <template v-else>
              {{ t('editor.redirect.summaryDirect', { target: state.target }) }}
            </template>
          </div>
        </div>
      </div>
    </w-scroll-area>
  </div>
</template>

<script setup>
import { defineAsyncComponent, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialog } from '@/composables/dialog'

import { isFollowable, parseRedirect, serializeRedirect } from '@/helpers/pageRedirect'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'

/**
 * A form rather than an editor: the target and the interstitial flag ARE the page's content, stored
 * as JSON (`helpers/pageRedirect.js`), and the title is the page's own field. `PageRedirect.vue`
 * draws the result for a reader.
 */

const editorStore = useEditorStore()
const pageStore = usePageStore()

const { t } = useI18n()

const state = reactive(parseRedirect(pageStore.content))

/*
  The form IS the content, so the store follows every keystroke. `immediate` canonicalizes what was
  already stored and seeds a page being created — neither is an edit, which is why the handlers
  call `touch()` for the unsaved-changes flag instead of this watcher.
*/
watch(
  state,
  (value) => {
    pageStore.content = serializeRedirect(value)
  },
  { immediate: true, deep: true }
)

function touch() {
  editorStore.markDirty()
}

function setTitle(title) {
  pageStore.title = title
  touch()
}

function setShowInterstitial(showInterstitial) {
  state.showInterstitial = showInterstitial
  touch()
}

/**
 * `kind` is which of the link picker's two tabs the answer came from — an explicit choice, rather
 * than a guess made afterwards from the shape of the string.
 *
 * The picker's "open in a new tab" offer is off: a redirection is not a link somebody clicks, so
 * there is no tab to choose and nowhere here to store the answer.
 */
function chooseTarget() {
  dialog({
    component: defineAsyncComponent(() => import('./LinkPickerDialog.vue')),
    componentProps: {
      title: t('editor.redirect.pickerTitle'),
      okLabel: t('common.actions.select'),
      initialHref: state.target,
      newTabOption: false
    }
  }).onOk(({ href, kind }) => {
    state.kind = kind === 'url' ? 'url' : 'page'
    state.target = href
    touch()
  })
}
</script>

<style>
/* Kept flat, not nested: a `&-suffix` selector is a Sass concatenation idiom that native CSS
   nesting silently drops. */
.editor-redirect {
  height: 100%;
}
.body--light .editor-redirect {
  background-color: var(--color-grey-3);
}
.body--dark .editor-redirect {
  background-color: var(--color-dark-6);
}
.editor-redirect {
  /* -> A form, not a document: it stops widening well before the column does */
}
.editor-redirect-form {
  max-width: 780px;
  margin: 0 auto;
  padding: 24px 16px 48px;
}
.editor-redirect {
  /* 16px of `w-item` padding plus its 56px avatar section: the field starts where the label above
     it does. */
}
.editor-redirect-field {
  padding: 0 16px 8px 72px;
}
.editor-redirect-target {
  display: flex;
  align-items: center;
  overflow-wrap: anywhere;
}
.editor-redirect {
  /* Amber, not red, while the form is incomplete: a save that will be refused is a warning, not an
     error that has happened. */
}
.editor-redirect-summary {
  display: flex;
  align-items: flex-start;
  margin-top: 16px;
  padding: 12px 16px;
  font-size: 0.8rem;
  line-height: 1.4;
}
.editor-redirect-summary.is-ready {
  background-color: rgba(25, 118, 210, 0.1);
  color: var(--color-blue-9);
}
.body--dark .editor-redirect-summary.is-ready.is-ready {
  color: var(--color-blue-3);
}
.editor-redirect-summary.is-incomplete {
  background-color: rgba(255, 152, 0, 0.12);
  color: var(--color-orange-9);
}
.body--dark .editor-redirect-summary.is-incomplete.is-incomplete {
  color: var(--color-orange-3);
}
</style>
