<template>
  <w-menu
    class="translucent-menu"
    auto-close
    :anchor="props.anchor"
    :self="props.self"
    :offset="props.offset"
    @show="loadTranslationStatus">
    <w-list padding style="min-width: 200px">
      <w-item
        v-for="lang of siteStore.locales.active"
        :key="lang.code"
        clickable
        @click="switchLocale(lang.code)">
        <w-item-section side>
          <w-avatar
            rounded
            :color="lang.code === pageStore.locale ? `accent-fill` : `slate`"
            text-color="white"
            size="sm">
            <div class="text-caption uppercase">
              <strong>{{ lang.language }}</strong>
            </div>
          </w-avatar>
        </w-item-section>
        <w-item-section>
          <w-item-label>{{ lang.nativeName }}</w-item-label>
          <w-item-label caption>{{ lang.name }}</w-item-label>
        </w-item-section>
        <!--
          Staleness/missing badge (OpenProject #2475) -- one signal covers both states (Feature
          #2439's own resolved scope), so this is deliberately the same badge either way, only the
          tooltip text tells a stale translation apart from a missing one. Absent entirely once
          `translationStatus` reports neither for this locale (including the common case: the fetch
          hasn't resolved yet, or this page has no id to ask about at all).
        -->
        <w-item-section side v-if="translationBadgeText(lang.code)">
          <w-badge color="warning" text-color="black" rounded>
            <w-icon name="tabler:alert-triangle" size="12px" />
            <w-tooltip anchor="center left" self="center right">{{
              translationBadgeText(lang.code)
            }}</w-tooltip>
          </w-badge>
        </w-item-section>
      </w-item>
    </w-list>
  </w-menu>
</template>

<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import { localizedPagePath } from '@/helpers/pagePaths'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

// PROPS

const props = defineProps({
  anchor: {
    type: String,
    default: 'bottom left'
  },
  self: {
    type: String,
    default: 'top left'
  },
  offset: {
    type: Array,
    default: () => [0, 0]
  }
})

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()

// ROUTER

const router = useRouter()

// I18N

const { t } = useI18n()

// DATA

/**
 * Per-locale `{ locale, exists, stale }`, one entry per active locale -- fetched fresh each time
 * the menu opens (see `loadTranslationStatus`) rather than kept warm across page navigations, the
 * same "fetched once per open, not assumed stale from an earlier visit" convention
 * `ImportPageDialog.vue`/`ImportBatchPageDialog.vue` already use for their own dialogs. Empty
 * before the first open, or whenever the fetch has nothing to report (see below) -- both read as
 * "no badge for anyone" through `translationBadgeText`, never as an error.
 */
const translationStatus = ref([])

// METHODS

/**
 * Populates `translationStatus` for the page currently on screen, on `w-menu`'s own `@show`.
 *
 * A page that has no id yet -- mid-creation, in the editor's `create` mode -- has nothing to ask
 * the server about, so this leaves `translationStatus` empty rather than requesting for an id that
 * does not exist. Best-effort otherwise: a badge that fails to load is not worth surfacing as an
 * error (same reasoning `HeaderNav.vue`'s own badge-count refresh gives), so any failure just
 * leaves every item unbadged.
 */
async function loadTranslationStatus() {
  translationStatus.value = []
  if (!pageStore.id) {
    return
  }
  try {
    const result = await API_CLIENT.get(
      `sites/${siteStore.id}/pages/${pageStore.id}/translationStatus`
    ).json()
    // -> Defensive against a stubbed/mocked `API_CLIENT` (or a genuinely empty body) resolving to
    //    `undefined` rather than an array -- `translationBadgeText`'s own `.find()` would otherwise
    //    throw on every render, not just fail to badge anything.
    translationStatus.value = Array.isArray(result) ? result : []
  } catch {
    translationStatus.value = []
  }
}

/**
 * The tooltip text for `code`'s badge, or `null` when it should show none at all -- doubles as the
 * template's own `v-if`, so there is exactly one place that decides whether a locale is badged.
 */
function translationBadgeText(code) {
  const status = translationStatus.value.find((entry) => entry.locale === code)
  if (!status) {
    return null
  }
  if (!status.exists) {
    return t('localeSwitcher.missing')
  }
  return status.stale ? t('localeSwitcher.stale') : null
}

/**
 * Switches the CONTENT locale being read -- the interface language (`commonStore.locale` /
 * vue-i18n) is a separate concern this menu does not touch, even though a click here used to move
 * only that one and leave the page on screen exactly as it was. This list is native names next to
 * each other precisely because it is choosing a TRANSLATION to read, so what it does is navigate.
 *
 * Re-prefixes the current page's own path (`pageStore.path`, never itself locale-prefixed) for
 * `code` via `localizedPagePath` -- bare for the primary locale unless `forcePrefix` is on, per the
 * model `shouldPrefixLocale` documents -- and pushes it.
 *
 * Not-found decision (the WP calls this out as needing to be made and documented): this navigates
 * unconditionally, without first asking the server whether `code` even has a page at this path. A
 * page rarely carries every translation, and the alternative -- falling back to the locale's home
 * page -- would silently hand the reader a DIFFERENT page than the one they were just reading, with
 * no sign that is what happened. Landing on the ordinary `ERR_PAGE_NOT_FOUND` flow instead (see the
 * route watcher in `pages/Index.vue`) is honest about what's true: it names the exact path that has
 * no French version yet, and -- for anyone who may write one -- offers to create it right there,
 * same as any other missing page. A pre-flight existence check would only buy silently swapping one
 * surprise for another.
 */
function switchLocale(code) {
  router.push(localizedPagePath(pageStore.path, code, siteStore.localeRouting))
}
</script>
