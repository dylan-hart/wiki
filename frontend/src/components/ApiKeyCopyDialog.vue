<template>
  <w-dialog
    v-model="dialogVisible"
    persistent
    :aria-label="t(`${labelPrefix}.copyKeyTitle`)"
    @hide="onDialogHide">
    <w-card style="min-width: 600px">
      <w-card-section class="card-header">
        <w-icon name="tabler:key" size="sm" class="me-2" />
        <span>{{ t(`${labelPrefix}.copyKeyTitle`) }}</span>
      </w-card-section>
      <w-card-section class="card-negative">
        <i18n-t tag="span" :keypath="`${labelPrefix}.newKeyCopyWarn`" scope="global">
          <template #bold>
            <strong>{{ t(`${labelPrefix}.newKeyCopyWarnBold`) }}</strong>
          </template>
        </i18n-t>
      </w-card-section>
      <w-form class="py-2">
        <w-item>
          <blueprint-icon icon="tabler:file-code" class="self-start" />
          <w-item-section>
            <w-input
              ref="iptKey"
              type="textarea"
              :model-value="props.keyValue"
              readonly
              dense
              hide-bottom-space
              :label="t(`${labelPrefix}.key`)" />
          </w-item-section>
        </w-item>
        <!--
          Shown for both flows this dialog serves: an admin-issued key still works against the MCP
          server's read tools, scoped to whatever groups it was given, so the snippet is not
          exclusive to the personal-token flow that the write tools require.
        -->
        <w-item>
          <blueprint-icon icon="tabler:terminal-2" class="self-start" />
          <w-item-section>
            <w-input
              type="textarea"
              :model-value="mcpInstallCommand"
              readonly
              dense
              hide-bottom-space
              :label="t(`admin.api.mcpInstallCommand`)"
              :hint="t(`admin.api.mcpInstallCommandHint`)" />
            <w-btn-toggle
              v-model="mcpInstallScope"
              class="mt-2"
              :aria-label="t(`admin.api.mcpInstallScope`)"
              :options="mcpInstallScopeOptions" />
          </w-item-section>
        </w-item>
      </w-form>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          icon="tabler:terminal-2"
          :label="t(`admin.api.copyMcpInstallCommand`)"
          color="primary"
          padding="xs md"
          @click="copyMcpInstallCommand" />
        <w-btn
          class="acrylic-btn"
          flat
          icon="tabler:copy"
          :label="t(`common.actions.copy`)"
          color="primary"
          padding="xs md"
          @click="copyKey" />
        <w-btn
          :label="t(`common.actions.close`)"
          color="primary"
          padding="xs md"
          @click="onDialogOK" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { copyToClipboard } from '@/helpers/clipboard'
import { ref } from 'vue'

const props = defineProps({
  keyValue: {
    type: String,
    required: true
  },
  // -> `admin.api.*` for the admin-issued key flow, `profile.api.*` for the self-service personal
  //    access token flow -- the same strings under different i18n namespaces, since a personal token
  //    isn't an admin's "API Key" to the reader holding it. The `admin.api.mcpInstall*` strings are
  //    global and deliberately not routed through this.
  labelPrefix: {
    type: String,
    default: 'admin.api'
  }
})

defineEmits([...dialogComponentEmits])

const iptKey = ref(null)

const { dialogVisible, onDialogHide, onDialogOK } = useDialogComponent({
  autofocus: () => iptKey.value
})

const { t } = useI18n()

/**
 * Defaults to `user` -- available across all of that user's own projects, still never committed --
 * rather than `local`, which is scoped to whichever single project directory the command happens to
 * be run from. Deliberately no `project` option: `project` scope writes the command, bearer token
 * included, into a `.mcp.json` that gets committed to a repo.
 */
const mcpInstallScope = ref('user')

const mcpInstallScopeOptions = computed(() => [
  { label: t(`admin.api.mcpInstallScopeUser`), value: 'user' },
  { label: t(`admin.api.mcpInstallScopeLocal`), value: 'local' }
])

const mcpInstallCommand = computed(() => {
  return (
    `claude mcp add --transport http cardinaljs ${window.location.origin}/_mcp ` +
    `--header "Authorization: Bearer ${props.keyValue}" --scope ${mcpInstallScope.value}`
  )
})

async function copyKey() {
  try {
    await copyToClipboard(props.keyValue)
    notify({
      type: 'positive',
      message: t(`${props.labelPrefix}.copySuccess`)
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t(`${props.labelPrefix}.copyFailed`),
      caption: err.message
    })
  }
}

async function copyMcpInstallCommand() {
  try {
    await copyToClipboard(mcpInstallCommand.value)
    notify({
      type: 'positive',
      message: t('admin.api.copyMcpInstallCommandSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.api.copyMcpInstallCommandFailed'),
      caption: err.message
    })
  }
}
</script>
