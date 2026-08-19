<template>
  <w-drawer class="bg-dark-6" :model-value="true" :width="295" dark>
    <w-scroll-area class="nav-edit" :thumb-style="thumbStyle" :bar-style="barStyle">
      <!--
        The `q-list q-list--dense q-list--dark` this carried were the old framework's classes and
        nothing defines them any more, which is why the rows had drifted to full height: the density
        now comes from `dense` on each item, matching what NavSidebar renders.
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
            :class="state.selected === element.id ? `is-active` : ``"
            @click="setItem(element)">
            <w-item-label class="text-caption" header>{{ element.label }}</w-item-label>
            <w-space />
            <w-item-section side>
              <w-icon class="handle" name="mdi:drag-horizontal" size="sm" />
            </w-item-section>
          </div>
          <w-item
            class="nav-edit-item nav-edit-item-link"
            v-else-if="element.type === `link`"
            dense
            :class="{ 'is-active': state.selected === element.id, 'is-nested': element.isNested }"
            @click="setItem(element)"
            clickable>
            <w-item-section side><w-icon :name="element.icon" color="white" /></w-item-section>
            <w-item-section class="text-wordbreak-all">{{ element.label }}</w-item-section>
            <w-item-section side>
              <w-icon class="handle" name="mdi:drag-horizontal" size="sm" />
            </w-item-section>
          </w-item>
          <div
            class="nav-edit-item nav-edit-item-separator"
            v-else
            :class="state.selected === element.id ? `is-active` : ``"
            @click="setItem(element)">
            <w-separator dark inset style="flex: 1; margin-top: 11px" />
            <w-item-section side>
              <w-icon class="handle" name="mdi:drag-horizontal" size="sm" />
            </w-item-section>
          </div>
        </template>
      </sortable>
      <div class="p-4 flex">
        <w-btn
          class="acrylic-btn"
          style="flex: 1"
          flat
          color="positive"
          :label="t(`common.actions.add`)"
          :aria-label="t(`common.actions.add`)"
          icon="la:plus-circle">
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
          class="ml-2 acrylic-btn"
          flat
          color="grey"
          :aria-label="t(`common.actions.add`)"
          icon="la:ellipsis-v"
          padding="xs sm">
          <w-menu :offset="[0, 10]" anchor="bottom right" self="top right" auto-close>
            <w-list separator>
              <w-item clickable @click="clearItems" :disable="state.items.length < 1">
                <w-item-section side>
                  <w-icon name="la:trash-alt" color="negative" />
                </w-item-section>
                <w-item-section>
                  <w-item-label>{{ t('navEdit.clearItems') }}</w-item-label>
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
            <w-icon class="mr-2" name="la:arrow-left" size="xs" />
            <span>{{ t('navEdit.emptyMenuText') }}</span>
          </w-card-section>
        </w-card>
      </template>
      <template v-else-if="!state.selected">
        <w-card>
          <w-card-section>
            <w-icon class="mr-2" name="la:arrow-left" size="xs" />
            <span>{{ t('navEdit.noSelection') }}</span>
          </w-card-section>
        </w-card>
      </template>
      <template v-if="state.current.type === `header`">
        <w-card class="pb-2">
          <w-card-section>
            <div class="text-subtitle1">{{ t('navEdit.header') }}</div>
          </w-card-section>
          <w-item>
            <blueprint-icon icon="typography" />
            <w-item-section>
              <w-item-label>{{ t(`navEdit.label`) }}</w-item-label>
              <w-item-label caption>{{ t(`navEdit.labelHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-input
                outlined
                v-model="state.current.label"
                dense
                hide-bottom-space
                :aria-label="t(`navEdit.label`)" />
            </w-item-section>
          </w-item>
          <w-item>
            <blueprint-icon icon="user-groups" />
            <w-item-section>
              <w-item-label>{{ t(`navEdit.visibility`) }}</w-item-label>
              <w-item-label caption>{{ t(`navEdit.visibilityHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-btn-toggle
                v-model="state.current.visibilityLimited"
                push
                glossy
                no-caps
                toggle-color="primary"
                :options="visibilityOptions" />
            </w-item-section>
          </w-item>
          <w-item class="items-center" v-if="state.current.visibilityLimited">
            <w-space />
            <div class="text-caption mr-4">{{ t('navEdit.selectGroups') }}</div>
            <w-select
              style="width: 100%; max-width: calc(50% - 34px)"
              outlined
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
        <w-card class="p-4 mt-4 flex">
          <w-space />
          <w-btn
            class="acrylic-btn"
            flat
            icon="la:trash-alt"
            :label="t(`common.actions.delete`)"
            color="negative"
            padding="xs md"
            @click="removeItem(state.current.id)" />
        </w-card>
      </template>
      <template v-if="state.current.type === `link`">
        <w-card class="pb-2">
          <w-card-section
            ><div class="text-subtitle1">{{ t('navEdit.link') }}</div></w-card-section
          >
          <w-item>
            <blueprint-icon icon="typography" />
            <w-item-section>
              <w-item-label>{{ t(`navEdit.label`) }}</w-item-label>
              <w-item-label caption>{{ t(`navEdit.labelHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-input
                outlined
                v-model="state.current.label"
                dense
                hide-bottom-space
                :aria-label="t(`navEdit.label`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="spring" />
            <w-item-section>
              <w-item-label>{{ t(`navEdit.icon`) }}</w-item-label>
              <w-item-label caption>{{ t(`navEdit.iconHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-input outlined v-model="state.current.icon" dense :aria-label="t(`navEdit.icon`)">
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
              <blueprint-icon icon="chevron-right" />
              <w-item-section>
                <w-item-label>{{ t(`navEdit.expandByDefault`) }}</w-item-label>
                <w-item-label caption>{{ t(`navEdit.expandByDefaultHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section avatar>
                <w-toggle
                  v-model="state.current.expandByDefault"
                  color="primary"
                  checked-icon="la:check"
                  unchecked-icon="la:times"
                  :aria-label="t(`navEdit.expandByDefault`)" />
              </w-item-section>
            </w-item>
          </template>
          <template v-else>
            <w-item>
              <blueprint-icon icon="link" />
              <w-item-section>
                <w-item-label>{{ t(`navEdit.target`) }}</w-item-label>
                <w-item-label caption>{{ t(`navEdit.targetHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section>
                <w-input
                  outlined
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
              <blueprint-icon icon="external-link" />
              <w-item-section>
                <w-item-label>{{ t(`navEdit.openInNewWindow`) }}</w-item-label>
                <w-item-label caption>{{ t(`navEdit.openInNewWindowHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section avatar>
                <w-toggle
                  v-model="state.current.openInNewWindow"
                  color="primary"
                  checked-icon="la:check"
                  unchecked-icon="la:times"
                  :aria-label="t(`navEdit.openInNewWindow`)" />
              </w-item-section>
            </w-item>
          </template>
          <w-separator class="my-2" inset />
          <w-item>
            <blueprint-icon icon="user-groups" />
            <w-item-section>
              <w-item-label>{{ t(`navEdit.visibility`) }}</w-item-label>
              <w-item-label caption>{{ t(`navEdit.visibilityHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-btn-toggle
                v-model="state.current.visibilityLimited"
                push
                glossy
                no-caps
                toggle-color="primary"
                :options="visibilityOptions" />
            </w-item-section>
          </w-item>
          <w-item class="items-center" v-if="state.current.visibilityLimited">
            <w-space />
            <div class="text-caption mr-4">{{ t('navEdit.selectGroups') }}</div>
            <w-select
              style="width: 100%; max-width: calc(50% - 34px)"
              outlined
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
        <w-card class="p-4 mt-4 flex items-start">
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
            icon="la:trash-alt"
            :label="t(`common.actions.delete`)"
            color="negative"
            padding="xs md"
            @click="removeItem(state.current.id)" />
        </w-card>
      </template>
      <template v-if="state.current.type === `separator`">
        <w-card class="pb-2">
          <w-card-section>
            <div class="text-subtitle1">{{ t('navEdit.separator') }}</div>
          </w-card-section>
          <w-item>
            <blueprint-icon icon="user-groups" />
            <w-item-section>
              <w-item-label>{{ t(`navEdit.visibility`) }}</w-item-label>
              <w-item-label caption>{{ t(`navEdit.visibilityHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-btn-toggle
                v-model="state.current.visibilityLimited"
                push
                glossy
                no-caps
                toggle-color="primary"
                :options="visibilityOptions" />
            </w-item-section>
          </w-item>
          <w-item class="items-center" v-if="state.current.visibilityLimited">
            <w-space />
            <div class="text-caption mr-4">{{ t('navEdit.selectGroups') }}</div>
            <w-select
              style="width: 100%; max-width: calc(50% - 34px)"
              outlined
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
        <w-card class="p-4 mt-4 flex">
          <w-space />
          <w-btn
            class="acrylic-btn"
            flat
            icon="la:trash-alt"
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
  'update:loading'
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
  groups: []
})

/**
 * The icon a new link item starts with.
 *
 * An Iconify reference, so that the icon picker opens on its search tab with this one selected, and so
 * that the sidebar draws it through `w-icon` like every other item. Kept to `mdi`, a set seeded on
 * every instance.
 */
const DEFAULT_LINK_ICON = 'mdi:text-box-outline'

const sortableOptions = {
  handle: '.handle',
  animation: 150
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

const thumbStyle = {
  right: '2px',
  borderRadius: '5px',
  backgroundColor: '#FFF',
  width: '5px',
  opacity: 0.5
}
const barStyle = {
  backgroundColor: '#000',
  width: '9px',
  opacity: 0.1
}

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
  state.items = state.items.filter((item) => item.id !== id)
  state.selected = null
  state.current = {}
}

function clearItems() {
  state.items = []
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
      caption: apiErrorMessage(err, 'An unexpected error occured.')
    })
  }
  state.loading--
}

async function loadMenuItems() {
  state.loading++
  try {
    // -> `full`, because the editor has to see items limited to groups the editor is not in: saving
    //    without them would delete them
    const items = await API_CLIENT.get(`sites/${props.siteId}/navigation/${props.navId}`, {
      searchParams: { full: true }
    }).json()
    state.items = flattenMenuItems(items)
    state.selected = null
    state.current = {}
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err, 'An unexpected error occured.')
    })
    emit('load-error')
  }
  state.loading--
}

/**
 * Builds the nested `items` payload a save PUTs, from the flat editing list.
 *
 * Thrown, not returned, on a nested item with nothing above it to nest under — the host's own
 * `save()` is what shows that as an error.
 */
function buildSaveItems() {
  return reconstructMenuItems(state.items)
}

/** Reloads the menu's items and the group list — the host calls this once `navId` is known. */
async function load() {
  await Promise.all([loadMenuItems(), loadGroups()])
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
