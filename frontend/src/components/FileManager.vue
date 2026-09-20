<template>
  <w-layout class="fileman" container>
    <!--
      Below 900px the three toolbars wrap onto two lines rather than overflowing the row (see the
      stylesheet, which is also why each carries a name). Close is in the last of them, and it is
      the only way out of the overlay.
    -->
    <w-header class="card-header">
      <w-toolbar class="fileman-hdr-title">
        <!--
          -> The accent lightened for a dark ground, not the white the title is set in. Stated here
             rather than in `.card-header` (`css/_base.css`), which every dialog in the app shares.

          -> A class rather than `WIcon`'s `color` prop: that prop resolves to a `text-<name>` CLASS,
             and `text-accent-dark` appears as literal text nowhere for Tailwind's scanner to find.
             The stylesheet below reads the variable instead, which `@theme static` guarantees is
             emitted.
        -->
        <w-icon class="fileman-hdr-icon" name="tabler:folder" left size="md" />
        <span>{{ t(`fileman.title`) }}</span>
      </w-toolbar>
      <w-toolbar class="fileman-hdr-search">
        <!--
          -> The CONTENT locale being browsed, not the UI language (`commonStore.locale` /
             `<locale-selector-menu/>`). Gated on `siteStore.useLocales` rather than
             `locales.showMenu`: that flag is about whether a READER is offered a switcher, which
             has no bearing on an author browsing the tree.

          -> Built on the "view options" menu idiom just below rather than on
             `LocaleSelectorMenu`, which is styled for a reader-facing language switcher. The
             chevron is what says a menu opens from here; without it a bare two-letter label reads
             as a status.
        -->
        <w-btn
          v-if="siteStore.useLocales"
          class="fileman-locale me-2"
          flat
          color="white"
          :label="state.locale"
          :aria-label="state.locale">
          <w-icon class="fileman-locale-caret" name="tabler:chevron-down" size="xs" />
          <w-menu class="translucent-menu" auto-close anchor="bottom left" self="top left">
            <w-card class="p-2">
              <w-list dense style="min-width: 180px">
                <w-item
                  v-for="lang of siteStore.locales.active"
                  :key="lang.code"
                  clickable
                  @click="selectLocale(lang.code)">
                  <w-item-section side>
                    <w-icon
                      :name="lang.code === state.locale ? `tabler:circle-check` : `tabler:circle`"
                      :color="lang.code === state.locale ? `positive` : `grey`"
                      size="xs" />
                  </w-item-section>
                  <w-item-section class="pe-2">
                    <w-item-label>{{ lang.nativeName }}</w-item-label>
                    <w-item-label caption>{{ lang.code }}</w-item-label>
                  </w-item-section>
                </w-item>
              </w-list>
            </w-card>
          </w-menu>
        </w-btn>
        <!--
          The same pill the site header uses (`HeaderSearch`), written out rather than a `w-input`:
          that component has no `dark`/`standout`/`debounce`, so those fall through as bare
          attributes and style nothing.
        -->
        <div class="fileman-search" :class="{ 'is-focused': state.searchIsFocused }">
          <w-icon class="fileman-search-lead" name="tabler:search" />
          <input
            ref="searchField"
            v-model="state.search"
            type="text"
            class="fileman-search-input"
            :placeholder="t(`fileman.searchFolder`)"
            :aria-label="t(`fileman.searchFolder`)"
            autocomplete="off"
            @focus="state.searchIsFocused = true"
            @blur="state.searchIsFocused = false" />
          <button
            v-if="state.search.length > 0"
            type="button"
            class="fileman-search-clear"
            :aria-label="t(`common.actions.clear`)"
            @click="state.search = ``">
            <w-icon name="tabler:x" />
          </button>
          <!--
            Truthful only because this overlay really does claim Cmd/Ctrl+K while it is up
            (`handleKeyPress` below; `HeaderSearch` stands down for an overlay). Gives way once the
            field is in use, where the clear button needs the room.
          -->
          <span
            v-if="!state.searchIsFocused && state.search.length < 1"
            class="fileman-search-kbd"
            aria-hidden="true"
            @click="searchField.focus()">
            {{ searchShortcutHint }}
          </span>
        </div>
      </w-toolbar>
      <w-toolbar class="fileman-hdr-actions">
        <w-space />
        <w-btn
          class="me-2"
          flat
          rounded
          color="white"
          :aria-label="t(`common.actions.viewDocs`)"
          icon="tabler:help-circle"
          :href="siteStore.docsBase + `/guide/file-manager`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn-group>
          <w-btn
            color="white"
            text-color="text-secondary"
            :label="t(`common.actions.close`)"
            :aria-label="t(`common.actions.close`)"
            icon="tabler:x"
            @click="close" />
        </w-btn-group>
      </w-toolbar>
    </w-header>
    <!--
      The folder tree: beside the list where there is room, a panel over it below 1024px, which is
      what `WDrawer` does on its own. The binding must be two-way -- the drawer asks to be closed
      when its scrim is tapped, and a one-way `:model-value="true"` left 350px of tree across a
      phone with no way to put it away. Narrower while it overlays, so there is scrim left to tap on.
    -->
    <w-drawer class="fileman-left" v-model="treeDrawerOpen" :width="isTreeOverlay ? 300 : 320">
      <w-scroll-area style="height: 100%">
        <!-- -> No side padding: a hovered or selected tree row reads as a band across the drawer -->
        <div class="pt-2 pb-2">
          <tree
            ref="treeComp"
            :nodes="state.treeNodes"
            :roots="state.treeRoots"
            v-model:selected="state.currentFolderId"
            @lazy-load="treeLazyLoad"
            :use-lazy-load="true"
            @context-action="treeContextAction"
            :display-mode="state.displayMode" />
        </div>
      </w-scroll-area>
    </w-drawer>
    <w-drawer class="fileman-right" :model-value="detailsPaneShown" :width="320" side="right">
      <w-scroll-area style="height: 100%">
        <div class="p-4">
          <template v-if="currentFileDetails">
            <!--
              The plate is always drawn, holding a placeholder glyph when the file has no preview:
              only images have a thumbnail and pages get an illustration, so otherwise the pane's
              whole layout changed with the row the reader happened to click.
            -->
            <div class="fileman-thumb">
              <img
                class="w-full aspect-[16/10] object-cover"
                v-if="currentFileDetails.thumbnail"
                :src="currentFileDetails.thumbnail"
                :alt="currentFileDetails.fileName" />
              <w-icon v-else class="fileman-thumb-placeholder" name="tabler:photo" size="46px" />
              <i class="fileman-thumb-tick fileman-thumb-tick--tl"></i>
              <i class="fileman-thumb-tick fileman-thumb-tick--tr"></i>
              <i class="fileman-thumb-tick fileman-thumb-tick--bl"></i>
              <i class="fileman-thumb-tick fileman-thumb-tick--br"></i>
            </div>
            <div
              class="fileman-details-row"
              v-for="item of currentFileDetails.items"
              :key="item.id">
              <label>{{ item.label }}</label>
              <span>{{ item.value }}</span>
            </div>
            <template v-if="insertMode">
              <w-separator class="my-4" />
              <!--
                -> `accent`, not `primary`: the two share a default under Ledger, but under Cobalt
                   the design fills this button with the accent rather than `primary`'s unrelated
                   blue. Not the accent's lighter FILL tone either -- that is 2.9:1 under a white
                   label, and `helpers/accessibility.test.js` pins it as never carrying one.
              -->
              <w-btn
                class="w-full fileman-insert-btn"
                @click="insertItem()"
                :label="t(`common.actions.insert`)"
                color="accent"
                icon="tabler:plus"
                padding="sm" />
            </template>
          </template>
        </div>
      </w-scroll-area>
    </w-drawer>
    <w-page-container>
      <!--
        The drawer's own scrim cannot provide "tap outside to dismiss" here: `WDrawer` teleports it
        to the body at z-30 and this view sits inside a dialog painted above it, so a tap beside the
        panel lands on this pane instead. On the pane rather than on the list inside it, which is
        only as tall as its rows; the handler steps aside for the toolbar, which holds the button
        that OPENS the tree.
      -->
      <w-page class="fileman-center column" @click="dismissTreeOverlay">
        <w-toolbar class="fileman-toolbar">
          <template v-if="state.isUploading">
            <div class="fileman-progressbar">
              <div :style="`width: ` + state.uploadPercentage + `%`">
                {{ state.uploadPercentage }}%
              </div>
            </div>
            <w-btn
              class="acrylic-btn ms-2"
              flat
              dense
              color="negative"
              :aria-label="t(`common.actions.cancel`)"
              icon="tabler:square"
              @click="uploadCancel"
              v-if="state.uploadPercentage < 100" />
          </template>
          <template v-else>
            <!--
              Ahead of the way INTO the tree: both answer "where am I" rather than "what can I do
              here".
            -->
            <up-one-level-btn
              :show="Boolean(state.currentFolderId)"
              tooltip-anchor="bottom middle"
              tooltip-self="top middle"
              @click="goUp" />
            <!-- The only way to open the tree while it overlays the list -->
            <w-btn
              v-if="isTreeOverlay"
              class="me-2"
              flat
              dense
              color="slate-soft"
              :aria-label="t(`common.sidebar.browse`)"
              icon="tabler:binary-tree"
              @click="state.treeOpen = true">
              <w-tooltip anchor="bottom middle" self="top middle">{{
                t(`common.sidebar.browse`)
              }}</w-tooltip>
            </w-btn>
            <w-space />
            <!-- -> No `dense`: the design draws this row at `WBtn`'s regular 32px, not its 28px -->
            <w-btn
              class="me-2"
              flat
              color="slate-soft"
              :aria-label="t(`fileman.viewOptions`)"
              icon="tabler:layout-list">
              <w-tooltip anchor="bottom middle" self="top middle">{{
                t(`fileman.viewOptions`)
              }}</w-tooltip>
              <w-menu anchor="bottom right" self="top right">
                <w-card class="p-2">
                  <div class="text-center">
                    <small class="text-grey">{{ t(`fileman.viewOptions`) }}</small>
                  </div>
                  <w-list dense>
                    <w-separator class="my-2" />
                    <w-item clickable>
                      <w-item-section side>
                        <w-icon name="tabler:list" color="slate-soft" size="xs" />
                      </w-item-section>
                      <w-item-section class="pe-2">{{ t('fileman.browseUsing') }}</w-item-section>
                      <w-item-section side>
                        <w-icon name="tabler:chevron-right" color="slate-soft" size="xs" />
                      </w-item-section>
                      <w-menu anchor="top end" self="top start">
                        <w-list class="p-2" dense>
                          <w-item clickable @click="state.displayMode = `path`">
                            <w-item-section side>
                              <w-icon
                                :name="
                                  state.displayMode === `path`
                                    ? `tabler:circle-check`
                                    : `tabler:circle`
                                "
                                :color="state.displayMode === `path` ? `positive` : `grey`"
                                size="xs" />
                            </w-item-section>
                            <w-item-section class="pe-2">{{
                              t('fileman.browseUsingPaths')
                            }}</w-item-section>
                          </w-item>
                          <w-item clickable @click="state.displayMode = `title`">
                            <w-item-section side>
                              <w-icon
                                :name="
                                  state.displayMode === `title`
                                    ? `tabler:circle-check`
                                    : `tabler:circle`
                                "
                                :color="state.displayMode === `title` ? `positive` : `grey`"
                                size="xs" />
                            </w-item-section>
                            <w-item-section class="pe-2">{{
                              t('fileman.browseUsingTitles')
                            }}</w-item-section>
                          </w-item>
                        </w-list>
                      </w-menu>
                    </w-item>
                    <w-item clickable @click="state.isCompact = !state.isCompact">
                      <w-item-section side>
                        <w-icon
                          :name="state.isCompact ? `tabler:checkbox` : `tabler:player-stop`"
                          :color="state.isCompact ? `positive` : `grey`"
                          size="xs" />
                      </w-item-section>
                      <w-item-section class="pe-2">{{ t('fileman.compactList') }}</w-item-section>
                    </w-item>
                    <w-item clickable @click="state.shouldShowFolders = !state.shouldShowFolders">
                      <w-item-section side>
                        <w-icon
                          :name="state.shouldShowFolders ? `tabler:checkbox` : `tabler:player-stop`"
                          :color="state.shouldShowFolders ? `positive` : `slate-pale`"
                          size="xs" />
                      </w-item-section>
                      <w-item-section class="pe-2">{{ t('fileman.showFolders') }}</w-item-section>
                    </w-item>
                  </w-list>
                </w-card>
              </w-menu>
            </w-btn>
            <w-btn
              class="me-2"
              flat
              color="slate-soft"
              :aria-label="t(`common.actions.refresh`)"
              icon="tabler:refresh"
              @click="reloadFolder(state.currentFolderId)">
              <w-tooltip anchor="bottom middle" self="top middle">{{
                t(`common.actions.refresh`)
              }}</w-tooltip>
            </w-btn>
            <w-separator class="me-2" inset vertical />
            <!--
              The two labelled actions are OUTLINED where the icon buttons before them are flat, so
              "what I can do here" reads as a pair of controls rather than two more glyphs in the
              row. `slate`, not `slate-soft`, which is a hairline/icon tone below the 4.5:1 floor
              for text.
            -->
            <w-btn
              class="fileman-new-btn me-2"
              outline
              :color="dark.isActive ? `slate-light` : `slate`"
              :label="t(`common.actions.new`)"
              :aria-label="t(`common.actions.new`)"
              icon="tabler:plus">
              <new-menu
                :hide-asset-btn="true"
                :show-new-folder="true"
                @new-folder="() => newFolder(state.currentFolderId)"
                @new-page="() => close()"
                :base-path="folderPath" />
            </w-btn>
            <!--
              Green, not the accent: the accent is spoken for on this screen, marking which row is
              selected, and a second accent control would compete with that. `WBtn`'s `outline`
              deliberately draws every outlined edge in the hairline tone, so the green edge comes
              from the class below rather than from a change to the shared component.
            -->
            <w-btn
              class="fileman-upload-btn"
              outline
              color="positive"
              :label="t(`common.actions.upload`)"
              :aria-label="t(`common.actions.upload`)"
              icon="tabler:cloud-upload"
              @click="uploadFile" />
            <!--
              Insert's other home is the details pane, which is absent below 1440px, and the file
              list offers it only through a right-click menu, which a touch screen has no gesture
              for. Same call on the same selection, in the one place always on screen.
            -->
            <w-btn
              v-if="insertMode && !detailsPaneShown && state.currentFileId"
              class="ms-2"
              flat
              dense
              color="primary"
              :label="t(`common.actions.insert`)"
              :aria-label="t(`common.actions.insert`)"
              icon="tabler:plus"
              @click="insertItem()" />
          </template>
        </w-toolbar>
        <div class="flex flex-wrap" style="flex: 1 1 100%">
          <!--
            Scoped to the file-LISTING pane, so a drag over the toolbar or the tree does not compete
            with what those already do. `dragover` has to be prevented too, not just `drop`: the
            browser's default for an unhandled `dragover` refuses the drop outright, which
            suppresses `drop` from firing at all.
          -->
          <div
            class="min-w-0 flex-1 fileman-droptarget"
            @dragenter.prevent="handleDragEnter"
            @dragover.prevent="handleDragOver"
            @dragleave.prevent="handleDragLeave"
            @drop.prevent="handleDrop">
            <!--
              `pointer-events: none` (see the stylesheet) keeps this overlay from ever being the
              target of a `dragenter`/`dragleave`: appearing under the pointer the instant a drag
              begins, it would otherwise fire a `dragleave` on the pane underneath it.
            -->
            <div class="fileman-dropoverlay" v-if="state.isDraggingOver">
              <w-icon name="tabler:cloud-upload" size="64px" />
              <span>{{ t('fileman.dropToUpload') }}</span>
            </div>
            <w-scroll-area style="height: 100%">
              <div class="fileman-loadinglist" v-if="state.fileListLoading">
                <w-spinner class="me-2" color="primary" size="64px" />
                <span class="text-primary">{{ t('fileman.fetchingFolderContents') }}</span>
              </div>
              <div class="fileman-emptylist" v-else-if="files.length < 1">
                <img src="/_assets/icons/carbon-copy-empty-box.svg" alt="" />
                <span>{{ t('common.pageSelector.folderEmptyWarning') }}</span>
              </div>
              <w-list class="fileman-filelist" v-else :class="state.isCompact && `is-compact`">
                <w-item
                  v-for="item of files"
                  :key="item.id"
                  clickable
                  active-class="active"
                  :active="item.id === state.currentFileId"
                  @click="selectItem(item)"
                  @dblclick="doubleClickItem(item)">
                  <w-item-section class="fileman-filelist-icon" avatar>
                    <w-icon :name="item.icon" :size="state.isCompact ? `sm` : `xl`" />
                  </w-item-section>
                  <w-item-section class="fileman-filelist-label">
                    <w-item-label>{{ usePathTitle ? item.fileName : item.title }}</w-item-label>
                  </w-item-section>
                  <w-item-section class="fileman-filelist-type">
                    <div>{{ item.caption }}</div>
                  </w-item-section>
                  <w-item-section class="fileman-filelist-side" side v-if="item.side">
                    <div>{{ item.side }}</div>
                  </w-item-section>
                  <w-menu class="translucent-menu" context-menu auto-close>
                    <w-card class="p-2">
                      <w-list dense style="min-width: 150px">
                        <w-item
                          clickable
                          v-if="insertMode && item.type !== `folder`"
                          @click="insertItem(item)">
                          <w-item-section side>
                            <w-icon name="tabler:plus" color="primary" />
                          </w-item-section>
                          <w-item-section>{{ t(`common.actions.insert`) }}</w-item-section>
                        </w-item>
                        <w-item clickable v-if="item.type === `page`" @click="editItem(item)">
                          <w-item-section side>
                            <w-icon name="tabler:edit" color="warning-fill" />
                          </w-item-section>
                          <w-item-section>{{ t(`common.actions.edit`) }}</w-item-section>
                        </w-item>
                        <!-- -> The route 503s without the Puppeteer extension (mirrored here via
                                siteStore.pdfExportAvailable) and refuses any editor but markdown
                                (backend/models/rendering.ts's ensureCanRender), so the button is
                                absent rather than offered and failing. -->
                        <w-item
                          clickable
                          v-if="
                            item.type === `page` &&
                            item.pageType === `markdown` &&
                            siteStore.pdfExportAvailable
                          "
                          @click="rerenderPage(item)">
                          <w-item-section side>
                            <w-icon name="tabler:wand" color="warning-fill" />
                          </w-item-section>
                          <w-item-section>{{ t(`common.actions.rerender`) }}</w-item-section>
                        </w-item>
                        <w-item clickable v-if="item.type !== `folder`" @click="openItem(item)">
                          <w-item-section side>
                            <w-icon name="tabler:eye" color="primary" />
                          </w-item-section>
                          <w-item-section>{{ t(`common.actions.view`) }}</w-item-section>
                        </w-item>
                        <w-item clickable v-if="item.type !== `folder`" @click="copyItemURL(item)">
                          <w-item-section side>
                            <w-icon name="tabler:clipboard" color="primary" />
                          </w-item-section>
                          <w-item-section>{{ t(`common.actions.copyURL`) }}</w-item-section>
                        </w-item>
                        <w-item clickable v-if="item.type === `asset`" @click="downloadItem(item)">
                          <w-item-section side>
                            <w-icon name="tabler:download" color="primary" />
                          </w-item-section>
                          <w-item-section>{{ t(`common.actions.download`) }}</w-item-section>
                        </w-item>
                        <w-item
                          clickable
                          v-if="item.type === `page` || item.type === `folder`"
                          @click="duplicateItem(item)">
                          <w-item-section side>
                            <w-icon name="tabler:copy" color="slate-soft" />
                          </w-item-section>
                          <w-item-section>{{ t('fileman.duplicateItem') }}</w-item-section>
                        </w-item>
                        <!--
                          One entry for a page: name and place are picked in the same dialog, so two
                          actions would be two ways into one form.
                        -->
                        <w-item clickable v-if="item.type === `page`" @click="renameMovePage(item)">
                          <w-item-section side>
                            <w-icon name="tabler:share" color="slate-soft" />
                          </w-item-section>
                          <w-item-section>{{ t('fileman.renameMovePage') }}</w-item-section>
                        </w-item>
                        <template v-else>
                          <w-item clickable @click="renameItem(item)">
                            <w-item-section side>
                              <w-icon name="tabler:arrow-forward-up" color="slate-soft" />
                            </w-item-section>
                            <w-item-section>{{ t('fileman.renameItem') }}</w-item-section>
                          </w-item>
                          <w-item clickable v-if="item.type === `asset`" @click="moveItem(item)">
                            <w-item-section side>
                              <w-icon name="tabler:share" color="slate-soft" />
                            </w-item-section>
                            <w-item-section>{{ t('fileman.moveItem') }}</w-item-section>
                          </w-item>
                        </template>
                        <w-item clickable @click="delItem(item)">
                          <w-item-section side>
                            <w-icon name="tabler:trash" color="negative" />
                          </w-item-section>
                          <w-item-section class="text-negative">{{
                            t(`common.actions.delete`)
                          }}</w-item-section>
                        </w-item>
                      </w-list>
                    </w-card>
                  </w-menu>
                </w-item>
              </w-list>
            </w-scroll-area>
          </div>
        </div>
      </w-page>
    </w-page-container>
    <w-footer>
      <w-bar class="fileman-path">
        <small>{{ folderPath }}</small>
      </w-bar>
    </w-footer>
    <input type="file" ref="fileIpt" multiple @change="uploadNewFiles" style="display: none" />
  </w-layout>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRaw, watch } from 'vue'
