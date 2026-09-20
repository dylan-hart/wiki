<template>
  <w-btn
    class="header-actions-btn ms-4"
    flat
    round
    dense
    icon="tabler:dots-vertical"
    :aria-label="t('common.header.moreActions')">
    <w-menu ref="menu" class="translucent-menu" anchor="bottom right" self="top right">
      <!--
        Row icons take their colour as a literal `text-*` class, not `WIcon`'s `color` prop, which
        builds `text-${color}` at runtime: Tailwind generates a utility only for a class name it can
        find as literal text in the source, so a constructed one falls back to the menu's own ink.
      -->
      <w-list padding style="min-width: 250px">
        <!-- Nothing else in the phone header says whose session this is -->
        <template v-if="userStore.authenticated">
          <w-item>
            <w-item-section avatar>
              <w-avatar v-if="userStore.hasAvatar" size="32px">
                <img :src="`/_user/current/avatar`" :alt="userStore.name" />
              </w-avatar>
              <w-avatar v-else-if="userStore.avatarProviderUrl" size="32px">
                <img :src="userStore.avatarProviderUrl" :alt="userStore.name" />
              </w-avatar>
              <w-icon v-else name="tabler:user-circle" />
            </w-item-section>
            <w-item-section>
              <w-item-label>{{ userStore.name }}</w-item-label>
              <w-item-label caption>{{ userStore.email }}</w-item-label>
            </w-item-section>
          </w-item>
          <w-separator class="my-2" />
        </template>
        <!--
          A submenu, because New Page is a choice of editor rather than a single action. It anchors to
          this row because `WMenu` takes the nearest `.w-item` as its trigger. `hide-asset-btn` because
          the File Manager row below already offers it; `@new-page` closes this menu once the submenu
          has acted, or it floats over the editor it just opened.
        -->
        <w-item v-if="userStore.can(`write:pages`)" clickable>
          <w-item-section avatar>
            <w-icon name="tabler:plus" class="text-blue-4" />
          </w-item-section>
          <w-item-section>{{ t('common.header.createNewPage') }}</w-item-section>
          <w-item-section side>
            <w-icon name="tabler:chevron-right" />
          </w-item-section>
          <page-new-menu hide-asset-btn @new-page="close" />
        </w-item>
        <!--
          -> `write:pages` counts too, for an author whose rules cover the pages but not the assets
             beside them, since the editor sends them here to insert an image. The endpoints behind
             the manager check every path again, so this decides only whether the door is shown.
        -->
        <w-item v-if="canUseFileManager" clickable @click="openFileManager">
          <w-item-section avatar>
            <w-icon name="tabler:folder-open" class="text-positive" />
          </w-item-section>
          <w-item-section>{{ t('fileman.title') }}</w-item-section>
        </w-item>
        <!--
          The same affordance as `HeaderNav.vue`'s badged button, collapsed below 900px: destination
          and glyph must stay equal to it and to `InboxOverlay.vue`'s Watching tab, or the header's
          inbox icon depends on window width. `inboxGlyph.test.js` asserts that equality.
        -->
        <w-item v-if="userStore.authenticated" clickable @click="openInbox">
          <w-item-section avatar>
            <w-icon name="tabler:inbox" class="text-amber" />
          </w-item-section>
          <w-item-section>{{ t('inbox.title') }}</w-item-section>
        </w-item>
        <w-item v-if="userStore.can(`access:admin`)" clickable to="/_admin" @click="close">
          <w-item-section avatar>
            <w-icon name="tabler:tool" class="text-pink" />
          </w-item-section>
          <w-item-section>{{ t('common.header.admin') }}</w-item-section>
        </w-item>
        <!-- -> A guest whose rules grant nothing but reading has none of the rows above, and would
                otherwise open the menu on blank space over a rule with Login alone underneath -->
        <w-separator v-if="hasActionRows" class="my-2" />
        <!--
          The account rows are flattened into this list rather than opened as a second submenu: two
          plain actions, and the wide-screen panel they live in is wider than this menu ever is.
        -->
        <template v-if="userStore.authenticated">
          <w-item clickable @click="openProfile">
            <w-item-section avatar>
              <w-icon name="tabler:user" class="text-primary" />
            </w-item-section>
            <w-item-section>{{ t('common.header.profile') }}</w-item-section>
          </w-item>
          <w-item clickable @click="logout">
            <w-item-section avatar>
              <w-icon name="tabler:logout" class="text-red" />
            </w-item-section>
            <w-item-section>{{ t('common.header.logout') }}</w-item-section>
          </w-item>
        </template>
        <w-item v-else clickable to="/login" @click="close">
          <w-item-section avatar>
            <w-icon name="tabler:login" class="text-primary" />
          </w-item-section>
          <w-item-section>{{ t('common.actions.login') }}</w-item-section>
        </w-item>
      </w-list>
    </w-menu>
  </w-btn>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import PageNewMenu from '@/components/PageNewMenu.vue'

/**
 * Rendered only below 900px (`HeaderNav.vue`), standing in for the action buttons the wide bar draws
 * individually. Each row repeats the permission test of the button it replaces rather than being
 * handed a list.
 */

const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

const menu = ref(null)

const canUseFileManager = computed(
  () => userStore.can('write:assets') || userStore.can('write:pages')
)

/**
 * Restates each row's own test rather than a shorter equivalent — `canUseFileManager` already implies
 * the New Page row's permission today, but a row added or a test changed up there would otherwise
 * leave this behind, and the failure is silent.
 */
const hasActionRows = computed(
  () =>
    userStore.can('write:pages') ||
    canUseFileManager.value ||
    userStore.authenticated ||
    userStore.can('access:admin')
)

/**
 * Every row calls this rather than the menu carrying `auto-close`: that closes on ANY click inside,
 * including the New Page row -- taking the submenu's trigger out of the document in the same tick it
 * was pressed.
 */
function close() {
  menu.value?.hide()
}

/*
  Closed before the manager opens: it is a full-screen overlay, and a menu teleported to the body
  outranks it, so the menu would float over the panel it had just opened.
*/
function openFileManager() {
  close()
  siteStore.openFileManager()
}

function openInbox() {
  close()
  siteStore.openOverlay('Inbox', { tab: 'watching' })
}

function openProfile() {
  close()
  siteStore.openOverlay('Profile')
}

function logout() {
  close()
  userStore.logout()
}
</script>

<style>
/* -> Here rather than a `color` prop: `WBtn` emits that as an inline style, which would outrank */
/*    this rule. Matches `.account-avbtn`, the button it stands in for. */
.header-actions-btn {
  color: rgba(255, 255, 255, 0.75);
}
</style>
