<template>
  <w-page class="admin-comments">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon name="tabler:message" size="64px" class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.comments.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.comments.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <w-spinner class="me-4" v-show="state.loading > 0" color="accent" size="sm" />
        <w-btn
          class="me-2"
          icon="la:question-circle"
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
          icon="la:redo-alt"
          flat
          color="secondary"
          :aria-label="t(`common.actions.refresh`)"
          @click="loadComments()"
          :loading="state.loading > 0">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          v-if="state.mode === `provider`"
          icon="mdi:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save()"
          :disabled="!selectedProvider || !selectedProvider.isSelectable"
          :loading="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <div class="px-4 pt-4">
      <w-tabs v-model="state.mode" no-caps>
        <w-tab name="provider" :label="t('admin.comments.provider')" />
        <w-tab name="moderation" :label="t('admin.comments.moderation')" />
      </w-tabs>
    </div>
    <div class="flex flex-wrap p-4 gap-4" v-if="state.mode === `provider`">
      <!-- ----------------------- -->
      <!-- Provider picker -->
      <!-- ----------------------- -->
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
                  name="mdi:minus-box-outline"
                  color="grey" />
                <w-icon
                  v-else-if="state.selectedModule === prov.module"
                  name="mdi:checkbox-marked-circle-outline" />
                <w-icon v-else name="mdi:checkbox-blank-circle-outline" color="grey" />
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
      <!-- ----------------------- -->
      <!-- Selected provider -->
      <!-- ----------------------- -->
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
        <!-- -> Disqus/Commento/Artalk are pure client-side embeds this fork does not render on page
             views yet -- see the permission-boundary note on CommentProviders in
             backend/models/commentProviders.ts before ever wiring one up. -->
        <w-banner
          class="mb-4"
          v-if="selectedProvider.codeTemplate"
          :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`">
          {{ t('admin.comments.externalProviderNotice') }}
        </w-banner>
        <!-- ----------------------- -->
        <!-- Description -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mb-4">
          <w-card-header>{{ selectedProvider.title }}</w-card-header>
          <w-card-section>
            <div class="text-body2">{{ selectedProvider.description }}</div>
            <div class="text-caption mt-2" v-if="selectedProvider.website">
              <a :href="selectedProvider.website" target="_blank" rel="noreferrer">{{
                selectedProvider.website
              }}</a>
            </div>
          </w-card-section>
        </w-card>
        <!-- ----------------------- -->
        <!-- Configuration -->
        <!-- ----------------------- -->
        <w-card class="pb-2">
          <w-card-header>{{ t('admin.comments.providerConfig') }}</w-card-header>
          <w-card-section>
            <w-banner
              v-if="!selectedProvider.config || Object.keys(selectedProvider.config).length < 1"
              :class="dark.isActive ? `bg-negative text-white` : `bg-grey-2 text-grey-7`"
              >{{ t('admin.comments.providerNoConfig') }}</w-banner
            >
          </w-card-section>
          <!--
            Generic per-prop config form, shared with `AdminAnalytics.vue`, `AdminAuth.vue`,
            `AdminSearch.vue` and `AdminStorage.vue` -- see `ModuleConfigForm.vue`.
            `selectedProvider.config` is the `buildConfigEditor()`-built editable structure, not the
            raw stored values; mutating a field's `.value` there, which this component does in place,
            is what `buildConfigPayload()` in `payloadFor()` below reads back.
          -->
          <module-config-form v-if="selectedProvider.config" :config="selectedProvider.config" />
        </w-card>
      </div>
    </div>
    <!-- ----------------------- -->
    <!-- Moderation -->
    <!-- ----------------------- -->
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
            <template #prepend><w-icon class="opacity-50" name="la:search" size="20px" /></template>
          </w-input>
          <w-input
            class="denser"
            v-model="state.searchAuthor"
            dense
            :placeholder="t('admin.comments.searchByAuthor')"
            :aria-label="t('admin.comments.searchByAuthor')"
            :class="dark.isActive ? `bg-dark text-white` : `bg-white`">
            <template #prepend><w-icon class="opacity-50" name="la:user" size="20px" /></template>
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
                  icon="la:trash"
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

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.comments.title')
}))

// DATA

const state = reactive({
  loading: 0,
  selectedModule: '',
  providers: [],
  // -> `provider` (selection/config, Task 621) or `moderation` (this task's listing)
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

// COMPUTED

const selectedProvider = computed(
  () => state.providers.find((prov) => prov.module === state.selectedModule) ?? null
)

const activeSite = computed(() => adminStore.sites.find((s) => s.id === adminStore.currentSiteId))

/**
 * Comments are on for this site (`AdminGeneral.vue`'s `features.comments` toggle) but nothing is
 * active yet -- the reader-facing side of the feature will render nothing until an administrator
 * picks a provider here.
 */
const showEnabledNoProviderHint = computed(() => {
  return (
    Boolean(activeSite.value?.features?.comments) && !state.providers.some((prov) => prov.isEnabled)
  )
})

/**
 * Whether the moderation tab has anything to show at all: either the feature is off for this site,
 * or no provider has ever been activated -- in which case there is no comment surface for readers,
 * so the list would only ever be empty. A banner pointing at `AdminGeneral.vue`'s toggle and this
 * page's own provider tab explains why, rather than rendering a table with no rows and no context.
 */
const moderationUnavailable = computed(() => {
  return !activeSite.value?.features?.comments || !state.providers.some((prov) => prov.isEnabled)
})

// WATCHERS

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

/** Lazy-loads the moderation list the first time its tab is opened, or once it becomes available. */
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
      // -> Reassigning triggers the currentPage watcher below, which reloads
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

// METHODS

/** A single-line preview of a comment's content, collapsing whitespace and capping the length. */
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

/**
 * A provider as the API expects it. Read-only props are left out: the server keeps whatever is
 * stored for them, so sending them back would be pretending they can be set.
 */
function payloadFor(prov) {
  return { module: prov.module, config: buildConfigPayload(prov.config) }
}

/** Activates the selected provider and stores its config, then reloads to pick up the server truth. */
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
    // -> The API client does not throw for a 400, so a refusal comes back as a parsed error
    //    envelope rather than a rejection: without this check it reads as a successful save.
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

/**
 * Fetches a page of the moderation listing (`GET sites/:siteId/comments`, Task 625), filtered by
 * whatever's currently in the two search boxes. `page` is 1-based, converted to the `offset`/`limit`
 * the endpoint actually takes.
 */
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

/**
 * Delete-with-confirmation, matching `AdminStorage.vue`'s `setupDestroy` pattern: nothing is deleted
 * until the `confirm()` dialog is explicitly accepted.
 */
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
      // -> The API client does not throw for a 400, so a refusal comes back as a response with
      //    `ok: false` rather than a rejection: without this check it reads as a successful delete.
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

// MOUNTED

onMounted(() => {
  load()
})
</script>