import { useRouter } from 'vue-router'

import { useFileManagerActions } from '@/composables/fileManagerActions'
import { useFileUpload } from '@/composables/fileUpload'
import { notify } from '@/composables/notify'
import { useMinWidth, useScreen } from '@/composables/screen'
import { useDark } from '@/composables/dark'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import Fuse from 'fuse.js/basic'
import NewMenu from './PageNewMenu.vue'
import Tree from './TreeNav.vue'
import UpOneLevelBtn from './UpOneLevelBtn.vue'
import { apiErrorMessage } from '@/helpers/apiError'
import { fetchTreeEntries, mergeFolderEntries, parentFolderIdOf } from '@/helpers/treeNodes'
import { assetUrl } from '@/helpers/assets'
import { humanizeDate } from '@/helpers/datetime'
import fileTypes from '@/helpers/fileTypes'
import { formatFileSize } from '@/helpers/fileSize'
import { localizedPagePath } from '@/helpers/pagePaths'
import { isApplePlatform } from '@/helpers/platform'

/**
 * Initial state from whoever opened this overlay (`siteStore.openOverlay('FileManager', opts)`),
 * forwarded here by `MainOverlayDialog.vue`. Read via `props`, not `siteStore.overlayOpts` directly
 * -- the store field is the transport, the prop is the contract.
 */
