<template>
  <div class="nav-edit-menu">
    <!-- -> Start/end only: a menu is a light object, the full four marks belong to a dialog or a
            card. Drawn just inside the panel -- WMenu's popup clips overflow past its padding
            edge. -->
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
        <!--
          `--color-accent-fill` has no dark-mode override of its own, so left alone the radio's
          ring/dot draws the light-mode bright tone against a dark ground.
        -->
        <w-radio
          class="nav-edit-menu__radio"
          v-model="state.mode"
          :val="entry.value"
          :color="dark.isActive ? `accent-dark` : `accent-fill`"
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
        <!-- Same dark-mode accent swap as the mode radios above. -->
        <w-btn-toggle
          class="nav-edit-menu__menu-source"
          v-model="state.menuMode"
          :options="menuSourceOptions"
          :toggle-color="dark.isActive ? `accent-dark` : `accent-fill`"
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
        class="nav-edit-menu__save-btn"
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

import { useDark } from '@/composables/dark'
import { notify } from '@/composables/notify'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { apiErrorMessage } from '@/helpers/apiError'
import { log } from '@/helpers/log'

import NavCascadeGlyph from '@/components/NavCascadeGlyph.vue'

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

const dark = useDark()

const pageStore = usePageStore()
const siteStore = useSiteStore()

const { t } = useI18n()

const state = reactive({
  mode: 'inherit',
  /**
   * Asked of the server rather than read off `pageStore.navigationId`, which only answers this while
   * the SAVED mode is `inherit`: on a page that currently overrides, picking Inherit here has to
   * point at the ancestor's menu, and the ancestor holding it is not something the page knows.
   * Null means nothing to inherit: the sidebar above this page is hidden.
   */
  inheritedNavId: null,
  /**
   * The target menu row's own source (`static`/`auto`/`mixed`) -- a different axis from `mode`
   * above, which is this ENTRY's cascade setting.
   *
   * `null` until `loadMenuMode` resolves, not `'static'`: `w-btn-toggle` selects no segment for
   * `null`, so the control never flashes "Manual" before the real value lands. A failed load leaves
   * it `null` on purpose -- `save()` and `startEditing()` then omit `menuMode`, which the server
   * treats as optional, rather than send a null.
   */
  menuMode: null,
  loading: 0
})

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

/**
 * Duplicated from `composables/dark.js`'s identical helper rather than shared: this owns one flip
 * only. Without it, `loadMenuMode()`'s resolve lands while `w-btn-toggle`'s color transition is
 * still animating the popup's open, so the control visibly slides from the `'static'` default to
 * the resolved value.
 */
function withoutTransitions(fn) {
  const root = document.documentElement
  root.classList.add('theme-transition-suppress')
  fn()

  // -> Load-bearing: forces a synchronous style recalc so the browser commits the new color WHILE
  //    transitions are still off.
  void getComputedStyle(document.body).transitionDuration

  requestAnimationFrame(() => {
    root.classList.remove('theme-transition-suppress')
  })
}

watch(
  () => state.mode,
  () => {
    nextTick(() => {
      props.updatePositionHandler()
    })
  }
)

/**
 * Quiet on failure: the mode itself is what this menu is for and can still be set, so a resolution
 * that did not come back only leaves the Edit Menu Items button out.
 */
