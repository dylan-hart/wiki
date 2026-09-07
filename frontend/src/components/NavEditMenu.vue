<template>
  <div class="nav-edit-menu">
    <!-- -> Two corner marks (start/end only, matching PageNewMenu.vue's own menu-material marks --
            a menu is a light object, the full four belong to a dialog or a card), decorative and
            drawn just inside the panel since WMenu's popup clips overflow past its padding edge. -->
    <i class="nav-edit-menu__mark nav-edit-menu__mark--start" aria-hidden="true" />
    <i class="nav-edit-menu__mark nav-edit-menu__mark--end" aria-hidden="true" />

    <div class="nav-edit-menu__header">
      <span class="nav-edit-menu__eyebrow">{{ t('navEdit.title') }}</span>
      <span class="nav-edit-menu__path">{{ displayPath }}</span>
    </div>

    <div class="nav-edit-menu__section">
      <div class="nav-edit-menu__section-label">{{ t('navEdit.modeSectionLabel') }}</div>
      <label
        v-for="entry in cascadeModes"
        :key="entry.value"
        class="nav-edit-menu__row"
        :class="{ 'nav-edit-menu__row--selected': state.mode === entry.value }">
        <w-radio
          class="nav-edit-menu__radio"
          v-model="state.mode"
          :val="entry.value"
          color="accent-fill"
          :aria-label="t(entry.label)" />
        <nav-cascade-glyph :mode="entry.value" :root="isRoot" />
        <span class="nav-edit-menu__row-text">
          <span class="nav-edit-menu__row-label">{{ t(entry.label) }}</span>
          <span class="nav-edit-menu__row-hint">{{ t(entry.hint) }}</span>
        </span>
      </label>
    </div>

    <template v-if="canEditMenuItems">
      <div class="nav-edit-menu__rule" />
      <div class="nav-edit-menu__section">
        <div class="nav-edit-menu__section-label">{{ t('navEdit.menuSourceLabel') }}</div>
        <w-btn-toggle
          class="nav-edit-menu__menu-source"
          v-model="state.menuMode"
          :options="menuSourceOptions"
          toggle-color="accent-fill"
          :aria-label="t('navEdit.menuSourceLabel')" />
        <div class="nav-edit-menu__menu-source-hint">{{ menuSourceHint }}</div>
      </div>
      <div class="nav-edit-menu__section nav-edit-menu__section--tight">
        <button type="button" class="nav-edit-menu__edit-btn" @click="startEditing">
          <w-icon name="tabler:list-details" class="nav-edit-menu__edit-icon" />
          <span class="nav-edit-menu__edit-label">{{ t(`navEdit.editMenuItems`) }}</span>
          <w-icon name="tabler:chevron-right" class="nav-edit-menu__edit-chevron" />
        </button>
      </div>
    </template>

    <div class="nav-edit-menu__footer">
      <w-btn
        outline
        :label="t('common.actions.cancel')"
        color="text-secondary"
        padding="xs md"
        @click="props.menuHideHandler" />
      <w-btn
        icon="tabler:check"
        :label="t('common.actions.save')"
        color="slate"
        padding="xs md"
        @click="save"
        :loading="state.loading > 0" />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'

import { notify } from '@/composables/notify'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { apiErrorMessage } from '@/helpers/apiError'
import { log } from '@/helpers/log'

import NavCascadeGlyph from '@/components/NavCascadeGlyph.vue'

// PROPS

const props = defineProps({
  menuHideHandler: {
    type: Function,
    default: () => ({})
  },
  updatePositionHandler: {
    type: Function,
    default: () => ({})
  }
})

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  mode: 'inherit',
  /**
   * The menu this page inherits, resolved on open for any page that is not the root — see the
   * `inherited` endpoint.
   *
   * Asked of the server rather than read off `pageStore.navigationId`, which only answers this while
   * the SAVED mode is `inherit`: on a page that currently overrides, picking Inherit here has to point
   * at the ancestor's menu, and the ancestor holding it is not something the page knows.
   *
   * Null means nothing to inherit: the sidebar above this page is hidden.
   */
  inheritedNavId: null,
  /**
   * The target menu row's own source (`static`/`auto`/`mixed`) -- a different axis from `mode` above,
   * which is this ENTRY's cascade setting. Loaded from the currently-resolved menu (`pageStore.navigationId`)
   * on open, via `loadMenuMode`, and saved alongside `mode` as `menuMode` -- see `save()` and
   * `updateNavigation`'s own doc comment for why the two travel separately.
   */
  menuMode: 'static',
  loading: 0
})

