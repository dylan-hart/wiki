<template>
  <w-dialog
    v-model="dialogVisible"
    max-width="860px"
    :aria-label="t(`fileman.assetPreview`)"
    @hide="onDialogHide">
    <w-card class="asset-preview">
      <w-card-section class="card-header">
        <w-icon name="tabler:photo" size="sm" class="me-2" />
        <span class="asset-preview-title">{{ fileName }}</span>
      </w-card-section>
      <w-card-section class="asset-preview-stage">
        <p v-if="state.imageFailed" class="asset-preview-failed" role="alert">
          {{ t(`fileman.assetPreviewImageFailed`) }}
        </p>
        <img v-else class="asset-preview-image" :src="url" :alt="fileName" @error="onImageError" />
      </w-card-section>
      <w-card-section>
        <dl class="asset-preview-facts">
          <div v-if="dimensions" class="asset-preview-fact">
            <dt>{{ t(`fileman.detailsAssetDimensions`) }}</dt>
            <dd data-test="asset-preview-dimensions">{{ dimensions }}</dd>
          </div>
          <div class="asset-preview-fact">
            <dt>{{ t(`fileman.detailsAssetSize`) }}</dt>
            <dd data-test="asset-preview-size">{{ formatFileSize(fileSize) }}</dd>
          </div>
          <div class="asset-preview-fact">
            <dt>{{ t(`fileman.detailsAssetType`) }}</dt>
            <dd data-test="asset-preview-type">{{ mimeType }}</dd>
          </div>
        </dl>
      </w-card-section>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          icon="tabler:clipboard"
          :label="t(`common.actions.copyURL`)"
          color="primary"
          padding="xs md"
          data-test="asset-preview-copy"
          @click="copyUrl" />
        <w-btn
          class="acrylic-btn"
          flat
          icon="tabler:download"
          :label="t(`common.actions.download`)"
          color="primary"
          padding="xs md"
          data-test="asset-preview-download"
          @click="download" />
        <w-btn
          :label="t(`common.actions.close`)"
          color="primary"
          padding="xs md"
          data-test="asset-preview-close"
          @click="onDialogCancel" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive } from 'vue'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { assetUrl } from '@/helpers/assets'
import { copyToClipboard } from '@/helpers/clipboard'
import { formatFileSize } from '@/helpers/fileSize'
import { useSiteStore } from '@/stores/site'

const props = defineProps({
  assetId: {
    type: String,
    required: true
  },
  fileName: {
    type: String,
    required: true
  },
  folderPath: {
    type: String,
    default: ''
  },
  fileSize: {
    type: Number,
    default: 0
  },
  mimeType: {
    type: String,
    default: ''
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogCancel } = useDialogComponent()

const siteStore = useSiteStore()

const { t } = useI18n()

const state = reactive({
  width: null,
  height: null,
  imageFailed: false
})

const url = computed(() => assetUrl(props.folderPath, props.fileName))

const dimensions = computed(() =>
  Number.isInteger(state.width) && Number.isInteger(state.height)
    ? t('fileman.assetDimensionsValue', { width: state.width, height: state.height })
    : null
)

function onImageError() {
  state.imageFailed = true
}

async function copyUrl() {
  try {
    await copyToClipboard(`${window.location.origin}${url.value}`)
    notify({
      type: 'positive',
      message: t('fileman.copyURLSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('fileman.copyURLFailed'),
      caption: apiErrorMessage(err)
    })
  }
}

async function download() {
  try {
    const blob = await API_CLIENT.get(
      `sites/${siteStore.id}/assets/${props.assetId}/content`
    ).blob()
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = props.fileName
    link.click()
    URL.revokeObjectURL(objectUrl)
  } catch (err) {
    notify({
      type: 'negative',
      message: t('fileman.downloadFailed'),
      caption: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
}

onMounted(async () => {
  try {
    const asset = await API_CLIENT.get(`sites/${siteStore.id}/assets/${props.assetId}`).json()
    state.width = asset?.width ?? null
    state.height = asset?.height ?? null
  } catch {
    state.width = null
    state.height = null
  }
})
</script>

<style scoped>
.asset-preview {
  width: min(860px, calc(100vw - 2rem));
}

.asset-preview-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-preview-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
}

.asset-preview-image {
  display: block;
  max-width: 100%;
  max-height: 60vh;
  object-fit: contain;
}

.asset-preview-failed {
  margin: 0;
  color: var(--color-text-caption);
}

.asset-preview-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 2rem;
  margin: 0;
}

.asset-preview-fact dt {
  color: var(--color-text-caption);
  font-size: 0.8125rem;
}

.asset-preview-fact dd {
  margin: 0;
}
</style>
