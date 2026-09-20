<template>
  <div class="site-footer">
    <!--
      The separator is a real character between the spans rather than a border or a gap, so it
      wraps with them on a narrow screen.
    -->
    <div class="site-footer-line">
      <i18n-t
        v-if="hasSiteFooter"
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
      <span v-if="hasSiteFooter" class="site-footer-sep" aria-hidden="true">·</span>
      <i18n-t
        :keypath="props.generic ? `common.footerGeneric` : `common.footerPoweredBy`"
        tag="span"
        scope="global">
        <template #link>
          <a :href="PROJECT_URL" target="_blank" rel="noopener noreferrer">Cardinal.js</a>
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

/** This fork's own home, not upstream's `js.wiki`. */
const PROJECT_URL = 'https://github.com/dylan-hart/wiki'

import { useSiteStore } from '@/stores/site'

/**
 * Footer CONTENT only: the enclosing layout supplies the `<w-footer>` element itself, so this
 * component carries no positioning of its own.
 */

const props = defineProps({
  generic: {
    type: Boolean,
    default: false
  }
})

const siteStore = useSiteStore()

const { t } = useI18n()

const currentYear = new Date().getFullYear()

const hasSiteFooter = computed(() => {
  return !props.generic && siteStore.company && siteStore.contentLicense
})
const isCopyright = computed(() => {
  return siteStore.contentLicense === 'alr'
})
</script>

<style scoped>
/*
  `--color-text-caption` rather than anything fainter: this is where the site puts its own copyright
  notice, so it has to stay readable, and the caption tier is the floor.
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

/*
  Cobalt draws this bar dark navy in BOTH themes, so it takes the dedicated `--color-footer-*`
  tokens rather than `--color-tint`. Additive rather than a swap of the base rule, whose Ledger
  default is still needed. Only light suppresses the rule above the bar: Cobalt dark draws one, and
  `--color-hairline-dark` already resolves there through the `.body--dark` rule above.
*/
:global(body.body--cobalt .site-footer) {
  background-color: var(--color-footer-bg);
  color: var(--color-footer-text);
}

:global(body.body--cobalt:not(.body--dark) .site-footer) {
  border-top: 0;
}

/*
  Cobalt dark's copyright line wants `--color-text-caption-dark`, not `--color-footer-text`, which
  was only ever given a light-mode Cobalt value. The `.body--dark` rule above already asks for the
  right token and loses this cascade purely on specificity, so this is one extra notch rather than
  a new token.
*/
:global(body.body--cobalt.body--dark .site-footer) {
  color: var(--color-text-caption-dark);
}

.site-footer-line {
  text-align: center;
  /*
    `company` and `footerExtra` are free text with no length limit and no truncation here, and a
    single unbroken token (a pasted URL, a run of digits) has nowhere to break. Preflight sets no
    `overflow-wrap`, so without this the bar pushes wider than the page instead of wrapping.
  */
  overflow-wrap: anywhere;
}

.site-footer-line a {
  text-decoration: none;
  color: var(--color-accent-strong);
}

:global(body.body--dark .site-footer-line a) {
  color: var(--color-accent-dark);
}

/*
  Cobalt's footer link takes `--color-footer-link`, not the general `--color-accent-strong`: a
  dark-navy bar in both themes needs its own link tone, where the page accent shifts between them.
*/
:global(body.body--cobalt .site-footer-line a) {
  color: var(--color-footer-link);
}

.site-footer-sep {
  margin: 0 0.4em;
  opacity: 0.6;
}

.site-footer-line a:hover,
.site-footer-line a:focus {
  text-decoration: underline;
}
</style>