/*
  The five non-root cascade rows and the root's own two, in display order -- each entry's `label`/
  `hint` are i18n keys, not resolved strings, so `cascadeModes` below stays a cheap re-slice on
  `isRoot` rather than a full re-translation. Copy is the handoff's own shorter table
  (ui-redesign-nav/HANDOFF.md §1); see `backend/locales/en.json`'s `navEdit.mode*` keys.
*/
const CASCADE_MODES = [
  { value: 'inherit', label: 'navEdit.modeInherit', hint: 'navEdit.modeInheritHint' },
  { value: 'override', label: 'navEdit.modeOverride', hint: 'navEdit.modeOverrideHint' },
  {
    value: 'overrideExact',
    label: 'navEdit.modeOverrideExact',
    hint: 'navEdit.modeOverrideExactHint'
  },
  { value: 'hide', label: 'navEdit.modeHideDescendants', hint: 'navEdit.modeHideDescendantsHint' },
  { value: 'hideExact', label: 'navEdit.modeHideExact', hint: 'navEdit.modeHideExactHint' }
]

const ROOT_CASCADE_MODES = [
  { value: 'inherit', label: 'navEdit.modeShow', hint: 'navEdit.modeShowHint' },
  { value: 'hide', label: 'navEdit.modeHide', hint: 'navEdit.modeHideHint' }
]

// COMPUTED

const isRoot = computed(() => {
  return pageStore.path === '' || pageStore.path === 'home'
})

const displayPath = computed(() => (isRoot.value ? '/' : `/${pageStore.path}`))

const cascadeModes = computed(() => (isRoot.value ? ROOT_CASCADE_MODES : CASCADE_MODES))

const menuSourceOptions = computed(() => [
  { value: 'static', label: t('navEdit.menuSourceStatic') },
  { value: 'auto', label: t('navEdit.menuSourceAuto') },
  { value: 'mixed', label: t('navEdit.menuSourceMixed') }
])

// -> The one hint line under the segmented control, changing with the selection -- see the handoff.
const menuSourceHint = computed(() => {
  return (
    {
      static: t('navEdit.menuSourceStaticHint'),
      auto: t('navEdit.menuSourceAutoHint'),
      mixed: t('navEdit.menuSourceMixedHint')
    }[state.menuMode] ?? ''
  )
})

const canEditMenuItems = computed(() => {
  // -> Inheriting edits the menu this page shows where it lives, which needs there to be one
  if (!isRoot.value && state.mode === 'inherit') {
    return Boolean(state.inheritedNavId)
  }
  return ['inherit', 'override', 'overrideExact'].includes(state.mode)
})

// WATCHERS

watch(
  () => state.mode,
  () => {
    nextTick(() => {
      props.updatePositionHandler()
    })
  }
)

// METHODS

/**
 * Resolves the menu this page inherits, so that Inherit can offer to edit it.
 *
 * Quiet on failure: the mode itself is what this menu is for and can still be set, so a resolution
 * that did not come back only leaves the Edit Menu Items button out.
 */
async function loadInheritedNav() {
  // -> Deliberately outside `state.loading`, which is what the Save button spins on: this runs as the
  //    menu opens, and a spinner there would read as a save in flight
  try {
    const resp = await API_CLIENT.get(
      `sites/${siteStore.id}/navigation/pages/${pageStore.id}/inherited`
    ).json()
    state.inheritedNavId = resp?.navigationId ?? null
    // -> A row appearing under the list makes the menu taller than the popup it was measured for
    nextTick(() => {
      props.updatePositionHandler()
    })
  } catch (err) {
    log.warn('nav', 'could not resolve the inherited navigation menu', err)
  }
}

/**
 * Resolves the currently-resolved menu's own source mode, to preselect the Menu Source selector.
 *
 * `pageStore.navigationId` is already the right target regardless of this entry's own cascade mode --
 * inheriting or owning, it is the menu this page currently shows, set by the server on every mode
 * change. Skipped entirely when there is none (`hide`/`hideExact`), and quiet on failure like
 * `loadInheritedNav`: the cascade mode is still usable even if this one call did not come back.
 */
async function loadMenuMode() {
  if (!pageStore.navigationId) {
    return
  }
  try {
    const resp = await API_CLIENT.get(
      `sites/${siteStore.id}/navigation/${pageStore.navigationId}/mode`
    ).json()
    state.menuMode = resp?.mode ?? 'static'
  } catch (err) {
    log.warn('nav', "could not resolve the menu's source mode", err)
  }
}

