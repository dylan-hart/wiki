<template>
  <w-dialog
    v-model="dialogVisible"
    :aria-label="isEdit ? t('admin.glossary.editTerm') : t('admin.glossary.newTerm')"
    @hide="onDialogHide">
    <w-card style="min-width: 650px">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-find-and-replace.svg" size="sm" class="me-2" />
        <span>{{ isEdit ? t('admin.glossary.editTerm') : t('admin.glossary.newTerm') }}</span>
      </w-card-section>
      <w-form ref="termForm" class="py-2" @submit="save">
        <w-item>
          <blueprint-icon icon="rename" />
          <w-item-section>
            <w-input
              ref="iptTerm"
              v-model="state.term"
              outlined
              dense
              required
              :rules="termValidation"
              hide-bottom-space
              :label="t(`admin.glossary.term`)"
              :hint="t(`admin.glossary.termHint`)"
              lazy-rules="ondemand" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="quote-left" />
          <w-item-section>
            <w-input
              v-model="state.definition"
              type="textarea"
              outlined
              dense
              required
              rows="3"
              :rules="definitionValidation"
              hide-bottom-space
              :label="t(`admin.glossary.definition`)"
              :hint="t(`admin.glossary.definitionHint`)"
              lazy-rules="ondemand" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="matches" />
          <w-item-section>
            <div class="flex flex-wrap gap-1 mb-2" v-if="state.aliases.length > 0">
              <w-chip
                v-for="alias of state.aliases"
                :key="alias"
                square
                dense
                removable
                @remove="removeAlias(alias)">
                {{ alias }}
              </w-chip>
            </div>
            <w-input
              v-model="state.aliasInput"
              outlined
              dense
              hide-bottom-space
              :label="t(`admin.glossary.aliases`)"
              :hint="t(`admin.glossary.aliasesHint`)"
              @keyup:enter="addAlias">
              <template #append>
                <w-btn
                  flat
                  round
                  dense
                  icon="la:plus"
                  :aria-label="t('common.actions.add')"
                  @click="addAlias" />
              </template>
            </w-input>
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="link" />
          <w-item-section>
            <w-input
              v-model="state.path"
              outlined
              dense
              hide-bottom-space
              :label="t(`admin.glossary.canonicalPage`)"
              :hint="pathHint"
              :prefix="state.path.trim() ? '/' : ''">
              <template #append>
                <w-spinner v-if="state.pathStatus === 'checking'" size="16px" />
                <w-icon
                  v-else-if="state.pathStatus === 'valid'"
                  name="la:check-circle"
                  size="xs"
                  color="positive" />
                <w-icon
                  v-else-if="state.pathStatus === 'invalid'"
                  name="la:exclamation-triangle"
                  size="xs"
                  color="negative" />
              </template>
            </w-input>
          </w-item-section>
        </w-item>
      </w-form>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`common.actions.cancel`)"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
        <w-btn
          unelevated
          :label="isEdit ? t(`common.actions.save`) : t(`common.actions.create`)"
          color="primary"
          padding="xs md"
          @click="save" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { debounce } from 'es-toolkit/function'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { normalizePagePath, pagePathHash } from '@/helpers/pagePaths'

/**
 * Collects/edits ONE glossary entry and hands it back to the caller (`AdminGlossary.vue`) via
 * `onDialogOK` -- it makes no API call of its own. Glossary admin editing is a staged workflow
 * (OpenProject #1113): every add/edit/delete is applied to a local working copy, and nothing reaches
 * the server until that screen's own "Save" action, which atomically replaces the whole glossary and
 * records a version. This dialog's only job is producing one valid, staged entry.
 *
 * The canonical-page field is a plain, live-validated path input (OpenProject #1112) rather than a
 * `<w-select>` dropdown fed by a capped candidate list -- a dropdown has no way to offer every page on
 * a wiki with more than a couple hundred, and silently made an already-assigned page outside that cap
 * unreachable. Typing a path debounces a lookup against the same by-hash page endpoint a page view
 * itself resolves a URL through (`pagePathHash` mirrors the backend's `generatePathHash` bit for bit),
 * showing whether it currently resolves -- but resolution is NOT enforced here: the final bulk Save
 * is what actually validates every entry, exactly like a JSON import does, so a path can be staged
 * before its target page exists yet without blocking the rest of this edit.
 */

// PROPS

const props = defineProps({
  siteId: {
    type: String,
    required: true
  },
  /** The staged entry being edited (`{ term, definition, aliases, path }`), or null to create one. */
  term: {
    type: Object,
    default: null
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptTerm.value
})

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  term: props.term?.term ?? '',
  definition: props.term?.definition ?? '',
  aliases: [...(props.term?.aliases ?? [])],
  aliasInput: '',
  path: props.term?.path ?? '',
  /** 'empty' | 'checking' | 'valid' | 'invalid' -- the live path lookup's current state. */
  pathStatus: 'empty',
  pathPageTitle: ''
})

// REFS

const termForm = ref(null)
const iptTerm = ref(null)

// COMPUTED

const isEdit = computed(() => Boolean(props.term))

const pathHint = computed(() => {
  if (state.pathStatus === 'checking') {
    return t('admin.glossary.canonicalPageChecking')
  }
  if (state.pathStatus === 'valid') {
    return t('admin.glossary.canonicalPageFound', { title: state.pathPageTitle })
  }
  if (state.pathStatus === 'invalid') {
    return t('admin.glossary.canonicalPageNotFound')
  }
  return t('admin.glossary.canonicalPageHint')
})

// VALIDATION RULES

const termValidation = [(val) => (val ?? '').trim().length > 0 || t('admin.glossary.termRequired')]

const definitionValidation = [
  (val) => (val ?? '').trim().length > 0 || t('admin.glossary.definitionRequired')
]

// WATCHERS

watch(() => state.path, debounce(checkPath, 400))

// METHODS

function addAlias() {
  const value = state.aliasInput.trim()
  state.aliasInput = ''
  const lower = value.toLowerCase()
  // -> Mirrors `normalizeAliases()` server-side (`models/glossary.ts`), which silently drops an
  //    alias matching the term itself -- it would only ever be a no-op surface form, never a
  //    genuinely distinct one. Rejecting it here too means a chip never appears just to vanish,
  //    unexplained, the next time this entry round-trips through Save.
  if (
    !value ||
    lower === state.term.trim().toLowerCase() ||
    state.aliases.some((a) => a.toLowerCase() === lower)
  ) {
    return
  }
  state.aliases.push(value)
}

function removeAlias(alias) {
  state.aliases = state.aliases.filter((a) => a !== alias)
}

/** Debounced (see the WATCHERS block): resolves `state.path` against this site's primary locale. */
async function checkPath() {
  const raw = state.path.trim()
  if (!raw) {
    state.pathStatus = 'empty'
    state.pathPageTitle = ''
    return
  }
  state.pathStatus = 'checking'
  try {
    const hash = pagePathHash(normalizePagePath(raw))
    const page = await API_CLIENT.get(`sites/${props.siteId}/pages/${hash}`).json()
    state.pathStatus = 'valid'
    state.pathPageTitle = page.title
  } catch {
    state.pathStatus = 'invalid'
    state.pathPageTitle = ''
  }
}

async function save() {
  const isFormValid = await termForm.value.validate(true)
  if (!isFormValid) {
    return
  }

  onDialogOK({
    term: state.term.trim(),
    definition: state.definition.trim(),
    aliases: state.aliases,
    path: state.path.trim() || null
  })
}

// MOUNTED

onMounted(checkPath)
</script>
