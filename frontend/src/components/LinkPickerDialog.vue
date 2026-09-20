<template>
  <w-dialog
    v-model="dialogVisible"
    :aria-label="props.title ?? t('linkPicker.title')"
    @hide="onDialogHide">
    <w-card class="link-picker" style="width: 860px; max-width: 90vw">
      <w-card-section class="card-header">
        <w-icon name="tabler:link" size="sm" class="me-2" />
        <span>{{ props.title ?? t('linkPicker.title') }}</span>
      </w-card-section>
      <w-tabs class="m-2" v-model="state.currentTab" no-caps inline-label>
        <w-tab name="page" icon="tabler:file-text" :label="t(`linkPicker.page`)" />
        <w-tab name="url" icon="tabler:world" :label="t(`linkPicker.url`)" />
      </w-tabs>
      <w-separator />
      <w-tab-panels v-model="state.currentTab">
        <w-tab-panel class="p-0" name="page">
          <div class="link-picker-browser flex flex-nowrap">
            <div class="link-picker-tree w-1/3">
              <w-scroll-area style="height: 300px">
                <!-- -> No side padding: it would inset the row highlight band, which spans the
                        column -->
                <div>
                  <tree
                    ref="treeComp"
                    v-model:selected="state.currentFolderId"
                    :nodes="state.treeNodes"
                    :roots="state.treeRoots"
                    :use-lazy-load="true"
                    :context-action-list="[]"
                    @lazy-load="treeLazyLoad" />
                </div>
              </w-scroll-area>
            </div>
            <div class="w-2/3">
              <w-scroll-area style="height: 300px">
                <w-list class="link-picker-list" dense>
                  <w-item
                    v-for="item of state.items"
                    :key="item.id"
                    clickable
                    active-class="active"
                    :active="item.type === `page` && item.path === state.path"
                    @click="selectItem(item)">
                    <w-item-section side>
                      <w-icon :name="item.icon" size="sm" />
                    </w-item-section>
                    <w-item-section>
                      <w-item-label>{{ item.title }}</w-item-label>
                      <w-item-label caption class="font-robotomono">/{{ item.path }}</w-item-label>
                    </w-item-section>
                  </w-item>
                </w-list>
                <div
                  v-if="state.items.length < 1 && !state.isFetching"
                  class="text-caption text-center p-6 text-black/60 dark:text-white/70">
                  {{ t('linkPicker.emptyFolder') }}
                </div>
              </w-scroll-area>
            </div>
          </div>
        </w-tab-panel>
        <w-tab-panel class="p-4" name="url">
          <w-input
            ref="iptUrl"
            v-model="state.url"
            dense
            hide-bottom-space
            :label="t(`linkPicker.linkUrl`)"
            :aria-label="t(`linkPicker.linkUrl`)"
            placeholder="https://example.com/page" />
          <w-checkbox
            v-if="props.newTabOption"
            class="mt-4"
            v-model="state.openInNewTab"
            :label="t(`linkPicker.openInNewTab`)" />
        </w-tab-panel>
      </w-tab-panels>
      <w-separator />
      <!-- -> Spells out what is about to be committed: both tabs can be half-filled, and only one of
              them is the answer -->
      <w-card-section class="flex flex-nowrap items-center py-2">
        <w-icon
          :name="state.currentTab === `page` ? `tabler:file-text` : `tabler:world`"
          size="sm"
          color="primary" />
        <div class="min-w-0 flex-1 ps-3">
          <div class="text-caption text-grey">{{ t('linkPicker.selection') }}</div>
          <div class="text-body2 font-robotomono link-picker-href">{{ href || '—' }}</div>
        </div>
      </w-card-section>
      <w-separator />
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          icon="tabler:x"
          :label="t(`common.actions.cancel`)"
          color="grey-7"
          padding="xs md"
          @click="onDialogCancel" />
        <w-btn
          icon="tabler:check"
          :label="props.okLabel ?? t(`common.actions.insert`)"
          color="primary"
          padding="xs md"
          :disabled="!canSubmit"
          @click="submit" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'

import { apiErrorMessage } from '@/helpers/apiError'
import { fetchTreeEntries, mergeFolderEntries } from '@/helpers/treeNodes'
import fileTypes from '@/helpers/fileTypes'
import { localizedPagePath } from '@/helpers/pagePaths'

import Tree from '@/components/TreeNav.vue'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

/**
 * Picks a link target: a page of this wiki, or any URL. Opened from anywhere that needs one, so it
 * decides nothing about what the link is FOR — it answers with `{ href, kind, openInNewTab, title }`
 * and leaves the caller to render or store that.
 */

