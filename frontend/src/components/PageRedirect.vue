<template>
  <div class="page-placeholder">
    <template v-if="problem">
      <w-icon class="page-placeholder-icon" name="tabler:alert-triangle" />
      <div class="text-h6">{{ t(`common.redirect.${problem}`) }}</div>
      <div class="text-body2 mt-1 opacity-60" v-if="canEditPage">
        {{ t('common.redirect.brokenHint') }}
      </div>
      <div class="text-caption font-robotomono mt-3 opacity-50" v-if="redirect.target">
        {{ redirect.target }}
      </div>
      <w-btn
        class="mt-6"
        v-if="canEditPage"
        icon="tabler:edit"
        color="primary"
        padding="xs lg"
        :label="t(`common.actions.edit`)"
        @click="editPage" />
    </template>
    <template v-else-if="!following">
      <w-icon class="page-placeholder-icon" name="tabler:directions" />
      <div class="text-h6">{{ t('common.redirect.held') }}</div>
      <div class="text-caption font-robotomono mt-3 opacity-50">{{ redirect.target }}</div>
      <w-btn
        class="mt-6"
        icon="tabler:arrow-right"
        color="primary"
        padding="xs lg"
        :label="t(`common.redirect.follow`)"
        @click="follow" />
    </template>
    <template v-else>
      <w-icon class="page-placeholder-icon" name="tabler:directions" />
      <!--
        `aria-live`, because nothing here is clicked: a screen reader is told where it is taking its
        reader at the moment the page announces it.
      -->
      <div class="text-h6" role="status" aria-live="polite">
        {{ t('common.redirect.redirectingTo', { target: redirect.target }) }}
      </div>
      <w-btn
        class="mt-6"
        icon="tabler:arrow-right"
        color="primary"
        padding="xs lg"
        :label="t(`common.redirect.goNow`)"
        @click="go" />
    </template>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { loading } from '@/composables/loading'

import {
  isFollowable,
  parseRedirect,
  REDIRECT_INTERSTITIAL_MS,
  resolveRedirectTarget
} from '@/helpers/pageRedirect'
import { parseLocalePrefix } from '@/helpers/pagePaths'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/**
 * `A → B → A` is a browser that never stops navigating, and no single page can see it: each one
 * points somewhere perfectly reasonable, and only the count across them says otherwise.
 */
const MAX_HOPS = 5

/**
 * Module-level on purpose: the page view keeps this one component mounted from a redirection to the
 * next, so the count is about the chain rather than about any page in it.
 */
let hops = 0

const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const router = useRouter()
const route = useRoute()

const { t } = useI18n()

let timer = null

const chainStopped = ref(false)

const activeLocaleCodes = computed(() => siteStore.locales.active.map((locale) => locale.code))

/** A URL target leaves the app and has no page locale to carry, so it passes through as-is. */
const redirect = computed(() => {
  const parsed = parseRedirect(pageStore.content)
  if (parsed.kind === 'url' || !parsed.target) {
    return parsed
  }
  return {
    ...parsed,
    target: resolveRedirectTarget(
      parsed.target,
      activeLocaleCodes.value,
      pageStore.locale,
      siteStore.localeRouting
    )
  }
})

/** The value doubles as the name of the `common.redirect.*` string that explains the problem. */
const problem = computed(() => {
  if (!isFollowable(redirect.value)) {
    return 'broken'
  }
  if (chainStopped.value) {
    return 'chain'
  }
  return redirect.value.kind === 'page' && isSelf(redirect.value.target) ? 'loop' : null
})

/**
 * Two things hold a redirection. `?redirect=no` is the one a person asks for. The other is an editor
 * route: `/_edit/<path>` and `/_create/<editor>` load the page BEFORE they open the editor on it, and
 * in that gap the page view is drawn for a page already known to be a redirection — which would take
 * the author to the target instead of showing them the form for it.
 */
const following = computed(
  () =>
    route.query.redirect !== 'no' &&
    !route.path.startsWith('/_edit') &&
    !route.path.startsWith('/_create')
)

const canEditPage = computed(() =>
  ['write:pages', 'manage:pages'].some((permission) =>
    userStore.pagePermissions.includes(permission)
  )
)

/*
  Keyed on the page rather than run on mount: this component stays mounted from one redirection to the
  next -- the page view swaps the store's contents under it -- so a mount hook would fire for the
  first one only. `immediate`, because arriving at a redirection directly is the ordinary case.
*/
watch(
  () => [pageStore.id, redirect.value.target, following.value],
  () => {
    clear()
    if (!following.value) {
      // -> Held, so nothing is being followed and whatever came before it was not a chain
      hops = 0
      chainStopped.value = false
      return
    }
    if (problem.value) {
      return
    }
    /*
      Counted here rather than in `go()`: the page that breaks the chain must not first show an
      interstitial saying the reader is on their way somewhere they cannot go. A URL target leaves
      the app entirely, which ends any chain by itself.
    */
    if (redirect.value.kind === 'page' && ++hops > MAX_HOPS) {
      chainStopped.value = true
      return
    }
    if (!redirect.value.showInterstitial) {
      go()
      return
    }
    timer = setTimeout(go, REDIRECT_INTERSTITIAL_MS)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  clear()
  // -> Whatever comes next is read rather than followed, so the chain ends here
  hops = 0
})

function clear() {
  clearTimeout(timer)
  timer = null
}

/**
 * Compared as path AND locale rather than path alone: the same path addressed at a DIFFERENT
 * translation is a link to another page, not a loop back to this one. `target` is `redirect`'s own
 * composed target above, so an absent prefix names the site's primary locale rather than "unknown".
 */
function isSelf(target) {
  const parsed = parseLocalePrefix(target, activeLocaleCodes.value, siteStore.locales.aliases)
  const targetLocale = parsed?.locale ?? siteStore.locales.primary
  if (targetLocale !== pageStore.locale) {
    return false
  }
  const targetPath = (parsed?.path ?? target).replace(/\/+$/, '')
  const stored = `/${pageStore.path}`.replace(/\/+$/, '')
  return (
    targetPath.toLowerCase() === stored.toLowerCase() || (stored === '/home' && targetPath === '')
  )
}

/**
 * `replace` rather than a push, both ways: a redirection is not somewhere anyone meant to be, and
 * leaving it in the history means the back button lands on it and bounces straight forward again.
 */
function go() {
  clear()
  if (problem.value) {
    return
  }
  if (redirect.value.kind === 'url') {
    // -> Leaving the app entirely, so the loading bar is what stands in for the wait
    loading.show()
    window.location.replace(redirect.value.target)
    return
  }
  router.replace(redirect.value.target)
}

function follow() {
  router.replace({ path: route.path, query: { ...route.query, redirect: undefined } })
}

function editPage() {
  router.push({
    path: `/_edit/${pageStore.path}`,
    query: siteStore.useLocales ? { locale: pageStore.locale } : undefined
  })
}
</script>
