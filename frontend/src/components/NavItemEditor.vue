<template>
  <w-drawer class="nav-edit-drawer" :model-value="true" :width="295">
    <div class="nav-edit-drawer-header">
      <span class="nav-edit-drawer-eyebrow">{{ t('navEdit.itemsHeading') }}</span>
      <span class="nav-edit-drawer-count">{{ state.items.length }}</span>
    </div>
    <w-scroll-area class="nav-edit flex-1 min-h-0">
      <div class="nav-edit-mixed-hint text-caption" v-if="isMixed">
        {{ t('navEdit.menuSourceMixedListHint') }}
      </div>
      <!--
        Exactly one root node per `#item`: `w-sortable` renders this slot straight into the sortable
        container with no per-item wrapper, so SortableJS's `oldIndex`/`newIndex` are DOM child
        positions -- a second sibling node per item would desync them from `state.items`' indices.
        The generated block's boundary is drawn with CSS sibling selectors instead.
      -->
      <w-sortable
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
            <!-- -> Rendered on every generated row; CSS shows it only on the first of the run. -->
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
      </w-sortable>
    </w-scroll-area>
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
        <div class="nav-edit-callout" v-if="editingDisabled">
          <div class="nav-edit-callout__icon"><w-icon name="tabler:info-circle" size="18px" /></div>
          <p>{{ t('navEdit.menuSourceReadOnlyNotice') }}</p>
        </div>

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
                      A button, not a bare `w-icon`: for a bundled icon `WIcon` renders an <svg>
                      whose body comes from `v-html`, and that branch renders no slot, so a `w-menu`
                      nested inside the icon would never exist.
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
              The sidebar renders a parent as an expansion item and never reads its target, so both
              fields below would do nothing. Hidden, not cleared: unnesting the last child turns the
              row back into an ordinary link, and it comes back with the address it had.
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
import IconPickerDialog from '@/components/IconPickerDialog.vue'
import { apiErrorMessage } from '@/helpers/apiError'
import { flattenMenuItems, reconstructMenuItems } from '@/helpers/navigation.js'

/**
 * Deliberately ignorant of WHERE the menu it edits lives — it knows only a `siteId` and a `navId`,
 * the row `GET/PUT /sites/:siteId/navigation/:navId` addresses, which is what lets several hosts
 * resolve `navId` their own way and drive the same editor. Saving is the host's job too: this
 * component only builds the payload, via `buildSaveItems()`.
 */

const props = defineProps({
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
   * The menu's own source (`static`/`auto`/`mixed`) — a different axis from however the host
   * addresses this menu, and left at `static` by a host that has not resolved it.
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

const emit = defineEmits([
  'load-error',
  'update:loading',
  /**
   * `copyFrom()` persists immediately, unlike every other change in this editor, which stays local
   * until the host's own Save calls `buildSaveItems()`. So the reader-facing sidebar can go stale
   * from this one action without the host ever running its save path — only the host knows whether
   * the copied menu is the one currently on screen.
   */
  'copied'
])

const { t } = useI18n()

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
  /** This site's default-menu roots, one per active locale. */
  copyLocales: [],
  copyOtherSites: []
})

/** An Iconify reference from a set seeded on every instance, so the picker can open on it. */
const DEFAULT_LINK_ICON = 'tabler:file-text'

/**
 * A generated (auto/mixed) folder item carries no `icon` of its own, so the fallback splits on
 * `isFolder` — not `NavSidebarItem.vue#iconFor()`'s `item.children?.length` half of the same check,
 * since `flattenMenuItem` never puts `children` on a flat editor row (nesting is `isNested` on the
 * row *after* it instead).
 */
function rowIcon(element) {
  return element.icon || (element.isFolder ? 'tabler:folder' : DEFAULT_LINK_ICON)
}

const visibilityOptions = [
  { value: false, label: t('navEdit.visibilityAll') },
  { value: true, label: t('navEdit.visibilityLimited') }
]

/**
 * Parenthood is not a property of the item: the list is flat and `isNested` says an item belongs to
 * whatever link comes before it, so what makes a link a parent is the item that FOLLOWS it. Hence
 * asked of the list rather than read off `state.current`.
 */
const currentIsParent = computed(() => {
  const item = state.current
  if (item?.type !== 'link' || item.isNested) {
    return false
  }
  const idx = state.items.findIndex((it) => it.id === item.id)
  return idx >= 0 && Boolean(state.items[idx + 1]?.isNested)
})

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

const isAuto = computed(() => props.menuMode === 'auto')

const isMixed = computed(() => props.menuMode === 'mixed')

const isCurrentGenerated = computed(() => Boolean(state.current?.generated))

/** Editing a generated item would only be undone by the next `getNav` read, which regenerates it. */
const editingDisabled = computed(() => isAuto.value || isCurrentGenerated.value)

/**
 * `filter` blocks starting a drag ON a generated item, `onMove` blocks dropping INTO the generated
 * block: a manual item interleaved with tree-walk output would just be overwritten by the next read.
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
 * `> 1` locale because this menu's own locale root is in that list. "Copy from..." is hidden rather
 * than shown disabled when nothing qualifies: a single-locale, single-site instance has no picker
 * this could open onto.
 */
const canCopyFrom = computed(() => state.copyLocales.length > 1 || state.copyOtherSites.length > 0)

function setItem(item) {
  state.selected = item.id
  state.current = item
}

