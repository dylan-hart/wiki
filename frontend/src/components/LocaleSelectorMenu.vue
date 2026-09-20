<template>
  <w-menu
    class="translucent-menu"
    auto-close
    :anchor="effectiveAnchor.anchor"
    :self="effectiveAnchor.self"
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
            :color="lang.code === pageStore.locale ? `accent` : `slate`"
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
          One badge covers both a stale translation and a missing one; only the tooltip text tells
          them apart.
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
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import { directionalAnchor } from '@/helpers/directionalAnchor'
import { localizedPagePath } from '@/helpers/pagePaths'

import { useDirection } from '@/composables/direction'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

const props = defineProps({
  /**
   * Left unset, `effectiveAnchor` mirrors the LTR pair for `dir="rtl"`: `WMenu` places itself in raw
   * viewport pixels with no idea which way the reader's text flows, so a fixed physical default
   * would be wrong under RTL. A caller that knows its own physical layout overrides it.
   */
  anchor: {
    type: String,
    default: null
  },
  self: {
    type: String,
    default: null
  },
  offset: {
    type: Array,
    default: () => [0, 0]
  }
})

const direction = useDirection()

/**
 * Reactive rather than read off `document.documentElement.dir` once at setup: this component is
 * mounted once and stays put across navigations, so it has to follow a mid-session direction change.
 */
const effectiveAnchor = computed(() => {
  const defaultPair = directionalAnchor(direction.isRTL ? 'rtl' : 'ltr', 'bottom left', 'top left')
  return {
    anchor: props.anchor ?? defaultPair.anchor,
    self: props.self ?? defaultPair.self
  }
})

const pageStore = usePageStore()
const siteStore = useSiteStore()

const router = useRouter()

const { t } = useI18n()

/**
 * Per-locale `{ locale, exists, stale }`, refetched on each open rather than kept warm across
 * navigations. Empty reads as "no badge for anyone", never as an error.
 */
const translationStatus = ref([])

/**
 * A page mid-creation has no id to ask the server about, so it is left unbadged rather than
 * requested for. Best-effort otherwise: a badge that fails to load is not worth an error.
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
    // -> An empty body resolves to `undefined`, on which `translationBadgeText`'s `.find()` would
    //    throw on every render rather than merely failing to badge.
    translationStatus.value = Array.isArray(result) ? result : []
  } catch {
    translationStatus.value = []
  }
}

/** Doubles as the template's `v-if`, so one place decides whether a locale is badged. */
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
 * Switches the CONTENT locale being read: the interface language is a separate concern this menu
 * does not touch. `pageStore.path` is never itself locale-prefixed, so it is re-prefixed for `code`.
 *
 * Navigates unconditionally, without first asking whether `code` has a page at this path: falling
 * back to that locale's home page would silently hand the reader a DIFFERENT page than the one they
 * were reading, whereas the ordinary not-found flow names the path that has no translation yet and
 * offers to create it.
 */
function switchLocale(code) {
  router.push(localizedPagePath(pageStore.path, code, siteStore.localeRouting))
}
</script>