const props = defineProps({
  title: {
    type: String,
    default: null
  },
  okLabel: {
    type: String,
    default: null
  },
  initialHref: {
    type: String,
    default: ''
  },
  /**
   * Off for a caller with nowhere to put the answer: a control whose effect is discarded is worse
   * than no control.
   */
  newTabOption: {
    type: Boolean,
    default: true
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const pageStore = usePageStore()
const siteStore = useSiteStore()

const { t } = useI18n()

const treeComp = ref(null)
const iptUrl = ref(null)

const state = reactive({
  currentTab: 'page',
  /** Null is the site root. */
  currentFolderId: null,
  treeNodes: {},
  treeRoots: [],
  items: [],
  /** A slash path with no leading slash. Only a row in the list sets it. */
  path: '',
  pageTitle: '',
  isFetching: false,
  url: 'https://',
  openInNewTab: false
})

/*
  Tree and link are both scoped to `pageStore.locale`: listing a page that exists only in another
  locale would hand back `/en/<fr-path>`, a path that never existed -- a dead link the moment it is
  followed.
*/
const href = computed(() =>
  state.currentTab === 'page'
    ? state.path
      ? localizedPagePath(state.path, pageStore.locale, siteStore.localeRouting)
      : ''
    : state.url.trim()
)

const canSubmit = computed(() => {
  if (state.currentTab === 'page') {
    return state.path.length > 0
  }
  // -> The scheme alone is what the field is prefilled with, so it does not count as an answer
  return href.value.length > 0 && !/^[a-z][a-z0-9+.-]*:\/*$/i.test(href.value)
})

watch(
  () => state.currentFolderId,
  (folderId) => loadTree({ parentId: folderId })
)

/**
 * `initLoad` also asks for the folders above the one being listed, so opening on a page buried a few
 * levels down draws its whole branch from a single request. Those extra entries come back flagged
 * `isAncestor` and belong in the tree only, never in the list.
 */
async function loadTree({ parentId = null, parentPath = null, initLoad = false }) {
  if (state.isFetching) {
    return
  }
  state.isFetching = true
  const isCurrentFolder = (parentId ?? null) === state.currentFolderId
  if (isCurrentFolder) {
    state.items = []
  }
  try {
    const entries = await fetchTreeEntries(siteStore.id, {
      parentId,
      parentPath,
      types: ['folder', 'page'],
      locale: pageStore.locale,
      initLoad
    })
    const { roots } = mergeFolderEntries(state.treeNodes, entries, parentId)
    for (const id of roots) {
      if (!state.treeRoots.includes(id)) {
        state.treeRoots.push(id)
      }
    }
    for (const entry of entries ?? []) {
      const path = entry.folderPath ? `${entry.folderPath}/${entry.fileName}` : entry.fileName
      if (isCurrentFolder && !entry.isAncestor) {
        state.items.push({
          id: entry.id,
          type: entry.type,
          title: entry.title,
          path,
          icon: entry.type === 'folder' ? fileTypes.folder.icon : fileTypes.page.icon
        })
      }
    }
    state.items.sort((a, b) =>
      a.type === b.type ? a.title.localeCompare(b.title) : a.type === 'folder' ? -1 : 1
    )
  } catch (err) {
    notify({
      type: 'negative',
      message: t('linkPicker.loadFailed'),
      caption: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
  if (parentId) {
    treeComp.value?.setLoaded(parentId)
  }
  state.isFetching = false
}

function treeLazyLoad(nodeId, isCurrent, { done }) {
  loadTree({ parentId: nodeId }).then(done)
}

function findFolderIdByPath(path) {
  if (!path) {
    return null
  }
  const entry = Object.entries(state.treeNodes).find(
    ([, node]) => (node.folderPath ? `${node.folderPath}/${node.fileName}` : node.fileName) === path
  )
  return entry?.[0] ?? null
}

function selectItem(item) {
  if (item.type === 'folder') {
    state.currentFolderId = item.id
    treeComp.value?.setOpened(item.id)
    return
  }
  state.path = item.path
  state.pageTitle = item.title
}

function submit() {
  onDialogOK({
    href: href.value,
    /*
      Which tab answered: it cannot be recovered from the string afterwards, since `/help` is both a
      page of this wiki and a perfectly good relative URL elsewhere.
    */
    kind: state.currentTab,
    // -> Never for a page: one of this wiki's own opens in the tab the reader is already in
    openInNewTab: state.currentTab === 'url' && props.newTabOption && state.openInNewTab,
    title: state.currentTab === 'page' ? state.pageTitle : ''
  })
}

onMounted(async () => {
  /*
    An href already set decides which tab opens and what it starts on, so re-opening the picker on an
    existing link starts from that link rather than from nothing.
  */
  if (props.initialHref) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(props.initialHref) || props.initialHref.startsWith('//')) {
      state.currentTab = 'url'
      state.url = props.initialHref
    } else {
      state.path = props.initialHref.replace(/^\/+/, '')
    }
  }

  // -> Opens on the folder holding the page being edited: where a link most often points
  const startFolder = pageStore.folderPath
  await loadTree({ parentPath: startFolder, initLoad: true })
  const startFolderId = findFolderIdByPath(startFolder)
  if (startFolderId) {
    const parts = startFolder.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const ancestorId = findFolderIdByPath(parts.slice(0, i).join('/'))
      if (ancestorId) {
        treeComp.value?.setOpened(ancestorId)
      }
    }
    state.currentFolderId = startFolderId
  } else {
    // -> Already at the root, which the watcher above will not fire for
    await loadTree({})
  }

  if (state.currentTab === 'url') {
    await nextTick()
    iptUrl.value?.focus()
  }
})
</script>

<style>
.link-picker-browser {
  height: 300px;
  max-height: 90vh;
}
.link-picker {
  /* -> Empty: the recessed surface belongs to the tree column below */
}
.link-picker-tree {
  height: 300px;
}
.body--light .link-picker-tree {
  background-color: var(--color-blue-grey-1);
}
.body--dark .link-picker-tree {
  background-color: var(--color-dark-4);
}
.link-picker-list {
  padding: 8px 12px;
}
.link-picker-list > .w-item {
  padding: 4px 6px;
}
.link-picker-list > .w-item.active {
  background-color: var(--color-primary);
  color: #fff;
}
.link-picker-list > .w-item.active .w-item-label--caption {
  color: rgba(255, 255, 255, 0.7);
}
.link-picker-href {
  overflow-wrap: anywhere;
}
</style>
