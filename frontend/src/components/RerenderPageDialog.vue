<template>
  <w-dialog
    v-model="dialogVisible"
    position="bottom"
    persistent
    :aria-label="t('renderPageDialog.loading')"
    @hide="onDialogHide">
    <w-card style="width: 350px">
      <w-linear-progress query />
      <w-card-section class="text-center">
        {{ t('renderPageDialog.loading') }}
      </w-card-section>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { onMounted } from 'vue'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { useSiteStore } from '@/stores/site'

const props = defineProps({
  id: {
    type: String,
    required: true
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const siteStore = useSiteStore()

const { t } = useI18n()

async function rerenderPage() {
  await new Promise((resolve) => setTimeout(resolve, 1000)) // allow for dialog to show
  try {
    // -> Answers 202: rendering runs a headless browser on the server, so the page joins a queue
    //    drained one at a time and there is no new render to show yet
    await API_CLIENT.post(`sites/${siteStore.id}/pages/${props.id}/render`)
    notify({
      type: 'positive',
      message: t('renderPageDialog.queued')
    })
    onDialogOK()
  } catch (err) {
    // -> Without the Puppeteer extension the server has no renderer to run and answers 503; saying
    //    so is the whole point of showing this
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
    onDialogCancel()
  }
}

onMounted(() => {
  rerenderPage()
})
</script>