function startEditing() {
  siteStore.$patch({
    overlay: 'NavEdit',
    overlayOpts: {
      mode: state.mode,
      menuMode: state.menuMode,
      // -> A menu this page does not own: only Inherit edits one, and only away from the root, where
      //    inheriting and owning are the same menu. See NavEditOverlay's `navId`.
      ...(!isRoot.value && state.mode === 'inherit' && { navId: state.inheritedNavId })
    }
  })
  props.menuHideHandler()
}

async function save() {
  state.loading++
  try {
    // -> The menu items themselves are what the overlay saves; this popup only ever saves the two
    //    modes -- the entry's cascade (`mode`) and the resolved menu's own source (`menuMode`)
    const resp = await API_CLIENT.put(`sites/${siteStore.id}/navigation/pages/${pageStore.id}`, {
      json: { mode: state.mode, menuMode: state.menuMode }
    }).json()
    notify({
      type: 'positive',
      message: t('navEdit.saveModeSuccess')
    })
    pageStore.$patch({
      navigationMode: state.mode,
      navigationId: resp.navigationId ?? null
    })
    /*
      Force-refetch rather than relying on the `pageStore.navigationId` watcher `NavSidebar.vue` runs
      (OpenProject #1012's fix, same as `NavEditOverlay.vue`'s own `save()`): that watcher only fires
      when the id itself changes, but plenty of saves from THIS popup leave it unchanged while still
      changing what the sidebar should show -- `menuMode` alone (`static`/`auto`/`mixed`, resolved
      against the SAME row), or `override` <-> `overrideExact` (both resolve to this entry's own row,
      per `updateNavigation()`). Left to the watcher, none of those redraw the sidebar until a full
      reload re-fetches from scratch -- this is the "still reproduces" gap the item editor's own Save
      button already closed but this popup's Save never did.
    */
    await siteStore.fetchNavigation(resp.navigationId ?? null, true)
    props.menuHideHandler()
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.loading--
}

// MOUNTED

onMounted(() => {
  state.mode = pageStore.navigationMode
  loadMenuMode()
  if (!isRoot.value) {
    loadInheritedNav()
  }
})
</script>

<style scoped>
/*
  The Ledger card, per ui-redesign-nav/HANDOFF.md §1 -- 344px, square, a hairline edge and the
  create-menu's own drop shadow. `position: relative` is what the corner marks below position
  against, same reasoning as `PageNewMenu.vue`'s own `.page-new-menu`.
*/
.nav-edit-menu {
  position: relative;
  width: 344px;
  max-width: 100%;
  background-color: var(--color-surface);
  border: 1px solid var(--color-hairline);
  box-shadow: 0 10px 28px rgba(28, 34, 51, 0.16);
}

:global(body.body--dark .nav-edit-menu) {
  background-color: var(--color-dark-3);
  border-color: var(--color-hairline-dark);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
}

/* -> Two opposite corner marks only -- see PageNewMenu.vue's own identical construction/comment. */
.nav-edit-menu__mark {
  position: absolute;
  width: 7px;
  height: 7px;
  pointer-events: none;
}

.nav-edit-menu__mark--start {
  inset-block-start: 3px;
  inset-inline-start: 3px;
  border-block-start: 1px solid var(--color-slate-faint);
  border-inline-start: 1px solid var(--color-slate-faint);
}

.nav-edit-menu__mark--end {
  inset-block-end: 3px;
  inset-inline-end: 3px;
  border-block-end: 1px solid var(--color-slate-faint);
  border-inline-end: 1px solid var(--color-slate-faint);
}

.nav-edit-menu__header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 11px 14px 9px;
  border-bottom: 1px solid var(--color-tint);
}

:global(body.body--dark .nav-edit-menu__header) {
  border-bottom-color: var(--color-hairline-dark);
}

.nav-edit-menu__eyebrow {
  font: 600 10px/1.2 var(--font-mono);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--color-primary);
}

:global(body.body--dark .nav-edit-menu__eyebrow) {
  color: var(--color-accent-dark);
}

.nav-edit-menu__path {
  margin-inline-start: auto;
  overflow: hidden;
  font: 400 10.5px/1.2 var(--font-mono);
  color: var(--color-text-caption);
  white-space: nowrap;
  text-overflow: ellipsis;
}

:global(body.body--dark .nav-edit-menu__path) {
  color: var(--color-text-caption-dark);
}

.nav-edit-menu__section {
  padding: 8px 0 4px;
}

