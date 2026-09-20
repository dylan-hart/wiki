<template>
  <w-layout>
    <w-page-container>
      <router-view />
    </w-page-container>
  </w-layout>
</template>

<script setup>
/**
 * No `FooterNav` of its own, unlike `MainLayout` and `AdminLayout`: `pages/Login.vue` draws the
 * site colophon inside its own credentials column instead. A footer bar below a row that is already
 * `100vh` tall sits off the bottom of a screen that does not otherwise scroll.
 */
</script>
