<template>
  <w-btn class="account-avbtn flush-hover-btn header-nav-btn" flat>
    <w-avatar v-if="userStore.authenticated && userStore.hasAvatar" size="30px" square>
      <img :src="`/_user/current/avatar`" :alt="userStore.name" />
    </w-avatar>
    <w-avatar v-else-if="userStore.authenticated && userStore.avatarProviderUrl" size="30px" square>
      <img :src="userStore.avatarProviderUrl" :alt="userStore.name" />
    </w-avatar>
    <span v-else-if="userStore.authenticated" class="account-initials">{{ initials }}</span>
    <w-icon v-else name="tabler:user-circle" />
    <w-menu class="translucent-menu" auto-close>
      <w-card style="width: 300px">
        <!--
          -> The two greys are pitched for the light menu and go muddy on the near-black dark one,
             so dark takes white and a light grey instead -- the name still reads ahead of the
             address
        -->
        <w-card-section>
          <div class="text-subtitle1 text-grey-7 dark:text-white">{{ userStore.name }}</div>
          <div class="text-caption text-grey-8 dark:text-grey-5">{{ userStore.email }}</div>
        </w-card-section>
        <w-separator :dark="false" />
        <w-card-actions class="account-actions">
          <w-btn
            class="account-actions-btn"
            flat
            :label="t(`common.header.profile`)"
            icon="tabler:user"
            color="primary"
            @click="siteStore.openOverlay('Profile')" />
          <w-btn
            class="account-actions-btn border-l border-hairline dark:border-hairline-dark"
            flat
            :label="t(`common.header.logout`)"
            icon="tabler:logout"
            color="negative"
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

import { initials as initialsFor } from '@/helpers/initials'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

const initials = computed(() => initialsFor(userStore.name))
</script>

<style>
/*
  -> No `color` prop on the button: `WBtn` emits an inline `color`, which would outrank this rule.
     A translucent white glyph is near-invisible against the white header plate, so the button
     takes the same icon-stroke tone as the rest of the band.
*/
.account-avbtn {
  color: var(--color-header-icon);
}

/*
  Only the box is set here: the fill, shape, type and Ledger dark-mode override are shared with a
  comment's `identity="initials"` avatar, in `css/tailwind.css`.
*/
.account-initials {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
}

.body--dark:not(.body--cobalt) .account-avbtn {
  color: var(--color-slate-light);
}

/*
  Overrides `WCardActions`' centered default so the pair fills the row edge-to-edge, flush to the
  shared middle divider. Scoped here rather than in `WCardActions`: every other caller's
  confirm/cancel pair still wants the centered layout.
*/
.account-actions {
  padding: 0;
  gap: 0;
  align-items: stretch;
}

.account-actions .account-actions-btn {
  flex: 1 1 50%;
  width: 50%;
}
</style>
