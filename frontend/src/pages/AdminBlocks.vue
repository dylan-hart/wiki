<template>
  <w-page class="admin-flags">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:components" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.blocks.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.blocks.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <!--
          Behind the experimental flag: an uploaded block is arbitrary JS, served to every reader of
          the page it's used on with no permission gate of its own beyond `manage:sites` on this site
          (controllers/blocks.ts) -- a bigger blast radius than the rest of this flag's surface.
        -->
        <template v-if="flagsStore.experimental">
          <w-btn
            class="me-2 acrylic-btn"
            icon="tabler:plus"
            :label="t(`admin.blocks.add`)"
            color="primary"
            @click="addBlock" />
          <w-separator class="me-2" vertical />
        </template>
        <w-btn
          class="me-2"
          icon="tabler:help-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/editors`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2"
          icon="tabler:refresh"
          outline
          color="slate-soft"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          icon="tabler:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <div class="p-4 gap-4">
      <!--
        Kroki and PlantUML both draw against a public third-party demo server by default, which
        nothing else on this page discloses until it rate-limits, goes down, or the diagram source
        turns out to be sensitive. Shown once above the list: both blocks share the same story.
      -->
      <w-banner
        v-if="hasServerConfigurableBlocks"
        class="mb-4 border border-hairline bg-tint text-slate dark:border-hairline-dark dark:bg-dark-2 dark:text-text-secondary-dark">
        {{ t('admin.blocks.selfHostedServerNote') }}
      </w-banner>
      <w-card>
        <w-list separator>
          <w-item v-for="block of state.blocks" :key="block.id">
            <!-- A custom block brings no in-repo definition, so there is no `icon` to trust. -->
            <blueprint-icon :icon="block.isCustom ? 'tabler:puzzle' : block.icon" />
            <w-item-section>
              <w-item-label
                ><strong>{{ block.name }}</strong></w-item-label
              >
              <w-item-label caption>{{ block.description }}</w-item-label>
              <w-item-label class="flex items-center" caption>
                <w-chip
                  class="m-0 font-mono"
                  dense
                  size="11px"
                  :color="dark.isActive ? `accent-wash-dark` : `accent-wash`"
                  :text-color="dark.isActive ? `accent-dark` : `accent`">
                  &lt;block-{{ block.block }}&gt;
                </w-chip>
                <w-separator class="mx-2 my-1" vertical />
                <em class="block-origin--custom" v-if="block.isCustom">{{
                  t('admin.blocks.custom')
                }}</em>
                <em class="text-positive" v-else>{{ t('admin.blocks.builtin') }}</em>
              </w-item-label>
            </w-item-section>
            <template v-if="hasServerProp(block)">
              <w-item-section side style="min-width: 260px">
                <w-input
                  dense
                  v-model="block.config.server"
                  :label="t('admin.blocks.server')"
                  :aria-label="t('admin.blocks.server')"
                  :placeholder="serverProp(block)?.default"
                  :hint="t('admin.blocks.serverHint')" />
              </w-item-section>
              <w-separator class="mx-4" vertical />
            </template>
            <template v-if="block.isCustom">
              <w-item-section side>
                <w-btn
                  icon="tabler:trash"
                  :aria-label="t(`common.actions.delete`)"
                  color="negative"
                  outline
                  padding="xs sm"
                  @click="deleteBlock(block.id)" />
              </w-item-section>
              <w-separator class="ms-6" vertical />
            </template>
            <template v-if="configurableFields(block).length > 0">
              <w-item-section side>
                <w-btn
                  icon="tabler:settings"
                  :label="t(`admin.blocks.configure`)"
                  :color="dark.isActive ? `slate-light` : `slate`"
                  outline
                  padding="xs md"
                  @click="openConfig(block)" />
              </w-item-section>
              <w-separator class="ms-4" vertical />
            </template>
            <!--
              Label before the switch, where `WToggle`'s own `label` puts it after. Drawn as a
              sibling caption rather than by reordering the shared control, which every other toggle
              in the app follows.
            -->
            <w-item-section side>
              <div class="flex flex-nowrap items-center gap-2 pe-2">
                <span class="text-caption text-slate dark:text-text-secondary-dark">{{
                  t('admin.blocks.isEnabled')
                }}</span>
                <w-toggle v-model="block.isEnabled" :aria-label="t(`admin.blocks.isEnabled`)" />
              </div>
            </w-item-section>
          </w-item>
        </w-list>
      </w-card>

      <div class="flex flex-wrap items-center mt-6 mb-2">
        <div class="min-w-0 flex-1">
          <div class="admin-subsection-title">{{ t('admin.blocks.credentialsTitle') }}</div>
          <div class="text-[13px] text-text-secondary dark:text-text-secondary-dark">
            {{ t('admin.blocks.credentialsSubtitle') }}
          </div>
        </div>
        <w-btn
          class="acrylic-btn"
          icon="tabler:plus"
          :label="t(`admin.blocks.credentialAdd`)"
          color="primary"
          @click="addCredential" />
      </div>
      <w-card>
        <w-list separator v-if="state.credentials.length > 0">
          <w-item v-for="credential of state.credentials" :key="credential.id">
            <w-item-section>
              <w-item-label
                ><strong>{{ credential.name }}</strong></w-item-label
              >
              <w-item-label caption class="flex items-center">
                <!--
                  Plain tint, not the accent wash the block tag above wears: the wash is reserved for
                  what an author types into a page.
                -->
                <w-chip
                  class="m-0 font-mono"
                  dense
                  size="11px"
                  :color="dark.isActive ? `dark-2` : `tint`"
                  :text-color="dark.isActive ? `text-secondary-dark` : `slate`">
                  {{ credential.id }}
                </w-chip>
                <w-btn
                  class="ms-1"
                  icon="tabler:copy"
                  flat
                  dense
                  size="sm"
                  padding="none xs"
                  :color="dark.isActive ? `slate-light` : `slate-soft`"
                  :aria-label="t(`admin.blocks.credentialCopyId`)"
                  @click="copyCredentialId(credential.id)">
                  <w-tooltip>{{ t(`admin.blocks.credentialCopyId`) }}</w-tooltip>
                </w-btn>
              </w-item-label>
              <!-- Red when empty: a credential with no allowed origin can never be used at all. -->
              <w-item-label caption class="flex flex-wrap items-center gap-1 mt-1">
                <w-icon
                  name="tabler:world"
                  size="13px"
                  class="me-1"
                  :class="
                    credential.allowedOrigins?.length
                      ? `text-slate-soft dark:text-slate-light`
                      : `text-negative`
                  " />
                <span
                  v-if="credential.allowedOrigins?.length"
                  class="font-mono text-[11.5px] text-text-secondary dark:text-text-secondary-dark">
                  {{ credential.allowedOrigins.join(', ') }}
                </span>
                <span v-else class="font-mono text-[11.5px] text-negative">{{
                  t('admin.blocks.credentialAllowedDomainsEmpty')
                }}</span>
              </w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-btn
                class="me-2"
                icon="tabler:world"
                :label="t(`admin.blocks.credentialDomains`)"
                :color="dark.isActive ? `slate-light` : `slate`"
                outline
                padding="xs md"
                @click="editDomains(credential)" />
            </w-item-section>
            <w-item-section side>
              <w-btn
                class="me-2"
                icon="tabler:refresh"
                :label="t(`admin.blocks.credentialRotate`)"
                :color="dark.isActive ? `slate-light` : `slate`"
                outline
                padding="xs md"
                @click="rotateCredential(credential)" />
            </w-item-section>
            <w-item-section side>
              <w-btn
                icon="tabler:trash"
                :aria-label="t(`common.actions.delete`)"
                color="negative"
                outline
                padding="xs sm"
                @click="deleteCredential(credential)" />
            </w-item-section>
          </w-item>
        </w-list>
        <div class="p-4 text-text-secondary dark:text-text-secondary-dark" v-else>
          {{ t('admin.blocks.credentialsEmpty') }}
        </div>
      </w-card>
    </div>
    <w-dialog
      v-model="state.configDialog.open"
      :aria-label="
        t('admin.blocks.configureTitle', { blockName: state.configDialog.block?.name ?? '' })
      ">
      <w-card style="width: 500px; max-width: 90vw">
        <w-card-section class="flex flex-wrap items-center pb-0">
          <div class="text-h6">
            {{
              t('admin.blocks.configureTitle', { blockName: state.configDialog.block?.name ?? '' })
            }}
          </div>
          <w-space />
          <w-btn
            icon="tabler:x"
            flat
            round
            dense
            :aria-label="t(`common.actions.close`)"
            @click="closeConfig" />
        </w-card-section>
        <w-card-section>
          <block-props-form
            v-if="state.configDialog.block"
            :fields="configurableFields(state.configDialog.block)"
            :values="state.configDialog.values" />
        </w-card-section>
        <w-separator />
        <w-card-section class="flex justify-end">
          <w-btn
            class="me-2"
            flat
            color="grey"
            :label="t(`common.actions.cancel`)"
            @click="closeConfig" />
          <w-btn color="primary" :label="t(`common.actions.save`)" @click="saveConfig" />
        </w-card-section>
      </w-card>
    </w-dialog>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'

