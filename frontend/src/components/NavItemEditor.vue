<template>
  <w-drawer class="nav-edit-drawer" :model-value="true" :width="295">
    <!-- -> The Ledger column header: an eyebrow plus the item count, matching the handoff's own
            "Menu items" band above the tree (`ui-redesign-nav/HANDOFF.md` §2). -->
    <div class="nav-edit-drawer-header">
      <span class="nav-edit-drawer-eyebrow">{{ t('navEdit.itemsHeading') }}</span>
      <span class="nav-edit-drawer-count">{{ state.items.length }}</span>
    </div>
    <w-scroll-area class="nav-edit flex-1 min-h-0">
      <!--
        The `q-list q-list--dense q-list--dark` this carried were the old framework's classes and
        nothing defines them any more, which is why the rows had drifted to full height: the density
        now comes from `dense` on each item, matching what NavSidebar renders.
      -->
      <div class="nav-edit-mixed-hint text-caption" v-if="isMixed">
        {{ t('navEdit.menuSourceMixedListHint') }}
      </div>
      <!--
        Exactly one root node per `#item` invocation, deliberately: `sortablejs-vue3` renders this slot
        directly into the sortable container with no per-item wrapper (see its source), so SortableJS's
        `oldIndex`/`newIndex` are DOM child positions -- a second sibling node per item (e.g. a divider
        rendered alongside the row) would desync those from `state.items`' own indices. The generated
        block's boundary is marked with pure CSS sibling selectors instead (`.is-generated` adjacency,
        below) for exactly this reason.
      -->
      <sortable
        class="nav-edit-list"
        :list="state.items"
        item-key="id"
        :options="sortableOptions"
        @end="updateItemPosition">
        <template #item="{ element }">
          <div
            class="nav-edit-item nav-edit-item-header"
            v-if="element.type === `header`"
            :class="{
              'is-active': state.selected === element.id,
              'is-generated': element.generated
            }"
            @click="setItem(element)">
            <w-item-label class="text-caption" header>{{ element.label }}</w-item-label>
            <w-space />
            <w-item-section side>
              <w-icon
                v-if="!element.generated"
                class="handle"
                name="tabler:grip-horizontal"
                size="sm" />
            </w-item-section>
          </div>
          <w-item
            class="nav-edit-item nav-edit-item-link"
            v-else-if="element.type === `link`"
            dense
            :class="{
              'is-active': state.selected === element.id,
              'is-nested': element.isNested,
              'is-generated': element.generated
            }"
            @click="setItem(element)"
            clickable>
            <!--
              -> Shown only for the first generated row after a manual one (see the CSS): the eyebrow
                 marking `isMixed`'s generated block, which the handoff draws once above the run rather
                 than per row.
            -->
            <span class="nav-edit-generated-eyebrow" v-if="element.generated">
              {{ t('navEdit.generatedFromTree') }}
            </span>
            <w-item-section side><w-icon :name="rowIcon(element)" /></w-item-section>
            <w-item-section class="text-wordbreak-all">{{ element.label }}</w-item-section>
            <w-item-section side>
              <w-icon
                v-if="!element.generated"
                class="handle"
                name="tabler:grip-horizontal"
                size="sm" />
            </w-item-section>
          </w-item>
          <div
            class="nav-edit-item nav-edit-item-separator"
            v-else
            :class="{
              'is-active': state.selected === element.id,
              'is-generated': element.generated
            }"
            @click="setItem(element)">
            <w-separator inset style="flex: 1" />
            <w-item-section side>
              <w-icon
                v-if="!element.generated"
                class="handle"
                name="tabler:grip-horizontal"
                size="sm" />
            </w-item-section>
          </div>
        </template>
      </sortable>
    </w-scroll-area>
    <!--
      -> Pinned outside the scroll area rather than scrolling with the list (it used to be the last
         child inside `w-scroll-area`): the handoff draws it as the drawer's own bottom bar, ruled off
         above, present whenever there is something of this menu's own to add.
    -->
    <div class="nav-edit-bottombar" v-if="!isAuto">
      <w-btn
        style="flex: 1"
        color="primary"
        :label="t(`common.actions.add`)"
        :aria-label="t(`common.actions.add`)"
        icon="tabler:plus">
        <w-icon name="tabler:chevron-down" size="xs" />
        <w-menu fit :offset="[0, 10]" auto-close>
          <w-list separator>
            <w-item clickable @click="addItem(`header`)">
              <w-item-section side><w-icon name="tabler:heading" /></w-item-section>
              <w-item-section>
                <w-item-label>{{ t('navEdit.header') }}</w-item-label>
              </w-item-section>
            </w-item>
            <w-item clickable @click="addItem(`link`)">
              <w-item-section side><w-icon name="tabler:link" /></w-item-section>
              <w-item-section>
                <w-item-label>{{ t('navEdit.link') }}</w-item-label>
              </w-item-section>
            </w-item>
            <w-item clickable @click="addItem(`separator`)">
              <w-item-section side><w-icon name="tabler:minus" /></w-item-section>
              <w-item-section>
                <w-item-label>{{ t('navEdit.separator') }}</w-item-label>
              </w-item-section>
            </w-item>
          </w-list>
        </w-menu>
      </w-btn>
      <w-btn
        class="ms-2"
        outline
        color="slate"
        :aria-label="t(`common.actions.add`)"
        icon="tabler:dots-vertical"
        padding="xs sm">
        <w-menu :offset="[0, 10]" anchor="bottom right" self="top right" auto-close>
          <w-list separator>
            <w-item
              clickable
              @click="clearItems"
              :disabled="!state.items.some((item) => !item.generated)">
              <w-item-section side>
                <w-icon name="tabler:trash" color="negative" />
              </w-item-section>
              <w-item-section>
                <w-item-label>{{ t('navEdit.clearItems') }}</w-item-label>
              </w-item-section>
            </w-item>
            <!--
              Hidden rather than disabled when there is nothing to copy from -- a single-locale site
              with no other enabled site has no picker this could open onto.
            -->
            <w-item clickable @click="openCopyDialog" v-if="canCopyFrom">
              <w-item-section side>
                <w-icon name="tabler:file-import" />
              </w-item-section>
              <w-item-section>
                <w-item-label>{{ t('navEdit.copyFrom') }}</w-item-label>
              </w-item-section>
            </w-item>
          </w-list>
        </w-menu>
      </w-btn>
    </div>
  </w-drawer>
  <w-page-container>
    <w-page class="nav-edit-panel">
      <div class="nav-edit-callout" v-if="state.items.length < 1">
        <div class="nav-edit-callout__icon"><w-icon name="tabler:arrow-left" size="18px" /></div>
        <p>{{ t('navEdit.emptyMenuText') }}</p>
      </div>
      <div class="nav-edit-callout" v-else-if="!state.selected">
        <div class="nav-edit-callout__icon"><w-icon name="tabler:arrow-left" size="18px" /></div>
        <p>{{ t('navEdit.noSelection') }}</p>
      </div>
      <template v-else>
        <!-- -> The read-only notice sits ABOVE the (dimmed) card, per the handoff, rather than as a
                banner glued to its top edge. -->
        <div class="nav-edit-callout" v-if="editingDisabled">
          <div class="nav-edit-callout__icon"><w-icon name="tabler:info-circle" size="18px" /></div>
          <p>{{ t('navEdit.menuSourceReadOnlyNotice') }}</p>
        </div>

        <!--
          One property card for every item type, per the handoff's "settings-row primitive" (the same
          `BlueprintIcon` plate + `w-item` row this app's settings pages already draw with) -- rather
          than three near-duplicate `w-card`s, only the type name, the parent badge and the rows inside
          differ.
        -->
        <w-card class="nav-edit-card" :class="{ 'nav-edit-card--disabled': editingDisabled }">
          <i class="nav-edit-card__corner nav-edit-card__corner--tl" aria-hidden="true"></i>
          <i class="nav-edit-card__corner nav-edit-card__corner--tr" aria-hidden="true"></i>
          <i class="nav-edit-card__corner nav-edit-card__corner--bl" aria-hidden="true"></i>
          <i class="nav-edit-card__corner nav-edit-card__corner--br" aria-hidden="true"></i>
          <div class="nav-edit-card__header">
            <span>{{ currentTypeLabel }}</span>
            <span class="nav-edit-parent-badge" v-if="currentIsParent">
              {{ t('navEdit.parentBadge', { count: currentChildCount }) }}
            </span>
          </div>

          <template v-if="state.current.type === `header`">
            <w-item>
              <blueprint-icon icon="tabler:typography" />
              <w-item-section>
                <w-item-label>{{ t(`navEdit.label`) }}</w-item-label>
                <w-item-label caption>{{ t(`navEdit.labelHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section>
                <w-input
                  v-model="state.current.label"
                  dense
                  hide-bottom-space
                  :aria-label="t(`navEdit.label`)" />
              </w-item-section>
            </w-item>
            <w-item>
              <blueprint-icon icon="tabler:users-group" />
              <w-item-section>
                <w-item-label>{{ t(`navEdit.visibility`) }}</w-item-label>
                <w-item-label caption>{{ t(`navEdit.visibilityHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section avatar>
                <w-btn-toggle
                  v-model="state.current.visibilityLimited"
                  :aria-label="t(`navEdit.visibility`)"
                  :options="visibilityOptions" />
              </w-item-section>
            </w-item>
            <w-item class="items-center" v-if="state.current.visibilityLimited">
              <w-space />
              <div class="text-caption me-4">{{ t('navEdit.selectGroups') }}</div>
              <w-select
                style="width: 100%; max-width: calc(50% - 34px)"
                v-model="state.current.visibilityGroups"
                :options="state.groups"
                option-value="id"
                option-label="name"
                emit-value
                map-options
                dense
                multiple
                :aria-label="t(`navEdit.selectGroups`)" />
            </w-item>
          </template>

          <template v-if="state.current.type === `link`">
            <w-item>
              <blueprint-icon icon="tabler:typography" />
              <w-item-section>
                <w-item-label>{{ t(`navEdit.label`) }}</w-item-label>
                <w-item-label caption>{{ t(`navEdit.labelHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section>
                <w-input
                  v-model="state.current.label"
                  dense
                  hide-bottom-space
                  :aria-label="t(`navEdit.label`)" />
              </w-item-section>
            </w-item>
            <w-item>
              <blueprint-icon icon="tabler:star" />
              <w-item-section>
                <w-item-label>{{ t(`navEdit.icon`) }}</w-item-label>
                <w-item-label caption>{{ t(`navEdit.iconHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section>
                <w-input v-model="state.current.icon" dense :aria-label="t(`navEdit.icon`)">
                  <template #append>
                    <!--
                      A button, not a bare `w-icon`: for a bundled icon WIcon renders an <svg> whose
                      body is set through `v-html`, and that branch renders no slot -- so the menu
                      inside it never existed and the control did nothing. It was also just the glyph,
                      with no hit area of its own. Same fix as the page-properties dialog.
                    -->
                    <w-btn
                      flat
                      dense
                      round
                      icon="tabler:search"
                      color="primary"
                      :aria-label="t(`iconPicker.open`)">
                      <w-tooltip>{{ t('iconPicker.open') }}</w-tooltip>
                      <w-menu content-class="shadow-7">
                        <icon-picker-dialog v-model="state.current.icon" />
                      </w-menu>
                    </w-btn>
                  </template>
                </w-input>
              </w-item-section>
            </w-item>
            <!--
              A parent is a row that opens a submenu rather than a row that goes anywhere: the sidebar
              renders it as an expansion item and never reads its target, so both fields below are
              hidden rather than shown doing nothing. Hidden, not cleared -- unnesting the last child
              turns the row back into an ordinary link, and it comes back with the address it had.
            -->
            <template v-if="currentIsParent">
              <w-item tag="label">
                <blueprint-icon icon="tabler:chevron-right" />
                <w-item-section>
                  <w-item-label>{{ t(`navEdit.expandByDefault`) }}</w-item-label>
                  <w-item-label caption>{{ t(`navEdit.expandByDefaultHint`) }}</w-item-label>
                </w-item-section>
                <w-item-section avatar>
                  <w-toggle
                    v-model="state.current.expandByDefault"
                    :aria-label="t(`navEdit.expandByDefault`)" />
                </w-item-section>
              </w-item>
            </template>
            <template v-else>
              <w-item>
                <blueprint-icon icon="tabler:link" />
                <w-item-section>
                  <w-item-label>{{ t(`navEdit.target`) }}</w-item-label>
                  <w-item-label caption>{{ t(`navEdit.targetHint`) }}</w-item-label>
                </w-item-section>
                <w-item-section>
                  <w-input
                    v-model="state.current.target"
                    dense
                    hide-bottom-space
                    :aria-label="t(`navEdit.target`)">
                    <template #append>
                      <!--
                        Beside the field rather than in place of it: a path someone knows is quicker
                        typed than browsed to, and an external URL has nothing to browse. Same shape as
                        the icon picker's button one row up, for the same reason -- both open a chooser
                        for the field they sit in.
                      -->
                      <w-btn
                        flat
                        dense
                        round
                        icon="tabler:folder-open"
                        color="primary"
                        :aria-label="t(`common.actions.browse`)"
                        @click="browseTarget">
                        <w-tooltip>{{ t('common.actions.browse') }}</w-tooltip>
                      </w-btn>
                    </template>
                  </w-input>
                </w-item-section>
              </w-item>
              <w-item tag="label">
                <blueprint-icon icon="tabler:external-link" />
                <w-item-section>
                  <w-item-label>{{ t(`navEdit.openInNewWindow`) }}</w-item-label>
                  <w-item-label caption>{{ t(`navEdit.openInNewWindowHint`) }}</w-item-label>
                </w-item-section>
                <w-item-section avatar>
                  <w-toggle
                    v-model="state.current.openInNewWindow"
                    :aria-label="t(`navEdit.openInNewWindow`)" />
                </w-item-section>
              </w-item>
            </template>
            <w-item>
              <blueprint-icon icon="tabler:users-group" />
              <w-item-section>
                <w-item-label>{{ t(`navEdit.visibility`) }}</w-item-label>
                <w-item-label caption>{{ t(`navEdit.visibilityHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section avatar>
                <w-btn-toggle
                  v-model="state.current.visibilityLimited"
                  :aria-label="t(`navEdit.visibility`)"
                  :options="visibilityOptions" />
              </w-item-section>
            </w-item>
            <w-item class="items-center" v-if="state.current.visibilityLimited">
              <w-space />
              <div class="text-caption me-4">{{ t('navEdit.selectGroups') }}</div>
              <w-select
                style="width: 100%; max-width: calc(50% - 34px)"
                v-model="state.current.visibilityGroups"
                :options="state.groups"
                option-value="id"
                option-label="name"
                emit-value
                map-options
                dense
                multiple
                :aria-label="t(`navEdit.selectGroups`)" />
            </w-item>
          </template>

          <template v-if="state.current.type === `separator`">
            <w-item>
              <blueprint-icon icon="tabler:users-group" />
              <w-item-section>
                <w-item-label>{{ t(`navEdit.visibility`) }}</w-item-label>
                <w-item-label caption>{{ t(`navEdit.visibilityHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section avatar>
                <w-btn-toggle
                  v-model="state.current.visibilityLimited"
                  :aria-label="t(`navEdit.visibility`)"
                  :options="visibilityOptions" />
              </w-item-section>
            </w-item>
            <w-item class="items-center" v-if="state.current.visibilityLimited">
              <w-space />
              <div class="text-caption me-4">{{ t('navEdit.selectGroups') }}</div>
              <w-select
                style="width: 100%; max-width: calc(50% - 34px)"
                v-model="state.current.visibilityGroups"
                :options="state.groups"
                option-value="id"
                option-label="name"
                emit-value
                map-options
                dense
                multiple
                :aria-label="t(`navEdit.selectGroups`)" />
            </w-item>
          </template>
        </w-card>

        <!--
          Structure card: nest/un-nest for a link, Delete for every type -- one card rather than the
          per-type duplicate this used to be, matching the handoff's "header and separator items get
          the same card with only Delete".
        -->
        <w-card class="nav-edit-structure-card" v-if="!editingDisabled">
          <div class="nav-edit-structure-card__nest" v-if="state.current.type === `link`">
            <div class="nav-edit-structure-card__buttons">
              <w-btn
                class="nav-edit-structure-btn"
                outline
                color="slate"
                icon="tabler:indent-increase"
                :label="t(`navEdit.nestItem`)"
                :disabled="state.current.isNested"
                @click="state.current.isNested = true" />
              <w-btn
                class="nav-edit-structure-btn"
                outline
                color="slate"
                icon="tabler:indent-decrease"
                :label="t(`navEdit.unnestItem`)"
                :disabled="!state.current.isNested"
                @click="state.current.isNested = false" />
            </div>
            <div class="nav-edit-structure-card__caption">{{ t('navEdit.nestingWarn') }}</div>
          </div>
          <w-space />
          <w-btn
            flat
            icon="tabler:trash"
            :label="t(`common.actions.delete`)"
            color="negative"
            @click="removeItem(state.current.id)" />
        </w-card>
      </template>
    </w-page>
  </w-page-container>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, defineAsyncComponent, onMounted, reactive, watch } from 'vue'

import { dialog } from '@/composables/dialog'
import { notify } from '@/composables/notify'

import { v4 as uuid } from 'uuid'
import { Sortable } from 'sortablejs-vue3'
import IconPickerDialog from '@/components/IconPickerDialog.vue'
import { apiErrorMessage } from '@/helpers/apiError'
import { flattenMenuItems, reconstructMenuItems } from '@/helpers/navigation.js'

/**
 * The item-list-plus-detail-panel navigation editor: the sortable list of items on the left, and the
 * header/link/separator property panel on the right (including the visibility-group picker).
 *
 * Deliberately ignorant of WHERE the menu it edits lives — it knows only a `siteId` and a `navId`,
 * the row `GET/PUT /sites/:siteId/navigation/:navId` addresses. That is what lets both hosts drive it:
 * `NavEditOverlay.vue` resolves `navId` from the page it is opened on (or the menu that page
 * inherits) and still owns the mode-aware `PUT .../pages/:pageId` save; `AdminNavigation.vue`'s
 * launched dialog resolves `navId` from the site id (site-wide default) or an override's own
 * `navigationId`, and saves straight to `PUT .../:navId` via `setNavItems`. Either way, saving itself
 * is the host's job: this component only builds the payload, via `buildSaveItems()`.
 */

// PROPS

const props = defineProps({
  /** Site the menu belongs to. */
  siteId: {
    type: String,
    required: true
  },
  /** The menu being edited — a tree entry id, or a site id for the site-wide default. */
  navId: {
    type: String,
    required: true
  },
  /**
   * The menu's own source (`static`/`auto`/`mixed`) -- a different axis from wherever the host
   * addresses this menu by. Left at the default for a host (e.g. `AdminNavEditDialog.vue`) that has
   * not resolved it: `static` is what every menu was before this feature, and is the one source this
   * component behaves for exactly as it always did. `NavEditOverlay.vue` is the one host that resolves
   * and passes it, since it is the one host that also offers a way to change it (`NavEditMenu.vue`'s
   * mode selector).
   *
   * `auto` renders the whole list read-only, since every item is `generated` — there is nothing of
   * this menu's own to edit. `mixed` keeps add/remove/drag for the items that are NOT `generated`,
   * fenced off from the generated block by both a visual divider and a drag boundary — see
   * `sortableOptions` and `buildSaveItems`.
   */
  menuMode: {
    type: String,
    default: 'static'
  }
})

// EMITS

const emit = defineEmits([
  'load-error',
  /**
   * Whether a load or a group fetch is in flight — the host's own Save button (and busy spinner)
   * disable against this, so it is pushed out as a normal event rather than left for the host to
   * reach for by reading `editorRef.value.loading` across the component boundary.
   */
  'update:loading',
  /**
   * `copyFrom()` below persists immediately (`POST .../:navId/copy`), unlike every other change in
   * this editor -- which stays local until the host's own Save button calls `buildSaveItems()` and
   * saves it. That means the reader-facing sidebar can go stale from this ONE action without the
   * host ever calling its own save path -- OpenProject #1012. Pushed out as an event, matching this
   * component's "deliberately ignorant of where the menu lives" design (see the header comment): it
   * knows the copy just wrote to the server, not whether that menu is the one currently on screen.
   */
  'copied'
])

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  loading: 0,
  selected: null,
  items: [],
  current: {
    label: '',
    icon: '',
    target: '/',
    openInNewWindow: false,
    expandByDefault: false,
    visibilityGroups: [],
    visibilityLimited: false,
    isNested: false
  },
  groups: [],
  /** This site's default-menu roots, one per active locale -- what "Copy from..." offers same-site. */
  copyLocales: [],
  /** Other enabled sites -- what "Copy from..." offers for the cross-site case. */
  copyOtherSites: []
})

/**
 * The icon a new link item starts with.
 *
 * An Iconify reference, so that the icon picker opens on its search tab with this one selected, and so
 * that the sidebar draws it through `w-icon` like every other item. Kept to `mdi`, a set seeded on
 * every instance.
 */
const DEFAULT_LINK_ICON = 'tabler:file-text'

/**
 * The glyph a `link` row draws: its own `icon` when it has one, and otherwise a folder-vs-page
 * fallback (OpenProject #2885, porting #2826's fix here) -- `element.isFolder`, since a
 * generated (auto/mixed) folder item carries no `icon` of its own either, and without this an
 * icon-less folder row drew a blank 15px gap where the tree's own shape should be readable at a
 * glance. Not `NavSidebarItem.vue#iconFor()`'s `|| item.children?.length > 0` half of that same
 * check: `flattenMenuItem` (`helpers/navigation.js`) never puts a `children` array on a flat
 * editor row (nesting is `isNested` on the row *after* it instead), so it would always read
 * `undefined` here and never actually contribute.
 */
function rowIcon(element) {
  return element.icon || (element.isFolder ? 'tabler:folder' : DEFAULT_LINK_ICON)
}

const visibilityOptions = [
  { value: false, label: t('navEdit.visibilityAll') },
  { value: true, label: t('navEdit.visibilityLimited') }
]

// COMPUTED

/**
 * Whether the link being edited is a parent — one the sidebar draws as a submenu.
 *
 * Parenthood is not a property of the item: this list is flat, and `isNested` says an item belongs to
 * whatever link comes before it, so what makes a link a parent is the item that FOLLOWS it. Which is why
 * this is asked of the list rather than read off `state.current`, and why it answers again the moment a
 * child is nested, unnested or dragged away.
 */
const currentIsParent = computed(() => {
  const item = state.current
  if (item?.type !== 'link' || item.isNested) {
    return false
  }
  const idx = state.items.findIndex((it) => it.id === item.id)
  return idx >= 0 && Boolean(state.items[idx + 1]?.isNested)
})

/**
 * How many items the selected parent link opens onto, for the property card's own "Parent · N
 * children" badge. Counted off the flat list rather than a real tree, matching `currentIsParent`'s
 * own reasoning: every consecutive `isNested` item right after this one belongs to it.
 */
const currentChildCount = computed(() => {
  if (!currentIsParent.value) {
    return 0
  }
  const idx = state.items.findIndex((it) => it.id === state.current.id)
  let count = 0
  for (let i = idx + 1; i < state.items.length && state.items[i]?.isNested; i++) {
    count++
  }
  return count
})

/** The property card's own header label -- the item type being edited, translated. */
const currentTypeLabel = computed(() => {
  switch (state.current?.type) {
    case 'header':
      return t('navEdit.header')
    case 'link':
      return t('navEdit.link')
    case 'separator':
      return t('navEdit.separator')
    default:
      return ''
  }
})

/** Whole menu is `getNav`'s generated preview -- nothing of this menu's own to add, remove or drag. */
const isAuto = computed(() => props.menuMode === 'auto')

/** Generated and stored items share one list -- the divider/boundary rendering only applies here. */
const isMixed = computed(() => props.menuMode === 'mixed')

/** Whether the item currently open in the detail panel is one `getNav` generated, not a stored one. */
const isCurrentGenerated = computed(() => Boolean(state.current?.generated))

/**
 * Whether the detail panel's own fields (and its Delete/Nest buttons) are disabled -- either because
 * the WHOLE menu is read-only (`auto`), or because THIS item specifically is a generated one sitting
 * in an otherwise-editable `mixed` menu. Editing a generated item's fields would only be undone by the
 * next `getNav` read, which regenerates it fresh from the tree every time.
 */
const editingDisabled = computed(() => isAuto.value || isCurrentGenerated.value)

/**
 * `auto` disables dragging entirely -- every item is generated, so there is nothing of this menu's
 * own to reorder. `mixed` still drags normally among the non-generated items (`filter` blocks starting
 * a drag ON a generated one, `onMove` blocks dropping INTO the generated block), which is what keeps a
 * manual item from ending up interleaved with tree-walk output that would just be overwritten by the
 * next read anyway.
 */
const sortableOptions = computed(() => ({
  handle: '.handle',
  animation: 150,
  disabled: isAuto.value,
  filter: '.is-generated',
  preventOnFilter: true,
  onMove: (evt) => !evt.related?.classList?.contains('is-generated')
}))

/**
 * Whether "Copy from..." has anything to offer: another locale of this site's own default menu, or
 * another enabled site (any of its locales). Hidden entirely rather than shown disabled when neither
 * holds, per the edge case a single-locale, single-site instance is in by default.
 */
const canCopyFrom = computed(() => state.copyLocales.length > 1 || state.copyOtherSites.length > 0)

// METHODS

function setItem(item) {
  state.selected = item.id
  state.current = item
}

/**
 * Picks the link's target: a page of this wiki, or any URL.
 *
 * The same dialog the markdown editor's Insert Link opens, with both of its tabs — a navigation link
 * goes to either, and which one it is is the reader's question rather than this panel's. It opens on
 * whatever the field already holds, so coming back to a link that exists starts from that link.
 *
 * Its "open in a new tab" offer is turned off: this panel asks that one row down and stores the
 * answer, so a second control for it could only disagree with the toggle that is actually saved.
 */
function browseTarget() {
  dialog({
    component: defineAsyncComponent(() => import('./LinkPickerDialog.vue')),
    componentProps: {
      title: t('navEdit.target'),
      okLabel: t('common.actions.select'),
      initialHref: state.current.target,
      newTabOption: false
    }
  }).onOk(({ href }) => {
    state.current.target = href
  })
}

function addItem(type) {
  // -> Nothing of this menu's own to add to while every item is generated -- the Add button is
  //    already hidden for `auto` (see the template), this is the defensive twin of that
  if (isAuto.value) {
    return
  }
  const newItem = {
    id: uuid(),
    type,
    visibilityGroups: [],
    visibilityLimited: false
  }
  switch (type) {
    case 'header': {
      newItem.label = t('navEdit.header')
      break
    }
    case 'link': {
      newItem.label = t('navEdit.link')
      newItem.icon = DEFAULT_LINK_ICON
      newItem.target = '/'
      newItem.openInNewWindow = false
      newItem.expandByDefault = false
      newItem.isNested = false
      break
    }
  }
  state.items.push(newItem)
  state.selected = newItem.id
  state.current = newItem
}

function removeItem(id) {
  // -> A generated item is not this menu's own to remove -- the Delete button is already hidden for
  //    one (see the template), this is the defensive twin of that
  if (state.items.find((item) => item.id === id)?.generated) {
    return
  }
  state.items = state.items.filter((item) => item.id !== id)
  state.selected = null
  state.current = {}
}

function clearItems() {
  // -> Clears only what this menu owns -- a generated item is not something a save could ever remove
  //    (the next read regenerates it fresh from the tree regardless), so leaving it out of `items`
  //    here would still show it right back after saving. Kept in place instead.
  state.items = state.items.filter((item) => item.generated)
  state.selected = null
  state.current = {}
}

function updateItemPosition(ev) {
  const item = state.items.splice(ev.oldIndex, 1)[0]
  state.items.splice(ev.newIndex, 0, item)
}

async function loadGroups() {
  state.loading++
  try {
    const groups = await API_CLIENT.get('groups').json()
    state.groups = (groups ?? []).map((g) => ({ id: g.id, name: g.name }))
  } catch (err) {
    // -> Without the list, per-group visibility cannot be set, but the rest of the editor still works
    notify({
      type: 'warning',
      message: t('navEdit.groupsFailed'),
      caption: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
  state.loading--
}

async function loadMenuItems() {
  state.loading++
  try {
    // -> `full`, because the editor has to see items limited to groups the editor is not in: saving
    //    without them would delete them
    const { items } = await API_CLIENT.get(`sites/${props.siteId}/navigation/${props.navId}`, {
      searchParams: { full: true }
    }).json()
    state.items = flattenMenuItems(items)
    state.selected = null
    state.current = {}
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err, t('common.error.unexpected'))
    })
    emit('load-error')
  }
  state.loading--
}

/**
 * Builds the nested `items` payload a save PUTs, from the flat editing list.
 *
 * Thrown, not returned, on a nested item with nothing above it to nest under — the host's own
 * `save()` is what shows that as an error. `generated`-skipping and `mixed`-menu `pinned`
 * recomputation are `reconstructMenuItems`'s own concern — see its doc comment.
 */
function buildSaveItems() {
  return reconstructMenuItems(state.items, { menuMode: props.menuMode })
}

/**
 * Fetches what "Copy from..." needs to decide whether it has anything to offer, and to populate its
 * picker without asking the server the same two questions again once opened: this site's own
 * default-menu roots (`GET .../navigation/roots`) and the list of other enabled sites (`GET /sites`).
 *
 * Failures are swallowed rather than surfaced via `notify()` -- unlike the group list, losing this
 * only hides an action, it does not break anything already on screen. The two calls are settled
 * independently so that a site list the current user cannot read (it needs `read:sites` /
 * `access:admin`, not just the `manage:navigation` this whole editor already requires) does not also
 * take down the same-site "copy from another locale" case, which needs neither.
 */
async function loadCopySources() {
  state.loading++
  // -> Wrapped as a whole, not just around the `await`: `API_CLIENT.get()` itself can throw
  //    synchronously (a bad client-side call, or a test double standing in for a network error)
  //    before `Promise.allSettled` ever gets to run, which would otherwise skip `state.loading--`
  //    below and leave the editor stuck looking busy forever
  try {
    const [rootsResult, sitesResult] = await Promise.allSettled([
      API_CLIENT.get(`sites/${props.siteId}/navigation/roots`).json(),
      API_CLIENT.get('sites').json()
    ])
    state.copyLocales = rootsResult.status === 'fulfilled' ? (rootsResult.value ?? []) : []
    state.copyOtherSites =
      sitesResult.status === 'fulfilled'
        ? (sitesResult.value ?? []).filter((site) => site.id !== props.siteId && site.isEnabled)
        : []
  } catch {
    state.copyLocales = []
    state.copyOtherSites = []
  }
  state.loading--
}

/** Opens the source picker, then runs the copy against whatever it answers with. */
function openCopyDialog() {
  dialog({
    component: defineAsyncComponent(() => import('./CopyNavItemsDialog.vue')),
    componentProps: {
      siteId: props.siteId,
      navId: props.navId,
      locales: state.copyLocales,
      otherSites: state.copyOtherSites
    }
  }).onOk(({ sourceSiteId, sourceNavId }) => copyFrom(sourceSiteId, sourceNavId))
}

/**
 * Appends a source menu's items onto this one, matching 2.5.x's merge-onto-existing "copy from
 * locale" behavior -- `replace` is not offered from here, since this editor always already has a
 * loaded, editable list of its own, and appending is the natural fit for that.
 *
 * Reloads from the server afterwards rather than splicing the response in locally, and warns the
 * admin to check the copied items: item `target` paths travel over unrewritten (a page path valid in
 * the source locale or site is not guaranteed to mean anything in this one), which is the same
 * best-effort limitation 2.5.x had.
 */
async function copyFrom(sourceSiteId, sourceNavId) {
  state.loading++
  try {
    await API_CLIENT.post(`sites/${props.siteId}/navigation/${props.navId}/copy`, {
      json: { sourceSiteId, sourceNavId, mode: 'append' }
    }).json()
    await loadMenuItems()
    // -> OpenProject #1012: this already persisted server-side, unlike the rest of this editor's
    //    changes -- see the `copied` event's own doc comment above for why the host needs telling.
    emit('copied')
    notify({
      type: 'warning',
      message: t('navEdit.copyFromWarn')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
  state.loading--
}

/** Reloads the menu's items and the group list — the host calls this once `navId` is known. */
async function load() {
  await Promise.all([loadMenuItems(), loadGroups(), loadCopySources()])
}

// EXPOSED

/** Whether an initial load or a group fetch is in flight. */
const loading = computed(() => state.loading > 0)

defineExpose({
  loading,
  load,
  buildSaveItems
})

// WATCHERS

watch(loading, (v) => emit('update:loading', v), { immediate: true })

// MOUNTED

onMounted(load)
</script>

<style lang="scss" scoped>
/*
  -- Cobalt (Task #2802) ----------------------------------------------------------------
  `ui-redesign-nav/HANDOFF.md` §2, Cobalt column, on top of the Ledger restyle below (Task #2801) --
  every value here is a `var(--color-*)`/`var(--radius-*)` reference onto `tailwind.css`'s
  `body.body--cobalt` token block (Task #2767), the same way the Ledger rules read literal SCSS
  `$variables` and the `body--dark` rules read the dark ones -- never a hardcoded hex.

  Two values the handoff calls for have no token in that block yet, and are flagged rather than
  hardcoded (see the two comments below that name them): the Cobalt "faint rule" `#eef1fb` (property
  card internal rules) and the Cobalt "slate button" text `#1e2a5e` (this file's own outline-button
  text and callout copy).

  A THIRD, larger gap: this file's several `color="primary"` / `color="negative"` / `toggle-color=
  "primary"` usages (the Add button, Delete button, and every Visibility segmented control) resolve
  to `var(--q-primary)` / `var(--q-accent)` / `var(--q-negative)` -- the admin-configurable brand
  colors, which `tailwind.css`'s own comment says get their per-aesthetic DEFAULT from
  `helpers/aestheticDefaults.js` (Task #2768), not a `body.body--cobalt` block here. That file does
  not exist yet, so none of those controls currently follow the aesthetic at all (they stay whatever
  `--q-primary`/`--q-accent`/`--q-negative` resolve to site-wide) -- left untouched here rather than
  hardcoding the handoff's `#c8303c` into this one file's buttons, which would only be right until an
  admin picks a different accent and would still leave every OTHER `color="primary"` button on this
  page (there are none besides Add/Delete/the segmented controls) inconsistent with it.
*/

/*
  The Ledger drawer: the sidebar's own tint (`var(--color-tint-alt)`), not a fixed dark panel -- the drawer used
  to be `bg-dark-6` regardless of the site's theme, which is gone along with the last hardcoded dark
  surface in this file. `body--dark` gets its own step of the app's existing dark ramp instead, the
  same way `TableEditorOverlay` does.
*/
.nav-edit-drawer {
  background-color: var(--color-tint-alt);
  border-inline-end: 1px solid var(--color-hairline);
}

:global(body.body--dark .nav-edit-drawer) {
  background-color: var(--color-dark-4);
  border-inline-end-color: var(--color-hairline-dark);
}

/*
  Cobalt: the reader-facing sidebar's own indigo ground (`--color-admin-sidebar-bg`, `#10194a`),
  matching the handoff's "the sidebar indigo, no border" -- the drawer's Ledger tint and Cobalt's dark
  ground are different ROLES (a light tint strip vs. the sidebar itself), which is why this is a
  `body--cobalt` override rather than the same token the Ledger rule above already reads.
*/
:global(body.body--cobalt .nav-edit-drawer) {
  background-color: var(--color-admin-sidebar-bg);
  border-inline-end: 0;
}

.nav-edit-drawer-header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 38px;
  box-sizing: border-box;
  padding: 0 14px 0 18px;
  border-bottom: 1px solid var(--color-hairline);
}

:global(body.body--dark .nav-edit-drawer-header) {
  border-bottom-color: var(--color-hairline-dark);
}

:global(body.body--cobalt .nav-edit-drawer-header) {
  height: 40px;
  border-bottom-color: var(--color-sidebar-hairline);
}

.nav-edit-drawer-eyebrow {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--color-slate);
}

:global(body.body--dark .nav-edit-drawer-eyebrow) {
  color: var(--color-slate-light);
}

:global(body.body--cobalt .nav-edit-drawer-eyebrow) {
  color: var(--color-sidebar-kicker);
}

.nav-edit-drawer-count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 500;
  color: var(--color-slate);
  background-color: var(--color-surface);
  border: 1px solid var(--color-hairline);
  padding: 1px 6px;
}

:global(body.body--dark .nav-edit-drawer-count) {
  color: var(--color-text-dark);
  background-color: var(--color-dark-3);
  border-color: var(--color-hairline-dark);
}

:global(body.body--cobalt .nav-edit-drawer-count) {
  color: var(--color-sidebar-text);
  background-color: rgb(255 255 255 / 0.1);
  border: 0;
  border-radius: var(--radius-pill);
}

.nav-edit {
  height: 100%;

  .handle {
    cursor: grab;
    color: var(--color-slate-faint);
  }

  /* -> A rule between nav items is content here, not trim */
  .nav-edit-item-separator .w-separator {
    --w-hairline-color: #{var(--color-rule)};
  }
}

:global(body.body--dark .nav-edit .nav-edit-item-separator .w-separator) {
  --w-hairline-color: #{var(--color-border-dark)};
}

/*
  Cobalt: the grip handle and the separator's own rule both sit on the dark drawer ground now, so
  both move to a translucent-white tone rather than the light-drawer slate above -- the handle to the
  handoff's own row-glyph "disabled" value (`--color-text-caption`, `#5a6699`), the rule to the same
  on-dark translucency the generated block's dashed border uses below.
*/
:global(body.body--cobalt .nav-edit .handle) {
  color: var(--color-text-caption);
}

:global(body.body--cobalt .nav-edit .nav-edit-item-separator .w-separator) {
  --w-hairline-color: rgb(255 255 255 / 0.18);
}

.nav-edit-mixed-hint {
  padding: 10px 18px 0;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--color-text-caption);
}

:global(body.body--dark .nav-edit-mixed-hint) {
  color: var(--color-text-secondary-dark);
}

:global(body.body--cobalt .nav-edit-mixed-hint) {
  color: var(--color-sidebar-text-secondary);
}

.nav-edit-list {
  padding: 12px 0 0;
}

/*
  Cobalt: "padding/row-gap/radius matching `NavSidebar.vue` in Cobalt" (Task #2802's own description)
  -- `--radius-control` gives each row Cobalt's 6px row radius (and is `0` in Ledger, so applying it
  unconditionally below on `.nav-edit-item` is a no-op there). The row gap is approximated as a
  bottom margin per row rather than a flex `gap`, since `sortable`'s items are plain block children
  (see the template's own comment on why there is exactly one root node per item) rather than a flex
  container this could add `gap` to directly.
*/
:global(body.body--cobalt .nav-edit-list) {
  padding: 14px 10px 0;
}

:global(body.body--cobalt .nav-edit-item) {
  margin-bottom: 2px;
  border-radius: var(--radius-control);
}

.nav-edit-item {
  position: relative;
  color: var(--color-slate);
  cursor: pointer;

  &.is-active {
    background-color: var(--color-surface);
    border-inline-start: 2px solid var(--color-accent-fill);
    color: var(--color-ink);
    font-weight: 500;

    .handle {
      color: var(--color-slate-soft);
    }
  }

  &.sortable-chosen {
    background-color: var(--color-tint);
  }

  /*
    A `mixed` menu's generated block, styled apart from what this menu actually owns: dimmed and not
    grab-cursored (the handle icon is simply omitted for one -- see the template), so a glance at the
    list already tells the two apart before reading either the mixed-hint above the list or the detail
    panel's disabled fields.
  */
  &.is-generated {
    color: var(--color-slate-faint);
    cursor: default;
  }

  /*
    The boundary itself, marked with a rule rather than an extra element: see the template comment on
    `sortable`'s `#item` slot for why a divider cannot be a sibling DOM node here.
  */
  &.is-generated + &:not(.is-generated),
  &:not(.is-generated) + &.is-generated {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 2px dashed var(--color-slate-pale);
  }
}

:global(body.body--dark .nav-edit-item) {
  color: var(--color-text-secondary-dark);

  &.is-active {
    background-color: var(--color-dark-3);
    color: var(--color-text-dark);
  }

  &.is-generated {
    color: var(--color-text-caption-dark);
  }
}

/*
  Cobalt: the row-type tables in the handoff give each row kind its own on-dark text tone (header
  `#7f8ed1`, link `#d7deff`, generated `#5a6699`, ...) rather than one uniform row color the way
  Ledger's `var(--color-slate)` is -- the base color here is the Link row's own tone (`--color-sidebar-text`),
  and the header/generated rows below override it more specifically. `.is-active`'s ground reuses
  `--nav-active-inset` (already the exact composite box-shadow the handoff calls for) rather than a
  border, since Cobalt's selected row is an inset accent bar, not a Ledger-style border.
*/
:global(body.body--cobalt .nav-edit-item) {
  color: var(--color-sidebar-text);

  &.is-active {
    background-color: var(--color-accent-strong);
    box-shadow: var(--nav-active-inset);
    color: var(--color-white);
    font-weight: 600;

    /* -> Flagged: the handoff's own selected-row grip (`#c9d6ff`) has no token; nearest is the
          sidebar's own on-dark text tone. */
    .handle {
      color: var(--color-sidebar-text);
    }
  }

  &.sortable-chosen {
    /* -> Not spec'd explicitly for Cobalt; a faint lift off the dark ground, matching the same
          translucent-white treatment the generated block and nested run use below. */
    background-color: rgb(255 255 255 / 0.06);
  }

  &.is-generated {
    color: var(--color-text-caption);
  }

  &.is-generated + &:not(.is-generated),
  &:not(.is-generated) + &.is-generated {
    border-top-color: rgb(255 255 255 / 0.22);
  }
}

/*
  The generated block's own eyebrow ("From the page tree"), drawn once above the run rather than on
  every generated row -- present in the DOM on every one (so there is exactly one root node per
  `sortable` `#item`, per the template's own comment) and shown by CSS only on the row a manual item
  (or nothing) precedes.
*/
.nav-edit-generated-eyebrow {
  display: none;
  flex-basis: 100%;
  padding-bottom: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--color-slate-faint);
}

.nav-edit-item:not(.is-generated) + .nav-edit-item.is-generated .nav-edit-generated-eyebrow,
.nav-edit-list .nav-edit-item.is-generated:first-child .nav-edit-generated-eyebrow {
  display: block;
}

:global(body.body--dark .nav-edit-generated-eyebrow) {
  color: var(--color-text-caption-dark);
}

:global(body.body--cobalt .nav-edit-generated-eyebrow) {
  color: var(--color-text-caption);
}

.nav-edit-item-header {
  display: flex;
  align-items: center;
  padding: 6px 10px 6px 18px !important;

  .w-item-label--header {
    padding: 0;
    color: inherit;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }
}

:global(body.body--cobalt .nav-edit-item-header) {
  padding: 6px 10px !important;
  color: var(--color-sidebar-kicker);
}

.nav-edit-item-link {
  /*
    OpenProject #2825: the row itself has only ONE main section (icon + label + trailing handle),
    so `WItem.vue`'s shared `flex-wrap: wrap` never turns on -- that is scoped to
    `:has(.w-item-section--main + .w-item-section--main)`, the two-main-section "settings row"
    shape from #2822/#2823, deliberately narrowed to avoid touching an ordinary menu/nav row like
    this one. But the generated-eyebrow span below (`.nav-edit-generated-eyebrow`, `flex-basis:
    100%`) still needs somewhere to wrap TO when it's shown, or it just steals space on the row's
    one unwrapped line and squeezes the icon/label/handle into whatever is left. A local,
    unconditional `flex-wrap: wrap` here is inert for the ordinary (non-generated) row -- nothing
    else on this row ever claims a 100% flex-basis -- so it only ever does anything once the
    eyebrow is present.
  */
  flex-wrap: wrap;
  padding: 7px 10px 7px 18px !important;
  font-size: 13.5px;

  &.is-active {
    padding-inline-start: 16px !important;
  }

  /*
    OpenProject #2885: a nested row used to be marked with the same rail + background-wash +
    mitred-elbow construction `NavSidebar.vue` drew for an open group's children -- #2827 already
    dropped that reading there, and this ports the identical fix here so both views of the tree
    stop disagreeing. Indentation is the only nesting cue left; the 10px border-inline-start stays
    (it is the one thing providing it -- nothing else on this row declares content padding for it)
    but goes transparent, and the mitred `::before` elbow that used to turn it out of the row above
    is gone outright, along with its per-theme colour overrides below.
  */
  &.is-nested {
    margin-inline-start: 18px;
    padding: 7px 10px 7px 14px !important;
    font-size: 13px;
    border-inline-start: 10px solid transparent;

    &.is-active {
      padding-inline-start: 12px !important;
    }
  }
}

/*
  Cobalt: "Link | ... padding 7px 10px 7px 18px | `#d7deff`, icon `#7f8ed1`, 8px 10px" -- a shallower,
  symmetric padding (no 18px indent) and a leading-icon color distinct from the row's own text color
  (both currently paint with `currentColor` off `.nav-edit-item`'s single color -- see that rule's own
  Cobalt override above for the text half). `:not(.handle)` excludes the trailing grip, which keeps
  its own color from the `.handle` rule.
*/
:global(body.body--cobalt .nav-edit-item-link) {
  padding: 8px 10px !important;

  &.is-active {
    padding-inline-start: 10px !important;
  }
}

:global(body.body--cobalt .nav-edit-item-link .w-icon:not(.handle)) {
  color: var(--color-sidebar-icon);
}

/*
  Cobalt keeps its own, shallower indent than Ledger's 18px -- the rail/wash/radius/text-tone
  that used to go with it were the same #2827-style darkening this whole rule was gutted for
  above, so nothing else survives here either.
*/
:global(body.body--cobalt .nav-edit-item-link.is-nested) {
  margin-inline-start: 10px;
}

/*
  Orphaned nested row: a nested link with nothing valid above it to nest under (the very first item in
  the list, or one immediately following a header/separator) -- flagged the way `nestingWarn` promises,
  in the accent wash rather than the app's generic `var(--color-negative)`.
*/
.nav-edit-item-header,
.nav-edit-item-separator {
  & + .nav-edit-item-link.is-nested {
    background-color: var(--color-accent-wash) !important;
    border-inline-start-color: var(--color-accent-fill) !important;
    color: var(--color-primary);
  }
}

.nav-edit-list .nav-edit-item-link.is-nested:first-child {
  background-color: var(--color-accent-wash) !important;
  border-inline-start-color: var(--color-accent-fill) !important;
  color: var(--color-primary);
}

:global(body.body--dark .nav-edit-item-header + .nav-edit-item-link.is-nested),
:global(body.body--dark .nav-edit-item-separator + .nav-edit-item-link.is-nested),
:global(body.body--dark .nav-edit-list .nav-edit-item-link.is-nested:first-child) {
  background-color: var(--color-accent-wash-dark) !important;
  border-inline-start-color: var(--color-accent-dark) !important;
  color: var(--color-accent-dark);
}

/*
  Cobalt: "ground `rgba(255,77,90,.16)`, rail `#ff4d5a`" -- that rgba is `--color-accent-fill` itself
  (`#ff4d5a` = `rgb(255 77 90)`) at 16% opacity, so it is written as the decomposed rgb() triplet
  rather than a `color-mix()`/relative-color expression this codebase does not otherwise use.
*/
:global(body.body--cobalt .nav-edit-item-header + .nav-edit-item-link.is-nested),
:global(body.body--cobalt .nav-edit-item-separator + .nav-edit-item-link.is-nested),
:global(body.body--cobalt .nav-edit-list .nav-edit-item-link.is-nested:first-child) {
  background-color: rgb(255 77 90 / 0.16) !important;
  border-inline-start-color: var(--color-accent-fill) !important;
  color: var(--color-accent-fill);
}

.nav-edit-item-separator {
  display: flex;
  align-items: center;
  padding: 9px 10px 9px 18px !important;
}

.nav-edit-bottombar {
  flex: none;
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--color-hairline);
}

:global(body.body--dark .nav-edit-bottombar) {
  border-top-color: var(--color-hairline-dark);
}

:global(body.body--cobalt .nav-edit-bottombar) {
  padding: 12px 14px;
  border-top-color: var(--color-sidebar-hairline);
}

/* -- Right panel -------------------------------------------------------- */

.nav-edit-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.nav-edit-callout {
  display: flex;
  max-width: 760px;
  border: 1px solid var(--color-hairline);
  background-color: var(--color-surface);

  &__icon {
    flex: none;
    width: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--color-tint);
    border-inline-end: 1px solid var(--color-hairline);
    color: var(--color-text-secondary);
  }

  p {
    margin: 0;
    padding: 12px 16px;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--color-slate);
  }
}

:global(body.body--dark .nav-edit-callout) {
  border-color: var(--color-hairline-dark);
  background-color: var(--color-dark-3);
}

:global(body.body--dark .nav-edit-callout__icon) {
  background-color: var(--color-dark-4);
  border-inline-end-color: var(--color-hairline-dark);
  color: var(--color-text-secondary-dark);
}

:global(body.body--dark .nav-edit-callout p) {
  color: var(--color-text-dark);
}

/*
  Cobalt: "`#e6edff`, `border-left: 3px solid #1f4fd6`, radius 6px, text `#1e2a5e`" -- a flat tinted
  card with an accent-colored start border, rather than Ledger's bordered box with a separate icon
  gutter, so the gutter div's own background/divider are cleared below rather than restyled to match.
  `#1e2a5e` (the same "slate button" gap the overlay header's Cancel button flags) has no token yet;
  `--color-text-secondary` is the nearest existing one.
*/
:global(body.body--cobalt .nav-edit-callout) {
  border: 0;
  border-inline-start: 3px solid var(--color-accent-strong);
  border-radius: var(--radius-control);
  background-color: var(--color-tint);
}

:global(body.body--cobalt .nav-edit-callout__icon) {
  background-color: transparent;
  border-inline-end: 0;
  color: var(--color-accent-strong);
}

:global(body.body--cobalt .nav-edit-callout p) {
  color: var(--color-text-secondary);
}

/*
  Cobalt shape (Task #2767's own shape tokens): `--radius-card`/`--shadow-card` are `0`/`none` in
  Ledger, so applying them here unconditionally (rather than behind a `body--cobalt` guard) changes
  nothing there and gives Cobalt "white, radius 8px" with a hairline ring in place of a drop shadow
  (OpenProject #2856's matte pass) with no separate override block needed. `overflow: hidden` is NOT
  included here, unlike `.nav-edit-structure-card`
  below -- Ledger's own corner marks (`.nav-edit-card__corner`, right below) are absolutely positioned
  OUTSIDE this card's box on purpose, to overhang the edge by 4px, and `overflow: hidden` would clip
  them; it is added Cobalt-only instead, once the marks are already hidden there (`--corner-marks:
  none`).
*/
.nav-edit-card {
  max-width: 760px;
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}

:global(body.body--cobalt .nav-edit-card) {
  overflow: hidden;
}

.nav-edit-card--disabled {
  opacity: 0.55;
  pointer-events: none;
}

/*
  The property card's own corner marks -- four short strokes at 7px, overhanging the card by 4px, in
  the icon-stroke slate. Real elements rather than a `::before`/`::after` pair (only two pseudo-
  elements are available and four corners are needed), the same way the design's own reference draws
  them.

  `display: var(--corner-marks)` is the same shape token every registration mark in the app answers
  to (`block` in Ledger, `none` in Cobalt, where the card carries a radius and a shadow instead) --
  not a `body--cobalt` override, since the token already IS the per-aesthetic switch.
*/
.nav-edit-card__corner {
  position: absolute;
  display: var(--corner-marks);
  width: 7px;
  height: 7px;
  border-style: solid;
  border-width: 0;
  border-color: var(--color-slate-soft);
  pointer-events: none;
}

.nav-edit-card__corner--tl {
  top: -4px;
  inset-inline-start: -4px;
  border-top-width: 1px;
  border-inline-start-width: 1px;
}

.nav-edit-card__corner--tr {
  top: -4px;
  inset-inline-end: -4px;
  border-top-width: 1px;
  border-inline-end-width: 1px;
}

.nav-edit-card__corner--bl {
  bottom: -4px;
  inset-inline-start: -4px;
  border-bottom-width: 1px;
  border-inline-start-width: 1px;
}

.nav-edit-card__corner--br {
  bottom: -4px;
  inset-inline-end: -4px;
  border-bottom-width: 1px;
  border-inline-end-width: 1px;
}

.nav-edit-card__header {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 38px;
  box-sizing: border-box;
  padding: 0 14px;
  background-color: var(--color-tint);
  border-bottom: 1px solid var(--color-hairline);
  color: var(--color-slate);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

:global(body.body--dark .nav-edit-card__header) {
  background-color: var(--color-dark-2);
  border-bottom-color: var(--color-hairline-dark);
  color: var(--color-slate-light);
}

/*
  Cobalt: "40px white, rule `#eef1fb`; type name Barlow Condensed 600 16px `#1f4fd6`" -- white rather
  than tinted, a taller band, and the display face/size/color the handoff gives the type name (Ledger
  keeps the mono eyebrow treatment instead). `#eef1fb` (the Cobalt "faint rule") has no token yet;
  `--color-hairline` is the nearest existing divider.
*/
:global(body.body--cobalt .nav-edit-card__header) {
  height: 40px;
  background-color: var(--color-white);
  border-bottom-color: var(--color-hairline);
  color: var(--color-accent-strong);
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: normal;
  text-transform: none;
}

.nav-edit-parent-badge {
  margin-inline-start: auto;
  border: 1px solid var(--color-slate-soft);
  padding: 2px 6px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

/* Cobalt: "badge `#e6edff` / `#1a3fb0`, radius 4px" -- a filled tag-style badge, not an outline. */
:global(body.body--cobalt .nav-edit-parent-badge) {
  border: 0;
  border-radius: var(--radius-mark);
  background-color: var(--color-tint);
  color: var(--color-tag-chip-text);
}

.nav-edit-structure-card {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 16px;
  max-width: 760px;
  padding: 12px 14px;
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.nav-edit-structure-card__nest {
  display: flex;
  flex: 1 1 280px;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
}

.nav-edit-structure-card__buttons {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.nav-edit-structure-card__caption {
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-caption);
}

:global(body.body--dark .nav-edit-structure-card__caption) {
  color: var(--color-text-secondary-dark);
}

:global(body.body--cobalt .nav-edit-structure-card__caption) {
  color: var(--color-text-secondary);
}

/*
  Cobalt: "glyphs indent-increase / indent-decrease, text `#38465f` / `#1f4fd6`" -- `color="slate"`
  sets `var(--color-slate)` as an inline style (same non-aesthetic-token reasoning as the overlay
  header's Cancel button), so this needs the same `!important` override. Unlike Cancel's, this one
  has a real Cobalt token: `--color-accent-strong` is exactly the `#1f4fd6` the handoff calls for.
*/
:global(body.body--cobalt .nav-edit-structure-btn) {
  color: var(--color-accent-strong) !important;
}
</style>
