<template>
  <w-layout>
    <w-page-container>
      <router-view />
    </w-page-container>
  </w-layout>
</template>

<script setup>
/**
 * The shell behind `/login` (and `/login/reset-password/:token`, the same page).
 *
 * It draws no footer of its own, and that is deliberate rather than the gap task 749 originally
 * fixed. Every other layout that renders real site content in a plain scrolling page -- `MainLayout`
 * (via `pages/Index.vue`), `AdminLayout` -- ends its `WPageContainer` in a `FooterNav`, so the
 * site's copyright/license line and `footerExtra` text are visible everywhere. The login screen
 * shows the same colophon, but `Cardinal Wiki - Login 3x.dc.html` puts it INSIDE the 500px
 * credentials column -- 26px under the panel, centred, no band and no rule -- so `pages/Login.vue`
 * renders it there instead. Putting it here instead meant a footer bar below a row that is already
 * `100vh` tall: present in the DOM, and off the bottom of a screen that does not otherwise scroll.
 *
 * Profile never belonged in that list either: it was a routed `/_profile/*` layout with the same
 * always-open-modal shape as `InboxLayout` (#2510, following #2502) and is now a `MainOverlayDialog`
 * entry with no layout of its own at all (OpenProject #2532) -- either way, a footer behind its full-
 * viewport backdrop/panel would never actually be visible, the same reason `InboxLayout` never had one.
 */
</script>
