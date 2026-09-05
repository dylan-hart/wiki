<template>
  <w-page class="admin-locale">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-change-theme.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.sites.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.sites.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="me-2"
          icon="la:redo-alt"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.refresh`)"
          @click="refresh">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn icon="la:plus" :label="t(`admin.sites.new`)" color="primary" @click="createSite" />
      </div>
    </div>
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12">
        <w-card>
          <w-list separator>
            <w-item v-for="site of adminStore.sites" :key="site.id">
              <w-item-section side>
                <w-icon name="la:chalkboard" color="primary" />
              </w-item-section>
              <w-item-section
                ><strong>{{ site.title }}</strong></w-item-section
              >
              <w-item-section>
                <div>
                  <a
                    class="site-hostname-link"
                    :href="siteUrl(site)"
                    target="_blank"
                    rel="noopener noreferrer"
                    :aria-label="t(`admin.sites.openSite`, { hostname: site.hostname })">
                    <w-chip
                      class="mx-0"
                      v-if="site.hostname !== `*`"
                      color="blue-7"
                      text-color="white"
                      size="sm">
                      <w-avatar icon="la:angle-right" color="blue-5" text-color="white" />
                      <span>{{ site.hostname }}</span>
                    </w-chip>
                    <w-chip class="mx-0" v-else color="indigo-7" text-color="white" size="sm">
                      <w-avatar icon="la:asterisk" color="indigo-5" text-color="white" />
                      <span>catch-all</span>
                    </w-chip>
                  </a>
                </div>
              </w-item-section>
              <w-item-section side>
                <w-toggle
                  :model-value="site.isEnabled"
                  :label="t(`admin.sites.isActive`)"
                  :aria-label="t(`admin.sites.isActive`)"
                  @update:model-value="
                    (val) => {
                      toggleSiteState(site, val)
                    }
                  " />
              </w-item-section>
              <w-separator class="ms-4" vertical />
              <w-item-section side style="flex-direction: row; align-items: center">
                <w-btn
                  class="acrylic-btn me-2"
                  flat
                  :href="siteUrl(site)"
                  target="_blank"
                  icon="la:external-link-alt"
                  color="grey"
                  :aria-label="t(`admin.sites.openSite`, { hostname: site.hostname })">
                  <w-tooltip>{{
                    t(`admin.sites.openSite`, { hostname: site.hostname })
                  }}</w-tooltip>
                </w-btn>
                <w-btn
                  class="acrylic-btn me-2"
                  flat
                  @click="editSite(site)"
                  icon="la:pen"
                  :color="dark.isActive ? `indigo-4` : `indigo`"
                  :label="t(`common.actions.edit`)" />
                <w-btn
                  class="acrylic-btn"
                  flat
                  icon="la:trash"
                  color="negative"
                  @click="deleteSite(site)"
                  :aria-label="t(`common.actions.delete`)" />
              </w-item-section>
            </w-item>
          </w-list>
        </w-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { nextTick, onMounted } from 'vue'
import { useRouter } from 'vue-router'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { dialog } from '@/composables/dialog'

import { useAdminStore } from '../stores/admin'
import SiteActivateDialog from '../components/SiteActivateDialog.vue'
import SiteCreateDialog from '../components/SiteCreateDialog.vue'
import SiteDeleteDialog from '../components/SiteDeleteDialog.vue'

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()

// ROUTER

const router = useRouter()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.sites.title')
}))

// METHODS

/**
 * The URL to open a site in a new tab. Sites are resolved purely by the request's `Host`
 * header (WIKI.sitesMappings[req.hostname]), so opening one just means navigating to its
 * hostname. The `*` catch-all row has no hostname of its own, so it falls back to whatever
 * host is currently serving this admin page.
 */
function siteUrl(site) {
  return `//${site.hostname === '*' ? window.location.host : site.hostname}`
}
async function refresh() {
  await adminStore.fetchSites()
  notify({
    type: 'positive',
    message: t('admin.sites.refreshSuccess')
  })
}
function createSite() {
  dialog({
    component: SiteCreateDialog
  })
}
function editSite(st) {
  adminStore.$patch({
    currentSiteId: st.id
  })
  nextTick(() => {
    router.push(`/_admin/${st.id}/general`)
  })
}
function toggleSiteState(st, newState) {
  dialog({
    component: SiteActivateDialog,
    componentProps: {
      site: st,
      targetState: newState
    }
  })
}
function deleteSite(st) {
  dialog({
    component: SiteDeleteDialog,
    componentProps: {
      site: st
    }
  })
}

// MOUNTED

onMounted(async () => {
  await adminStore.fetchSites()
})
</script>

<style lang="scss" scoped>
.site-hostname-link {
  display: inline-flex;
  text-decoration: none;
}
</style>
