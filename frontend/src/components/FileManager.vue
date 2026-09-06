<template>
  <w-layout class="fileman" container>
    <!--
      Three toolbars in one flex row, which below ~700px is more than fits: the row overflowed and took the
      last of them -- the one holding Close -- off the side of the screen, so on a phone the overlay could
      be opened and not shut. They wrap onto two lines instead below 900px; see the stylesheet, which is
      also why each of the three carries a name.
    -->
    <w-header class="card-header">
      <w-toolbar class="fileman-hdr-title">
        <!--
          -> The band's glyph takes the accent lightened for a dark ground, not the white the title
             is set in: `ui-redesign/Cardinal Wiki - File Manager 3x.dc.html` strokes it `#f08287`,
             which is `--color-accent-dark`, and nine other 3x design files draw their own overlay
             header the same way. Stated here rather than in `.card-header` (`css/_base.scss`)
             because that band is shared with every other dialog in the app.

          -> A class rather than `WIcon`'s `color` prop: that prop resolves to a `text-<name>` CLASS,
             and `text-accent-dark` appears as literal text nowhere in this repo for Tailwind's
             scanner to find (`css/tailwind.css`'s own note by `@theme static` describes exactly this
             hazard). The stylesheet below reads the variable instead, which `static` guarantees is
             emitted.
        -->
        <w-icon class="fileman-hdr-icon" name="tabler:folder" left size="md" />
        <span>{{ t(`fileman.title`) }}</span>
      </w-toolbar>
      <w-toolbar class="fileman-hdr-search">
        <!--
          -> The CONTENT locale being browsed, not the UI language -- `commonStore.locale` /
             `<locale-selector-menu/>` switch that, and mounting it here read as "which locale's
             files am I seeing" without doing anything of the sort. Gated on `siteStore.useLocales`
             (more than one active locale) rather than `locales.showMenu`: that flag is about
             whether a READER is offered a switcher, which has no bearing on whether an author
             browsing the tree needs to pick which locale's files to see.

          Menu idiom follows this same file's "view options" button just below: a `w-menu` of
          `w-item`s with a check-circle/circle pair marking the current choice, rather than
          `LocaleSelectorMenu`'s avatar-initials layout -- that one is styled for a reader-facing
          language switcher, this is an in-toolbar filter control like the rest of this row. The
          design agrees and settles it: `Cardinal Wiki - File Manager 3x.dc.html` draws this control
          as a bare outlined chip reading `EN` with a chevron after it -- no avatar, no initials --
          so `helpers/initials.js` existing (WP #2609) does not change the calculus either way.

          -> The chip itself: 34px tall with a `rgba(255,255,255,.25)` edge, matching the search
             field beside it rather than standing a button's height above it. The chevron is what
             says a menu opens from here; without it the code drew a bare two-letter label that read
             as a status, not a control.
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
          The same pill the site header uses, rather than a `w-input`.

          It was a `w-input` carrying `dark`, `standout="bg-white text-dark"` and `debounce`, none of
          which that component has -- they fell through as bare attributes and styled nothing. What
          rendered was the FILLED variant: a 4%-black wash holding white text, on a near-black header,
          with its label stranded above the toolbar. Written out here so it matches HeaderSearch,
          which is what a search field in this app looks like.
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
            The shortcut hint the design draws at this field's trailing edge, and the same key cap
            `HeaderSearch` sets: a mono square on the field's own ground. It is truthful here -- this
            overlay really does claim Cmd/Ctrl+K while it is up (`handleKeyPress` below, and the note
            in `HeaderSearch` explaining why that one stands down for an overlay) -- so the field was
            answering a shortcut it never advertised.

            Gives way once the field is in use, as HeaderSearch's does: past that point the reader is
            already where the key would have taken them, and the clear button needs the room.
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
      <!--
        The same chrome the editing overlays close themselves with -- see `NavEditOverlay`: a flat round
        help button, then the pushed group. One button in the group here, since there is nothing to save;
        `push` goes on the buttons, which is where `WBtn` reads it, not on the group.

        -> No right margin on the last control: the toolbar's own 12px is already close to the 9-10px the
           header leaves above and below.
      -->
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
          <!-- -> `WTooltip` already defaults to below-the-trigger, which is where a header wants it -->
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
      The folder tree. Beside the list where there is room for both, and a panel over it where there is
      not -- which is what `WDrawer` does on its own below 1024px, except that this was bound `:model-value
      ="true"`: one-way, and permanently open. Overlaying, that put 350px of tree across a 390px screen
      with no way to put it away, since the drawer asks to be closed when its scrim is tapped and nothing
      was listening. `treeDrawerOpen` is that listener, and above the breakpoint it answers true always.

      Narrower while it overlays, so there is a comfortable width of scrim left to tap on.

      -> 320px beside the list, which is what the design measures both flanking columns at. The
         overlay width stays 300: the design draws no phone state, and that number is about how much
         scrim is left beside the panel, not about matching the column.
    -->
    <w-drawer class="fileman-left" v-model="treeDrawerOpen" :width="isTreeOverlay ? 300 : 320">
      <w-scroll-area style="height: 100%">
        <!--
          -> No side padding: the tree's rows run the full width of the drawer, so a hovered or
             selected row reads as a band across it rather than a floating pill. `pt-2` is the gap
             above the root entry that the padding used to imply.
        -->
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
              A FRAMED slot, always drawn, not a bare image that appears only when there is one to
              show: the design gives this pane a fixed 16/10 plate at the top with blueprint corner
              marks around it, holding a placeholder glyph when the selected file has no preview.
              Only images have a thumbnail (`/_thumb/:id.webp` 404s for anything else) and pages get
              an illustration, so a PDF or an archive used to open the pane with the detail rows
              jumped to the top and nothing above them -- the pane's whole layout changing with the
              row the reader happened to click.

              -> No `rounded` on the image any more. `--radius-*` is zeroed repo-wide (see the note
                 in `css/tailwind.css`), and the frame around it is square.
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
                -> `primary` (`#c14a52`), not the `#e4676b` the design fills this button with: the
                   fill tone is 2.9:1 under a white label and `helpers/accessibility.test.js` pins it
                   as never carrying one. Same call, for the same reason, as the segmented control in
                   `PageHistoryOverlay.vue`.
              -->
              <w-btn
                class="w-full fileman-insert-btn"
                @click="insertItem()"
                :label="t(`common.actions.insert`)"
                color="primary"
                icon="tabler:plus"
                padding="sm" />
            </template>
          </template>
        </div>
      </w-scroll-area>
    </w-drawer>
    <w-page-container>
      <!--
        Tapping this pane puts the tree panel away, which is the "tap outside to dismiss" the drawer's own
        scrim would normally provide. It cannot here: `WDrawer` teleports that scrim to <body> at z-30, and
        this whole view is inside a dialog which paints above it -- so the scrim is invisible, and a tap
        beside the panel lands on this pane instead. Rather than raise the z-index of a scrim shared with
        the site's nav drawer, the pane takes the tap it is already receiving.

        On the pane rather than on the list inside it, because the list is only as tall as its rows: below
        the last file the tap reaches this element and nothing else. The handler steps aside for the
        toolbar, which holds the button that OPENS the tree.
      -->
      <w-page class="fileman-center column" @click="dismissTreeOverlay">
        <!-- TOOLBAR ----------------------------------------------------- -->
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
              The shared up-one-level plate (`UpOneLevelBtn.vue`), the same control the Browse panel
              and the save dialog carry. Absent at the root, where the folder tree beside the list is
              already showing that there is nothing above this. First in the toolbar, ahead of the way
              INTO the tree, because both answer "where am I" rather than "what can I do here".
            -->
            <up-one-level-btn
              :show="Boolean(state.currentFolderId)"
              tooltip-anchor="bottom middle"
              tooltip-self="top middle"
              @click="goUp" />
            <!--
              What opens the tree while it is a panel: nothing else does, and the tree is how a reader
              gets to another folder. First in the toolbar rather than in the pushed group, because it is
              about where they are rather than about what to do here.
            -->
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
            <!--
              -> The toolbar sits on Cardinal's own 32px band, which is `WBtn`'s regular geometry --
                 `dense` is the 28px compact variant, and the design draws every control in this row
                 at 32px. See `WBtn`'s own "Cardinal geometry" note.
            -->
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
              The two labelled actions are OUTLINED where the icon buttons before them are flat: the
              design rules a separator across the toolbar and puts an edge around everything past it,
              so "what I can do here" reads as a pair of controls rather than as two more glyphs in
              the row. `slate`, not `slate-soft` -- the design sets this label in `#38465f`, and
              `slate-soft` is a hairline/icon tone below the 4.5:1 floor for text (see
              `css/tailwind.css`'s own note beside the two faint slates).
            -->
            <w-btn
              class="me-2"
              outline
              color="slate"
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
              Upload is GREEN, not the accent: the design draws it `#3f7a66` inside a `#5f9c86` edge,
              which is `--color-positive` in `--color-positive-fill`. It used to be the accent on the
              reasoning that this pane's primary action should be the one accent-coloured control in
              it -- but the accent is spoken for on this screen, marking which row is selected, and a
              second accent control competing with that is exactly what the design avoids.

              `WBtn`'s `outline` deliberately draws every outlined edge in the hairline tone ("an
              outlined button's edge is chrome, its label is not"), so the green edge comes from the
              class below rather than from a change to the shared component.
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
              Insert lives in the details pane, which is a 350px column with no overlay form -- so below
              1440px the editor's insert flow could be opened and never completed: the file list offers it
              only through a right-click menu, which is not a gesture a touch screen has. Here it is the
              same call on the same selection, in the one place that is always on screen.
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
            The drop zone for drag-and-drop upload -- scoped to the file-LISTING pane specifically,
            not the toolbar or the tree beside it, so a drag that starts over either of those does
            not compete with what they already do (searching, browsing folders). `dragover` has to be
            prevented too, not just `drop`: the browser's default for an unhandled `dragover` is to
            refuse the drop outright, which suppresses `drop` from firing at all.
          -->
          <div
            class="min-w-0 flex-1 fileman-droptarget"
            @dragenter.prevent="handleDragEnter"
            @dragover.prevent="handleDragOver"
            @dragleave.prevent="handleDragLeave"
            @drop.prevent="handleDrop">
            <!--
              `pointer-events: none` (see the stylesheet) keeps this overlay itself from ever being
              the target of a `dragenter`/`dragleave` -- without it, the overlay appearing under the
              pointer the instant a drag begins would immediately fire a `dragleave` on the pane
              underneath it, and `handleDragEnter`/`handleDragLeave` would have to account for an
              event this element caused by existing.
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
                    <w-icon :name="item.icon" :size="state.isCompact ? `md` : `xl`" />
                  </w-item-section>
                  <w-item-section class="fileman-filelist-label">
                    <w-item-label>{{ usePathTitle ? item.fileName : item.title }}</w-item-label>
                    <w-item-label caption v-if="!state.isCompact">{{ item.caption }}</w-item-label>
                  </w-item-section>
                  <!--
                    -> A file size is a MEASUREMENT, and the design sets every one of those in the
                       mono face -- here, in the details pane beside it, and in the path bar along
                       the bottom. `.text-caption` is the proportional caption scale and was drawing
                       "248 KB" in the same face as the file's own name.
                  -->
                  <w-item-section class="fileman-filelist-side" side v-if="item.side">
                    <div>{{ item.side }}</div>
                  </w-item-section>
                  <!-- RIGHT-CLICK MENU -->
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
                                siteStore.pdfExportAvailable) and throws renderUnsupportedEditor for
                                any page whose editor isn't markdown (backend/models/rendering.ts's
                                ensureCanRender). No button that just fails, per OpenProject #864. -->
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
                        <w-item clickable v-if="item.type === `page`" @click="duplicateItem(item)">
                          <w-item-section side>
                            <w-icon name="tabler:copy" color="slate-soft" />
                          </w-item-section>
                          <w-item-section>{{ t('fileman.duplicateItem') }}</w-item-section>
                        </w-item>
                        <!--
                          One entry for a page: its name and its place are picked in the same dialog
                          the page view's own action rail opens, so offering them as two actions
                          would be offering two ways into one form.
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
    <!--
      -> No utility classes on the text: `.fileman-path` already owns the mono face, the 11.5px size
         and the colour for both appearances, and `text-grey-7` was painting a neutral Material grey
         into a language whose every other muted tone is blue-tinted.
    -->
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

