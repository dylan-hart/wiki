<template>
  <w-page class="admin-comments">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:message" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.comments.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.comments.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <w-spinner class="me-4" v-show="state.loading > 0" color="accent" size="sm" />
        <w-btn
          class="me-2"
          icon="tabler:help-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/comments`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2 acrylic-btn"
          v-if="state.mode === `moderation`"
          icon="tabler:refresh"
          flat
          color="slate"
          :aria-label="t(`common.actions.refresh`)"
          @click="loadComments()"
          :loading="state.loading > 0">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          v-if="state.mode === `provider`"
          icon="tabler:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save()"
          :disabled="!selectedProvider || !selectedProvider.isSelectable"
          :loading="state.loading > 0" />
      </div>
    </div>
    <div class="px-4 pt-4">
      <w-tabs v-model="state.mode" no-caps>
        <w-tab name="provider" :label="t('admin.comments.provider')" />
        <w-tab name="moderation" :label="t('admin.comments.moderation')" />
      </w-tabs>
    </div>
    <div class="flex flex-wrap p-4 gap-4" v-if="state.mode === `provider`">
      <div class="flex-none">
        <w-card class="rounded bg-dark">
          <w-list style="min-width: 300px" padding dark>
            <w-item
              v-for="prov of state.providers"
              :key="prov.module"
              active-class="bg-primary text-white"
              :active="state.selectedModule === prov.module"
              :disabled="!prov.isAvailable || !prov.isSelectable"
              clickable
              @click="state.selectedModule = prov.module">
              <w-item-section side>
                <w-icon
                  v-if="!prov.isAvailable || !prov.isSelectable"
                  name="tabler:square-minus"
                  color="grey" />
                <w-icon
                  v-else-if="state.selectedModule === prov.module"
                  name="tabler:circle-check" />
                <w-icon v-else name="tabler:circle" color="grey" />
              </w-item-section>
              <w-item-section>
                <w-item-label :class="!prov.isAvailable || !prov.isSelectable ? `text-grey` : ``">{{
                  prov.title
                }}</w-item-label>
                <w-item-label caption>{{ prov.description }}</w-item-label>
              </w-item-section>
              <w-item-section side>
                <status-light
                  :color="prov.isEnabled ? `positive` : `grey`"
                  :pulse="prov.isEnabled" />
              </w-item-section>
            </w-item>
            <w-item v-if="state.providers.length < 1">
              <w-item-section>
                <w-item-label caption>{{ t('admin.comments.noProviders') }}</w-item-label>
              </w-item-section>
            </w-item>
          </w-list>
        </w-card>
      </div>
      <div class="min-w-0 flex-1" v-if="selectedProvider">
        <w-banner
          class="mb-4"
          v-if="showEnabledNoProviderHint"
          inline-actions
          :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`">
          {{ t('admin.comments.enabledNoProviderHint') }}
          <template #action>
            <w-btn
              flat
              :label="t('admin.comments.goToGeneral')"
              :to="`/_admin/` + adminStore.currentSiteId + `/general`" />
          </template>
        </w-banner>
        <w-banner
          class="mb-4"
          v-if="selectedProvider.codeTemplate"
          :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`">
          {{ t('admin.comments.externalProviderNotice') }}
        </w-banner>
        <w-settings-card class="mb-4" :title="selectedProvider.title">
          <w-card-section>
            <div class="text-body2">{{ selectedProvider.description }}</div>
            <div class="text-caption mt-2" v-if="selectedProvider.website">
              <a :href="selectedProvider.website" target="_blank" rel="noreferrer">{{
                selectedProvider.website
              }}</a>
            </div>
          </w-card-section>
        </w-settings-card>
        <w-settings-card :title="t('admin.comments.providerConfig')">
          <w-card-section
            v-if="!selectedProvider.config || Object.keys(selectedProvider.config).length < 1">
            <w-banner :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`">{{
              t('admin.comments.providerNoConfig')
            }}</w-banner>
          </w-card-section>
          <!--
            `selectedProvider.config` is `buildConfigEditor()`'s editable structure, not the raw
            stored values: the form mutates each field's `.value` in place, and `payloadFor()` reads
            it back through `buildConfigPayload()`.
          -->
          <module-config-form v-if="selectedProvider.config" :config="selectedProvider.config" />
        </w-settings-card>
      </div>
    </div>
    <div class="p-4" v-if="state.mode === `moderation`">
      <w-banner
        v-if="moderationUnavailable"
        inline-actions
        :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`">
        {{ t('admin.comments.moderationUnavailableHint') }}
        <template #action>
          <w-btn
            flat
            :label="t('admin.comments.goToGeneral')"
            :to="`/_admin/` + adminStore.currentSiteId + `/general`" />
          <w-btn
            flat
            :label="t('admin.comments.configureProvider')"
            @click="state.mode = `provider`" />
        </template>
      </w-banner>
      <template v-else>
        <div class="flex flex-wrap gap-2 mb-4">
          <w-input
            class="denser"
            v-model="state.searchPath"
            dense
            :placeholder="t('admin.comments.searchByPage')"
            :aria-label="t('admin.comments.searchByPage')"
            :class="dark.isActive ? `bg-dark text-white` : `bg-white`">
            <template #prepend
              ><w-icon class="opacity-50" name="tabler:search" size="20px"
            /></template>
          </w-input>
          <w-input
            class="denser"
            v-model="state.searchAuthor"
            dense
            :placeholder="t('admin.comments.searchByAuthor')"
            :aria-label="t('admin.comments.searchByAuthor')"
            :class="dark.isActive ? `bg-dark text-white` : `bg-white`">
            <template #prepend
              ><w-icon class="opacity-50" name="tabler:user" size="20px"
            /></template>
          </w-input>
        </div>
        <w-card>
          <w-table
            :rows="state.comments"
            :columns="commentHeaders"
            row-key="id"
            flat
            :loading="state.loading > 0">
            <template #no-data>
              <div class="text-center text-grey mt-6">
                {{ t('admin.comments.searchNoResults') }}
              </div>
            </template>
            <template #body-cell-author="props">
              <w-td :props="props"
                ><em>{{ props.value }}</em></w-td
              >
            </template>
            <template #body-cell-page="props">
              <w-td :props="props"
                ><code>{{ props.value }}</code></w-td
              >
            </template>
            <template #body-cell-date="props">
              <w-td :props="props">{{ humanizeDate(t, props.value) }}</w-td>
            </template>
            <template #body-cell-delete="props">
              <w-td :props="props">
                <w-btn
                  class="acrylic-btn"
                  flat
                  icon="tabler:trash"
                  color="negative"
                  :aria-label="t('admin.comments.delete')"
                  @click="confirmDelete(props.row)" />
              </w-td>
            </template>
          </w-table>
        </w-card>
        <div class="flex items-center justify-center mt-6" v-if="state.totalPages > 1">
          <w-pagination
            v-model="state.currentPage"
            :max="state.totalPages"
            :max-pages="9"
            boundary-numbers
            direction-links />
        </div>
      </template>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, watch } from 'vue'
