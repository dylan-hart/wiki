<template>
  <w-drawer class="bg-dark-6" :model-value="true" :width="295" dark>
    <w-scroll-area class="nav-edit">
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
                name="mdi:drag-horizontal"
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
            <w-item-section side><w-icon :name="element.icon" color="white" /></w-item-section>
            <w-item-section class="text-wordbreak-all">{{ element.label }}</w-item-section>
            <w-item-section side>
              <w-icon
                v-if="!element.generated"
                class="handle"
                name="mdi:drag-horizontal"
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
            <w-separator dark inset style="flex: 1; margin-top: 11px" />
            <w-item-section side>
              <w-icon
                v-if="!element.generated"
                class="handle"
                name="mdi:drag-horizontal"
                size="sm" />
            </w-item-section>
          </div>
        </template>
      </sortable>
      <div class="p-4 flex" v-if="!isAuto">
        <w-btn
          class="acrylic-btn"
          style="flex: 1"
          flat
          color="positive"
          :label="t(`common.actions.add`)"
          :aria-label="t(`common.actions.add`)"
          icon="la:plus">
          <w-menu fit :offset="[0, 10]" auto-close>
            <w-list separator>
              <w-item clickable @click="addItem(`header`)">
                <w-item-section side><w-icon name="la:heading" /></w-item-section>
                <w-item-section>
                  <w-item-label>{{ t('navEdit.header') }}</w-item-label>
                </w-item-section>
              </w-item>
              <w-item clickable @click="addItem(`link`)">
                <w-item-section side><w-icon name="la:link" /></w-item-section>
                <w-item-section>
                  <w-item-label>{{ t('navEdit.link') }}</w-item-label>
                </w-item-section>
              </w-item>
              <w-item clickable @click="addItem(`separator`)">
                <w-item-section side><w-icon name="la:minus" /></w-item-section>
                <w-item-section>
                  <w-item-label>{{ t('navEdit.separator') }}</w-item-label>
                </w-item-section>
              </w-item>
            </w-list>
          </w-menu>
        </w-btn>
        <w-btn
          class="ms-2 acrylic-btn"
          flat
          color="grey"
          :aria-label="t(`common.actions.add`)"
          icon="la:ellipsis-v"
          padding="xs sm">
          <w-menu :offset="[0, 10]" anchor="bottom right" self="top right" auto-close>
            <w-list separator>
              <w-item
                clickable
                @click="clearItems"
                :disabled="!state.items.some((item) => !item.generated)">
                <w-item-section side>
                  <w-icon name="la:trash" color="negative" />
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
                  <w-icon name="mdi:import" />
                </w-item-section>
                <w-item-section>
                  <w-item-label>{{ t('navEdit.copyFrom') }}</w-item-label>
                </w-item-section>
              </w-item>
            </w-list>
          </w-menu>
        </w-btn>
      </div>
    </w-scroll-area>
  </w-drawer>
  <w-page-container>
    <w-page class="p-4">
      <template v-if="state.items.length < 1">
        <w-card>
          <w-card-section>
            <w-icon class="me-2" name="la:arrow-left" size="xs" />
            <span>{{ t('navEdit.emptyMenuText') }}</span>
          </w-card-section>
        </w-card>
      </template>
      <template v-else-if="!state.selected">
        <w-card>
          <w-card-section>
            <w-icon class="me-2" name="la:arrow-left" size="xs" />
            <span>{{ t('navEdit.noSelection') }}</span>
          </w-card-section>
        </w-card>
      </template>
      <template v-if="state.current.type === `header`">
        <w-banner
          v-if="editingDisabled"
          dense
          class="mb-2"
          :class="dark.isActive ? `bg-negative text-white` : `bg-grey-3 text-grey-9`">
          {{ t('navEdit.menuSourceReadOnlyNotice') }}
        </w-banner>
        <w-card class="pb-2" :class="{ 'nav-edit-readonly': editingDisabled }">
          <w-card-section>
            <div class="text-subtitle1">{{ t('navEdit.header') }}</div>
          </w-card-section>
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
                toggle-color="primary"
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
        </w-card>
        <w-card class="p-4 mt-4 flex" v-if="!editingDisabled">
          <w-space />
          <w-btn
            class="acrylic-btn"
            flat
            icon="la:trash"
            :label="t(`common.actions.delete`)"
            color="negative"
            padding="xs md"
            @click="removeItem(state.current.id)" />
        </w-card>
      </template>
      <template v-if="state.current.type === `link`">
        <w-banner
          v-if="editingDisabled"
          dense
          class="mb-2"
          :class="dark.isActive ? `bg-negative text-white` : `bg-grey-3 text-grey-9`">
          {{ t('navEdit.menuSourceReadOnlyNotice') }}
        </w-banner>
        <w-card class="pb-2" :class="{ 'nav-edit-readonly': editingDisabled }">
          <w-card-section
            ><div class="text-subtitle1">{{ t('navEdit.link') }}</div></w-card-section
          >
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
          <w-separator class="my-2" inset />
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
                    icon="la:icons"
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
          <w-separator class="my-2" inset />
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
                      icon="la:folder-open"
                      color="primary"
                      :aria-label="t(`common.actions.browse`)"
                      @click="browseTarget">
                      <w-tooltip>{{ t('common.actions.browse') }}</w-tooltip>
                    </w-btn>
                  </template>
                </w-input>
              </w-item-section>
            </w-item>
            <w-separator class="my-2" inset />
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
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="tabler:users-group" />
            <w-item-section>
              <w-item-label>{{ t(`navEdit.visibility`) }}</w-item-label>
              <w-item-label caption>{{ t(`navEdit.visibilityHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-btn-toggle
                v-model="state.current.visibilityLimited"
                toggle-color="primary"
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
        </w-card>
        <w-card class="p-4 mt-4 flex items-start" v-if="!editingDisabled">
          <div>
            <w-btn
              class="acrylic-btn"
              v-if="state.current.isNested"
              flat
              :label="t(`navEdit.unnestItem`)"
              icon="mdi:format-indent-decrease"
              color="teal"
              padding="xs md"
              @click="state.current.isNested = false" />
            <w-btn
              class="acrylic-btn"
              v-else
              flat
              :label="t(`navEdit.nestItem`)"
              icon="mdi:format-indent-increase"
              color="teal"
              padding="xs md"
              @click="state.current.isNested = true" />
            <div class="text-caption mt-4 text-grey-7">{{ t('navEdit.nestingWarn') }}</div>
          </div>
          <w-space />
          <w-btn
            class="acrylic-btn"
            flat
            icon="la:trash"
            :label="t(`common.actions.delete`)"
            color="negative"
            padding="xs md"
            @click="removeItem(state.current.id)" />
        </w-card>
      </template>
      <template v-if="state.current.type === `separator`">
        <w-banner
          v-if="editingDisabled"
          dense
          class="mb-2"
          :class="dark.isActive ? `bg-negative text-white` : `bg-grey-3 text-grey-9`">
          {{ t('navEdit.menuSourceReadOnlyNotice') }}
        </w-banner>
        <w-card class="pb-2" :class="{ 'nav-edit-readonly': editingDisabled }">
          <w-card-section>
            <div class="text-subtitle1">{{ t('navEdit.separator') }}</div>
          </w-card-section>
          <w-item>
            <blueprint-icon icon="tabler:users-group" />
            <w-item-section>
              <w-item-label>{{ t(`navEdit.visibility`) }}</w-item-label>
              <w-item-label caption>{{ t(`navEdit.visibilityHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-btn-toggle
                v-model="state.current.visibilityLimited"
                toggle-color="primary"
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
        </w-card>
        <w-card class="p-4 mt-4 flex" v-if="!editingDisabled">
          <w-space />
          <w-btn
            class="acrylic-btn"
            flat
            icon="la:trash"
            :label="t(`common.actions.delete`)"
            color="negative"
            padding="xs md"
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
import { useDark } from '@/composables/dark'

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

// DARK MODE

const dark = useDark()

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
const DEFAULT_LINK_ICON = 'mdi:text-box-outline'

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
@use 'sass:color';

/*
  Light ink on an always-dark surface.

  This drawer is dark whatever the site theme is, but the shared components' own dark treatments are
  `dark:` variants -- keyed off `body.body--dark`, i.e. the APP theme. On a light-themed site their
  light-mode colours therefore applied here: `WItemLabel`'s header variant resolved to black at 54%
  and `WItemSection`'s side variant likewise, which on `dark-6` is invisible. WDrawer's `dark` prop
  covers plain inherited text, not a component that states a colour of its own, so each one that does
  is restated here at the value its dark variant would have used.
*/
.nav-edit {
  height: 100%;

  .handle {
    cursor: grab;
    color: rgba(255, 255, 255, 0.7);
  }

  /*
    Same padding NavSidebar gives its own headings: `WItemLabel`'s uniform `p-4` made this row 52px
    against the sidebar's 40px, so a heading looked considerably heavier here than the thing being
    edited.
  */
  .w-item-label--header {
    color: rgba(255, 255, 255, 0.7);
    padding-bottom: 4px;
  }

  /* -> A rule between nav items is content here, not trim: 15% white is too faint to aim at */
  .nav-edit-item-separator .w-separator {
    --w-hairline-color: rgb(255 255 255 / 0.32);
  }
}

.nav-edit-item {
  position: relative;
  &.is-active {
    background-color: $blue-8;
  }

  &.sortable-chosen {
    background-color: $blue-5;
  }

  /*
    A `mixed` menu's generated block, styled apart from what this menu actually owns: dimmed and not
    grab-cursored (the handle icon is simply omitted for one -- see the template -- so there is nothing
    left here to restyle for that), so a glance at the list already tells the two apart before reading
    either `.nav-edit-mixed-hint` above the list or the detail panel's disabled fields.
  */
  &.is-generated {
    opacity: 0.6;
    cursor: default;
  }

  /*
    The boundary itself, marked with a rule rather than an extra element: see the template comment on
    `sortable`'s `#item` slot for why a divider cannot be a sibling DOM node here.
  */
  &.is-generated + &:not(.is-generated),
  &:not(.is-generated) + &.is-generated {
    border-top: 2px dashed rgba(255, 255, 255, 0.35);
  }
}

.nav-edit-mixed-hint {
  padding: 8px 16px 0;
  color: rgba(255, 255, 255, 0.6);
}

/*
  Mutes and inerts a generated item's own detail panel -- `pointer-events: none` reaches every field
  regardless of what the shared component library renders each one as underneath (a native `<input>`,
  a `<button>`, a plain clickable `<div>`), which a native `disabled` attribute on each field could not
  promise without auditing every one of them individually.
*/
.nav-edit-readonly {
  opacity: 0.6;
  pointer-events: none;
}

.nav-edit-item-header {
  display: flex;
  cursor: pointer;
}
.nav-edit-item-link {
  &.is-nested {
    border-left: 10px solid $dark-1;
    background-color: $dark-4;
    &.is-active {
      background-color: $primary;
    }

    & + div:not(.is-nested) {
      &::before {
        content: '';
        display: 'block';
        position: absolute;
        top: 0;
        left: 0;
        width: 10px;
        height: 10px;
        border-style: solid;
        border-color: $dark-1 transparent transparent $dark-1;
        border-width: 10px 10px 10px 0;
      }
    }
  }

  &:not(.is-nested) + &.is-nested {
    &::before {
      content: '';
      display: 'block';
      position: absolute;
      top: -10px;
      left: -10px;
      width: 10px;
      height: 10px;
      border-style: solid;
      border-color: transparent transparent $dark-1 $dark-1;
      border-width: 0 10px 10px 0;
    }
  }
}
.nav-edit-item-separator {
  display: flex;
  cursor: pointer;
}

.nav-edit-item-header,
.nav-edit-item-separator {
  & + .nav-edit-item-link.is-nested {
    background-color: $negative !important;
    border-left-color: color.adjust($negative, $lightness: -10%) !important;

    & + div:not(.is-nested) {
      &::before {
        display: none !important;
      }
    }
  }
}

.nav-edit-list {
  .nav-edit-item-separator + .nav-edit-item-header > .w-item-label {
    padding-top: 8px;
  }

  .is-nested:first-child {
    background-color: $negative !important;
    border-left-color: color.adjust($negative, $lightness: -10%) !important;

    & + div:not(.is-nested) {
      &::before {
        display: none !important;
      }
    }
  }
}
</style>
