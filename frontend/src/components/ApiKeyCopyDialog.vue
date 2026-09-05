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
          #1117: a ready-to-paste `claude mcp add` install command, shown alongside the raw key. Shown
          unconditionally for both flows this dialog serves (admin-issued keys via `AdminApi.vue`,
          personal tokens via `ProfileApiKeyCreateDialog.vue`) -- an admin-issued key still works
          against the MCP server's read tools, scoped to whatever groups it was given, so the snippet
          is not exclusive to the personal-token flow that write tools actually require.
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
              toggle-color="primary"
              class="mt-2"
              :aria-label="t(`admin.api.mcpInstallScope`)"
              :options="mcpInstallScopeOptions" />
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

// PROPS

const props = defineProps({
  keyValue: {
    type: String,
    required: true
  },
  // -> `admin.api.*` for the admin-issued key flow, `profile.api.*` for the self-service personal
  //    access token flow -- the two string sets say the same things ("Copy Access Token", ...) under
  //    different i18n namespaces, since a personal token isn't an admin's "API Key" to the reader
  //    holding it. `admin.api.mcpInstallCommand*` is genuinely global and is not routed through this.
  //    Mirrors `ApiKeyRevokeDialog`'s own `labelPrefix` prop.
  labelPrefix: {
    type: String,
    default: 'admin.api'
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// REFS

const iptKey = ref(null)

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK } = useDialogComponent({
  autofocus: () => iptKey.value
})

// I18N

const { t } = useI18n()

// SCOPE TOGGLE

/**
 * `user`/`local` toggle for the generated install command's `--scope` flag (OpenProject #2411).
 * Defaults to `user` -- available across all the admin/user's own projects, still never committed --
 * rather than `local`, which is scoped to whichever single project directory the command happens to
 * be run from.
 *
 * Deliberately no `project` option: `project` scope writes the command -- bearer token included --
 * into `.mcp.json`, which gets committed to a repo. See the `mcpInstallCommand` doc comment below.
 */
const mcpInstallScope = ref('user')

const mcpInstallScopeOptions = computed(() => [
  { label: t(`admin.api.mcpInstallScopeUser`), value: 'user' },
  { label: t(`admin.api.mcpInstallScopeLocal`), value: 'local' }
])

// COMPUTED

/**
 * A ready-to-paste `claude mcp add` install command for this instance's in-process MCP server
 * (`/_mcp`, OpenProject #985). `window.location.origin` rather than a hardcoded host -- this dialog
 * is rendered from whichever origin the admin/user is actually browsing.
 *
 * `--scope` comes from the `mcpInstallScope` toggle above and is either `user` or `local` -- never
 * `project`: `project` scope writes the command -- bearer token included -- into `.mcp.json`, which
 * gets committed to a repo. Both remaining options stay private to whoever's terminal the command is
 * pasted into, the same one-time-visibility framing as the raw key above.
 */
const mcpInstallCommand = computed(() => {
  return (
    `claude mcp add --transport http wikijs ${window.location.origin}/_mcp ` +
    `--header "Authorization: Bearer ${props.keyValue}" --scope ${mcpInstallScope.value}`
  )
})

// METHODS

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