// PROPS

/**
 * Initial state from whoever opened this overlay (`siteStore.openOverlay('FileManager', opts)`),
 * forwarded here by `MainOverlayDialog.vue` (OpenProject #2530). Read via `props`, not
 * `siteStore.overlayOpts` directly -- the store field is the transport, the prop is the contract.
 */
const props = defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

// COMPOSABLES

const dark = useDark()
const screen = useScreen()

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()

// ROUTER

const router = useRouter()

// I18N

const { t } = useI18n()

// DATA

/**
 * Where the view options are remembered. The browser rather than the account, deliberately: how
 * densely a list should be drawn is a property of the screen it is being read on, and the same person
 * on a laptop and on a large monitor will not want the same answer.
 */
const VIEW_OPTIONS_KEY = 'wiki.fileman.viewOptions'

/**
 * The remembered view options, each taken only if it is still a value this component understands.
 *
 * Field by field rather than wholesale: the entry outlives the code that wrote it, and an option that
 * has since changed shape -- or been hand-edited in devtools -- must not be able to put the file list
 * into a state it has no way back out of.
 */
function storedViewOptions() {
  let stored = null
  try {
    stored = JSON.parse(globalThis.localStorage?.getItem(VIEW_OPTIONS_KEY) ?? 'null')
  } catch {
    // -> Unreadable is the same as absent: the defaults below stand
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
  /** Drives the search pill's inversion, as HeaderSearch does it. */
  searchIsFocused: false,
  currentFolderId: null,
  currentFileId: null,
  /**
   * The content locale currently being browsed -- distinct from `commonStore.locale` (the UI
   * language). Initialized in `onMounted` to `pageStore.locale` and changed only by `selectLocale`.
   */
  locale: null,
  /**
   * Whether the folder tree has been opened. Only consulted while it overlays the list — beside it, it
   * is simply there. Deliberately NOT one of the remembered view options: those describe how a list is
   * drawn, and this is a panel that is open at the moment.
   */
  treeOpen: false,
  treeNodes: {},
  treeRoots: [],
  displayMode: 'title',
  isCompact: false,
  shouldShowFolders: true,
  isUploading: false,
  shouldCancelUpload: false,
  uploadPercentage: 0,
  fileList: [],
  fileListLoading: false,
  /** Whether a file drag from outside the browser is currently over the drop zone. See `dragDepth` in `composables/fileUpload.js`. */
  isDraggingOver: false
})

