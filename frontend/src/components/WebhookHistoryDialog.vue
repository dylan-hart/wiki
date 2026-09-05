<template>
  <w-dialog v-model="dialogVisible" :aria-label="t(`admin.webhooks.history`)" @hide="onDialogHide">
    <w-card class="relative" style="min-width: 650px">
      <w-card-section class="card-header">
        <w-icon name="tabler:history" size="sm" class="me-2" />
        <span>{{ t(`admin.webhooks.history`) }}</span>
      </w-card-section>
      <w-card-section class="text-caption text-grey pt-0">
        {{ hook.name }}
      </w-card-section>
      <w-separator />

      <w-card-section style="max-height: 60vh; overflow-y: auto">
        <div v-if="!state.isLoading && state.deliveries.length < 1" class="text-center py-6">
          <w-icon name="tabler:info-circle" size="sm" class="me-1" />
          <span class="text-caption">{{ t('admin.webhooks.historyNone') }}</span>
        </div>
        <w-list v-else separator>
          <w-item v-for="(delivery, idx) of state.deliveries" :key="idx">
            <w-item-section side>
              <w-icon
                v-if="delivery.state === `completed`"
                name="tabler:circle-check"
                color="positive"
                size="sm" />
              <w-icon
                v-else-if="delivery.state === `failed`"
                name="tabler:alert-triangle"
                color="negative"
                size="sm" />
              <w-icon
                v-else-if="delivery.state === `interrupted`"
                name="tabler:square"
                color="orange"
                size="sm" />
              <w-spinner v-else color="indigo" size="xs" />
            </w-item-section>
            <w-item-section>
              <w-item-label>{{ delivery.event }}</w-item-label>
              <w-item-label caption>{{
                humanizeDateWithSeconds(t, delivery.startedAt)
              }}</w-item-label>
              <w-item-label v-if="delivery.state === `failed`" caption class="text-negative">
                {{ delivery.lastErrorMessage }}
              </w-item-label>
            </w-item-section>
            <w-item-section side>
              <span class="text-caption text-grey"
                >{{ delivery.attempt }} / {{ delivery.maxRetries + 1 }}</span
              >
            </w-item-section>
          </w-item>
        </w-list>
        <div
          v-if="state.total > state.deliveries.length"
          class="text-caption text-grey text-center pt-2">
          {{
            t('admin.webhooks.historyTruncated', {
              shown: state.deliveries.length,
              total: state.total
            })
          }}
        </div>
      </w-card-section>

      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`common.actions.close`)"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
      </w-card-actions>

      <w-inner-loading :showing="state.isLoading" size="38px" spinner-class="text-accent" />
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { onMounted, reactive } from 'vue'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDateWithSeconds } from '@/helpers/datetime'

// PROPS

const props = defineProps({
  hook: {
    type: Object,
    required: true
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogCancel } = useDialogComponent()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  isLoading: false,
  total: 0,
  deliveries: []
})

// METHODS

async function load() {
  state.isLoading = true
  try {
    const resp = await API_CLIENT.get(`hooks/${props.hook.id}/deliveries`).json()
    state.total = resp?.total ?? 0
    state.deliveries = resp?.deliveries ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}

// MOUNTED

onMounted(() => {
  load()
})
</script>