async function loadInheritedNav() {
  // -> Outside `state.loading`, which is what the Save button spins on: this runs as the menu
  //    opens, and a spinner there would read as a save in flight
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
 * `pageStore.navigationId` is the right target regardless of this entry's own cascade mode --
 * inheriting or owning, it is the menu this page currently shows. Quiet on failure like
 * `loadInheritedNav`: the cascade mode is still usable even if this one call did not come back.
 */
async function loadMenuMode() {
  if (!pageStore.navigationId) {
    // -> A menu with no row yet is Manual, so this is the answer rather than a guess: left `null`,
    //    the control would sit with no segment selected for good.
    state.menuMode = 'static'
    return
  }
  try {
    const resp = await API_CLIENT.get(
      `sites/${siteStore.id}/navigation/${pageStore.navigationId}/mode`
    ).json()
    withoutTransitions(() => {
      state.menuMode = resp?.mode ?? 'static'
    })
  } catch (err) {
    log.warn('nav', "could not resolve the menu's source mode", err)
  }
}

function startEditing() {
  siteStore.$patch({
    overlay: 'NavEdit',
    overlayOpts: {
      mode: state.mode,
      ...(state.menuMode !== null && { menuMode: state.menuMode }),
      // -> A menu this page does not own: only Inherit edits one, and only away from the root,
      //    where inheriting and owning are the same menu.
      ...(!isRoot.value && state.mode === 'inherit' && { navId: state.inheritedNavId })
    }
  })
  props.menuHideHandler()
}

async function save() {
  state.loading++
  try {
    const resp = await API_CLIENT.put(`sites/${siteStore.id}/navigation/pages/${pageStore.id}`, {
      json: { mode: state.mode, ...(state.menuMode !== null && { menuMode: state.menuMode }) }
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
      Force-refetch rather than relying on the `pageStore.navigationId` watcher `NavSidebar.vue`
      runs: that watcher only fires when the id itself changes, but plenty of saves from here leave
      it unchanged while still changing what the sidebar shows -- `menuMode` alone, or `override`
      <-> `overrideExact` (both resolve to this entry's own row).
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

onMounted(() => {
  state.mode = pageStore.navigationMode
  loadMenuMode()
  if (!isRoot.value) {
    loadInheritedNav()
  }
})
</script>

<style scoped>
/* `position: relative` is what the corner marks below position against. */
.nav-edit-menu {
  position: relative;
  width: 344px;
  max-width: 100%;
  background-color: var(--color-surface);
  /*
    Through the card tokens rather than literals: their Ledger values are exactly what this card
    needs, so Cobalt's borderless, radius-8px pair then applies with no override block below.
  */
  border: var(--border-card);
  border-radius: var(--radius-card);
  box-shadow: 0 10px 28px rgba(28, 34, 51, 0.16);
}

:global(body.body--dark .nav-edit-menu) {
  background-color: var(--color-dark-3);
  border-color: var(--color-hairline-dark);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
}

/*
  The shadow's rgb triplet is `--color-ink`'s Cobalt value at 18% alpha, as the Ledger literal above
  is its Ledger value at 16%. No rgb-channel token exists to express either through `var()`.
*/
:global(body.body--cobalt .nav-edit-menu) {
  overflow: hidden;
  box-shadow: 0 10px 28px rgba(16, 25, 74, 0.18);
}

/* -> `display: var(--corner-marks)` is how Cobalt drops the marks without an override block. */
.nav-edit-menu__mark {
  position: absolute;
  display: var(--corner-marks);
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

/*
  Cobalt's faint rule has no dedicated token: `--color-tint`'s Cobalt value is the SELECTED-ROW tint
  role and would visibly tint every rule instead of drawing a hairline. `--color-hairline` is the
  closest existing token in both value and role, pending one named for this role.
*/
:global(body.body--cobalt .nav-edit-menu__header) {
  border-bottom-color: var(--color-hairline);
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

/*
  Same color role as Ledger (`--color-accent-fill`), not `--nav-active-inset`, which is built for
  `NavSidebar`'s own active item and carries the admin brand accent -- a different role from this
  row's accent-FILL highlight.
*/
:global(body.body--cobalt .nav-edit-menu__row--selected) {
  box-shadow: inset 3px 0 0 var(--color-accent-fill);
}

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

/*
  `--color-slate-pale` has no Cobalt value, and no "pale/disabled" Cobalt token exists for the
  unchecked border: `--color-admin-sidebar-text` carries the right one, pending a properly-named
  token for this role. The selected ring/dot takes `--color-accent`, not `--color-accent-fill` --
  see `tailwind.css`'s token block for why that role is not reused here. `WRadio` sets the selected
  color inline, which only `!important` from a plain CSS class beats.
*/
:global(body.body--cobalt .nav-edit-menu .w-radio > span:first-child) {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border-color: var(--color-admin-sidebar-text);
}

:global(body.body--cobalt .nav-edit-menu .w-radio .size-2\.5) {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

:global(body.body--cobalt .nav-edit-menu .w-radio[aria-checked='true'] > span:first-child) {
  border-color: var(--color-accent) !important;
}

:global(body.body--cobalt .nav-edit-menu .w-radio[aria-checked='true'] .size-2\.5) {
  background-color: var(--color-accent) !important;
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

:global(body.body--cobalt .nav-edit-menu__row--selected .nav-edit-menu__row-label) {
  font-weight: 600;
}

.nav-edit-menu__row-hint {
  font: 400 11.5px/1.35 var(--font-sans);
  color: var(--color-text-caption);
}

:global(body.body--dark .nav-edit-menu__row-hint) {
  color: var(--color-text-caption-dark);
}

:global(body.body--cobalt .nav-edit-menu__row--selected .nav-edit-menu__row-hint) {
  color: var(--color-text-secondary);
}

.nav-edit-menu__rule {
  height: 1px;
  margin: 4px 14px;
  background-color: var(--color-tint);
}

:global(body.body--dark .nav-edit-menu__rule) {
  background-color: var(--color-hairline-dark);
}

/* Same faint-rule token gap as the header's own rule above. */
:global(body.body--cobalt .nav-edit-menu__rule) {
  background-color: var(--color-hairline);
}

/* Equal-width segments: `w-btn-toggle`'s own segments size to content. */
.nav-edit-menu__menu-source {
  display: flex;
  width: 100%;
}

.nav-edit-menu :deep(.nav-edit-menu__menu-source .w-btn-toggle__segment) {
  flex: 1 1 0;
  height: 30px;
}

/*
  `WBtnToggle.vue` suppresses only a middle/last segment's START border, so the group's two OUTER
  edges still draw -- here, directly against this card's own border, double-bordering both ends.
  Scoped to this instance rather than the shared primitive, and unconditional across aesthetics:
  the card border it collides with is always present.
*/
.nav-edit-menu :deep(.nav-edit-menu__menu-source .w-btn-toggle__segment:first-child) {
  border-inline-start-width: 0;
}

.nav-edit-menu :deep(.nav-edit-menu__menu-source .w-btn-toggle__segment:last-child) {
  border-inline-end-width: 0;
}

/*
  The selected fill uses `--color-accent` (the white-text-accent role), not the
  `--color-accent-fill` that `toggle-color` sets inline; `WBtnToggle` writes the selected segment's
  fill and border inline, so only `!important` beats it, as with the radio above.

  The unselected-text rule below has no Cobalt "slate button" token to reach for -- `--color-slate`
  is not redefined for Cobalt -- so `--color-ink` stands in there and on the footer Save button.
  Its `:not(.body--dark)` scope is load-bearing: `--color-ink` stays navy under Cobalt dark, so
  unscoped this rule outspecifies `WBtnToggle.vue`'s own correct dark rule and paints navy text on
  the dark panel behind it.
*/
:global(body.body--cobalt .nav-edit-menu__menu-source .w-btn-toggle__segment[aria-checked='true']) {
  background-color: var(--color-accent) !important;
  border-color: var(--color-accent) !important;
  box-shadow: var(--shadow-primary);
}

:global(
  body.body--cobalt:not(.body--dark)
    .nav-edit-menu__menu-source
    .w-btn-toggle__segment[aria-checked='false']
) {
  color: var(--color-ink);
}

:global(body.body--cobalt .nav-edit-menu__menu-source .w-btn-toggle__segment:first-child) {
  border-start-start-radius: var(--radius-control);
  border-end-start-radius: var(--radius-control);
}

:global(body.body--cobalt .nav-edit-menu__menu-source .w-btn-toggle__segment:last-child) {
  border-start-end-radius: var(--radius-control);
  border-end-end-radius: var(--radius-control);
}

.nav-edit-menu__menu-source-hint {
  padding: 6px 14px 0;
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

:global(body.body--cobalt .nav-edit-menu__edit-btn) {
  border-radius: var(--radius-control);
  color: var(--color-accent-strong);
}

.nav-edit-menu__edit-icon {
  color: var(--color-slate-soft);
}

:global(body.body--cobalt .nav-edit-menu__edit-icon) {
  color: var(--color-accent-strong);
}

.nav-edit-menu__edit-label {
  flex: 1 1 auto;
  text-align: start;
}

.nav-edit-menu__edit-chevron {
  color: var(--color-slate-faint);
}

/*
  `--color-slate-faint` isn't redefined for Cobalt; `--color-sidebar-icon` carries the right value
  for the same "muted icon on a Cobalt surface" role.
*/
:global(body.body--cobalt .nav-edit-menu__edit-chevron) {
  color: var(--color-sidebar-icon);
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

/*
  Same missing "slate button" token as the segmented control's unselected text above; `color="slate"`
  sets the fill as an inline style on `WBtn`, hence `!important`.
*/
:global(body.body--cobalt .nav-edit-menu__save-btn) {
  background-color: var(--color-ink) !important;
}
</style>