// -> Over the defaults just above, which is what the view falls back to on a first visit
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
      // -> Full, or storage denied. Not worth a word to the reader: the options still work, they
      //    just will not be there next time.
    }
  }
)

// REFS

const fileIpt = ref(null)
const searchField = ref(null)
const treeComp = ref(null)

// COMPOSABLES OVER THIS COMPONENT'S OWN STATE

/*
  The upload on-ramps and the item actions, both lifted out whole
  (`composables/fileUpload.js`, `composables/fileManagerActions.js`). Both still work on this
  component's `state` and its listing -- `loadTree` and `close` are function declarations below, so
  they are already hoisted by the time these run.
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
  renameMovePage,
  delPage,
  renameAsset,
  delAsset
} = useFileManagerActions({ state, treeComp, loadTree, close })

// COMPUTED

const insertMode = computed(() => props.overlayOpts?.insertMode ?? false)

/**
 * The search field's key-cap hint: `⌘K` on macOS/iOS/iPadOS, `Ctrl+K` everywhere else, resolved
 * exactly as `HeaderSearch` resolves its own -- the two answer the same key and must name it the
 * same way. A `computed()` rather than a `const` for the reason spelled out there: `t()`'s result is
 * what is reactive, and this component can set up before `boot/i18n.js` has loaded the catalog.
 */