/**
 * The picker's own "open in a new tab" offer is turned off: this panel asks that one row down and
 * stores the answer, so a second control could only disagree with the toggle that is actually saved.
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
  // -> Defensive twin of the template's own `v-if="!isAuto"` on the Add button
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
  // -> Defensive twin of the template hiding Delete for a generated item
  if (state.items.find((item) => item.id === id)?.generated) {
    return
  }
  state.items = state.items.filter((item) => item.id !== id)
  state.selected = null
  state.current = {}
}

function clearItems() {
  // -> Generated items are kept: a save cannot remove them (the next read regenerates them from the
  //    tree), so dropping them here would only show them right back
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
    // -> A warning, not an error: only per-group visibility is lost, the rest of the editor works
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
    // -> `full`, because the editor has to see items limited to groups it is not in: saving without
    //    them would delete them
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
 * Throws, rather than returning an error, on a nested item with nothing above it to nest under —
 * the host's own `save()` is what shows that.
 */
function buildSaveItems() {
  return reconstructMenuItems(state.items, { menuMode: props.menuMode })
}

/**
 * Failures are swallowed rather than surfaced via `notify()`: losing this only hides an action, it
 * does not break anything already on screen. The two calls settle independently so that a site list
 * the current user cannot read (`GET /sites` needs `read:sites` / `access:admin`, not just the
 * `manage:navigation` this editor already requires) does not also take down the same-site "copy from
 * another locale" case, which needs neither.
 */
async function loadCopySources() {
  state.loading++
  // -> Wrapped as a whole, not just around the `await`: `API_CLIENT.get()` itself can throw
  //    synchronously before `Promise.allSettled` runs, skipping `state.loading--` below and leaving
  //    the editor stuck looking busy
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
 * `append` only, never `replace`: this editor always already has a loaded, editable list of its own.
 * Copied `target` paths travel over unrewritten — a page path valid in the source locale or site is
 * not guaranteed to mean anything in this one — which is what the warning toast is for.
 */
async function copyFrom(sourceSiteId, sourceNavId) {
  state.loading++
  try {
    await API_CLIENT.post(`sites/${props.siteId}/navigation/${props.navId}/copy`, {
      json: { sourceSiteId, sourceNavId, mode: 'append' }
    }).json()
    await loadMenuItems()
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

async function load() {
  await Promise.all([loadMenuItems(), loadGroups(), loadCopySources()])
}

const loading = computed(() => state.loading > 0)

defineExpose({
  loading,
  load,
  buildSaveItems
})

watch(loading, (v) => emit('update:loading', v), { immediate: true })

onMounted(load)
</script>

<style scoped>
.nav-edit-drawer {
  background-color: var(--color-tint-alt);
  border-inline-end: 1px solid var(--color-hairline);
}

:global(body.body--dark .nav-edit-drawer) {
  background-color: var(--color-dark-4);
  border-inline-end-color: var(--color-hairline-dark);
}

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
  The row gap is a per-row bottom margin rather than a flex `gap`: `w-sortable` renders its items as
  plain block children, not a flex container this could add `gap` to.
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

  &.is-generated {
    color: var(--color-slate-faint);
    cursor: default;
  }

  /*
    The generated block's boundary, drawn as a rule rather than an extra element: see the template's
    `#item` slot comment for why a divider cannot be a sibling DOM node here.
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

:global(body.body--cobalt .nav-edit-item) {
  color: var(--color-sidebar-text);

  &.is-active {
    background-color: var(--color-accent-strong);
    box-shadow: var(--nav-active-inset);
    color: var(--color-white);
    font-weight: 600;

    .handle {
      color: var(--color-sidebar-text);
    }
  }

  &.sortable-chosen {
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
  Present in the DOM on every generated row -- the `#item` slot allows only one root node per item --
  and shown by CSS only on the row a manual item (or nothing) precedes.
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
    `WItem.vue`'s shared `flex-wrap: wrap` is scoped to two-main-section rows, which this is not, so
    the generated eyebrow (`flex-basis: 100%`) would have nothing to wrap TO and would instead
    squeeze the icon/label/handle off the row's one line. Inert until the eyebrow is present --
    nothing else on this row claims a full-width basis.
  */
  flex-wrap: wrap;
  padding: 7px 10px 7px 18px !important;
  font-size: 13.5px;

  &.is-active {
    padding-inline-start: 16px !important;
  }

  /*
    Indentation is the only nesting cue, and the transparent 10px `border-inline-start` is what
    provides it -- nothing else on this row declares content padding for it -- so it is load-bearing
    despite drawing nothing.
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

:global(body.body--cobalt .nav-edit-item-link) {
  padding: 8px 10px !important;

  &.is-active {
    padding-inline-start: 10px !important;
  }
}

:global(body.body--cobalt .nav-edit-item-link .w-icon:not(.handle)) {
  color: var(--color-sidebar-icon);
}

:global(body.body--cobalt .nav-edit-item-link.is-nested) {
  margin-inline-start: 10px;
}

/*
  Orphaned nested row -- a nested link with nothing valid above it to nest under -- flagged in the
  accent wash the way `nestingWarn` promises, not the app's generic `var(--color-negative)`.
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
  The ground is `--color-accent-fill` at 16%, written as a decomposed rgb() triplet rather than the
  `color-mix()`/relative-color expression this codebase does not otherwise use.
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
  No `overflow: hidden` here, unlike `.nav-edit-structure-card`: the corner marks below are
  positioned OUTSIDE this card's box to overhang it by 4px, and would be clipped. Cobalt hides the
  marks (`--corner-marks: none`), so it can afford the clip.
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
  Four real elements rather than a `::before`/`::after` pair -- only two pseudo-elements are
  available and four corners are needed. `display: var(--corner-marks)` is itself the per-aesthetic
  switch (`block` in Ledger, `none` in Cobalt), so no `body--cobalt` override is needed.
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

/* `color="slate"` sets an inline style on the button, so overriding it here needs `!important`. */
:global(body.body--cobalt .nav-edit-structure-btn) {
  color: var(--color-accent-strong) !important;
}
</style>