import { debounce } from 'es-toolkit/function'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { loading } from '@/composables/loading'
import { confirm } from '@/composables/dialog'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'

import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDate } from '@/helpers/datetime'
import { buildConfigEditor, buildConfigPayload } from '@/helpers/moduleConfig'

import ModuleConfigForm from '@/components/ModuleConfigForm.vue'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const dark = useDark()

const adminStore = useAdminStore()
const siteStore = useSiteStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.comments.title')
}))

const state = reactive({
  loading: 0,
  selectedModule: '',
  providers: [],
  mode: 'provider',
  comments: [],
  searchPath: '',
  searchAuthor: '',
  currentPage: 1,
  pageSize: 20,
  totalPages: 1
})

const commentHeaders = [
  {
    label: t('admin.comments.excerpt'),
    align: 'left',
    field: (row) => excerptOf(row.content),
    name: 'excerpt',
    sortable: false
  },
  {
    label: t('admin.comments.author'),
    align: 'left',
    field: 'authorName',
    name: 'author',
    sortable: false
  },
  {
    label: t('admin.comments.page'),
    align: 'left',
    field: 'pagePath',
    name: 'page',
    sortable: false
  },
  {
    label: t('admin.comments.date'),
    align: 'left',
    field: 'createdAt',
    name: 'date',
    sortable: false
  },
  {
    label: '',
    align: 'right',
    field: 'delete',
    name: 'delete',
    sortable: false,
    style: 'width: 60px'
  }
]

const selectedProvider = computed(
  () => state.providers.find((prov) => prov.module === state.selectedModule) ?? null
)

const activeSite = computed(() => adminStore.sites.find((s) => s.id === adminStore.currentSiteId))

const showEnabledNoProviderHint = computed(() => {
  return (
    Boolean(activeSite.value?.features?.comments) && !state.providers.some((prov) => prov.isEnabled)
  )
})

/**
 * With no comment surface for readers the list could only ever be empty, so the tab shows a banner
 * pointing at the site toggle and the provider tab rather than a table with no rows and no context.
 */
const moderationUnavailable = computed(() => {
  return !activeSite.value?.features?.comments || !state.providers.some((prov) => prov.isEnabled)
})

