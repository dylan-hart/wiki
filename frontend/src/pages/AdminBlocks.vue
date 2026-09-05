<template>
  <w-page class="admin-flags">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon name="tabler:components" size="64px" class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.blocks.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.blocks.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <!--
          Kept behind the experimental flag even now that upload is real: an uploaded block is
          arbitrary JS, served back to every reader of the page it's used on with no permission gate
          of its own (see controllers/blocks.ts) once `manage:sites` on this site let someone in. That
          is a materially bigger blast radius than the rest of this flag's surface, and deserves a
          deliberate graduation rather than falling out of this task as a side effect.
        -->
        <template v-if="flagsStore.experimental">
          <w-btn
            class="me-2 acrylic-btn"
            icon="la:plus"
            :label="t(`admin.blocks.add`)"
            color="primary"
            @click="addBlock" />
          <w-separator class="me-2" vertical />
        </template>
        <w-btn
          class="me-2"
          icon="la:question-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/editors`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2"
          icon="la:redo-alt"
          outline
          color="slate-soft"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          icon="mdi:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <div class="p-4 gap-4">
      <!--
        OpenProject #829 item 5: upstream discussions #3275/#7258/#7229 all describe the same
        dead end -- an author reaches for Kroki or PlantUML, the block draws against the public
        demo server by default, and nothing on this page said that server exists, that it is a
        third party, or that self-hosting one is an option -- until it rate-limits, goes down, or
        the diagram source itself is sensitive. Shown once, above the whole list, rather than
        repeated per block: both blocks share the exact same story.
      -->
      <w-banner
        v-if="hasServerConfigurableBlocks"
        class="mb-4"
        :class="dark.isActive ? `bg-grey-9 text-white` : `bg-grey-2 text-grey-7`">
        {{ t('admin.blocks.selfHostedServerNote') }}
      </w-banner>
      <w-card>
        <w-list separator>
          <w-item v-for="block of state.blocks" :key="block.id">
            <blueprint-icon :icon="block.isCustom ? `plugin` : block.icon" />
            <w-item-section>
              <w-item-label
                ><strong>{{ block.name }}</strong></w-item-label
              >
              <w-item-label caption>{{ block.description }}</w-item-label>
              <w-item-label class="flex items-center" caption>
                <w-chip
                  class="m-0"
                  dense
                  :color="dark.isActive ? `pink-8` : `pink-1`"
                  :text-color="dark.isActive ? `white` : `pink-9`">
                  <span class="text-caption">&lt;block-{{ block.block }}&gt;</span>
                </w-chip>
                <w-separator class="mx-2 my-1" vertical />
                <em class="text-purple" v-if="block.isCustom">{{ t('admin.blocks.custom') }}</em>
                <em class="text-teal-7" v-else>{{ t('admin.blocks.builtin') }}</em>
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
                  icon="la:trash"
                  :aria-label="t(`common.actions.delete`)"
                  color="negative"
                  outline
                  padding="xs sm"
                  @click="deleteBlock(block.id)" />
              </w-item-section>
              <w-separator class="ms-6" vertical />
            </template>
            <!--
              Configure never renders for a custom block: a custom block has no manifest entry, so
              `getSiteBlocks()` (backend/models/blocks.ts) reports `configFields: []` for it, and this
              guard hides the button rather than opening a form with nothing in it. It also stays
              hidden for a block whose only config field is `server` when that field already has its
              own dedicated input above (block-kroki, block-plantuml) -- `configurableFields` is what
              keeps the same setting from getting two separate editors.
            -->
            <template v-if="configurableFields(block).length > 0">
              <w-item-section side>
                <w-btn
                  icon="la:cog"
                  :label="t(`admin.blocks.configure`)"
                  :color="dark.isActive ? `blue-grey-3` : `blue-grey-8`"
                  outline
                  padding="xs md"
                  @click="openConfig(block)" />
              </w-item-section>
              <w-separator class="ms-4" vertical />
            </template>
            <w-item-section side>
              <w-toggle
                class="pe-2"
                v-model="block.isEnabled"
                :label="t(`admin.blocks.isEnabled`)"
                :aria-label="t(`admin.blocks.isEnabled`)" />
            </w-item-section>
          </w-item>
        </w-list>
      </w-card>

      <div class="flex flex-wrap items-center mt-6 mb-2">
        <div class="min-w-0 flex-1">
          <div class="text-h6">{{ t('admin.blocks.credentialsTitle') }}</div>
          <div class="text-body2 text-grey">{{ t('admin.blocks.credentialsSubtitle') }}</div>
        </div>
        <w-btn
          class="acrylic-btn"
          icon="la:plus"
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
                <w-chip
                  class="m-0"
                  dense
                  :color="dark.isActive ? `blue-grey-8` : `blue-grey-1`"
                  :text-color="dark.isActive ? `white` : `blue-grey-9`">
                  <span class="text-caption">{{ credential.id }}</span>
                </w-chip>
                <w-btn
                  class="ms-1"
                  icon="la:copy"
                  flat
                  round
                  dense
                  size="sm"
                  :aria-label="t(`admin.blocks.credentialCopyId`)"
                  @click="copyCredentialId(credential.id)">
                  <w-tooltip>{{ t(`admin.blocks.credentialCopyId`) }}</w-tooltip>
                </w-btn>
              </w-item-label>
              <w-item-label caption class="flex flex-wrap items-center gap-1 mt-1">
                <w-icon name="la:globe" size="14px" class="me-1" />
                <span v-if="credential.allowedOrigins?.length" class="text-caption">
                  {{ credential.allowedOrigins.join(', ') }}
                </span>
                <span v-else class="text-caption text-negative">{{
                  t('admin.blocks.credentialAllowedDomainsEmpty')
                }}</span>
              </w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-btn
                class="me-2"
                icon="la:globe"
                :label="t(`admin.blocks.credentialDomains`)"
                :color="dark.isActive ? `blue-grey-3` : `blue-grey-8`"
                outline
                padding="xs md"
                @click="editDomains(credential)" />
            </w-item-section>
            <w-item-section side>
              <w-btn
                class="me-2"
                icon="la:sync-alt"
                :label="t(`admin.blocks.credentialRotate`)"
                :color="dark.isActive ? `blue-grey-3` : `blue-grey-8`"
                outline
                padding="xs md"
                @click="rotateCredential(credential)" />
            </w-item-section>
            <w-item-section side>
              <w-btn
                icon="la:trash"
                :aria-label="t(`common.actions.delete`)"
                color="negative"
                outline
                padding="xs sm"
                @click="deleteCredential(credential)" />
            </w-item-section>
          </w-item>
        </w-list>
        <div class="p-4 text-grey" v-else>{{ t('admin.blocks.credentialsEmpty') }}</div>
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
            icon="la:times"
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