const props = defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

const dark = useDark()
const screen = useScreen()

const pageStore = usePageStore()
const siteStore = useSiteStore()

const router = useRouter()

const { t } = useI18n()

/**
 * Remembered in the browser rather than on the account, deliberately: how densely a list should be
 * drawn is a property of the screen it is being read on, and the same person on a laptop and on a
 * large monitor will not want the same answer.
 */
const VIEW_OPTIONS_KEY = 'wiki.fileman.viewOptions'

/**
 * Field by field rather than wholesale: the stored entry outlives the code that wrote it, and an
 * option that has since changed shape -- or been hand-edited in devtools -- must not be able to put
 * the file list into a state it has no way back out of.
 */
function storedViewOptions() {
  let stored = null
  try {
    stored = JSON.parse(globalThis.localStorage?.getItem(VIEW_OPTIONS_KEY) ?? 'null')
  } catch {
    // -> Unreadable is the same as absent
  }
  if (!stored || typeof stored !== 'object') {
    return {}
  }
  return {
    ...(['title', 'path'].includes(stored.displayMode) ? { displayMode: stored.displayMode } : {}),
    ...(typeof stored.isCompact === 'boolean' ? { isCompact: stored.isCompact } : {}),
    ...(typeof stored.shouldShowFolders === 'boolean'
      ? { shouldShowFolders: stored.shouldShowFolders }
      : {})
  }
}

