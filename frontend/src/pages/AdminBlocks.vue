<template>
  <w-page class="admin-flags">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <img class="admin-icon animated fadeInLeft" src="/_assets/icons/fluent-plugin.svg" />
      </div>
      <div class="min-w-0 flex-1 pl-4">
        <div class="text-h5 text-primary animated fadeInLeft">{{ t('admin.blocks.title') }}</div>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
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
            class="mr-2 acrylic-btn"
            unelevated
            icon="la:plus"
            :label="t(`admin.blocks.add`)"
            color="primary"
            @click="addBlock" />
          <w-separator class="mr-2" vertical />
        </template>
        <w-btn
          class="mr-2 acrylic-btn"
          icon="la:question-circle"
          flat
          color="grey"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/editors`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="mr-2 acrylic-btn"
          icon="la:redo-alt"
          flat
          color="secondary"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="refresh">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          unelevated
          icon="mdi:check"
          :label="t(`common.actions.apply`)"
          color="secondary"
          @click="save"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <div class="p-4 gap-4">
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
                  square
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
                  outlined
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
                  no-caps
                  padding="xs sm"
                  @click="deleteBlock(block.id)" />
              </w-item-section>
              <w-separator class="ml-6" vertical />
            </template>
            <!--
              Configure never renders for a custom block: a custom block has no manifest entry, so
              `getSiteBlocks()` (backend/models/blocks.ts) reports `configFields: []` for it, and this
              guard hides the button rather than opening a form with nothing in it.
            -->
            <template v-if="block.configFields?.length > 0">
              <w-item-section side>
                <w-btn
                  icon="la:cog"
                  :label="t(`admin.blocks.configure`)"
                  :color="dark.isActive ? `blue-grey-3` : `blue-grey-8`"
                  outline
                  no-caps
                  padding="xs md"
                  @click="openConfig(block)" />
              </w-item-section>
              <w-separator class="ml-4" vertical />
            </template>
            <w-item-section side>
              <w-toggle
                class="pr-2"
                v-model="block.isEnabled"
                :label="t(`admin.blocks.isEnabled`)"
                :aria-label="t(`admin.blocks.isEnabled`)" />
            </w-item-section>
          </w-item>
        </w-list>
      </w-card>
    </div>
    <w-dialog v-model="state.configDialog.open">
      <w-card style="width: 500px; max-width: 90vw">
        <w-card-section class="flex flex-wrap items-center pb-0">
          <div class="text-h6">
            {{
              t('admin.blocks.configureTitle', { blockName: state.configDialog.block?.name ?? '' })
            }}
          </div>
          <w-space />
          <w-btn icon="la:times" flat round dense @click="closeConfig" />
        </w-card-section>
        <w-card-section>
          <block-props-form
            v-if="state.configDialog.block"
            :fields="state.configDialog.block.configFields"
            :values="state.configDialog.values" />
        </w-card-section>
        <w-separator />
        <w-card-section class="flex justify-end">
          <w-btn
            class="mr-2"
            flat
            color="grey"
            :label="t(`common.actions.cancel`)"
            @click="closeConfig" />
          <w-btn unelevated color="primary" :label="t(`common.actions.save`)" @click="saveConfig" />
        </w-card-section>
      </w-card>
    </w-dialog>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { onMounted, reactive, watch } from 'vue'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { loading } from '@/composables/loading'
import { confirm, dialog } from '@/composables/dialog'
import { useSiteAdminAccess } from '@/composables/siteAdminAccess'

import BlockUploadDialog from '@/components/BlockUploadDialog.vue'

import { useAdminStore } from '@/stores/admin'
import { useFlagsStore } from '@/stores/flags'
import { useSiteStore } from '@/stores/site'

import { pick } from 'es-toolkit/object'
import { apiErrorMessage } from '@/helpers/apiError'
import { seedConfigValues } from '@/helpers/blocks'

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

useMeta({
  title: t('admin.editors.title')
})

const state = reactive({
  loading: 0,
  blocks: [],
  configDialog: {
    open: false,
    /** The block being configured -- the same object as in `state.blocks`, not a copy. */
    block: null,
    /** Local reactive copy of `block.config`, edited by `BlockPropsForm` and merged back on save. */
    values: {}
  }
})

// WATCHERS

watch(
  () => adminStore.currentSiteId,
  (newValue) => {
    loading.show()
    load()
  }
)

// METHODS

/** Whether this block declares a `server` prop — only block-kroki and block-plantuml do today. */
function hasServerProp(block) {
  return Boolean(serverProp(block))
}

function serverProp(block) {
  return block.props?.find((prop) => prop.name === 'server')
}

async function load() {
  state.loading++
  try {
    const blocks = (await API_CLIENT.get(`sites/${adminStore.currentSiteId}/blocks`).json()) ?? []
    // -> `config` is always an object from the API, but guarded here too so `v-model="block.config.server"`
    //    never writes onto `undefined` if that ever stops being true
    state.blocks = blocks.map((block) => ({ ...block, config: block.config ?? {} }))
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.blocks.loadFailed'),
      caption: err.message
    })
  }
  loading.hide()
  state.loading--
}

async function save() {
  state.loading++
  try {
    const resp = await API_CLIENT.put(`sites/${adminStore.currentSiteId}/blocks`, {
      json: {
        states: state.blocks.map((bl) => pick(bl, ['id', 'isEnabled', 'config']))
      }
    }).json()
    if (!resp?.ok) {
      throw new Error(
        t(`admin.blocks.${resp?.error}`, resp?.message || 'An unexpected error occured.')
      )
    }
    notify({
      type: 'positive',
      message: t('admin.blocks.saveSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.blocks.saveFailed'),
      caption: err.message
    })
  }
  state.loading--
}

async function refresh() {
  await load()
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
    persistent: true
  }).onOk(async () => {
    state.loading++
    try {
      const resp = await API_CLIENT.delete(`sites/${adminStore.currentSiteId}/blocks/${id}`)
      if (!resp?.ok) {
        throw new Error((await resp.json())?.message || 'An unexpected error occured.')
      }
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
  state.configDialog.values = seedConfigValues(block)
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

// MOUNTED

onMounted(async () => {
  loading.show()
  if (adminStore.currentSiteId) {
    await load()
  }
})
</script>

<style lang="scss"></style>
