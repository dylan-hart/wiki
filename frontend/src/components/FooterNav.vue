<template>
  <div class="site-footer">
    <div class="site-footer-line">
      <i18n-t
        v-if="hasSiteFooter"
        class="me-1"
        :keypath="isCopyright ? `common.footerCopyright` : `common.footerLicense`"
        tag="span"
        scope="global">
        <template #company>
          <strong>{{ siteStore.company }}</strong>
        </template>
        <template #year>
          <span>{{ currentYear }}</span>
        </template>
        <template #license>
          <span>{{ t(`common.license.` + siteStore.contentLicense) }}</span>
        </template>
      </i18n-t>
      <i18n-t
        :keypath="props.generic ? `common.footerGeneric` : `common.footerPoweredBy`"
        tag="span"
        scope="global">
        <template #link>
          <a href="https://js.wiki" target="_blank" rel="noopener noreferrer"
            ><strong>Wiki.js</strong></a
          >
        </template>
      </i18n-t>
    </div>
    <div v-if="!props.generic && siteStore.footerExtra" class="site-footer-line">
      <span>{{ siteStore.footerExtra }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useSiteStore } from '@/stores/site'

/**
 * Footer content.
 *
 * Content only: the enclosing layout supplies the footer element itself (`<w-footer>`, or
 * `<q-footer>` in a layout not yet migrated). Keeping positioning out of here is what lets the
 * three layouts sharing this component migrate one at a time instead of all together.
 */

// PROPS

const props = defineProps({
  generic: {
    type: Boolean,
    default: false
  }
})

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

const currentYear = new Date().getFullYear()

// COMPUTED

const hasSiteFooter = computed(() => {
  return !props.generic && siteStore.company && siteStore.contentLicense
})
const isCopyright = computed(() => {
  return siteStore.contentLicense === 'alr'
})
</script>

<style scoped>
/*
  The colophon at the foot of the article column: Cardinal's tint, ruled off above, set in Roboto
  Mono at 11px. `--color-text-caption` rather than anything fainter -- this is the one place the site
  puts its own copyright notice, so it has to be readable, and the caption tier is the floor.
*/
.site-footer {
  background-color: var(--color-tint);
  border-top: 1px solid var(--color-hairline);
  color: var(--color-text-caption);
  padding: 8px 16px;
  font-family: var(--font-mono);
  font-size: 11px;
}

:global(body.body--dark .site-footer) {
  background-color: var(--color-dark-4);
  border-top-color: var(--color-hairline-dark);
  color: var(--color-text-caption-dark);
}

.site-footer-line {
  text-align: center;
  /*
    Both `company` and `footerExtra` are free text with no length limit set anywhere they're
    written (`AdminGeneral.vue`'s inputs carry no `maxlength`) and no truncation logic here --
    unlike `HeaderNav`'s site title, which sits in a `truncate` cell. A long-but-spaced company name
    just wraps onto a second line, which is fine, but a single long unbroken token (a pasted URL, a
    run of digits) has nowhere else to break: Preflight resets the box model but sets no
    `overflow-wrap`, so without this the footer bar -- which is otherwise exactly `WPageContainer`
    width -- would push wider than the page instead of wrapping.
  */
  overflow-wrap: anywhere;
}

.site-footer-line a {
  text-decoration: none;
  color: inherit;
}

.site-footer-line a:hover,
.site-footer-line a:focus {
  text-decoration: underline;
}
</style>