const state = reactive({
  loading: 0,
  isFetching: false,
  search: '',
  searchIsFocused: false,
  currentFolderId: null,
  currentFileId: null,
  /** The CONTENT locale being browsed -- not `commonStore.locale`, which is the UI language. */
  locale: null,
  /**
   * Only consulted while the tree overlays the list. Deliberately NOT one of the remembered view
   * options: those describe how a list is drawn, and this is a panel that is open at the moment.
   */
  treeOpen: false,
  treeNodes: {},
  treeRoots: [],
  displayMode: 'title',
  isCompact: true,
  shouldShowFolders: true,
  isUploading: false,
  shouldCancelUpload: false,
  uploadPercentage: 0,
  fileList: [],
  fileListLoading: false,
  /** Maintained by `composables/fileUpload.js` (see its `dragDepth`), not here. */
  isDraggingOver: false
})

Object.assign(state, storedViewOptions())

/*
  Written on every change rather than when the overlay closes: the file manager is also opened from
  the editor's insert flow, which can be dismissed in ways that never reach a teardown here.
*/
watch(
  () => [state.displayMode, state.isCompact, state.shouldShowFolders],
  ([displayMode, isCompact, shouldShowFolders]) => {
    try {
      globalThis.localStorage?.setItem(
        VIEW_OPTIONS_KEY,
        JSON.stringify({ displayMode, isCompact, shouldShowFolders })
      )
    } catch {
      // -> Full, or storage denied: the options still work, they just will not persist
    }
  }
)

const fileIpt = ref(null)
const searchField = ref(null)
const treeComp = ref(null)

/*
  `loadTree` and `close` are function declarations below, so they are already hoisted by the time
  these composables run over this component's own `state`.
*/
const {
  uploadFile,
  uploadNewFiles,
  uploadFiles,
  uploadCancel,
  handleDragEnter,
  handleDragOver,
  handleDragLeave,
  handleDrop
} = useFileUpload({
  state,
  fileIpt,
  reloadCurrentFolder: () => loadTree({ parentId: state.currentFolderId })
})

const {
  newFolder,
  renameFolder,
  delFolder,
  reloadFolder,
  rerenderPage,
  duplicatePage,
  duplicateFolder,
  renameMovePage,
  delPage,
  renameAsset,
  moveAsset,
  previewAsset,
  delAsset
} = useFileManagerActions({ state, treeComp, loadTree, close })

const insertMode = computed(() => props.overlayOpts?.insertMode ?? false)

/**
 * Resolved exactly as `HeaderSearch` resolves its own -- the two answer the same key and must name
 * it the same way. A `computed()` rather than a `const` because `t()`'s result is what is reactive,
 * and this component can set up before `boot/i18n.js` has loaded the catalog.
 */
const searchShortcutHint = computed(() =>
  isApplePlatform() ? t('common.header.searchShortcutMac') : t('common.header.searchShortcutOther')
)

/**
 * 1024 is `WDrawer`'s own default `overlayBelow`, which is what actually decides how the drawer
 * draws itself — this asks the same question from the outside, so the toolbar knows whether to
 * offer a way in. The two have to agree.
 */
const isAtLeastMd = useMinWidth(1024)
const isTreeOverlay = computed(() => !isAtLeastMd.value)

/**
 * The details pane has no overlay form, so below `lg` there is simply no room for it -- which is
 * why the Insert button it holds needs a second home; see the toolbar.
 */
const detailsPaneShown = computed(() => screen.gte.lg)

/** The setter is what the drawer's scrim reaches when it is tapped. */
const treeDrawerOpen = computed({
  get: () => !isTreeOverlay.value || state.treeOpen,
  set: (val) => {
    state.treeOpen = val
  }
})

