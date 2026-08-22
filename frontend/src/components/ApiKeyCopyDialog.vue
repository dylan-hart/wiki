<template>
  <w-dialog v-model="dialogVisible" persistent @hide="onDialogHide">
    <w-card style="min-width: 600px">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-key-2.svg" size="sm" class="mr-2" />
        <span>{{ t(`admin.api.copyKeyTitle`) }}</span>
      </w-card-section>
      <w-card-section class="card-negative">
        <i18n-t tag="span" keypath="admin.api.newKeyCopyWarn" scope="global">
          <template #bold>
            <strong>{{ t('admin.api.newKeyCopyWarnBold') }}</strong>
          </template>
        </i18n-t>
      </w-card-section>
      <w-form class="py-2">
        <w-item>
          <blueprint-icon icon="binary-file" class="self-start" />
          <w-item-section>
            <w-input
              type="textarea"
              outlined
              :model-value="props.keyValue"
              readonly
              dense
              hide-bottom-space
              :label="t(`admin.api.key`)"
              autofocus />
          </w-item-section>
        </w-item>
        <!--
          #1117: a ready-to-paste `claude mcp add` install command, shown alongside the raw key. Shown
          unconditionally for both flows this dialog serves (admin-issued keys via `AdminApi.vue`,
          personal tokens via `ProfileApiKeyCreateDialog.vue`) -- an admin-issued key still works
          against the MCP server's read tools, scoped to whatever groups it was given, so the snippet
          is not exclusive to the personal-token flow that write tools actually require.
        -->
        <w-item>
          <blueprint-icon icon="run-command" class="self-start" />
          <w-item-section>
            <w-input
              type="textarea"
              outlined
              :model-value="mcpInstallCommand"
              readonly
              dense
              hide-bottom-space
              :label="t(`admin.api.mcpInstallCommand`)"
              :hint="t(`admin.api.mcpInstallCommandHint`)" />
          </w-item-section>
        </w-item>
      </w-form>
      <w-card-actions class="card-actions">
        <w-space />
        <!--
          The dialog is the only place this token ever appears, so copying either string must not
          depend on selecting a wrapped, hundreds-of-characters-long string by hand
        -->
        <w-btn
          class="acrylic-btn"
          flat
          icon="la:terminal"
          :label="t(`admin.api.copyMcpInstallCommand`)"
          color="primary"
          padding="xs md"
          @click="copyMcpInstallCommand" />
        <w-btn
          class="acrylic-btn"
          flat
          icon="la:copy"
          :label="t(`common.actions.copy`)"
          color="primary"
          padding="xs md"
          @click="copyKey" />
        <w-btn
          unelevated
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

// PROPS

const props = defineProps({
  keyValue: {
    type: String,
    required: true
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK } = useDialogComponent()

// I18N

const { t } = useI18n()

// COMPUTED

/**
 * A ready-to-paste `claude mcp add` install command for this instance's in-process MCP server
 * (`/_mcp`, OpenProject #985). `window.location.origin` rather than a hardcoded host -- this dialog
 * is rendered from whichever origin the admin/user is actually browsing.
 *
 * `--scope local`, not `project`: `project` scope writes the command -- bearer token included -- into
 * `.mcp.json`, which gets committed to a repo. This has to stay private to whoever's terminal it's
 * pasted into, the same one-time-visibility framing as the raw key above.
 */
const mcpInstallCommand = computed(() => {
  return (
    `claude mcp add --transport http wikijs ${window.location.origin}/_mcp ` +
    `--header "Authorization: Bearer ${props.keyValue}" --scope local`
  )
})

// METHODS

async function copyKey() {
  try {
    await copyToClipboard(props.keyValue)
    notify({
      type: 'positive',
      message: t('admin.api.copySuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.api.copyFailed'),
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
