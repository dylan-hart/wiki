<template>
  <w-menu
    class="translucent-menu"
    auto-close
    :anchor="props.anchor"
    :self="props.self"
    :offset="props.offset">
    <w-list padding style="min-width: 200px">
      <w-item
        v-for="lang of siteStore.locales.active"
        :key="lang.code"
        clickable
        @click="switchLocale(lang.code)">
        <w-item-section side>
          <w-avatar
            rounded
            :color="lang.code === pageStore.locale ? `secondary` : `primary`"
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
      </w-item>
    </w-list>
  </w-menu>
</template>

<script setup>
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

// METHODS

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
  router.push(
    localizedPagePath(pageStore.path, code, {
      useLocales: siteStore.useLocales,
      primary: siteStore.locales.primary,
      forcePrefix: siteStore.locales.forcePrefix
    })
  )
}
</script>