.nav-edit-menu__section--tight {
  padding: 0 14px 12px;
}

.nav-edit-menu__section-label {
  padding: 2px 14px 6px;
  font: 600 10px/1.2 var(--font-mono);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--color-text-caption);
}

:global(body.body--dark .nav-edit-menu__section-label) {
  color: var(--color-text-caption-dark);
}

.nav-edit-menu__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 14px;
  cursor: pointer;
}

.nav-edit-menu__row:hover:not(.nav-edit-menu__row--selected) {
  background-color: var(--color-paper);
}

:global(body.body--dark .nav-edit-menu__row:hover:not(.nav-edit-menu__row--selected)) {
  background-color: var(--color-dark-1);
}

.nav-edit-menu__row:focus-within {
  outline: 2px solid var(--color-accent-fill);
  outline-offset: -2px;
}

.nav-edit-menu__row--selected {
  background-color: var(--color-tint-alt);
  box-shadow: inset 2px 0 0 var(--color-accent-fill);
}

:global(body.body--dark .nav-edit-menu__row--selected) {
  background-color: var(--color-dark-2);
}

/* -> Shape only -- colour comes from the `color="accent-fill"` prop, which sets it inline. */
.nav-edit-menu :deep(.w-radio) {
  flex: none;
}

.nav-edit-menu :deep(.w-radio > span:first-child) {
  width: 13px;
  height: 13px;
  border-radius: 0;
  border-color: var(--color-slate-pale);
}

:global(body.body--dark .nav-edit-menu .w-radio[aria-checked='false'] > span:first-child) {
  border-color: var(--color-disabled-dark);
}

.nav-edit-menu :deep(.w-radio .size-2\.5) {
  width: 7px;
  height: 7px;
  border-radius: 0;
}

.nav-edit-menu__row-text {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  flex-direction: column;
}

.nav-edit-menu__row-label {
  font: 400 13px/1.3 var(--font-sans);
  color: var(--color-text-body);
}

.nav-edit-menu__row--selected .nav-edit-menu__row-label {
  font-weight: 500;
  color: var(--color-ink);
}

:global(body.body--dark .nav-edit-menu__row-label) {
  color: var(--color-text-dark);
}

.nav-edit-menu__row-hint {
  font: 400 11.5px/1.35 var(--font-sans);
  color: var(--color-text-caption);
}

:global(body.body--dark .nav-edit-menu__row-hint) {
  color: var(--color-text-caption-dark);
}

.nav-edit-menu__rule {
  height: 1px;
  margin: 4px 14px;
  background-color: var(--color-tint);
}

:global(body.body--dark .nav-edit-menu__rule) {
  background-color: var(--color-hairline-dark);
}

/*
  The "Menu source" segmented control -- `w-btn-toggle` already draws the shared hairline/accent
  material this needs (see WBtnToggle.vue); only two things are added here: equal-width segments
  (its own segments size to content by default) filling the section's own 14px gutters, and the
  30px height the handoff calls for (its own default is a `min-height` at the same value, restated
  here as the authority for this popover rather than relied on implicitly).
*/
.nav-edit-menu__menu-source {
  display: flex;
  width: 100%;
}

.nav-edit-menu :deep(.nav-edit-menu__menu-source .w-btn-toggle__segment) {
  flex: 1 1 0;
  height: 30px;
}

.nav-edit-menu__menu-source-hint {
  padding-top: 6px;
  font: 400 11.5px/1.4 var(--font-sans);
  color: var(--color-text-caption);
}

:global(body.body--dark .nav-edit-menu__menu-source-hint) {
  color: var(--color-text-caption-dark);
}

.nav-edit-menu__edit-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  background-color: transparent;
  border: 1px solid var(--color-hairline);
  color: var(--color-slate);
  font: 500 12.5px/1.2 var(--font-sans);
  cursor: pointer;
}

:global(body.body--dark .nav-edit-menu__edit-btn) {
  border-color: var(--color-hairline-dark);
  color: var(--color-text-dark);
}

.nav-edit-menu__edit-icon {
  color: var(--color-slate-soft);
}

.nav-edit-menu__edit-label {
  flex: 1 1 auto;
  text-align: start;
}

.nav-edit-menu__edit-chevron {
  color: var(--color-slate-faint);
}

.nav-edit-menu__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px;
  background-color: var(--color-paper);
  border-top: 1px solid var(--color-hairline);
}

:global(body.body--dark .nav-edit-menu__footer) {
  background-color: var(--color-dark-2);
  border-top-color: var(--color-hairline-dark);
}
</style>
