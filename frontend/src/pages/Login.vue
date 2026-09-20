<template>
  <div class="auth" :class="{ 'auth--exiting': exiting }">
    <div class="auth-content">
      <div class="auth-logo"><img :src="`/_site/current/logo`" :alt="siteStore.title" /></div>
      <h2 class="auth-site-title" v-if="siteStore.logoText">{{ siteStore.title }}</h2>
      <p class="auth-lead">{{ t('auth.loginToContinue') }}</p>
      <auth-login-panel @exit-flourish="exiting = true" />
      <!--
        Inside the column, not under the whole shell: the row is already `100vh` tall, so a
        page-wide footer bar below it is unreachable on a screen that does not otherwise scroll.
        `.auth-colophon` takes the bar's tint and rule back off; `FooterNav` itself stays the band
        `MainLayout` and `AdminLayout` want.
      -->
      <div class="auth-colophon"><footer-nav /></div>
    </div>
    <div class="auth-bg" aria-hidden="true"><img :src="`/_site/current/loginBg`" alt="" /></div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useMeta } from '@/composables/meta'

import { useSiteStore } from '@/stores/site'

import AuthLoginPanel from '@/components/AuthLoginPanel.vue'
import FooterNav from '@/components/FooterNav.vue'

const siteStore = useSiteStore()

const { t } = useI18n()

/*
  Flipped by `AuthLoginPanel`'s `exit-flourish` emit to play the exit animation below, immediately
  before the panel's own delayed `window.location.replace()` tears the SPA down. Never reset back to
  `false`: the hard navigation replaces the whole page, so there is no "after" state to return to.
*/
const exiting = ref(false)

useMeta(() => ({
  title: t('auth.login.title')
}))
</script>

<style>
/* Selectors stay flat: `&-suffix` concatenation is a Sass idiom, not valid in native CSS nesting,
   and a browser silently drops such a rule rather than reporting it. */