import { useAdminSettings } from '@/composables/adminSettings'
import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { confirm, dialog } from '@/composables/dialog'
import { useSiteAdminAccess } from '@/composables/siteAdminAccess'

import BlockUploadDialog from '@/components/BlockUploadDialog.vue'
import BlockCredentialDialog from '@/components/BlockCredentialDialog.vue'

import { useAdminStore } from '@/stores/admin'
import { useFlagsStore } from '@/stores/flags'
import { useSiteStore } from '@/stores/site'

import { pick } from 'es-toolkit/object'
import { apiErrorMessage } from '@/helpers/apiError'
import { seedConfigValues } from '@/helpers/blocks'
import { copyToClipboard } from '@/helpers/clipboard'

import BlockPropsForm from '@/components/BlockPropsForm.vue'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const dark = useDark()
useSiteAdminAccess('site:blocks')

const adminStore = useAdminStore()
const flagsStore = useFlagsStore()
const siteStore = useSiteStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.blocks.title')
}))

const { state, load, save } = useAdminSettings({
  i18nPrefix: 'admin.blocks',
  extraState: {
    blocks: [],
    credentials: [],
    configDialog: {
      open: false,
      /** The same object as in `state.blocks`, not a copy. */
      block: null,
      /** A copy of `block.config`, merged back into the block on save. */
      values: {}
    }
  },
  fetch: async (siteId) => {
    try {
      return await API_CLIENT.get(`sites/${siteId}/blocks`).json()
    } finally {
      // -> Loaded even when the blocks list failed: an empty credentials table is its own thing to
      //    explain, not a consequence of the list above having failed.
      await loadCredentials()
    }
  },
  onLoaded: (blocks) => {
    // -> Guarded although the API always sends an object: `v-model="block.config.server"` would
    //    otherwise write onto `undefined`
    state.blocks = (blocks ?? []).map((block) => ({ ...block, config: block.config ?? {} }))
  },
  commit: (siteId) =>
    API_CLIENT.put(`sites/${siteId}/blocks`, {
      json: {
        states: state.blocks.map((bl) => pick(bl, ['id', 'isEnabled', 'config']))
      }
    }).json()
})

