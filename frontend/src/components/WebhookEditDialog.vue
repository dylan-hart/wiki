<template>
  <w-dialog
    v-model="dialogVisible"
    :aria-label="props.hookId ? t(`admin.webhooks.edit`) : t(`admin.webhooks.new`)"
    @hide="onDialogHide">
    <w-card class="relative" style="min-width: 850px">
      <w-card-section class="card-header">
        <template v-if="props.hookId">
          <w-icon name="img:/_assets/icons/fluent-pencil-drawing.svg" size="sm" class="me-2" />
          <span>{{ t(`admin.webhooks.edit`) }}</span>
        </template>
        <template v-else>
          <w-icon name="img:/_assets/icons/fluent-plus-plus.svg" size="sm" class="me-2" />
          <span>{{ t(`admin.webhooks.new`) }}</span>
        </template>
      </w-card-section>

      <!-- STATE INFO BAR -->
      <w-card-section
        v-if="props.hookId && state.hook.state === `pending`"
        class="flex flex-nowrap items-center bg-indigo text-white">
        <w-spinner size="18px" class="me-2" />
        <div class="text-caption">{{ t('admin.webhooks.statePendingHint') }}</div>
      </w-card-section>
      <w-card-section
        v-if="props.hookId && state.hook.state === `success`"
        class="flex flex-nowrap items-center bg-positive text-white">
        <w-spinner size="18px" class="me-2" />
        <div class="text-caption">{{ t('admin.webhooks.stateSuccessHint') }}</div>
      </w-card-section>
      <w-card-section
        v-if="props.hookId && state.hook.state === `error`"
        class="bg-negative text-white">
        <div class="flex flex-nowrap items-center">
          <w-icon color="white" size="xs" name="la:exclamation-triangle" class="me-2" />
          <div class="text-caption">{{ t('admin.webhooks.stateErrorExplain') }}</div>
        </div>
        <div class="text-caption text-red-2 ps-6 ms-1">{{ state.hook.lastErrorMessage }}</div>
      </w-card-section>

      <!-- FORM -->
      <w-form ref="editWebhookForm" class="py-2">
        <w-item>
          <blueprint-icon icon="info-popup" />
          <w-item-section>
            <w-input
              ref="iptName"
              v-model="state.hook.name"
              dense
              :rules="hookNameValidation"
              hide-bottom-space
              :label="t(`common.field.name`)"
              lazy-rules="ondemand" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="lightning-bolt" />
          <w-item-section>
            <w-select
              v-model="state.hook.events"
              :options="events"
              multiple
              map-options
              emit-value
              option-value="key"
              option-label="name"
              options-dense
              dense
              :rules="hookEventsValidation"
              hide-bottom-space
              :label="t(`admin.webhooks.events`)"
              lazy-rules="ondemand">
              <template #selected>
                <span v-if="state.hook.events.length > 0" class="text-caption">
                  {{
                    t(`admin.webhooks.eventsSelected`, state.hook.events.length, {
                      count: state.hook.events.length
                    })
                  }}
                </span>
                <span v-else>&nbsp;</span>
              </template>
              <template #option="{ opt }">
                <span class="flex flex-nowrap items-center gap-2">
                  <w-chip size="sm" color="positive" text-color="white">{{ opt.type }}</w-chip>
                  <span class="min-w-0 flex-1">
                    <w-item-label>{{ opt.name }}</w-item-label>
                    <!-- Subscribing is allowed, but say plainly that nothing fires it yet -->
                    <w-item-label v-if="!opt.isEmitted" caption>{{
                      t('admin.webhooks.eventNotEmitted')
                    }}</w-item-label>
                  </span>
                </span>
              </template>
            </w-select>
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="web-design" />
          <w-item-section>
            <w-select
              v-model="state.hook.siteId"
              dense
              :options="siteOptions"
              option-value="id"
              option-label="title"
              emit-value
              map-options
              options-dense
              hide-bottom-space
              :label="t(`admin.webhooks.site`)" />
            <w-item-label caption>{{ t(`admin.webhooks.siteHint`) }}</w-item-label>
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="unknown-status" class="self-start" />
          <w-item-section>
            <w-item-label>{{ t(`admin.webhooks.url`) }}</w-item-label>
            <w-item-label caption>{{ t(`admin.webhooks.urlHint`) }}</w-item-label>
            <w-input
              v-model="state.hook.url"
              class="mt-2"
              dense
              :rules="hookUrlValidation"
              hide-bottom-space
              placeholder="https://"
              :aria-label="t(`admin.webhooks.url`)"
              lazy-rules="ondemand">
              <template #prepend>
                <w-chip color="positive" text-color="white" size="sm">POST</w-chip>
              </template>
            </w-input>
          </w-item-section>
        </w-item>
        <w-item clickable @click="state.hook.includeMetadata = !state.hook.includeMetadata">
          <blueprint-icon icon="rescan-document" />
          <w-item-section>
            <w-item-label>{{ t(`admin.webhooks.includeMetadata`) }}</w-item-label>
            <w-item-label caption>{{ t(`admin.webhooks.includeMetadataHint`) }}</w-item-label>
          </w-item-section>
          <w-item-section avatar>
            <w-toggle
              v-model="state.hook.includeMetadata"
              :aria-label="t(`admin.webhooks.includeMetadata`)"
              @click.stop />
          </w-item-section>
        </w-item>
        <w-item clickable @click="state.hook.includeContent = !state.hook.includeContent">
          <blueprint-icon icon="select-all" />
          <w-item-section>
            <w-item-label>{{ t(`admin.webhooks.includeContent`) }}</w-item-label>
            <w-item-label caption>{{ t(`admin.webhooks.includeContentHint`) }}</w-item-label>
          </w-item-section>
          <w-item-section avatar>
            <w-toggle
              v-model="state.hook.includeContent"
              :aria-label="t(`admin.webhooks.includeContent`)"
              @click.stop />
          </w-item-section>
        </w-item>
        <w-item clickable @click="state.hook.acceptUntrusted = !state.hook.acceptUntrusted">
          <blueprint-icon icon="security-ssl" />
          <w-item-section>
            <w-item-label>{{ t(`admin.webhooks.acceptUntrusted`) }}</w-item-label>
            <w-item-label caption>{{ t(`admin.webhooks.acceptUntrustedHint`) }}</w-item-label>
          </w-item-section>
          <w-item-section avatar>
            <w-toggle
              v-model="state.hook.acceptUntrusted"
              :aria-label="t(`admin.webhooks.acceptUntrusted`)"
              @click.stop />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="fingerprint-scan" class="self-start" />
          <w-item-section>
            <w-item-label>{{ t(`admin.webhooks.authHeader`) }}</w-item-label>
            <w-item-label caption>{{ t(`admin.webhooks.authHeaderHint`) }}</w-item-label>
            <w-input
              v-model="state.hook.authHeader"
              class="mt-2"
              dense
              :aria-label="t(`admin.webhooks.authHeader`)" />
          </w-item-section>
        </w-item>
      </w-form>
      <w-card-actions class="card-actions">
        <w-btn
          class="acrylic-btn"
          flat
          icon="la:paper-plane"
          :label="t(`admin.webhooks.testSend`)"
          color="grey"
          padding="xs md"
          :disabled="!urlIsValid"
          :loading="state.isTesting"
          @click="sendTestEvent" />
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`common.actions.cancel`)"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
        <w-btn
          v-if="props.hookId"
          :label="t(`common.actions.save`)"
          color="primary"
          padding="xs md"
          :loading="state.isLoading"
          @click="save" />
        <w-btn
          v-else
          :label="t(`common.actions.create`)"
          color="primary"
          padding="xs md"
          :loading="state.isLoading"
          @click="create" />
      </w-card-actions>

      <w-inner-loading :showing="state.isLoading" size="38px" spinner-class="text-accent" />
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { computed, onMounted, reactive, ref } from 'vue'
import { apiErrorMessage } from '@/helpers/apiError'
import { useAdminStore } from '@/stores/admin'

