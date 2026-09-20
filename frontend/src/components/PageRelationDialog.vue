<template>
  <w-card class="page-relation-dialog" style="width: 500px">
    <w-toolbar class="bg-primary text-white">
      <div class="text-subtitle2" v-if="isEditMode">{{ t('editor.pageRel.titleEdit') }}</div>
      <div class="text-subtitle2" v-else>{{ t('editor.pageRel.title') }}</div>
    </w-toolbar>
    <w-card-section>
      <!--
        `self-start` on every button: WForm stacks with `flex-col`, so a button left to itself
        stretches to the full width of the dialog.
      -->
      <div class="w-section-header">{{ t('editor.pageRel.position') }}</div>
      <w-form class="gap-4 pt-4">
        <div>
          <w-btn-toggle
            v-model="state.pos"
            :aria-label="t(`editor.pageRel.position`)"
            :options="[
              { label: t('editor.pageRel.left'), value: 'left' },
              { label: t('editor.pageRel.center'), value: 'center' },
              { label: t('editor.pageRel.right'), value: 'right' }
            ]" />
        </div>
        <div class="w-section-header">{{ t('editor.pageRel.button') }}</div>
        <!-- One item, so the two fields are only ever as far apart as their own margins -->
        <div class="flex flex-col">
          <w-input
            ref="iptRelLabel"
            dense
            :label="t(`editor.pageRel.label`)"
            v-model="state.label" />
          <w-input
            v-if="state.pos !== `center`"
            dense
            :label="t(`editor.pageRel.caption`)"
            v-model="state.caption" />
        </div>
        <!--
          `-mt-2`: an outlined field carries `my-2` around its control, so the form's `gap-4` lands
          8px further down than the 16px those margins put between two stacked fields.
        -->
        <w-btn
          class="self-start rounded -mt-2"
          :label="t(`editor.pageRel.selectIcon`)"
          icon="tabler:search"
          color="primary"
          outline>
          <w-tooltip>{{ t('iconPicker.open') }}</w-tooltip>
          <w-menu content-class="shadow-7"><icon-picker-dialog v-model="state.icon" /></w-menu>
        </w-btn>
        <div class="w-section-header">{{ t('editor.pageRel.target') }}</div>
        <div class="flex flex-nowrap items-center gap-3">
          <w-btn
            class="flex-none rounded"
            :label="t(`editor.pageRel.selectPage`)"
            color="primary"
            outline
            @click="selectTarget" />
          <div class="text-caption font-robotomono min-w-0 flex-1 truncate">
            {{ state.target || '—' }}
          </div>
        </div>
        <div class="w-section-header">{{ t('editor.pageRel.preview') }}</div>
        <w-btn
          v-if="state.pos === `left`"
          class="self-start"
          padding="sm md"
          outline
          color="primary">
          <w-icon :name="state.icon" />
          <div class="flex flex-col text-left pl-4">
            <div class="text-body2">
              <strong>{{ state.label }}</strong>
            </div>
            <div class="text-caption">{{ state.caption }}</div>
          </div>
        </w-btn>
        <w-btn class="w-full" v-else-if="state.pos === `center`" color="primary" flat>
          <w-icon class="me-2" :name="state.icon" />
          <span>{{ state.label }}</span>
        </w-btn>
        <w-btn
          v-else-if="state.pos === `right`"
          class="self-start"
          padding="sm md"
          outline
          color="primary">
          <div class="flex flex-col text-left pr-4">
            <div class="text-body2">
              <strong>{{ state.label }}</strong>
            </div>
            <div class="text-caption">{{ state.caption }}</div>
          </div>
          <w-icon :name="state.icon" />
        </w-btn>
      </w-form>
    </w-card-section>
    <w-card-actions class="card-actions">
      <w-space />
      <w-btn
        class="acrylic-btn"
        icon="tabler:x"
        :label="t(`common.actions.discard`)"
        color="grey-7"
        padding="xs md"
        flat
        @click="$emit('close')" />
      <w-btn
        v-if="isEditMode"
        :disabled="!canSubmit"
        icon="tabler:check"
        :label="t(`common.actions.save`)"
        color="primary"
        padding="xs md"
        @click="saveAndClose" />
      <w-btn
        v-else
        :disabled="!canSubmit"
        icon="tabler:plus"
        :label="t(`common.actions.create`)"
        color="primary"
        padding="xs md"
        @click="createAndClose" />
    </w-card-actions>
  </w-card>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { v4 as uuid } from 'uuid'