const folderPath = computed(() => {
  if (!state.currentFolderId) {
    return '/'
  } else {
    const folderNode = state.treeNodes[state.currentFolderId] ?? {}
    return folderNode.folderPath
      ? `/${folderNode.folderPath}/${folderNode.fileName}/`
      : `/${folderNode.fileName}/`
  }
})

const usePathTitle = computed(() => state.displayMode === 'path')

const filteredFiles = computed(() => {
  if (state.search) {
    const fuse = new Fuse(state.fileList, {
      keys: ['title', 'fileName']
    })
    return fuse.search(state.search).map((n) => n.item)
  } else {
    return state.fileList
  }
})

const files = computed(() => {
  return filteredFiles.value
    .filter((f) => {
      if (f.type === 'folder' && !state.shouldShowFolders) {
        return false
      }
      return true
    })
    .map((f) => {
      switch (f.type) {
        case 'folder': {
          f.icon = fileTypes.folder.icon
          f.caption = t('fileman.folderChildrenCount', { count: f.children }, f.children)
          break
        }
        case 'page': {
          f.icon = f.pageType === 'redirect' ? fileTypes.redirect.icon : fileTypes.page.icon
          f.caption = t(`fileman.${f.pageType}PageType`)
          break
        }
        case 'asset': {
          f.icon = fileTypes[f.fileExt]?.icon ?? 'tabler:file'
          f.side = formatFileSize(f.fileSize)
          if (fileTypes[f.fileExt]) {
            f.caption = t(`fileman.${f.fileExt}FileType`)
          } else {
            f.caption = t('fileman.unknownFileType', { type: f.fileExt.toUpperCase() })
          }
          break
        }
      }
      return f
    })
})

const currentFileDetails = computed(() => {
  if (!state.currentFileId) {
    return null
  }
  const item = state.fileList.find((f) => f.id === state.currentFileId)
  if (!item || item.type === 'folder') {
    return null
  }

  const items = [
    {
      label: t('fileman.detailsTitle'),
      value: item.title
    }
  ]
  let thumbnail = null
  switch (item.type) {
    case 'page': {
      thumbnail = '/_assets/illustrations/fileman-page.svg'
      items.push({
        label: t('fileman.detailsPageType'),
        value: t(`fileman.${item.pageType}PageType`)
      })
      items.push({
        label: t('fileman.detailsPageEditor'),
        value: item.pageType
      })
      items.push({
        label: t('fileman.detailsPageUpdated'),
        value: humanizeDate(t, item.updatedAt)
      })
      items.push({
        label: t('fileman.detailsPageCreated'),
        value: humanizeDate(t, item.createdAt)
      })
      break
    }
    case 'asset': {
      // -> `/_thumb/` answers 404 for anything that is not an image
      thumbnail = item.mimeType?.startsWith('image/') ? `/_thumb/${item.id}.webp` : null
      items.push({
        label: t('fileman.detailsAssetType'),
        value: fileTypes[item.fileExt]
          ? t(`fileman.${item.fileExt}FileType`)
          : t('fileman.unknownFileType', { type: item.fileExt.toUpperCase() })
      })
      items.push({
        label: t('fileman.detailsAssetSize'),
        value: formatFileSize(item.fileSize)
      })
      break
    }
  }
  return {
    thumbnail,
    items
  }
})

watch(
  () => state.currentFolderId,
  async (newValue) => {
    // -> Picking a folder is what the tree is open FOR, so the panel closes behind the choice
    state.treeOpen = false
    await loadTree({ parentId: newValue })
  }
)

function dismissTreeOverlay(ev) {
  if (!isTreeOverlay.value || !state.treeOpen) {
    return
  }
  // -> The toolbar's own button is what opened it; closing here would undo that on the way back up
  if (ev?.target?.closest?.('.fileman-toolbar')) {
    return
  }
  state.treeOpen = false
}

/**
 * Setting `currentFolderId` is the whole of it -- the same watcher a tree click goes through
 * reloads the list and closes the tree panel, so going up and clicking up arrive at the same place.
 */
function goUp() {
  if (!state.currentFolderId) {
    return
  }
  state.currentFolderId = parentFolderIdOf(state.treeNodes, state.currentFolderId)
}

function close() {
  siteStore.overlay = null
}

function insertItem(item) {
  if (!item) {
    item = state.fileList.find((f) => f.id === state.currentFileId)
  }
  EVENT_BUS.emit('insertAsset', toRaw(item))
  close()
}

async function treeLazyLoad(nodeId, isCurrent, { done, fail }) {
  await loadTree({ parentId: nodeId, types: isCurrent ? null : ['folder'] })
  done()
}