// PROPS

const props = defineProps({
  hookId: {
    type: String,
    default: null
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptName.value
})

// I18N

const { t } = useI18n()

// STORES

const adminStore = useAdminStore()

// DATA

const state = reactive({
  isLoading: false,
  isTesting: false,
  /** Event keys the server actually emits. Null until fetched, i.e. assume all of them. */
  emittedEvents: null,
  hook: {
    name: '',
    events: [],
    url: '',
    acceptUntrusted: false,
    authHeader: '',
    includeMetadata: true,
    includeContent: false,
    state: 'pending',
    lastErrorMessage: '',
    // -> Null means "fires for every site" -- the default, and today's only behavior
    siteId: null
  }
})

// COMPUTED

const EVENT_DEFINITIONS = computed(() => [
  {
    key: 'page:create',
    name: t('admin.webhooks.eventCreatePage'),
    type: t('admin.webhooks.typePage')
  },
  { key: 'page:edit', name: t('admin.webhooks.eventEditPage'), type: t('admin.webhooks.typePage') },
  {
    key: 'page:rename',
    name: t('admin.webhooks.eventRenamePage'),
    type: t('admin.webhooks.typePage')
  },
  {
    key: 'page:delete',
    name: t('admin.webhooks.eventDeletePage'),
    type: t('admin.webhooks.typePage')
  },
  {
    key: 'asset:upload',
    name: t('admin.webhooks.eventUploadAsset'),
    type: t('admin.webhooks.typeAsset')
  },
  {
    key: 'asset:edit',
    name: t('admin.webhooks.eventEditAsset'),
    type: t('admin.webhooks.typeAsset')
  },
  {
    key: 'asset:rename',
    name: t('admin.webhooks.eventRenameAsset'),
    type: t('admin.webhooks.typeAsset')
  },
  {
    key: 'asset:delete',
    name: t('admin.webhooks.eventDeleteAsset'),
    type: t('admin.webhooks.typeAsset')
  },
  {
    key: 'comment:new',
    name: t('admin.webhooks.eventNewComment'),
    type: t('admin.webhooks.typeComment')
  },
  {
    key: 'comment:edit',
    name: t('admin.webhooks.eventEditComment'),
    type: t('admin.webhooks.typeComment')
  },
  {
    key: 'comment:delete',
    name: t('admin.webhooks.eventDeleteComment'),
    type: t('admin.webhooks.typeComment')
  },
  { key: 'user:join', name: t('admin.webhooks.eventUserJoin'), type: t('admin.webhooks.typeUser') },
  {
    key: 'user:login',
    name: t('admin.webhooks.eventUserLogin'),
    type: t('admin.webhooks.typeUser')
  },
  {
    key: 'user:logout',
    name: t('admin.webhooks.eventUserLogout'),
    type: t('admin.webhooks.typeUser')
  }
])

const events = computed(() =>
  EVENT_DEFINITIONS.value.map((evt) => ({
    ...evt,
    isEmitted: state.emittedEvents === null || state.emittedEvents.includes(evt.key)
  }))
)

/** `All sites` (null, the default) followed by every site, sourced the same way `AdminLayout.vue`'s
 *  own site picker is: straight off `adminStore.sites`. */
const siteOptions = computed(() => [
  { id: null, title: t('admin.webhooks.siteAll') },
  ...adminStore.sites
])

// REFS

const editWebhookForm = ref(null)
const iptName = ref(null)

// VALIDATION RULES

const hookNameValidation = [
  (val) => val.length > 0 || t('admin.webhooks.nameMissing'),
  (val) => /^[^<>"]+$/.test(val) || t('admin.webhooks.nameInvalidChars')
]
const hookEventsValidation = [(val) => val.length > 0 || t('admin.webhooks.eventsMissing')]
/**
 * Whether `val` is an http(s) URL the backend's own `invalidReason()` (`backend/api/hooks.ts`) would
 * accept too -- `new URL()` plus a protocol check, not a bare `startsWith('http')`, so a scheme like
 * `httpfoo://x` is refused here exactly as it already is server-side (OpenProject #1940).
 */
function isHttpUrl(val) {
  try {
    return ['http:', 'https:'].includes(new URL(val).protocol)
  } catch {
    return false
  }
}

const hookUrlValidation = [
  (val) => (val.length > 0 && isHttpUrl(val)) || t('admin.webhooks.urlMissing'),
  (val) => /^[^<>"]+$/.test(val) || t('admin.webhooks.urlInvalidChars')
]

/** Whether the URL currently typed in passes the same rules the form itself enforces on submit. */
const urlIsValid = computed(() => hookUrlValidation.every((rule) => rule(state.hook.url) === true))

// METHODS

/** The fields the API accepts — `state` and `lastErrorMessage` are the server's to set, not ours. */
function writableFields() {
  return {
    name: state.hook.name,
    events: state.hook.events,
    url: state.hook.url,
    includeMetadata: state.hook.includeMetadata,
    includeContent: state.hook.includeContent,
    acceptUntrusted: state.hook.acceptUntrusted,
    authHeader: state.hook.authHeader ?? '',
    siteId: state.hook.siteId ?? null
  }
}

async function fetchHook(id) {
  state.isLoading = true
  try {
    const resp = await API_CLIENT.get(`hooks/${id}`).json()
    if (!resp?.id) {
      throw new Error(t('admin.webhooks.loadFailed'))
    }
    // -> Merged onto the defaults so a null column (e.g. no auth header) still binds to an input
    state.hook = {
      ...state.hook,
      ...resp,
      authHeader: resp.authHeader ?? '',
      lastErrorMessage: resp.lastErrorMessage ?? ''
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
    onDialogHide()
  }
  state.isLoading = false
}

async function create() {
  state.isLoading = true
  try {
    const isFormValid = await editWebhookForm.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('admin.webhooks.createInvalidData'))
    }
    await API_CLIENT.post('hooks', { json: writableFields() }).json()
    notify({
      type: 'positive',
      message: t('admin.webhooks.createSuccess')
    })
    onDialogOK()
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}

async function save() {
  state.isLoading = true
  try {
    const isFormValid = await editWebhookForm.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('admin.webhooks.createInvalidData'))
    }
    await API_CLIENT.put(`hooks/${props.hookId}`, { json: writableFields() }).json()
    notify({
      type: 'positive',
      message: t('admin.webhooks.updateSuccess')
    })
    onDialogOK()
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}

/**
 * Sends a synthetic test delivery to whatever is currently typed into the form -- via
 * `POST /_api/hooks/test`, which takes the destination directly rather than a hookId, so this works
 * before the webhook has ever been saved. Never touches `create`/`save`: the outcome is reported in a
 * toast, not written into `state.hook`.
 */
async function sendTestEvent() {
  state.isTesting = true
  try {
    const resp = await API_CLIENT.post('hooks/test', {
      json: {
        url: state.hook.url,
        authHeader: state.hook.authHeader || undefined,
        acceptUntrusted: state.hook.acceptUntrusted
      }
    }).json()
    notify({
      type: resp?.ok ? 'positive' : 'negative',
      message: resp?.message || t('admin.webhooks.testFailed')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err, t('admin.webhooks.testFailed'))
    })
  }
  state.isTesting = false
}

async function fetchEmittedEvents() {
  try {
    const resp = await API_CLIENT.get('hooks/events').json()
    state.emittedEvents = (resp ?? []).filter((evt) => evt.isEmitted).map((evt) => evt.key)
  } catch {
    // -> Purely informational: on failure, flag nothing rather than flag everything
    state.emittedEvents = null
  }
}

// MOUNTED

onMounted(() => {
  fetchEmittedEvents()
  if (props.hookId) {
    fetchHook(props.hookId)
  }
})
</script>