const searchShortcutHint = computed(() =>
  isApplePlatform() ? t('common.header.searchShortcutMac') : t('common.header.searchShortcutOther')
)

/**
 * Whether the folder tree is a panel over the list rather than a column beside it.
 *
 * 1024 is `WDrawer`'s own default `overlayBelow`, which is what actually decides how the drawer draws
 * itself — this is the same question asked from the outside, so that the toolbar knows whether to offer a
 * way in. The two have to agree.
 */
const isAtLeastMd = useMinWidth(1024)
const isTreeOverlay = computed(() => !isAtLeastMd.value)

/**
 * Whether the details pane is beside the list. It is a 350px column with no overlay form, so below 1440px
 * there is simply no room for it -- which is also why the Insert button it holds needs a second home; see
 * the toolbar.
 */
const detailsPaneShown = computed(() => screen.gte.lg)

/**
 * The tree drawer's open state: always open where it has a column of its own, and the reader's to decide
 * where it overlays. The setter is what the drawer's scrim reaches when it is tapped.
 */
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
      // -> Show Folders Filter
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
          // -> A redirection has a target where a page has content, so it reads as its own kind of row
          f.icon = f.pageType === 'redirect' ? fileTypes.redirect.icon : fileTypes.page.icon
          f.caption = t(`fileman.${f.pageType}PageType`)
          break
        }
        case 'asset': {
          f.icon = fileTypes[f.fileExt]?.icon ?? ''
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
      // -> Only images get one, and the endpoint answers 404 for anything else
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

// WATCHERS

watch(
  () => state.currentFolderId,
  async (newValue) => {
    /*
      Picking a folder is what the tree is open FOR, so it closes behind the choice -- the contents of that
      folder are in the list underneath, which the panel is covering. Only while it overlays; beside the
      list it is a column and there is nothing to close.
    */
    state.treeOpen = false
    await loadTree({ parentId: newValue })
  }
)

// METHODS

/**
 * Put the folder tree away when the list behind it is tapped.
 *
 * A no-op unless the tree is actually overlaying and open, so an ordinary click on a file — which is what
 * this handler mostly receives — costs nothing and behaves as it always did.
 */
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
 * Up one level: select the folder above the one being listed, or the root when that folder is
 * directly under it.
 *
 * Setting `currentFolderId` is the whole of it -- the same watcher a tree click goes through reloads
 * the list and closes the tree panel behind the choice, so going up and clicking up arrive at exactly
 * the same place. Nothing is done at the root; the control is absent there.
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
      // -> The folder half of the response is the tree, and is merged the same way in all three
      //    browsers; what each does with the entries is its own list projection, below
      const { roots: newTreeRoots } = mergeFolderEntries(state.treeNodes, items, parentId)
      for (const item of items) {
        switch (item.type) {
          case 'folder': {
            // -> File List
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
 * Switch the content locale being browsed and reload the tree from the root.
 *
 * A folder id (or a selected file) from one locale means nothing in another, so the reset clears
 * every bit of state the previous locale's tree left behind -- the same fields `renameFolder`'s
 * `onOk` resets before its own reload -- rather than trying to re-resolve the current position in
 * the new locale's tree.
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

// --------------------------------------
// ITEM LIST ACTIONS
// --------------------------------------

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
        // -> Under `/_files/`, which is where a file is served from: the page tree it is listed
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
    // -> Fetched rather than linked to: the content route is behind the API client, which is what
    //    carries the token
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

/**
 * Duplicating a folder or an asset has no endpoint behind it yet, so the menu item itself is gated
 * to `item.type === 'page'` (see the template) -- this only ever runs for a page.
 */
function duplicateItem(item) {
  switch (item.type) {
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
 * Cmd+K (macOS/iOS) or Ctrl+K (everywhere else) reaches THIS search field while the overlay is up.
 *
 * HeaderSearch owns the same shortcut and steps aside for an overlay (see the note there), so the two
 * never both answer it. Bound and unbound with the component, which only exists while the overlay is
 * open -- the listener's lifetime is the window in which it should win.
 */
function handleKeyPress(ev) {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'k') {
    ev.preventDefault()
    searchField.value?.focus()
  }
}

// MOUNTED

onMounted(async () => {
  window.addEventListener('keydown', handleKeyPress)

  // -> pageStore.locale is always a real code (App.vue's resolveRouteLocale never leaves it empty,
  //    and its own store default is the site's primary), so there is no fallback case to cover here.
  state.locale = pageStore.locale

  const pathParts = pageStore.path.split('/')
  const parentPath = pathParts.slice(0, -1).join('/')

  await loadTree({
    parentPath,
    initLoad: true
  })

  // -> Open tree up to current folder
  const folderFolderPath = pathParts.slice(0, -2).join('/')
  const folderFileName = pathParts.at(-2)

  for (const [id, node] of Object.entries(state.treeNodes)) {
    if (
      parentPath.startsWith(node.folderPath ? `${node.folderPath}/${node.fileName}` : node.fileName)
    ) {
      treeComp.value.setOpened(id)
    }
  }

  // -> Switch to current folder (from page path)
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

<style lang="scss">
/*
  Where the overlay's header stops fitting on one line. Its own threshold: the three toolbars want roughly
  700px between them, and this leaves a margin over that. Not one of the app's shared breakpoints, though
  it is the same 900 the site header collapses its actions at -- both are simply where a window stops
  having room for a row of chrome.
*/
$fileman-hdr-wrap-max: 899.98px;

.fileman {
  /*
    THE HEADER ON A NARROW SCREEN
    =============================

    `.card-header` is a flex row, and its three toolbars are each `w-full`, so with wrapping turned on they
    would take a line each -- three lines of chrome above a file list. Two is enough:

      line 1   the title, with the help and Close group pushed to its end
      line 2   the locale button and the search field

    The title and the actions give up `w-full` to share the first line; the search toolbar keeps it and is
    ordered last, which is what puts it on the second. Close is what this is for -- off the end of the row
    it was unreachable, and it is the only way out of the overlay.
  */
  @media (max-width: $fileman-hdr-wrap-max) {
    > .card-header {
      flex-wrap: wrap;
    }

    &-hdr-title {
      width: auto;
      flex: 1 1 auto;
      /* -> "File Manager" wrapped to two lines rather than letting the row grow */
      white-space: nowrap;
    }

    &-hdr-actions {
      width: auto;
      flex: 0 0 auto;
    }

    &-hdr-search {
      order: 1;
    }
  }

  /*
    The overlay title's own glyph, in the accent lightened for a dark ground. See the template note:
    the variable rather than a `text-accent-dark` utility, which nothing in this repo emits.
  */
  &-hdr-icon {
    color: $accent-dark;
  }

  /*
    The locale chip. The design draws it as a hairline box the same 34px height as the search field
    beside it -- not as a button standing proud of the row -- so the edge is stated here and the
    height matched rather than left to `WBtn`'s own 32px band. This selector is one class and so is
    the `min-h-*` the component sets inline, but the inline style wins regardless of specificity,
    which is why the height goes on as `!important`; nothing else here needs it.
  */
  &-locale {
    height: 34px;
    min-height: 34px !important;
    border: 1px solid rgba(255, 255, 255, 0.25);

    &-caret {
      font-size: 12px;
      opacity: 0.6;
    }
  }

  /*
    The search field, following `.header-search-field` in HeaderSearch: 40px tall, dark fill on the
    dark header, inverting to white ink-on-white in use. Stated here rather than borrowing that
    component's class, so a change to the site header cannot silently restyle this overlay -- and the
    two have since parted company on both of the things that tie a control to its surroundings.

    The FILL: HeaderSearch sits on the site header, which is black, so its neutral `#212121` reads as
    a lift out of it. This header is `.card-header` -- `$dark-3` graded towards `$dark-5`, all of them
    blue-tinted -- and a neutral grey on a blue-grey ground reads as a different, muddier colour
    rather than a raised surface. One step up the same ramp, `$dark-2`, is the lift without the clash.

    The CORNERS: 7px, which is `WBtn`'s `push` radius, so the field and the Close button at the other
    end of the header are cut to the same shape. A full pill next to a 7px button read as two
    unrelated controls that happened to share a row.
  */
  &-search {
    display: flex;
    /*
      -> Bounded, as the design bounds it: `min-width: 180px; max-width: 420px`. Unbounded, the field
         ate every pixel the header's spacer did not, and on a wide monitor a folder search ran the
         better part of a metre.
    */
    flex: 1 1 auto;
    min-width: 180px;
    max-width: 420px;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 8px 0 11px;
    /*
      A white box on the dialog's dark title band -- the design's own treatment, and the mirror of
      what `HeaderSearch` does on the light one: a search field always presents the surface it is
      typed on, whichever ground it happens to sit against. So this one goes lighter than its bar
      where the header's goes darker, and neither inverts on focus any more.
    */
    background-color: $surface;
    color: $text-caption;
    transition: color 0.2s var(--ease-standard);

    // -> Driven by a class rather than `:focus-within`, matching HeaderSearch
    &.is-focused {
      color: $ink;
    }

    &-lead {
      flex-shrink: 0;
      font-size: 16px;
      color: $slate-faint;
    }

    &-input {
      flex: 1;
      min-width: 0;
      height: 100%;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      outline: none;

      &::placeholder {
        color: currentColor;
        opacity: 0.55;
      }
    }

    &-clear {
      flex-shrink: 0;
      display: inline-flex;
      padding: 4px;
      border-radius: 9999px;
      border: 0;
      background: none;
      color: inherit;
      opacity: 0.6;
      cursor: pointer;

      &:hover {
        opacity: 1;
      }
    }

    /*
      The shortcut key cap, declared the same way `.header-search-kbd` is: a square mono cap on the
      field's own ground. Restated rather than borrowed for the same reason the field itself is --
      this one sits on a white field in a dark title band, that one on the light site header, and a
      change to either must not silently move the other.
    */
    &-kbd {
      flex-shrink: 0;
      padding: 2px 5px;
      background-color: $surface;
      border: 1px solid $hairline;
      color: $text-caption;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 500;
      line-height: 1.4;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
    }
  }

  /*
    Each pane states its own ink alongside its fill. Nothing above these sets a text color for dark
    mode -- the app has no global `body--dark { color }` rule, and the panes are not `w-card`s, which
    is where that pairing normally lives -- so anything that just inherits (the folder tree's labels,
    a file's title, the size in the right-hand column) came out black on the dark fill.
  */
  &-left {
    @at-root .body--light & {
      background-color: $tint-alt;
      border-inline-end: 1px solid $hairline;
      color: $slate;
    }
    @at-root .body--dark & {
      background-color: $dark-4;
      border-inline-end: 1px solid $hairline-dark;
      color: $text-secondary-dark;
    }
  }

  &-center {
    @at-root .body--light & {
      background-color: $surface;
      color: $text-body;
    }
    @at-root .body--dark & {
      background-color: $dark-3;
      color: $text-dark;
    }
  }

  &-right {
    @at-root .body--light & {
      background-color: #fbfcfe;
      border-inline-start: 1px solid $hairline;
      color: $text-body;
    }
    @at-root .body--dark & {
      background-color: $dark-4;
      border-inline-start: 1px solid $hairline-dark;
      color: $text-dark;
    }
  }

  /*
    The action bar over the list. The design paints it in the page tint rather than in the list's own
    white -- the same pairing the path bar along the bottom already uses, so the pane reads as a
    sheet of paper with a strip of chrome at each end rather than as one continuous white field with
    two hairlines ruled across it. Dark follows the path bar too: the recessed rung, not the panel's.
  */
  &-toolbar {
    @at-root .body--light & {
      background-color: $tint;
      border-block-end: 1px solid $hairline;
    }
    @at-root .body--dark & {
      background-color: $dark-4;
      border-block-end: 1px solid $hairline-dark;
    }
  }

  /*
    Upload's green edge. `WBtn`'s `outline` draws every outlined edge in the hairline tone on purpose
    ("an outlined button's edge is chrome, its label is not"), and this is the one control the design
    overrides that for -- so the override lives here rather than as a prop on the shared component.
  */
  &-upload-btn {
    // -> The fill tone in both appearances: it is a hairline here, not a label, so the "never under
    //    white text" constraint that separates `$positive-fill` from `$positive` does not apply.
    border-color: $positive-fill;
  }

  &-path {
    font-family: var(--font-mono);
    font-size: 11.5px;

    @at-root .body--light & {
      background-color: $tint !important;
      border-block-start: 1px solid $hairline;
      color: $text-caption;
    }
    @at-root .body--dark & {
      background-color: $dark-4 !important;
      border-block-start: 1px solid $hairline-dark;
      color: $text-caption-dark;
    }
  }

  &-main {
    height: 100%;
  }

  &-loadinglist {
    padding: 16px;
    font-style: italic;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;

    > span {
      margin-top: 16px;
    }
  }

  &-emptylist {
    padding: 16px;
    font-style: italic;
    font-size: 1.5em;
    font-weight: 300;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;

    > img {
      opacity: 0.25;
      width: 200px;
    }

    @at-root .body--light & {
      color: $text-caption;
    }
    @at-root .body--dark & {
      color: $text-caption-dark;

      > img {
        filter: invert(1);
      }
    }
  }

  &-droptarget {
    position: relative;
    height: 100%;
  }

  /*
    Covers the whole pane rather than sitting as a border on it: a dashed inset rectangle plus a
    translucent wash reads as "drop here" at a glance, the same affordance file managers and mail
    clients use. `pointer-events: none` is load-bearing -- see the template comment beside it.
  */
  &-dropoverlay {
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

    @at-root .body--light & {
      background-color: rgba(255, 255, 255, 0.9);
      color: $text-body;
    }
    @at-root .body--dark & {
      background-color: rgba(20, 23, 31, 0.85);
      color: $text-dark;
    }
  }

  /*
    The listing runs edge to edge -- the rows are the page, not cards floating on it -- so the
    padding is each row's (11px 16px, the design's own) and the list has none of its own.
  */
  &-filelist {
    padding: 0;

    /*
      The selected row: the accent WASH plus an accent bar down its leading edge, matching how the
      site sidebar and the folder tree beside this list both mark what the reader is on. A solid
      accent fill (what this used to do) is the treatment a BUTTON gets; a selected row in a list is
      not one, and filling it meant the file name, its type and its size all had to be restated in
      white -- three overrides that existed only to survive the fill.

      The wash, not `--color-tint`: the design tints the selected row towards the accent (`#fdeced`),
      which is `--color-accent-wash`. The neutral tint was the same colour as the toolbar above the
      list, so a selected row read as a second strip of chrome rather than as a selection.

      The bar is an inset SHADOW rather than a border, again as the design draws it (`inset 3px 0 0`).
      A border would have to be reserved as `2px solid transparent` on every unselected row, which is
      what the previous rule did -- three pixels of padding stolen from every row in the list to make
      room for a mark almost none of them carry.
    */
    > .w-item {
      padding: 11px 16px;

      // -> The design rules each row off from the next; the last one meets the pane's own edge
      &:not(:last-child) {
        border-block-end: 1px solid $tint;
      }

      &.active {
        box-shadow: inset 3px 0 0 var(--color-accent-fill);
        background-color: var(--color-accent-wash);
        color: var(--color-ink);

        @at-root .body--dark & {
          background-color: var(--color-accent-wash-dark);
          color: var(--color-text-dark);
        }
      }

      @at-root .body--dark & {
        &:not(:last-child) {
          border-block-end-color: $hairline-dark;
        }
      }
    }

    // -> The design's own row type scale: a 14.5px/500 name over a 12px caption
    &-label {
      .w-item-label {
        font-size: 14.5px;
        font-weight: 500;
      }

      .w-item-label--caption {
        font-size: 12px;
        font-weight: 400;
      }
    }

    // -> A measurement, in the mono face, as every other measurement on this screen is
    &-side {
      font-family: var(--font-mono);
      font-size: 11.5px;

      @at-root .body--light & {
        color: $text-secondary;
      }
      @at-root .body--dark & {
        color: $text-secondary-dark;
      }
    }

    &.is-compact {
      > .w-item {
        padding: 0 16px;
        min-height: 36px;
      }

      .fileman-filelist-icon {
        padding-inline-end: 6px;
        min-width: 0;
      }
    }
  }
  /*
    The preview plate at the top of the details pane, always drawn -- see the template note. A framed
    16/10 box on the tint, with the blueprint corner marks the design language sets around anything
    it wants read as a plate rather than as a picture that happens to be there.
  */
  &-thumb {
    position: relative;
    aspect-ratio: 16 / 10;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-block-end: 16px;

    @at-root .body--light & {
      background-color: $tint;
      border: 1px solid $hairline;
    }
    @at-root .body--dark & {
      background-color: $dark-3;
      border: 1px solid $hairline-dark;
    }

    // -> The image fills the plate it is framed by, so the frame's own aspect ratio is the one drawn
    > img {
      display: block;
      height: 100%;
      object-fit: cover;
    }

    &-placeholder {
      color: $slate-pale;
    }

    /*
      The four corner marks. Outside the frame by 4px, drawn as two edges of a 7px square each, so
      they read as registration ticks rather than as a second border. Positioned with logical
      insets, so each tick's two drawn edges stay on the corner it is named for under RTL.
    */
    &-tick {
      position: absolute;
      width: 7px;
      height: 7px;
      border: 0 solid $slate-soft;
      pointer-events: none;

      @at-root .body--dark & {
        border-color: $slate-light;
      }

      &--tl {
        top: -4px;
        inset-inline-start: -4px;
        border-block-start-width: 1px;
        border-inline-start-width: 1px;
      }
      &--tr {
        top: -4px;
        inset-inline-end: -4px;
        border-block-start-width: 1px;
        border-inline-end-width: 1px;
      }
      &--bl {
        bottom: -4px;
        inset-inline-start: -4px;
        border-block-end-width: 1px;
        border-inline-start-width: 1px;
      }
      &--br {
        bottom: -4px;
        inset-inline-end: -4px;
        border-block-end-width: 1px;
        border-inline-end-width: 1px;
      }
    }
  }

  /*
    A detail row is a LABELLED VALUE, and the design lays it out as one: a 92px mono-uppercase label
    gutter with the value beside it, each row ruled off from the next. Stacked (what this used to do)
    made every value look like the start of its own paragraph and cost twice the vertical room, which
    is how a four-row pane came to need scrolling.
  */
  &-details-row {
    display: flex;
    gap: 10px;
    padding: 7px 0;

    @at-root .body--light & {
      border-block-end: 1px solid $tint;
    }
    @at-root .body--dark & {
      border-block-end: 1px solid $hairline-dark;
    }

    label {
      flex: 0 0 92px;
      padding-block-start: 2px;
      font-size: 0.6rem;
      font-weight: 600;

      font-family: var(--font-mono);
      letter-spacing: 0.14em;
      text-transform: uppercase;

      @at-root .body--light & {
        color: $text-caption;
      }
      @at-root .body--dark & {
        color: $text-caption-dark;
      }
    }
    span {
      flex: 1;
      min-width: 0;
      font-size: 13.5px;
      // -> A long file name has nowhere to break: the gutter beside it is fixed
      word-break: break-word;

      @at-root .body--light & {
        color: $ink;
      }
      @at-root .body--dark & {
        color: $text-dark;
      }
    }
  }

  /*
    The pane's own commit button, marked with the same registration ticks the plate above it carries
    -- the design puts them on the leading-top and trailing-bottom corners only, which is the motif's
    abbreviated form for a control rather than a plate.
  */
  &-insert-btn {
    &::before,
    &::after {
      content: '';
      position: absolute;
      width: 5px;
      height: 5px;
      border: 0 solid var(--color-accent);
      pointer-events: none;
    }

    &::before {
      top: -3px;
      inset-inline-start: -3px;
      border-block-start-width: 1px;
      border-inline-start-width: 1px;
    }

    &::after {
      bottom: -3px;
      inset-inline-end: -3px;
      border-block-end-width: 1px;
      border-inline-end-width: 1px;
    }
  }

  &-progressbar {
    width: 100%;
    flex: 1;
    height: 12px;

    @at-root .body--light & {
      background-color: $blue-grey-2;
    }
    @at-root .body--dark & {
      background-color: $dark-4 !important;
    }

    > div {
      height: 12px;
      background-color: $positive;
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
      box-shadow: 0 0 5px 0 $positive;
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
  }
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
