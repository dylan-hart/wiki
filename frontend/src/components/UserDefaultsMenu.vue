<template>
  <w-menu
    class="translucent-menu"
    anchor="bottom right"
    self="top right"
    :offset="[0, 10]"
    ref="menuRef">
    <w-card style="width: 850px">
      <w-card-section class="card-header">
        <w-icon name="cardinal:defaults" left size="sm" />
        <span>{{ t(`admin.users.defaults`) }}</span>
      </w-card-section>
      <w-list padding>
        <w-item>
          <blueprint-icon icon="timezone" />
          <w-item-section>
            <w-item-label>{{ t(`admin.general.defaultTimezone`) }}</w-item-label>
            <w-item-label caption>{{ t(`admin.general.defaultTimezoneHint`) }}</w-item-label>
          </w-item-section>
          <w-item-section>
            <w-select
              v-model="state.timezone"
              :options="timezones"
              option-value="value"
              option-label="text"
              emit-value
              map-options
              dense
              options-dense
              :aria-label="t(`admin.general.defaultTimezone`)" />
          </w-item-section>
        </w-item>
        <w-separator class="my-2" inset />
        <w-item>
          <blueprint-icon icon="calendar" />
          <w-item-section>
            <w-item-label>{{ t(`admin.general.defaultDateFormat`) }}</w-item-label>
            <w-item-label caption>{{ t(`admin.general.defaultDateFormatHint`) }}</w-item-label>
          </w-item-section>
          <w-item-section>
            <w-select
              v-model="state.dateFormat"
              emit-value
              map-options
              dense
              :aria-label="t(`admin.general.defaultDateFormat`)"
              :options="dateFormats" />
          </w-item-section>
        </w-item>
        <w-separator class="my-2" inset />
        <w-item>
          <blueprint-icon icon="clock" />
          <w-item-section>
            <w-item-label>{{ t(`admin.general.defaultTimeFormat`) }}</w-item-label>
            <w-item-label caption>{{ t(`admin.general.defaultTimeFormatHint`) }}</w-item-label>
          </w-item-section>
          <w-item-section class="flex-none">
            <w-btn-toggle
              v-model="state.timeFormat"
              toggle-color="primary"
              :aria-label="t(`admin.general.defaultTimeFormat`)"
              :options="timeFormats" />
          </w-item-section>
        </w-item>
      </w-list>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`common.actions.cancel`)"
          color="grey"
          padding="xs md"
          @click="menuRef.hide()" />
        <w-btn :label="t(`common.actions.save`)" color="primary" padding="xs md" @click="save" />
      </w-card-actions>
      <w-inner-loading :showing="state.loading > 0" />
    </w-card>
  </w-menu>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { onMounted, reactive, ref } from 'vue'

import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  loading: 0,
  timezone: '',
  dateFormat: '',
  timeFormat: ''
})

const menuRef = ref(null)

const dateFormats = [
  { value: '', label: t('profile.localeDefault') },
  { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' },
  { value: 'DD.MM.YYYY', label: 'DD.MM.YYYY' },
  { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' },
  { value: 'YYYY/MM/DD', label: 'YYYY/MM/DD' }
]
const timeFormats = [
  { value: '12h', label: t('admin.general.defaultTimeFormat12h') },
  { value: '24h', label: t('admin.general.defaultTimeFormat24h') }
]
const timezones = Intl.supportedValuesOf('timeZone')

// METHODS

async function save() {
  state.loading++
  try {
    await API_CLIENT.put('users/defaults', {
      json: {
        timezone: state.timezone,
        dateFormat: state.dateFormat,
        timeFormat: state.timeFormat
      }
    }).json()
    notify({
      type: 'positive',
      message: t('admin.users.defaultsSaveSuccess')
    })
    menuRef.value.hide()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.users.defaultsSaveFailed'),
      caption: t(
        `admin.users.${err.data?.error}`,
        apiErrorMessage(err, t('common.error.unexpected'))
      )
    })
  }
  state.loading--
}

// MOUNTED

onMounted(async () => {
  state.loading++
  try {
    const resp = await API_CLIENT.get('users/defaults').json()
    state.timezone = resp?.timezone ?? 'America/New_York'
    state.dateFormat = resp?.dateFormat ?? 'YYYY-MM-DD'
    state.timeFormat = resp?.timeFormat ?? '12h'
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.users.defaultsLoadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
})
</script>
