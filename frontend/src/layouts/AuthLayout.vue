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
 * Every other layout that renders real site content in a plain scrolling page -- `MainLayout` (via
 * `pages/Index.vue`), `AdminLayout` -- ends its `WPageContainer` in a `FooterNav`, so the site's
 * copyright/license line and `footerExtra` text are visible everywhere except here. The login/auth
 * screens are public-facing (this is the front door for an anonymous visitor, same as the home page),
 * not an internal control panel, so this uses the full variant like `MainLayout` does -- not
 * `generic` like `AdminLayout`, which deliberately hides site branding inside the admin area.
 * 2.5.x's login screen included this footer; its absence here was a gap introduced during the 3.x
 * rewrite, not an intentional redesign.
 *
 * Profile never belonged in that list either: it was a routed `/_profile/*` layout with the same
 * always-open-modal shape as `InboxLayout` (#2510, following #2502) and is now a `MainOverlayDialog`
 * entry with no layout of its own at all (OpenProject #2532) -- either way, a footer behind its full-
 * viewport backdrop/panel would never actually be visible, the same reason `InboxLayout` never had one.
 */
import FooterNav from '@/components/FooterNav.vue'
</script>
