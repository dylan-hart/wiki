<template>
  <div class="auth">
    <div class="auth-content">
      <div class="auth-logo"><img :src="`/_site/current/logo`" :alt="siteStore.title" /></div>
      <h2 class="auth-site-title" v-if="siteStore.logoText">{{ siteStore.title }}</h2>
      <p class="auth-lead">{{ t('auth.loginToContinue') }}</p>
      <auth-login-panel />
      <!--
        The colophon, inside the column rather than under the whole shell.

        `Cardinal Wiki - Login 3x.dc.html` draws it as the last thing in the 500px column -- 26px
        below the panel, centred, 11px mono, no band and no rule -- not as the page-wide footer bar
        every other layout ends in. It used to be an `AuthLayout` `<w-footer>`, which put it beneath
        a row that is already `100vh` tall: the right content (task 749 added it for exactly that
        reason) in a place nobody could see without scrolling a screen that does not otherwise
        scroll. `.auth-colophon` takes the bar's tint and rule back off; `FooterNav` itself is
        untouched, since `MainLayout` and `AdminLayout` still want the band.
      -->
      <div class="auth-colophon"><footer-nav /></div>
    </div>
    <div class="auth-bg" aria-hidden="true"><img :src="`/_site/current/loginBg`" alt="" /></div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { useMeta } from '@/composables/meta'

import { useSiteStore } from '@/stores/site'

import AuthLoginPanel from '@/components/AuthLoginPanel.vue'
import FooterNav from '@/components/FooterNav.vue'

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('auth.login.title')
}))
</script>

