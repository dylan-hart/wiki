<template>
  <section v-if="canShowEmbed" class="page-comments-embed">
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
 * Two boundaries this component exists to enforce:
 *
 * 1. **`read:comments`.** The gate is on the whole template, not on visibility: a reader who lacks
 *    the permission never gets a container, so no vendor `mount()` runs and no `<script>`/`<link>`
 *    is created -- the vendor is never told this page exists.
 * 2. **Canonical URL.** The origin comes from `siteStore.commentsProvider.origin` (the backend's
 *    `requestOrigin()`), never from `window.location`, so the vendor keys threads on the site's own
 *    canonical host whatever host the reader reached it by.
 *
 * The container is keyed on `pageStore.id` so each vendor's "already loaded" re-target flow
 * (`DISQUS.reset()`, `commento.main()`, ...) finds a freshly-mounted element rather than one reused
 * across pages.
 */

const { t } = useI18n()

const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const containerEl = ref(null)

const provider = computed(() => COMMENT_EMBED_PROVIDERS[siteStore.commentsProvider?.module])

/** `provider` is checked too: a module this build has no builder for draws nothing at all. */
const canShowEmbed = computed(
  () => Boolean(provider.value) && userStore.pagePermissions.includes('read:comments')
)

/**
 * `nextTick()` first: the container sits behind the `v-if`/`:key`, so the element only exists a
 * render after `canShowEmbed` flips or `pageStore.id` changes.
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
// -> SPA navigation does not remount this component, and `canShowEmbed` can flip after mount when
//    the per-route `pagePermissions` fetch lands -- both need a fresh embed.
watch(() => [pageStore.id, canShowEmbed.value], mountEmbed)
</script>