async function loadTree({ parentId = null, parentPath = null, types, initLoad = false }) {
  if (state.isFetching) {
    return
  }
  state.isFetching = true
  if (!parentId) {
    parentId = null
  }
  if (parentId === state.currentFolderId) {
    state.fileListLoading = true
    state.currentFileId = null
    state.fileList = []
  }
  try {
    const items = await fetchTreeEntries(siteStore.id, {
      parentId,
      parentPath,
      types,
      locale: state.locale,
      initLoad
    })
    if (items?.length > 0) {
      const { roots: newTreeRoots } = mergeFolderEntries(state.treeNodes, items, parentId)
      for (const item of items) {
        switch (item.type) {
          case 'folder': {
            if (parentId === state.currentFolderId && !item.isAncestor) {
              state.fileList.push({
                id: item.id,
                type: 'folder',
                title: item.title,
                fileName: item.fileName,
                children: item.childrenCount || 0
              })
            }
            break
          }
          case 'asset': {
            if (parentId === state.currentFolderId) {
              state.fileList.push({
                id: item.id,
                type: 'asset',
                title: item.title,
                fileExt: item.fileExt,
                fileSize: item.fileSize,
                mimeType: item.mimeType,
                folderPath: item.folderPath,
                fileName: item.fileName,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt
              })
            }
            break
          }
          case 'page': {
            if (parentId === state.currentFolderId) {
              state.fileList.push({
                id: item.id,
                type: 'page',
                title: item.title,
                pageType: item.editor || 'markdown',
                folderPath: item.folderPath,
                fileName: item.fileName,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt
              })
            }
            break
          }
        }
      }
      if (newTreeRoots.length > 0) {
        state.treeRoots = newTreeRoots
      }
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: t('fileman.folderTreeLoadFailed'),
      caption: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
  if (parentId === state.currentFolderId) {
    nextTick(() => {
      state.fileListLoading = false
    })
  }
  if (parentId) {
    treeComp.value.setLoaded(parentId)
  }
  state.isFetching = false
}

/**
 * A folder id (or a selected file) from one locale means nothing in another, so every bit of the
 * previous locale's tree state is cleared rather than re-resolved against the new one.
 */
async function selectLocale(code) {
  if (code === state.locale) {
    return
  }
  state.locale = code
  state.currentFolderId = null
  state.currentFileId = null
  state.treeNodes = {}
  state.treeRoots = []
  state.fileList = []
  treeComp.value?.resetLoaded()
  await loadTree({ initLoad: true })
}

function treeContextAction(nodeId, action) {
  switch (action) {
    case 'newFolder': {
      newFolder(nodeId)
      break
    }
    case 'rename': {
      renameFolder(nodeId)
      break
    }
    case 'del': {
      delFolder(nodeId)
      break
    }
  }
}

function selectItem(item) {
  if (item.type === 'folder') {
    state.currentFolderId = item.id
    treeComp.value.setOpened(item.id)
  } else {
    state.currentFileId = item.id
  }
}

function doubleClickItem(item) {
  if (insertMode.value) {
    insertItem(item)
  } else {
    openItem(item)
  }
}

function openItem(item) {
  switch (item.type) {
    case 'folder': {
      return
    }
    case 'page': {
      const pagePath = item.folderPath ? `${item.folderPath}/${item.fileName}` : item.fileName
      router.push(localizedPagePath(pagePath, state.locale, siteStore.localeRouting))
      close()
      break
    }
    case 'asset': {
      if (item.mimeType?.startsWith('image/')) {
        previewAsset(item)
        break
      }
      window.open(assetUrl(item.folderPath, item.fileName), '_blank')
      close()
      break
    }
  }
}

async function copyItemURL(item) {
  try {
    switch (item.type) {
      case 'page': {
        const pagePath = item.folderPath ? `${item.folderPath}/${item.fileName}` : item.fileName
        await navigator.clipboard.writeText(
          `${window.location.origin}${localizedPagePath(pagePath, state.locale, siteStore.localeRouting)}`
        )
        break
      }
      case 'asset': {
        // -> `/_files/`, where a file is actually served from: the page tree it is listed
        //    alongside in here is not a place a browser can fetch it from
        await navigator.clipboard.writeText(
          `${window.location.origin}${assetUrl(item.folderPath, item.fileName)}`
        )
        break
      }
      default: {
        throw new Error('ERR_INVALID_ITEM_TYPE')
      }
    }
    notify({
      type: 'positive',
      message: t('fileman.copyURLSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('fileman.copyURLFailed'),
      caption: apiErrorMessage(err)
    })
  }
}

async function editItem(item) {
  router.push({
    path: item.folderPath
      ? `/_edit/${item.folderPath}/${item.fileName}`
      : `/_edit/${item.fileName}`,
    query: siteStore.useLocales ? { locale: state.locale } : undefined
  })
  close()
}

async function downloadItem(item) {
  try {
    // -> Fetched rather than linked to: the content route lives behind the API client
    const blob = await API_CLIENT.get(`sites/${siteStore.id}/assets/${item.id}/content`).blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = item.fileName
    link.click()
    URL.revokeObjectURL(url)
  } catch (err) {
    notify({
      type: 'negative',
      message: t('fileman.downloadFailed'),
      caption: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
}

function renameItem(item) {
  switch (item.type) {
    case 'folder': {
      renameFolder(item.id)
      break
    }
    case 'page': {
      renameMovePage(item)
      break
    }
    case 'asset': {
      renameAsset(item.id)
      break
    }
  }
}

function moveItem(item) {
  switch (item.type) {
    case 'asset': {
      moveAsset(item)
      break
    }
  }
}

/** Only a page can be duplicated: there is no endpoint behind a folder or an asset. */
function duplicateItem(item) {
  switch (item.type) {
    case 'folder': {
      duplicateFolder(item)
      break
    }
    case 'page': {
      duplicatePage(item)
      break
    }
  }
}

function delItem(item) {
  switch (item.type) {
    case 'asset': {
      delAsset(item.id, item.title)
      break
    }
    case 'folder': {
      delFolder(item.id, true)
      break
    }
    case 'page': {
      const path = item.folderPath ? `${item.folderPath}/${item.fileName}` : item.fileName
      delPage(item.id, item.title, path)
      break
    }
  }
}

/**
 * `HeaderSearch` owns the same shortcut and steps aside for an overlay, so the two never both
 * answer it. Bound and unbound with the component, whose lifetime is the window in which this one
 * should win.
 */
function handleKeyPress(ev) {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'k') {
    ev.preventDefault()
    searchField.value?.focus()
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeyPress)

  // -> `pageStore.locale` is always a real code, so there is no fallback case to cover here
  state.locale = pageStore.locale

  const pathParts = pageStore.path.split('/')
  const parentPath = pathParts.slice(0, -1).join('/')

  await loadTree({
    parentPath,
    initLoad: true
  })

  const folderFolderPath = pathParts.slice(0, -2).join('/')
  const folderFileName = pathParts.at(-2)

  for (const [id, node] of Object.entries(state.treeNodes)) {
    if (
      parentPath.startsWith(node.folderPath ? `${node.folderPath}/${node.fileName}` : node.fileName)
    ) {
      treeComp.value.setOpened(id)
    }
  }

  const currentNode = Object.entries(state.treeNodes).find(
    ([, n]) => n.folderPath === folderFolderPath && n.fileName === folderFileName
  )
  if (currentNode) {
    state.currentFolderId = currentNode[0]
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeyPress)
})
</script>

<style>
/*
  Selectors are flat, not nested: a `&-suffix` selector is Sass string concatenation, and native CSS
  nesting silently drops such a rule rather than matching it.
*/
.fileman {
  /*
    Below 900px the header's three `w-full` toolbars would take a line each. The title and the
    actions give up `w-full` to share line one; the search toolbar keeps it and is ordered last, so
    it lands on line two. Close is what this is for: off the end of an unwrapped row it is
    unreachable, and it is the only way out of the overlay.
  */
}
@media (max-width: 899.98px) {
  .fileman > .card-header {
    flex-wrap: wrap;
  }
  .fileman-hdr-title {
    width: auto;
    flex: 1 1 auto;
    /* -> Otherwise the title wraps to two lines rather than letting the row grow */
    white-space: nowrap;
  }
  .fileman-hdr-actions {
    width: auto;
    flex: 0 0 auto;
  }
  .fileman-hdr-search {
    order: 1;
  }
}
.fileman {
  /* The variable, not a `text-accent-dark` utility: nothing in this repo emits that class. */
}
.fileman-hdr-icon {
  color: var(--color-accent-dark);
}
.fileman {
  /*
    The locale chip matches the 34px search field beside it rather than `WBtn`'s own 32px band. The
    height needs `!important` because `WBtn` sets `min-h-*` inline, which wins on any specificity.
  */
}
.fileman-locale {
  height: 34px;
  min-height: 34px !important;
  border: 1px solid rgba(255, 255, 255, 0.25);
}
.fileman-locale-caret {
  font-size: 12px;
  opacity: 0.6;
}
.fileman {
  /*
    The search field follows `.header-search-field` in `HeaderSearch`, restated here rather than
    borrowing that component's class so a change to the site header cannot silently restyle this
    overlay. The two have since parted company on fill and on focus behaviour.
  */
}
.fileman-search {
  display: flex;
  /* -> Bounded: unbounded, the field ate every pixel the header's spacer did not */
  flex: 1 1 auto;
  min-width: 180px;
  max-width: 420px;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 8px 0 11px;
  /*
    A white box on the dialog's dark title band, mirroring what `HeaderSearch` does on the light
    one: a search field presents the surface it is typed on, whichever ground it sits against.
  */
  background-color: var(--color-surface);
  color: var(--color-text-caption);
  transition: color 0.2s var(--ease-standard);
  /* -> Driven by a class rather than `:focus-within`, matching HeaderSearch */
}
.fileman-search.is-focused {
  color: var(--color-ink);
}
.fileman-search-lead {
  flex-shrink: 0;
  font-size: 16px;
  color: var(--color-slate-faint);
}
.fileman-search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  outline: none;
}
.fileman-search-input::placeholder {
  color: currentColor;
  opacity: 0.55;
}
.fileman-search-clear {
  flex-shrink: 0;
  display: inline-flex;
  padding: 4px;
  border-radius: 9999px;
  border: 0;
  background: none;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
}
.fileman-search-clear:hover {
  opacity: 1;
}
.fileman-search {
  /* The key cap is restated from `.header-search-kbd` for the same reason the field itself is. */
}
.fileman-search-kbd {
  flex-shrink: 0;
  padding: 2px 5px;
  background-color: var(--color-surface);
  border: 1px solid var(--color-hairline);
  color: var(--color-text-caption);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
.fileman {
  /*
    Each pane states its own ink alongside its fill: there is no global `body--dark { color }` rule
    and these panes are not `w-card`s, so anything that merely inherits comes out black on the dark
    fill.
  */
}
.body--light .fileman-left {
  background-color: var(--color-tint-alt);
  border-inline-end: 1px solid var(--color-hairline);
  color: var(--color-slate);
}
.body--dark .fileman-left {
  background-color: var(--color-dark-4);
  border-inline-end: 1px solid var(--color-hairline-dark);
  color: var(--color-text-secondary-dark);
}
.body--light .fileman-center {
  background-color: var(--color-surface);
  color: var(--color-text-body);
}
.body--dark .fileman-center {
  background-color: var(--color-dark-3);
  color: var(--color-text-dark);
}
.fileman-right {
  /*
    `#fbfcfe` stays a literal rather than `--color-surface`: the design draws this pane a hair off
    pure white in Ledger but pure white under Cobalt, and no token distinguishes "surface" from
    "surface, a shade warmer".
  */
}
.body--light .fileman-right {
  background-color: #fbfcfe;
  border-inline-start: 1px solid var(--color-hairline);
  color: var(--color-text-body);
}
.body--dark .fileman-right {
  background-color: var(--color-dark-4);
  border-inline-start: 1px solid var(--color-hairline-dark);
  color: var(--color-text-dark);
}
.fileman {
  /*
    The action bar takes the page tint rather than the list's own white, pairing with the path bar
    along the bottom, so the pane reads as a sheet of paper with a strip of chrome at each end.
  */
}
.body--light .fileman-toolbar {
  background-color: var(--color-tint);
  border-block-end: 1px solid var(--color-hairline);
}
.body--dark .fileman-toolbar {
  background-color: var(--color-dark-4);
  border-block-end: 1px solid var(--color-hairline-dark);
}
.fileman {
  /*
    `WBtn`'s `outline` draws every outlined edge in the hairline tone on purpose, and Upload is the
    one control the design overrides that for -- so the override lives here rather than as a prop on
    the shared component.
  */
}
.fileman-upload-btn {
  /* -> The fill tone: a hairline, not a label, so its "never under white text" bar does not apply */
  border-color: var(--color-positive-fill);
}
.fileman-path {
  font-family: var(--font-mono);
  font-size: 11.5px;
}
.body--light .fileman-path {
  background-color: var(--color-tint) !important;
  border-block-start: 1px solid var(--color-hairline);
  color: var(--color-text-caption);
}
.body--dark .fileman-path {
  background-color: var(--color-dark-4) !important;
  border-block-start: 1px solid var(--color-hairline-dark);
  color: var(--color-text-caption-dark);
}
.fileman-main {
  height: 100%;
}
.fileman-loadinglist {
  padding: 16px;
  font-style: italic;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
}
.fileman-loadinglist > span {
  margin-top: 16px;
}
.fileman-emptylist {
  padding: 16px;
  font-style: italic;
  font-size: 1.5em;
  font-weight: 300;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
}
.fileman-emptylist > img {
  opacity: 0.25;
  width: 200px;
}
.body--light .fileman-emptylist {
  color: var(--color-text-caption);
}
.body--dark .fileman-emptylist {
  color: var(--color-text-caption-dark);
}
.body--dark .fileman-emptylist > img {
  filter: invert(1);
}
.fileman-droptarget {
  position: relative;
  height: 100%;
}
.fileman {
  /* `pointer-events: none` on the drop overlay is load-bearing -- see the template comment. */
}
.fileman-dropoverlay {
  position: absolute;
  inset: 8px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  border: 2px dashed var(--color-accent);
  pointer-events: none;
  font-size: 1.1rem;
  font-weight: 500;
  text-align: center;
}
.body--light .fileman-dropoverlay {
  background-color: rgba(255, 255, 255, 0.9);
  color: var(--color-text-body);
}
.body--dark .fileman-dropoverlay {
  background-color: rgba(20, 23, 31, 0.85);
  color: var(--color-text-dark);
}
.fileman {
  /*
    CSS Grid, not flex: the size column (`v-if="item.side"`, absent on a folder or a page) has no
    width of its own, so under flex the label's `flex: 1 1 0%` absorbed the space it would have
    used and pushed the fixed-width type column further right than on a row that DOES have a size.
    An explicit `grid-template-columns` reserves every track whether or not a row populates it.
  */
}
.fileman-filelist {
  padding: 0;
  /*
    The selected row is an accent wash plus an inset bar, not a solid fill: a fill is what a BUTTON
    gets, and it would force the name, the type and the size each to be restated in white. The wash
    rather than `--color-tint`, which is the toolbar's own colour, so a selection would read as a
    second strip of chrome. The bar is an inset SHADOW rather than a border, which would have to be
    reserved as transparent on every unselected row.
  */
}
.fileman-filelist > .w-item {
  display: grid;
  /*
    The 56px icon track holds the `xl` (46px) icon plus the 6px `padding-inline-end` below, and
    matches `WItemSection`'s own default avatar reservation.
  */
  grid-template-columns: 56px minmax(0, 1fr) 110px 90px;
  padding: 11px 16px;
  min-height: 69px;
  /*
    Opts out of `WItem.vue`'s container-query row stacking
    (`.w-item:has(.w-item-section--main + .w-item-section--main)`): unopposed, its margins would
    land on this row's TYPE column, also a "main" section, whenever the pane narrows under 600px --
    which it does routinely once the details or tree panel sits beside it. `!important` rather than
    out-specificing a scoped `:has()` selector that would then have to be kept in step by hand.
  */
  container-type: normal !important;
}
.fileman-filelist > .w-item:not(:last-child) {
  border-block-end: 1px solid var(--color-tint);
}
.fileman-filelist > .w-item.active {
  box-shadow: inset 3px 0 0 var(--color-accent-fill);
  background-color: var(--color-accent-wash);
  color: var(--color-ink);
}
.body--dark .fileman-filelist > .w-item.active {
  background-color: var(--color-accent-wash-dark);
  color: var(--color-text-dark);
}
.body--dark .fileman-filelist > .w-item:not(:last-child) {
  border-block-end-color: var(--color-hairline-dark);
}
.fileman-filelist > .w-item {
  /*
    `WItemSection.vue`'s `.w-item-section--avatar` reserves a 56px `min-width` too, which under
    Grid overflows `.is-compact`'s narrower track instead of being ignored the way it was on a
    shrinking flex item. Nested under `.w-item` to beat that scoped rule's specificity outright
    rather than tie with it.
  */
}
.fileman-filelist > .w-item .fileman-filelist-icon {
  padding-inline-end: 6px;
  min-width: 0;
}
.fileman-filelist {
  /*
    The icon shrinks with the compact row from the template's own `:size` binding: CSS here can
    only size the row and its grid track, not the glyph inside it.
  */
}
.fileman-filelist.is-compact > .w-item {
  grid-template-columns: 40px minmax(0, 1fr) 110px 90px;
  padding: 4px 16px;
  min-height: 40px;
}
.fileman-filelist {
  /* -> The name, at the design's own row type scale */
}
.fileman-filelist-label .w-item-label {
  font-size: 14.5px;
  font-weight: 500;
}
.fileman-filelist {
  /*
    The filetype column takes its width from the row's grid template, not from here, and truncates
    rather than wraps: a caption on a second line would blow out the row's fixed height.
  */
}
.fileman-filelist-type {
  font-size: 12px;
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.body--light .fileman-filelist-type {
  color: var(--color-text-caption);
}
.body--dark .fileman-filelist-type {
  color: var(--color-text-caption-dark);
}
.fileman-filelist {
  /* -> A measurement, in the mono face, as every other measurement on this screen is */
}
.fileman-filelist-side {
  font-family: var(--font-mono);
  font-size: 11.5px;
}
.body--light .fileman-filelist-side {
  color: var(--color-text-secondary);
}
.body--dark .fileman-filelist-side {
  color: var(--color-text-secondary-dark);
}
.fileman {
  /* The preview plate is always drawn, even with nothing to preview -- see the template note. */
}
.fileman-thumb {
  position: relative;
  aspect-ratio: 16/10;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-block-end: 16px;
}
.body--light .fileman-thumb {
  background-color: var(--color-tint);
  border: 1px solid var(--color-hairline);
}
.body--dark .fileman-thumb {
  background-color: var(--color-dark-3);
  border: 1px solid var(--color-hairline-dark);
}
.fileman-thumb {
  /* -> The image fills the plate, so the frame's aspect ratio is the one drawn */
}
.fileman-thumb > img {
  display: block;
  height: 100%;
  object-fit: cover;
}
.fileman-thumb-placeholder {
  color: var(--color-slate-pale);
}
.fileman-thumb {
  /*
    Two edges of a 7px square each, 4px outside the frame, so they read as registration ticks
    rather than as a second border. Logical insets keep each tick's drawn edges on the corner it is
    named for under RTL. `display: var(--corner-marks)` resolves to `none` under Cobalt, which
    draws no corner marks anywhere.
  */
}
.fileman-thumb-tick {
  position: absolute;
  display: var(--corner-marks);
  width: 7px;
  height: 7px;
  border: 0 solid var(--color-slate-soft);
  pointer-events: none;
}
.body--dark .fileman-thumb-tick {
  border-color: var(--color-slate-light);
}
.fileman-thumb-tick--tl {
  top: -4px;
  inset-inline-start: -4px;
  border-block-start-width: 1px;
  border-inline-start-width: 1px;
}
.fileman-thumb-tick--tr {
  top: -4px;
  inset-inline-end: -4px;
  border-block-start-width: 1px;
  border-inline-end-width: 1px;
}
.fileman-thumb-tick--bl {
  bottom: -4px;
  inset-inline-start: -4px;
  border-block-end-width: 1px;
  border-inline-start-width: 1px;
}
.fileman-thumb-tick--br {
  bottom: -4px;
  inset-inline-end: -4px;
  border-block-end-width: 1px;
  border-inline-end-width: 1px;
}
.fileman {
  /*
    A detail row is a labelled value beside its gutter, not a stack: stacked, each value read as
    the start of its own paragraph and cost twice the vertical room, which is how a four-row pane
    came to need scrolling.
  */
}
.fileman-details-row {
  display: flex;
  gap: 10px;
  padding: 7px 0;
}
.body--light .fileman-details-row {
  border-block-end: 1px solid var(--color-tint);
}
.body--dark .fileman-details-row {
  border-block-end: 1px solid var(--color-hairline-dark);
}
.fileman-details-row label {
  flex: 0 0 92px;
  padding-block-start: 2px;
  font-size: 0.6rem;
  font-weight: 600;
  font-family: var(--font-mono);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.body--light .fileman-details-row label {
  color: var(--color-text-caption);
}
.body--dark .fileman-details-row label {
  color: var(--color-text-caption-dark);
}
.fileman-details-row span {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  /* -> A long file name has nowhere to break: the gutter beside it is fixed */
  word-break: break-word;
}
.body--light .fileman-details-row span {
  color: var(--color-ink);
}
.body--dark .fileman-details-row span {
  color: var(--color-text-dark);
}
.fileman {
  /* Registration ticks on two corners only: the motif's abbreviated form for a control. */
}
.fileman-insert-btn::before,
.fileman-insert-btn::after {
  content: '';
  position: absolute;
  width: 5px;
  height: 5px;
  border: 0 solid var(--color-accent);
  pointer-events: none;
}
.fileman-insert-btn::before {
  top: -3px;
  inset-inline-start: -3px;
  border-block-start-width: 1px;
  border-inline-start-width: 1px;
}
.fileman-insert-btn::after {
  bottom: -3px;
  inset-inline-end: -3px;
  border-block-end-width: 1px;
  border-inline-end-width: 1px;
}
.fileman-progressbar {
  width: 100%;
  flex: 1;
  height: 12px;
}
.body--light .fileman-progressbar {
  background-color: var(--color-blue-grey-2);
}
.body--dark .fileman-progressbar {
  background-color: var(--color-dark-4) !important;
}
.fileman-progressbar > div {
  height: 12px;
  background-color: var(--color-positive);
  background-image: linear-gradient(
    -45deg,
    rgba(255, 255, 255, 0.3) 25%,
    transparent 25%,
    transparent 50%,
    rgba(255, 255, 255, 0.3) 50%,
    rgba(255, 255, 255, 0.3) 75%,
    transparent 75%,
    transparent
  );
  background-size: 50px 50px;
  background-position: 0 0;
  animation: fileman-progress 2s linear infinite;
  box-shadow: 0 0 5px 0 var(--color-positive);
  font-size: 9px;
  letter-spacing: 2px;
  font-weight: 700;
  color: #fff;
  display: flex;
  justify-content: center;
  align-items: center;
  overflow: hidden;
  transition: all 1s ease;
}

@keyframes fileman-progress {
  0% {
    background-position: 0 0;
  }
  100% {
    background-position: -50px -50px;
  }
}
</style>
