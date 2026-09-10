<template>
  <div class="site-footer">
    <!--
      The colophon reads as one line of separated parts -- `© 2026 Cardinal wiki · CC BY-SA 4.0 ·
      Powered by Cardinal.js` -- which is what the design draws. The separator is a real character
      between spans rather than a border or a gap, so it wraps with them on a narrow screen.
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

/**
 * Where "Powered by Cardinal.js" points. The repository, which is this project's own home -- the
 * fork is not Wiki.js and no longer links to js.wiki.
 */
const PROJECT_URL = 'https://github.com/dylan-hart/wiki'

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

/*
  Cobalt draws the footer as a dark navy strip in BOTH themes (`Page View 3x - Cobalt`/`Page View
  Dark 3x - Cobalt` -- the mockups draw the identical `#10194a` bar either way), not the light-blue
  `--color-tint` this reused: `--color-footer-*` (`tailwind.css`, OpenProject #2767) is the dedicated
  token set declared for exactly this and was never wired up. Additive rather than a base-rule swap,
  since `--color-tint`'s own Ledger default is what the unscoped rule above still needs (OpenProject
  #2774). The light mockup draws no rule at all above the bar; the dark one does, and
  `--color-hairline-dark` already resolves correctly there via the existing `.body--dark` rule above,
  so only the light case needs suppressing here.
*/
:global(body.body--cobalt .site-footer) {
  background-color: var(--color-footer-bg);
  color: var(--color-footer-text);
}

:global(body.body--cobalt:not(.body--dark) .site-footer) {
  border-top: 0;
}

/*
  `ui-iteration-cobalt-typography/cobalt-typography.md` §3/§5 (OpenProject #2980): Cobalt dark's
  copyright line is the caption/kicker dark tier (`--color-text-caption-dark`, `#8b98d6` -- already
  restated for Cobalt in `tailwind.css`'s `body.body--cobalt.body--dark` block, and already what the
  Ledger dark rule above this one reads), NOT `--color-footer-text` -- that token was only ever given
  a light-mode Cobalt value, so left alone it keeps resolving to `#a7b3ea` under Cobalt dark too. The
  Ledger dark rule above already asks for the right token; it loses the cascade here purely on
  specificity (two classes vs. this selector's three), so the fix is this one extra notch rather than
  a new token.
*/
:global(body.body--cobalt.body--dark .site-footer) {
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

/* -> The one coloured thing in the bar, which is what the design makes it */
.site-footer-line a {
  text-decoration: none;
  color: var(--color-accent-strong);
}

:global(body.body--dark .site-footer-line a) {
  color: var(--color-accent-dark);
}

/*
  Cobalt's own footer link is `--color-footer-link` (`#ff7a84`, identical in both mockups), not the
  general `--color-accent-strong` this reused -- a dark-navy bar in both themes needs its own link
  tone rather than the page's own accent, which shifts between light and dark (OpenProject #2774).
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