// COMPOSABLES

const dark = useDark()
// -> Task #684: gates this page behind `site:blocks` (or `manage:sites`), redirecting away from a
//    site the caller may not administer. See `composables/siteAdminAccess.js`.
useSiteAdminAccess('site:blocks')

// STORES

const adminStore = useAdminStore()
const flagsStore = useFlagsStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

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
      /** The block being configured -- the same object as in `state.blocks`, not a copy. */
      block: null,
      /** Local reactive copy of `block.config`, edited by `BlockPropsForm` and merged back on save. */
      values: {}
    }
  },
  fetch: async (siteId) => {
    try {
      return await API_CLIENT.get(`sites/${siteId}/blocks`).json()
    } finally {
      // -> Loaded whether or not the blocks list came back, and with its own error handling: an
      //    empty credentials table is its own thing to explain, not a consequence of the list above
      //    having failed.
      await loadCredentials()
    }
  },
  onLoaded: (blocks) => {
    // -> `config` is always an object from the API, but guarded here too so `v-model="block.config.server"`
    //    never writes onto `undefined` if that ever stops being true
    state.blocks = (blocks ?? []).map((block) => ({ ...block, config: block.config ?? {} }))
  },
  commit: (siteId) =>
    API_CLIENT.put(`sites/${siteId}/blocks`, {
      json: {
        states: state.blocks.map((bl) => pick(bl, ['id', 'isEnabled', 'config']))
      }
    }).json()
})

// METHODS

/** Whether this block declares a `server` prop — only block-kroki and block-plantuml do today. */
function hasServerProp(block) {
  return Boolean(serverProp(block))
}

function serverProp(block) {
  return block.props?.find((prop) => prop.name === 'server')
}

/**
 * A block's admin-config fields that don't already have a dedicated control of their own.
 *
 * `server` is covered by the inline field above (`hasServerProp`) for block-kroki/block-plantuml, so
 * the generic "Configure" dialog has nothing left to add for either -- today `server` is their only
 * declared config field, so both simply never show the button (see WP #1745).
 */
function configurableFields(block) {
  return (block?.configFields ?? []).filter(
    (field) => !(field.name === 'server' && hasServerProp(block))
  )
}

/**
 * Whether the "self-host your own server" note is worth showing at all -- only when this site
 * actually has a block whose "Server" field it would be explaining, so the note never appears on a
 * site with neither Kroki nor PlantUML enabled.
 */
const hasServerConfigurableBlocks = computed(() => state.blocks.some(hasServerProp))

/**
 * Loaded separately from `load()`'s own error handling: a caller without `site:blocks` on this
 * site never reaches this page at all (`useSiteAdminAccess`), so a failure here is a genuine fault
 * rather than the expected shape for a caller with less access, same as the blocks list above.
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
      caption: err.message
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
      // -> ky throws above 400 (e.g. 409 for a built-in block), with the reason in the body
      notify({
        type: 'negative',
        message: apiErrorMessage(err)
      })
    }
    state.loading--
  })
}

/**
 * Opens the config dialog for a block, seeding its form from whatever the site has already saved,
 * falling back to each field's own default where it never has (`seedConfigValues`).
 *
 * @param {object} block The block, from `state.blocks` -- kept by reference so `saveConfig` can
 *   write straight back into it.
 */
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

/**
 * Commits the dialog's local values back into the block's own `config`, so the next `save()` picks
 * them up. Does not call the API itself -- the page's own Apply button is still what persists it,
 * same as every other field in this list.
 */
function saveConfig() {
  Object.assign(state.configDialog.block.config, state.configDialog.values)
  state.configDialog.open = false
}
</script>

<style lang="scss"></style>