function hasServerProp(block) {
  return Boolean(serverProp(block))
}

function serverProp(block) {
  return block.props?.find((prop) => prop.name === 'server')
}

/**
 * `server` already has its own inline field for the blocks that declare it, so the generic
 * "Configure" dialog must not offer a second editor for the same setting.
 */
function configurableFields(block) {
  return (block?.configFields ?? []).filter(
    (field) => !(field.name === 'server' && hasServerProp(block))
  )
}

const hasServerConfigurableBlocks = computed(() => state.blocks.some(hasServerProp))

/**
 * Reports its own failure rather than riding on `load()`'s: a caller without `site:blocks` never
 * reaches this page (`useSiteAdminAccess`), so a failure here is a genuine fault.
 */
async function loadCredentials() {
  try {
    state.credentials =
      (await API_CLIENT.get(`sites/${adminStore.currentSiteId}/block-credentials`).json()) ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.blocks.credentialsLoadFailed'),
      caption: apiErrorMessage(err)
    })
  }
}

function addCredential() {
  dialog({ component: BlockCredentialDialog, componentProps: { mode: 'create' } }).onOk(
    (credential) => {
      if (credential) {
        state.credentials.push(credential)
      }
    }
  )
}

function rotateCredential(credential) {
  dialog({
    component: BlockCredentialDialog,
    componentProps: { mode: 'rotate', credential }
  })
}