import { cloneDeep } from 'es-toolkit/object'

import { dialog } from '@/composables/dialog'

import IconPickerDialog from './IconPickerDialog.vue'
import LinkPickerDialog from './LinkPickerDialog.vue'

const props = defineProps({
  editId: {
    type: String,
    default: null
  }
})

const pageStore = usePageStore()
const siteStore = useSiteStore()

const { t } = useI18n()

const state = reactive({
  pos: 'left',
  label: '',
  caption: '',
  icon: 'tabler:arrow-left',
  target: ''
})

const iptRelLabel = ref(null)

const canSubmit = computed(() => state.label.length > 0)
const isEditMode = computed(() => Boolean(props.editId))

watch(
  () => state.pos,
  (newValue) => {
    switch (newValue) {
      case 'left': {
        state.icon = 'tabler:arrow-left'
        break
      }
      case 'center': {
        state.icon = 'tabler:book'
        break
      }
      case 'right': {
        state.icon = 'tabler:arrow-right'
        break
      }
    }
  }
)

const emit = defineEmits(['close'])

/* No new-tab option: a relation stores a target and nothing else, so the choice would be lost. */
function selectTarget() {
  dialog({
    component: LinkPickerDialog,
    componentProps: {
      title: t('editor.pageRel.target'),
      okLabel: t('common.actions.select'),
      initialHref: state.target,
      newTabOption: false
    }
  }).onOk(({ href }) => {
    state.target = href
  })
}

function create() {
  pageStore.$patch({
    relations: [
      ...pageStore.relations,
      {
        id: uuid(),
        position: state.pos,
        label: state.label,
        ...(state.pos !== 'center' ? { caption: state.caption } : {}),
        icon: state.icon,
        target: state.target
      }
    ]
  })
}

function persist() {
  const rels = cloneDeep(pageStore.relations)
  for (const rel of rels) {
    if (rel.id === props.editId) {
      rel.position = state.pos
      rel.label = state.label
      rel.caption = state.caption
      rel.icon = state.icon
      rel.target = state.target
    }
  }
  pageStore.$patch({
    relations: rels
  })
}

/*
  Named handlers: an inline `persist(); $emit('close')` is reformatted onto two lines by oxfmt, which
  is no longer a valid template expression.
*/
function saveAndClose() {
  persist()
  emit('close')
}

function createAndClose() {
  create()
  emit('close')
}

onMounted(() => {
  if (props.editId) {
    const rel = pageStore.relations.find((r) => r.id === props.editId)
    if (rel) {
      state.pos = rel.position
      state.label = rel.label
      state.caption = rel.caption || ''
      state.icon = rel.icon
      state.target = rel.target
    }
  }
  nextTick(() => {
    iptRelLabel.value.focus()
  })
})
</script>

<style>
/*
  `.w-section-header` carries its own 16px inset and expects a column that has none, so the card
  section's padding is given back around it -- through `--w-section-bleed`, once on the box that does
  the padding rather than as a negative margin on each band. Their bottom margin goes because three
  of them are items in the form's `flex-col gap-4`, which is already the space beneath them.
*/
.page-relation-dialog {
  --w-section-bleed: 16px;

  .w-section-header {
    margin-block-end: 0;
  }

  /*
    The first band is also the top of the section, so it takes that padding too -- as margin only;
    handing it back as `padding-top` puts its text below the centre the other bands align on.
  */
  > .w-card-section > .w-section-header:first-child {
    margin-block-start: -16px;
  }
}
</style>
