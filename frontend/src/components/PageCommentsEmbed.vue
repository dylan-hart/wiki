<template>
  <section v-if="canShowEmbed" class="page-comments-embed text-text-body dark:text-text-dark">
    <header class="page-comments-embed-header flex items-center gap-2">
      <h2 class="text-h6 m-0">{{ t(`common.comments.title`) }}</h2>
    </header>
    <div :key="pageStore.id" ref="containerEl" class="page-comments-embed-container" />
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { COMMENT_EMBED_PROVIDERS } from '@/helpers/commentEmbeds'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/**
 * Page-view embed for a `codeTemplate` comment provider (Disqus/Commento/Artalk) -- `Index.vue`
 * mounts this INSTEAD OF `PageComments.vue` whenever `siteStore.commentsProvider` is set (i.e. the
 * site's active provider is a `codeTemplate` one), the same `v-if="siteStore.features.comments &&
 * pageStore.allowComments"` gate `PageComments.vue` sits behind otherwise unchanged.
 *
 * Two boundaries this component exists to enforce -- both spelled out in
 * `backend/models/commentProviders.ts`'s doc comment, which this is the actual implementation of:
 *
 * 1. **`read:comments` permission boundary.** `canShowEmbed` below gates the ENTIRE template on
 *    `userStore.pagePermissions.includes('read:comments')` -- the page-scoped permission list
 *    `App.vue` already refreshes per route (the same list `Index.vue` reads for
 *    `write:pages`/`read:history`/etc). A reader who lacks it never gets `<div ref="containerEl">`
 *    rendered at all, so a vendor's `mount()` is never called and no `<script>`/`<link>` is ever
 *    created -- the vendor is never told this page exists, not merely CSS-hidden after the fact.
 * 2. **Canonical URL boundary.** `pageUrl` is built as `siteStore.commentsProvider.origin +
 *    '/' + page.path` -- `origin` came from the backend's `requestOrigin(req.protocol, req.hostname)`
 *    (`buildSitePayload()`, `api/sites.ts`), never from `window.location` here.
 *
 * The container is keyed on `pageStore.id`, so Vue tears it down and creates a fresh, empty element
 * on every SPA navigation to a different page rather than reusing one across pages -- what lets each
 * vendor's own "already loaded" re-target flow (`DISQUS.reset()`, `commento.main()`, `Artalk.init()`
 * again) target a real, freshly-mounted element every time, documented on
 * `helpers/commentEmbeds.js` itself.
 */

const { t } = useI18n()

const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const containerEl = ref(null)

/** The embed builder for the active provider, or undefined if its module key is unrecognized. */
const provider = computed(() => COMMENT_EMBED_PROVIDERS[siteStore.commentsProvider?.module])

/**
 * Whether to render anything at all -- see the permission-boundary doc above. `provider` is checked
 * too: an active `commentsProvider.module` this build has no embed builder for (a module removed
 * since it was activated) renders nothing rather than an empty, pointless container.
 */
const canShowEmbed = computed(
  () => Boolean(provider.value) && userStore.pagePermissions.includes('read:comments')
)

/**
 * Builds the vendor embed into `containerEl`, once it exists and both gates above hold. Awaits
 * `nextTick()` first: the container is behind the `v-if`/`:key` above, so a transition into
 * `canShowEmbed` or a `pageStore.id` change needs a render tick before the (fresh) element exists.
 */
async function mountEmbed() {
  if (!canShowEmbed.value) {
    return
  }
  await nextTick()
  if (!containerEl.value) {
    return
  }
  const path = (pageStore.path || '').replace(/^\/+/, '')
  const pageUrl = `${siteStore.commentsProvider.origin}/${path}`
  await provider.value.mount(containerEl.value, siteStore.commentsProvider.config, pageUrl)
}

onMounted(mountEmbed)
// -> SPA navigation between pages does not remount this component (same reasoning as
//    `PageComments.vue`'s own `pageStore.id` watcher), and `canShowEmbed` can flip once
//    `userStore.pagePermissions` finishes its own per-route fetch after this component has already
//    mounted -- both are what need a fresh embed, not just a page change on its own.
watch(() => [pageStore.id, canShowEmbed.value], mountEmbed)
</script>
