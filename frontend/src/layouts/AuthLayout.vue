<template>
  <w-layout>
    <w-page-container>
      <router-view />
      <w-footer>
        <footer-nav />
      </w-footer>
    </w-page-container>
  </w-layout>
</template>

<script setup>
/**
 * Every other layout that renders real site content -- `MainLayout` (via `pages/Index.vue`),
 * `ProfileLayout`, `AdminLayout` -- ends its `WPageContainer` in a `FooterNav`, so the site's
 * copyright/license line and `footerExtra` text are visible everywhere except here. The login/auth
 * screens are public-facing (this is the front door for an anonymous visitor, same as the home page),
 * not an internal control panel, so this uses the full variant like `MainLayout`/`ProfileLayout` do --
 * not `generic` like `AdminLayout`, which deliberately hides site branding inside the admin area.
 * 2.5.x's login screen included this footer; its absence here was a gap introduced during the 3.x
 * rewrite, not an intentional redesign.
 */
import FooterNav from '@/components/FooterNav.vue'
</script>
