<template>
  <w-btn class="account-avbtn header-nav-btn" flat>
    <w-icon v-if="!userStore.authenticated || !userStore.hasAvatar" name="la:user-circle" />
    <w-avatar v-else size="32px"
      ><img :src="`/_user/current/avatar`" :alt="userStore.name"
    /></w-avatar>
    <w-menu class="translucent-menu" auto-close>
      <w-card style="width: 300px">
        <!--
          -> The two greys are pitched for the light menu and go muddy on the dark one, where the
             surface is nearly black: the name takes white and the address a light grey, keeping the
             same relationship between them -- the name reads first, the address supports it
        -->
        <w-card-section>
          <div class="text-subtitle1 text-grey-7 dark:text-white">{{ userStore.name }}</div>
          <div class="text-caption text-grey-8 dark:text-grey-5">{{ userStore.email }}</div>
        </w-card-section>
        <w-separator :dark="false" />
        <w-card-actions align="center">
          <w-btn
            flat
            :label="t(`common.header.profile`)"
            icon="la:user-alt"
            color="primary"
            @click="siteStore.openOverlay('Profile')" />
          <w-btn
            flat
            :label="t(`common.header.logout`)"
            icon="la:sign-out-alt"
            color="red"
            @click="userStore.logout()" />
        </w-card-actions>
      </w-card>
    </w-menu>
    <w-tooltip labels>{{ t('common.header.account') }}</w-tooltip>
  </w-btn>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

// STORES

const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()
</script>

<style lang="scss">
// -> Where the button gets its colour, so it carries no `color` prop: `WBtn` emits an inline
//    `color`, which would outrank this rule
/*
  The account button takes the same chrome tone as the other five icons in the band rather than a
  dimmed white -- Cardinal's header is a white plate, so a translucent white here rendered the glyph
  almost invisible. `--color-slate-soft` is the icon-stroke tone the whole band is drawn in.
*/
.account-avbtn {
  color: var(--color-slate-soft);
}

.body--dark .account-avbtn {
  color: var(--color-slate-light);
}
</style>