watch(
  () => adminStore.currentSiteId,
  () => {
    load()
    state.comments = []
    state.currentPage = 1
    if (state.mode === 'moderation') {
      loadComments({ page: 1 })
    }
  }
)

watch(
  () => [state.mode, moderationUnavailable.value],
  ([mode, unavailable]) => {
    if (mode === 'moderation' && !unavailable && state.comments.length < 1) {
      loadComments({ page: 1 })
    }
  }
)

watch(
  () => [state.searchPath, state.searchAuthor],
  debounce(() => {
    if (state.currentPage !== 1) {
      // -> The currentPage watcher below is what reloads
      state.currentPage = 1
    } else {
      loadComments({ page: 1 })
    }
  }, 400)
)

watch(
  () => state.currentPage,
  (newValue) => {
    if (state.mode === 'moderation' && !moderationUnavailable.value) {
      loadComments({ page: newValue })
    }
  }
)

function excerptOf(content) {
  const flat = (content ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat
}

async function load() {
  state.loading++
  loading.show()
  try {
    const providers = await API_CLIENT.get(
      `sites/${adminStore.currentSiteId}/comments/providers`
    ).json()
    state.providers = (providers ?? []).map((prov) => ({
      ...prov,
      config: buildConfigEditor(prov.props, prov.config)
    }))
    if (!state.providers.some((prov) => prov.module === state.selectedModule)) {
      state.selectedModule =
        state.providers.find((prov) => prov.isEnabled)?.module ?? state.providers[0]?.module ?? ''
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.comments.loadFailed'),
      caption: apiErrorMessage(err),
      timeout: 20000
    })
  }
  loading.hide()
  state.loading--
}

function payloadFor(prov) {
  return { module: prov.module, config: buildConfigPayload(prov.config) }
}

async function save() {
  if (!selectedProvider.value) {
    return
  }
  state.loading++
  loading.show()
  try {
    const resp = await API_CLIENT.put(`sites/${adminStore.currentSiteId}/comments/providers`, {
      json: payloadFor(selectedProvider.value)
    }).json()
    // -> Belt and braces: the client throws on a non-2xx, but an error envelope returned with a 2xx
    //    status would otherwise read as a successful save.
    if (resp?.ok === false) {
      throw new Error(resp.message || t('admin.comments.saveFailed'))
    }
    notify({
      type: 'positive',
      message: t('admin.comments.saveSuccess')
    })
    await load()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.comments.saveFailed'),
      caption: apiErrorMessage(err)
    })
  }
  loading.hide()
  state.loading--
}

/** `page` is 1-based; the endpoint itself takes `offset`/`limit`. */
async function loadComments({ page } = {}) {
  if (moderationUnavailable.value) {
    return
  }
  const targetPage = page ?? state.currentPage ?? 1
  state.loading++
  loading.show()
  try {
    const resp = await API_CLIENT.get(`sites/${adminStore.currentSiteId}/comments`, {
      searchParams: {
        ...(state.searchPath ? { pagePath: state.searchPath } : {}),
        ...(state.searchAuthor ? { author: state.searchAuthor } : {}),
        offset: (targetPage - 1) * state.pageSize,
        limit: state.pageSize
      }
    }).json()
    state.comments = resp?.results ?? []
    state.totalPages = Math.max(1, Math.ceil((resp?.totalHits ?? 0) / state.pageSize))
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.comments.loadCommentsFailed'),
      caption: apiErrorMessage(err)
    })
  }
  loading.hide()
  state.loading--
}

function confirmDelete(comment) {
  confirm({
    title: t('admin.comments.deleteConfirmTitle'),
    message: t('admin.comments.deleteConfirmText', { author: comment.authorName }),
    cancel: true,
    persistent: true,
    color: 'negative',
    okLabel: t('common.actions.delete')
  }).onOk(async () => {
    state.loading++
    loading.show()
    try {
      const resp = await API_CLIENT.delete(
        `sites/${adminStore.currentSiteId}/comments/${comment.id}`
      )
      // -> This route sends no JSON on success, so the check is on the raw `Response`'s own `ok`
      //    flag rather than a parsed envelope.
      if (!resp?.ok) {
        throw new Error((await resp.json())?.message || t('admin.comments.deleteFailed'))
      }
      notify({
        type: 'positive',
        message: t('admin.comments.deleteSuccess')
      })
      await loadComments({ page: state.currentPage })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.comments.deleteFailed'),
        caption: apiErrorMessage(err)
      })
    }
    loading.hide()
    state.loading--
  })
}

onMounted(() => {
  load()
})
</script>