function editDomains(credential) {
  dialog({
    component: BlockCredentialDialog,
    componentProps: { mode: 'domains', credential }
  }).onOk(() => {
    loadCredentials()
  })
}

function deleteCredential(credential) {
  confirm({
    title: t('admin.blocks.credentialDelete'),
    message: t('admin.blocks.credentialDeleteConfirm', { name: credential.name }),
    cancel: true,
    persistent: true,
    color: 'negative',
    okLabel: t('common.actions.delete')
  }).onOk(async () => {
    try {
      await API_CLIENT.delete(
        `sites/${adminStore.currentSiteId}/block-credentials/${credential.id}`
      )
      state.credentials = state.credentials.filter((c) => c.id !== credential.id)
      notify({
        type: 'positive',
        message: t('admin.blocks.credentialDeleteSuccess')
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.blocks.credentialDeleteFailed'),
        caption: apiErrorMessage(err)
      })
    }
  })
}

async function copyCredentialId(id) {
  try {
    await copyToClipboard(id)
    notify({ type: 'positive', message: t('admin.blocks.credentialIdCopied') })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.blocks.credentialCopyFailed'),
      caption: apiErrorMessage(err)
    })
  }
}

function addBlock() {
  dialog({ component: BlockUploadDialog }).onOk((block) => {
    if (block) {
      state.blocks.push(block)
    }
  })
}

function deleteBlock(id) {
  const block = state.blocks.find((bl) => bl.id === id)
  confirm({
    title: t('admin.blocks.delete'),
    message: t('admin.blocks.deleteConfirm', { blockName: block?.name ?? '' }),
    cancel: true,
    persistent: true,
    color: 'negative',
    okLabel: t('common.actions.delete')
  }).onOk(async () => {
    state.loading++
    try {
      await API_CLIENT.delete(`sites/${adminStore.currentSiteId}/blocks/${id}`)
      notify({
        type: 'positive',
        message: t('admin.blocks.deleteSuccess')
      })
      await load()
    } catch (err) {
      // -> ky throws above 400 (409 for a built-in block), with the reason in the body
      notify({
        type: 'negative',
        message: apiErrorMessage(err)
      })
    }
    state.loading--
  })
}

function openConfig(block) {
  state.configDialog.block = block
  state.configDialog.values = seedConfigValues({
    ...block,
    configFields: configurableFields(block)
  })
  state.configDialog.open = true
}

function closeConfig() {
  state.configDialog.open = false
}

/** Writes into the block's own `config` only; the page's Apply button is what persists it. */
function saveConfig() {
  Object.assign(state.configDialog.block.config, state.configDialog.values)
  state.configDialog.open = false
}
</script>

<style scoped>
/*
  The page title's display face, one step down and in the chrome's own casing, so a second heading on
  the screen reads as a division of this page rather than as a second page title. Scoped rather than
  sitting beside `.admin-page-title` in `AdminLayout.vue` while there is one caller.
*/
.admin-subsection-title {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-ink);
}

:global(body.body--dark .admin-subsection-title) {
  color: var(--color-text-dark);
}

/*
  A literal rather than a token: `--color-purple` is a different, far more saturated hue, and a
  one-caller colour has not earned a place in `css/tailwind.css`'s token block. Tokenise it if a
  second surface ever needs to mark something as custom or third-party.
*/
.block-origin--custom {
  color: #7a4a86;
}

/* Lightened the way `--color-primary-light` is: no dark design sheet draws this tone. */
:global(body.body--dark .block-origin--custom) {
  color: color-mix(in srgb, #7a4a86 55%, white);
}
</style>