<style lang="scss">
/*
  The login screen, and with it the auth panel's shared visual language.

  Unscoped on purpose, and `.auth`-prefixed throughout: `AuthLoginPanel`, `AuthRegisterScreen` and
  `AuthTfaScreens` only ever render inside this column, and the two design files draw them as one
  continuous surface rather than three components that happen to be adjacent. Holding the tones, the
  rhythm and the frames in one place is what stops the three from drifting apart the way the
  `acrylic-btn` / `color="primary"` treatment they each carried already had. Anything that is a
  MEASUREMENT of a control -- a button's own band height -- goes through `WBtn`'s `size`/`padding`
  props at the call site instead, since its `min-height` is an inline style no stylesheet rule can
  reach without `!important`.

  Reference: `ui-redesign/Cardinal Wiki - Login 3x.dc.html` and `- Auth Screens 3x.dc.html`.
*/
.auth {
  background-color: $surface;
  color: $text-body;
  display: flex;
  align-items: stretch;
  /*
    On the row, not on the background pane alone. The pane used to carry a fixed `height: 100vh`,
    which made it the thing setting the screen's height -- so a column taller than the viewport (the
    register form on a site with several strategies) overflowed it instead of growing it. A minimum
    on the row lets either side be the taller one.
  */
  min-height: 100vh;

  @at-root .body--dark & {
    background-color: $dark-6;
    color: $text-dark;
  }

  &-content {
    flex: 1 0 100%;
    width: 100%;
    max-width: 500px;
    /* -> The design's `48px 56px`; this was `3rem 4rem`, 8px wider on each side */
    padding: 48px 56px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: stretch;
    box-sizing: border-box;

    @media (max-width: $breakpoint-xs-max) {
      padding: 1rem 2rem;
      max-width: 100vw;
    }
  }

  &-logo {
    margin-bottom: 6px;

    img {
      height: 72px;
    }
  }

  /*
    The wordmark. Cardinal sets it in the display face, uppercase and letter-spaced -- the same
    treatment the header band's own site title takes -- rather than in the body face at whatever
    case the site happened to type its name in.
  */
  &-site-title {
    font-family: var(--font-display);
    font-size: 30px;
    line-height: 1.2;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin: 0;
    color: $ink;

    @at-root .body--dark & {
      color: $text-dark;
    }
  }

  /* -> The line under the wordmark */
  &-lead {
    font-size: 14px;
    line-height: 1.5;
    color: $text-secondary;
    margin: 6px 0 20px;

    @at-root .body--dark & {
      color: $text-secondary-dark;
    }
  }

  /*
    A screen's own subtitle, once the panel has switched away from the login form -- register, 2FA,
    forgot, reset. The auth-screens sheet sets each at 13.5px with 14px beneath it.
  */
  &-subtitle {
    font-size: 13.5px;
    line-height: 1.5;
    color: $text-secondary;
    margin: 0 0 14px;

    @at-root .body--dark & {
      color: $text-secondary-dark;
    }
  }

  /*
    A statement rather than a subtitle -- "check your emails to activate your account", "this site
    requires two-factor authentication". The design sets these a tier darker than a subtitle, in the
    chrome tone, because they are the whole content of the screen rather than a preamble to a form.
  */
  &-notice {
    font-size: 13.5px;
    line-height: 1.6;
    color: $slate;
    margin: 0;

    @at-root .body--dark & {
      color: $text-dark;
    }
  }

  /* -> The first line of the 2FA setup screen, which the design leads with in semibold */
  &-notice--lead {
    font-weight: 600;
    line-height: 1.5;
    margin-bottom: 6px;
  }

  /* -> The caption over the strategy selector */
  &-hint {
    font-size: 13px;
    line-height: 1.4;
    color: $text-secondary;
    margin: 0 0 8px;

    @at-root .body--dark & {
      color: $text-secondary-dark;
    }
  }

  &-strategies {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(45%, 1fr));
    gap: 10px;
    margin-bottom: 18px;
  }

  /*
    The fields. The design draws each as a bare hairline box with a leading glyph and no label above
    it -- so the label is passed as a placeholder plus an `aria-label` instead (the conversion
    `PagePropertiesDialog.vue` already made, for the same reason), and the box takes the design's own
    height. `min-height` here is a utility CLASS on the control, not an inline style, so an unlayered
    rule beats `min-h-[34px]` without `!important`.
  */
  &-field .w-input-control {
    min-height: 44px;
    padding-inline: 12px;
  }

  /* -> The register form's fields are one step shorter than the login screen's */
  &-field--sm .w-input-control {
    min-height: 40px;
    padding-inline: 11px;
  }

  /*
    The blueprint corner marks on a primary action: two 6px right-angles standing 3px outside the
    top-left and bottom-right corners. The same mark the page header's icon plate draws, and for the
    same reason -- this is the thing being pointed at. Two corners rather than four is what both auth
    sheets draw. Drawn in the bright accent, which is what a mark is (ink, carrying no text); the
    button's own fill carries a white label and therefore stays on `$primary`.
  */
  &-marks {
    position: relative;

    &::before,
    &::after {
      content: '';
      position: absolute;
      width: 6px;
      height: 6px;
      pointer-events: none;
    }

    &::before {
      top: -3px;
      inset-inline-start: -3px;
      border-top: 1px solid $accent-fill;
      border-inline-start: 1px solid $accent-fill;
    }

    &::after {
      bottom: -3px;
      inset-inline-end: -3px;
      border-bottom: 1px solid $accent-fill;
      border-inline-end: 1px solid $accent-fill;
    }
  }

  /*
    Every glyph in an auth button. `WBtn` scales an icon to its own line height (1.715em), which at
    these larger labels draws a 24px glyph where both sheets draw 15-16px. Stated as a ratio rather
    than a length, so the one rule covers all five band sizes.
  */
  .w-btn .w-icon {
    font-size: 1.15em;
  }

  /*
    The colophon. `FooterNav` draws itself as a tinted, ruled bar for the two layouts that end a
    scrolling page in one; here it is a line of type at the foot of the column, which is what the
    design draws. The mono face, the 11px and the caption tone are already the bar's own.
  */
  &-colophon {
    margin-top: 26px;

    .site-footer {
      background-color: transparent;
      border-top: 0;
      padding: 0;
    }
  }

  &-bg {
    flex: 1;
    flex-basis: 0;
    position: relative;
    /*
      The design's own ground, and the answer to which of three grounds this pane has: the tint is
      the LAYOUT's, and a site's uploaded login background sits on top of it. With nothing painted
      here, a site that has never uploaded one showed a white pane beside a white column and the
      split read as a rendering fault rather than as a screen.
    */
    background-color: $tint;
    min-height: 100vh;
    overflow: hidden;

    @at-root .body--dark & {
      background-color: $dark-4;
    }

    img {
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
  }
}
</style>