/*
  The login screen, and with it the auth panel's shared visual language.

  Unscoped on purpose, and `.auth`-prefixed throughout: `AuthLoginPanel`, `AuthRegisterScreen` and
  `AuthTfaScreens` only ever render inside this column and are drawn as one continuous surface, so
  holding the tones, the rhythm and the frames in one place is what stops the three from drifting
  apart. Anything that is a MEASUREMENT of a control -- a button's own band height -- goes through
  `WBtn`'s `size`/`padding` props at the call site instead, since its `min-height` is an inline
  style no stylesheet rule can reach without `!important`.
*/
.auth {
  background-color: var(--color-surface);
  color: var(--color-text-body);
  display: flex;
  align-items: stretch;
  /*
    A minimum on the row, not a fixed height on the background pane: a column taller than the
    viewport (the register form on a site with several strategies) must grow the screen, not
    overflow a pane that is setting its height.
  */
  min-height: 100vh;
}
.body--dark .auth {
  background-color: var(--color-dark-6);
  color: var(--color-text-dark);
}
.auth-content {
  flex: 1 0 100%;
  width: 100%;
  max-width: 500px;
  padding: 48px 56px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: stretch;
  box-sizing: border-box;
  /*
    The exit flourish plays inside the panel's own navigation budget, so this duration must stay in
    step with `AuthLoginPanel.vue`'s `EXIT_FLOURISH_MS`.
  */
  transition:
    transform 320ms ease-out,
    opacity 320ms ease-out;
  transform-origin: center;
}
@media (max-width: 599.98px) {
  .auth-content {
    padding: 1rem 2rem;
    max-width: 100vw;
  }
}
.auth-logo {
  margin-bottom: 6px;
}
.auth-logo img {
  height: 192px;
}
.auth {
  /* The wordmark, in the display face the header band's own site title takes. */
}
.auth-site-title {
  font-family: var(--font-display);
  font-size: 30px;
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin: 0;
  color: var(--color-ink);
}
.body--dark .auth-site-title {
  color: var(--color-text-dark);
}
.auth {
  /* -> The line under the wordmark */
}
.auth-lead {
  font-size: 14px;
  line-height: 1.5;
  color: var(--color-text-secondary);
  margin: 6px 0 20px;
}
.body--dark .auth-lead {
  color: var(--color-text-secondary-dark);
}
.auth {
  /* A screen's own subtitle, once the panel has switched away from the login form. */
}
.auth-subtitle {
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--color-text-secondary);
  margin: 0 0 14px;
}
.body--dark .auth-subtitle {
  color: var(--color-text-secondary-dark);
}
.auth {
  /*
    A statement rather than a subtitle -- "check your emails to activate your account". A tier
    darker than a subtitle, because it is the whole content of the screen, not a preamble to a form.
  */
}
.auth-notice {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--color-slate);
  margin: 0;
}
.body--dark .auth-notice {
  color: var(--color-text-dark);
}
.auth {
  /* -> The 2FA setup screen's lead line */
}
.auth-notice--lead {
  font-weight: 600;
  line-height: 1.5;
  margin-bottom: 6px;
}
.auth {
  /* -> The caption over the strategy selector */
}
.auth-hint {
  font-size: 13px;
  line-height: 1.4;
  color: var(--color-text-secondary);
  margin: 0 0 8px;
}
.body--dark .auth-hint {
  color: var(--color-text-secondary-dark);
}
.auth-strategies {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(45%, 1fr));
  gap: 10px;
  margin-bottom: 18px;
}
.auth {
  /*
    Each field is a bare hairline box with no label above it, so its label is passed as a
    placeholder plus an `aria-label`. `min-height` on the control is a utility CLASS rather than an
    inline style, so an unlayered rule beats it without `!important`.
  */
}
.auth-field .w-input-control {
  min-height: 44px;
  padding-inline: 12px;
}
.auth {
  /* -> The register form's fields are one step shorter than the login screen's */
}
.auth-field--sm .w-input-control {
  min-height: 40px;
  padding-inline: 11px;
}
.auth {
  /*
    The blueprint corner marks on a primary action: two right-angles standing outside the top-left
    and bottom-right corners, drawn in the accent, which is what a mark carrying no text is.
    `display: var(--corner-marks)` gates them per aesthetic -- `block` under Ledger, `none` under
    Cobalt, whose cards and controls carry no registration marks at all.
  */
}
.auth-marks {
  position: relative;
}
.auth-marks::before,
.auth-marks::after {
  content: '';
  position: absolute;
  display: var(--corner-marks);
  width: 6px;
  height: 6px;
  pointer-events: none;
}
.auth-marks::before {
  top: -3px;
  inset-inline-start: -3px;
  border-top: 1px solid var(--color-accent-fill);
  border-inline-start: 1px solid var(--color-accent-fill);
}
.auth-marks::after {
  bottom: -3px;
  inset-inline-end: -3px;
  border-bottom: 1px solid var(--color-accent-fill);
  border-inline-end: 1px solid var(--color-accent-fill);
}
.auth {
  /*
    `WBtn` scales an icon to its own line height, which at these larger labels draws a glyph half
    again too big. A ratio rather than a length, so the one rule covers every band size.
  */
}
.auth .w-btn .w-icon {
  font-size: 1.15em;
}
.auth {
  /*
    `FooterNav` draws itself as a tinted, ruled bar for the layouts that end a scrolling page in
    one; at the foot of this column it is a line of type instead, so the band comes back off.
  */
}
.auth-colophon {
  margin-top: 26px;
}
.auth-colophon .site-footer {
  background-color: transparent;
  border-top: 0;
  padding: 0;
}
.auth-bg {
  flex: 1;
  flex-basis: 0;
  position: relative;
  /*
    A site's uploaded login background sits on top of this tint. Without it, a site that has never
    uploaded one draws a white pane beside a white column, which reads as a rendering fault.
  */
  background-color: var(--color-tint);
  min-height: 100vh;
  overflow: hidden;
  /* -> Matches `.auth-content`'s own duration and easing */
  transition: opacity 320ms ease-out;
}
.body--dark .auth-bg {
  background-color: var(--color-dark-4);
}
.auth-bg img {
  position: relative;
  width: 100%;
  height: 100%;
  object-fit: cover;
  top: 0;
  bottom: 0;
  inset-inline-start: 0;
  inset-inline-end: 0;
  margin: 0;
  padding: 0;
}
.auth {
  /*
    The exit flourish's end state. `.auth-bg` only fades -- the background pane dims rather than
    shrinking with the column in front of it.
  */
}
.auth--exiting .auth-content {
  transform: scale(0.94);
  opacity: 0;
}
.auth--exiting .auth-bg {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .auth {
    /* -> Defence in depth: `AuthLoginPanel.vue` already skips the `exit-flourish` emit under */
    /*    reduced motion, so `.auth--exiting` never lands here however it were toggled. */
  }
  .auth-content,
  .auth-bg {
    transition: none;
  }
}
</style>
