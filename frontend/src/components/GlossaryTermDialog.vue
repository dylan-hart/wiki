<template>
  <w-dialog
    v-model="dialogVisible"
    :aria-label="isEdit ? t('admin.glossary.editTerm') : t('admin.glossary.newTerm')"
    @hide="onDialogHide">
    <w-card style="min-width: 650px">
      <w-card-section class="card-header">
        <w-icon name="tabler:list-search" size="sm" class="me-2" />
        <span>{{ isEdit ? t('admin.glossary.editTerm') : t('admin.glossary.newTerm') }}</span>
      </w-card-section>
      <w-form ref="termForm" class="py-2" @submit="save">
        <w-item>
          <blueprint-icon icon="tabler:cursor-text" />
          <w-item-section>
            <w-input
              ref="iptTerm"
              v-model="state.term"
              dense
              required
              :rules="termValidation"
              hide-bottom-space
              :label="t(`admin.glossary.term`)"
              :hint="t(`admin.glossary.termHint`)"
              lazy-rules="ondemand" />
          </w-item-section>
          <w-item-section side>
            <w-checkbox v-model="state.isAcronym" dense :label="t('admin.glossary.isAcronym')" />
            <div class="text-caption text-grey" style="max-width: 140px">
              {{ t('admin.glossary.isAcronymHint') }}
            </div>
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="tabler:quote" />
          <w-item-section>
            <w-input
              v-model="state.definition"
              type="textarea"
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
          <blueprint-icon icon="tabler:flame" />
          <w-item-section>
            <div class="flex flex-wrap gap-1 mb-2" v-if="state.aliases.length > 0">
              <w-chip
                v-for="alias of state.aliases"
                :key="alias.value"
                dense
                clickable
                removable
                :icon="alias.isAcronym ? 'tabler:square-letter-a' : null"
                :aria-label="
                  alias.isAcronym
                    ? t('admin.glossary.aliasIsAcronym', { alias: alias.value })
                    : t('admin.glossary.aliasIsNotAcronym', { alias: alias.value })
                "
                @click="toggleAliasAcronym(alias)"
                @remove="removeAlias(alias.value)">
                {{ alias.value }}
              </w-chip>
            </div>
            <w-input
              v-model="state.aliasInput"
              dense
              hide-bottom-space
              :label="t(`admin.glossary.aliases`)"
              :hint="t(`admin.glossary.aliasesHint`)"
              @keyup:enter="addAlias">
              <template #append>
                <w-checkbox
                  v-model="state.aliasIsAcronym"
                  dense
                  :label="t('admin.glossary.isAcronym')" />
                <w-btn
                  flat
                  round
                  dense
                  icon="tabler:plus"
                  :aria-label="t('common.actions.add')"
                  @click="addAlias" />
              </template>
            </w-input>
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="tabler:link" />
          <w-item-section>
            <w-input
              v-model="state.path"
              dense
              hide-bottom-space
              :label="t(`admin.glossary.canonicalPage`)"
              :hint="pathHint"
              :prefix="state.path.trim() ? '/' : ''">
              <template #append>
                <w-spinner v-if="state.pathStatus === 'checking'" size="16px" />
                <w-icon
                  v-else-if="state.pathStatus === 'valid'"
                  name="tabler:circle-check"
                  size="xs"
                  color="positive" />
                <w-icon
                  v-else-if="state.pathStatus === 'invalid'"
                  name="tabler:alert-triangle"
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
 * Glossary admin editing is staged: this dialog makes no API call of its own, handing one entry back
 * through `onDialogOK` for `AdminGlossary.vue` to hold in a local working copy until its own Save
 * atomically replaces the whole glossary.
 *
 * The canonical-page field is a live-validated path input rather than a `<w-select>` fed by a capped
 * candidate list, which cannot offer every page of a large wiki and made an already-assigned page
 * outside the cap unreachable. Resolution is shown but NOT enforced: the bulk Save validates every
 * entry, so a path may be staged before its target page exists.
 */

const props = defineProps({
  siteId: {
    type: String,
    required: true
  },
  /** `{ term, definition, isAcronym, aliases: { value, isAcronym }[], path }`, or null to create. */
  term: {
    type: Object,
    default: null
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptTerm.value
})

const { t } = useI18n()

const state = reactive({
  term: props.term?.term ?? '',
  definition: props.term?.definition ?? '',
  /** An acronym's stored casing is a canonical DISPLAY casing, consulted by the path-segment
   *  humanizer. */
  isAcronym: props.term?.isAcronym ?? false,
  /** `{ value, isAcronym }[]` */
  aliases: (props.term?.aliases ?? []).map((a) => ({ ...a })),
  aliasInput: '',
  /** Applies to the NEXT alias `addAlias()` pushes, not to any already in the list. */
  aliasIsAcronym: false,
  path: props.term?.path ?? '',
  /** 'empty' | 'checking' | 'valid' | 'invalid' */
  pathStatus: 'empty',
  pathPageTitle: ''
})

const termForm = ref(null)
const iptTerm = ref(null)

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

const termValidation = [(val) => (val ?? '').trim().length > 0 || t('admin.glossary.termRequired')]

const definitionValidation = [
  (val) => (val ?? '').trim().length > 0 || t('admin.glossary.definitionRequired')
]

watch(() => state.path, debounce(checkPath, 400))

function addAlias() {
  const value = state.aliasInput.trim()
  state.aliasInput = ''
  const lower = value.toLowerCase()
  // -> Mirrors `normalizeAliases()` in `models/glossary.ts`, which silently drops an alias matching
  //    the term itself: rejecting it here too keeps a chip from vanishing unexplained after a Save.
  if (
    !value ||
    lower === state.term.trim().toLowerCase() ||
    state.aliases.some((a) => a.value.toLowerCase() === lower)
  ) {
    return
  }
  state.aliases.push({ value, isAcronym: state.aliasIsAcronym })
}

function removeAlias(value) {
  state.aliases = state.aliases.filter((a) => a.value !== value)
}

function toggleAliasAcronym(alias) {
  alias.isAcronym = !alias.isAcronym
}

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
    isAcronym: state.isAcronym,
    aliases: state.aliases,
    path: state.path.trim() || null
  })
}

onMounted(checkPath)
</script>
