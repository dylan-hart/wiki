<template>
  <w-btn class="account-avbtn header-nav-btn" flat>
    <!--
      An uploaded avatar, or the reader's own initials in a solid slate square -- which is what the
      design draws (`ui-redesign/Cardinal Wiki - Ledger 3x.dc.html`: a 30px `#38465f` box with the
      initials in tracked Barlow Condensed). A generic user glyph said nothing about WHO is signed
      in; two letters do, and they are the one piece of identity the header already has.
    -->
    <w-avatar v-if="userStore.authenticated && userStore.hasAvatar" size="30px" square>
      <img :src="`/_user/current/avatar`" :alt="userStore.name" />
    </w-avatar>
    <span v-else-if="userStore.authenticated" class="account-initials">{{ initials }}</span>
    <w-icon v-else name="tabler:user-circle" />
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
            icon="tabler:user"
            color="primary"
            @click="siteStore.openOverlay('Profile')" />
          <w-btn
            flat
            :label="t(`common.header.logout`)"
            icon="tabler:logout"
            color="red"
            @click="userStore.logout()" />
        </w-card-actions>
      </w-card>
    </w-menu>
    <w-tooltip labels>{{ t('common.header.account') }}</w-tooltip>
  </w-btn>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

// STORES

const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// COMPUTED

/**
 * Up to two letters standing in for an avatar: the first letter of the first and last
 * whitespace-separated parts of the display name, so "Dylan Hart" reads DH while a single-word name
 * reads its one letter rather than doubling it.
 */
const initials = computed(() => {
  const parts = (userStore.name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    return '?'
  }
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
})
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

/*
  The initials block: a solid slate square in tracked Barlow Condensed, as the design draws it. 30px
  inside the button's own 64px band, so it reads as a mark set IN the bar rather than as another
  full-height segment of it.
*/
.account-initials {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  background-color: var(--color-slate);
  color: #fff;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
}

.body--dark .account-initials {
  background-color: var(--color-slate-light);
  color: var(--color-ink-dark);
}

.body--dark .account-avbtn {
  color: var(--color-slate-light);
}
</style>
