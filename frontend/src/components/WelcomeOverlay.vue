<template>
  <div class="welcome">
    <div class="welcome-bg" />
    <div class="welcome-content">
      <div class="welcome-logo"><img src="/_assets/logo-wikijs.svg" alt="" /></div>
      <div class="welcome-title">{{ t('welcome.title') }}</div>
      <div class="welcome-subtitle">{{ t('welcome.subtitle') }}</div>
      <div class="welcome-actions">
        <w-btn
          color="primary"
          :label="t(`welcome.createHome`)"
          icon="la:plus"
          @click="onCreateHomeClick">
          <!--
            -> With exactly one editor enabled there is nothing to pick, so the menu is skipped
               entirely (onCreateHomeClick creates the page directly) rather than making the visitor
               open a one-item menu just to click its only entry.
          -->
          <w-menu
            v-if="enabledEditors.length !== 1"
            class="translucent-menu"
            auto-close
            anchor="top left"
            self="bottom left">
            <w-list padding>
              <w-item
                clickable
                @click="createHomePage(`wysiwyg`)"
                v-if="enabledEditors.includes(`wysiwyg`)">
                <blueprint-icon icon="tabler:presentation" />
                <w-item-section class="pe-2">{{ t('welcome.usingVisualEditor') }}</w-item-section>
                <w-item-section side><w-icon name="mdi:chevron-right" /></w-item-section>
              </w-item>
              <w-item
                clickable
                @click="createHomePage(`markdown`)"
                v-if="enabledEditors.includes(`markdown`)">
                <blueprint-icon icon="tabler:markdown" />
                <w-item-section class="pe-2">{{ t('welcome.usingMarkdownEditor') }}</w-item-section>
                <w-item-section side><w-icon name="mdi:chevron-right" /></w-item-section>
              </w-item>
              <w-item
                clickable
                @click="createHomePage(`asciidoc`)"
                v-if="enabledEditors.includes(`asciidoc`)">
                <blueprint-icon icon="tabler:file-text" />
                <w-item-section class="pe-2">{{ t('welcome.usingAsciidocEditor') }}</w-item-section>
                <w-item-section side><w-icon name="mdi:chevron-right" /></w-item-section>
              </w-item>
            </w-list>
          </w-menu>
        </w-btn>
        <!--
          -> Same test the admin area itself makes on arrival: this screen greets whoever may write the
             first page, which on a wiki with an editors group is not necessarily somebody who may
             administer it -- and the button would land them on the unauthorized screen.
        -->
        <w-btn
          v-if="userStore.can(`access:admin`)"
          color="primary"
          :label="t(`welcome.admin`)"
          icon="la:cog"
          @click="loadAdmin" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'
import { useMeta } from '@/composables/meta'

import { useFlagsStore } from '@/stores/flags'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { apiErrorMessage } from '@/helpers/apiError'

// PROPS

/**
 * `MainOverlayDialog.vue` forwards `siteStore.overlayOpts` to every overlay it mounts as this prop
 * (OpenProject #2530). Declared here even though this overlay opens with no initial state to read --
 * without a declared prop, the value would fall through onto this component's DOM root instead.
 */
defineProps({
  overlayOpts: { type: Object, default: () => ({}) }
})

// STORES

const flagsStore = useFlagsStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('welcome.title')
}))

// COMPUTED

/**
 * Same per-editor gating the menu items use, collected once so the trigger button can decide
 * whether there is anything to pick between.
 */
const enabledEditors = computed(() => {
  const editors = []
  if (flagsStore.experimental && siteStore.editors.wysiwyg) {
    editors.push('wysiwyg')
  }
  if (siteStore.editors.markdown) {
    editors.push('markdown')
  }
  if (flagsStore.experimental && siteStore.editors.asciidoc) {
    editors.push('asciidoc')
  }
  return editors
})

// METHODS

/**
 * With exactly one editor enabled, skip the picker and create the page with it directly. With
 * zero or several enabled, the menu (rendered alongside this button) handles the click itself via
 * its own trigger listener, so there is nothing to do here.
 */
function onCreateHomeClick() {
  if (enabledEditors.value.length === 1) {
    createHomePage(enabledEditors.value[0])
  }
}

async function createHomePage(editor) {
  loading.show()
  siteStore.overlay = ''
  try {
    await pageStore.pageCreate({
      editor,
      locale: siteStore.locales.primary,
      path: 'home',
      title: t('welcome.homeDefault.title'),
      description: t('welcome.homeDefault.description'),
      content: t('welcome.homeDefault.content')
    })
  } catch (err) {
    // -> Opening the editor is what this button does, so a failure has to be said out loud rather
    //    than leaving the spinner up over a screen that never changed
    siteStore.overlay = 'Welcome'
    notify({
      type: 'negative',
      message: t('welcome.editorOpenFailed'),
      caption: apiErrorMessage(err)
    })
  }
  loading.hide()
}

function loadAdmin() {
  siteStore.overlay = ''
  router.push('/_admin')
}
</script>

<style lang="scss">
.welcome {
  background: #fff radial-gradient(ellipse, #fff, #ddd);
  color: $grey-9;
  height: 100vh;
  border: 1px solid #eee;

  @at-root .body--dark & {
    background: $dark-6 radial-gradient(ellipse, $dark-4, $dark-6);
    color: $blue-grey-1;
    border: 1px solid $dark-4;
  }

  &-bg {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 320px;
    height: 320px;
    background: linear-gradient(0, #fff 50%, $blue-5 50%);
    border-radius: 50%;
    filter: blur(100px);
    transform: translate(-50%, -55%);

    @at-root .body--dark & {
      background: linear-gradient(0, $dark-6 50%, $blue-5 50%);
    }
  }

  &-content {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    width: 90vw;
  }

  &-logo {
    user-select: none;

    > img {
      height: 200px;
      user-select: none;
    }
  }

  &-title {
    font-size: 4rem;
    font-weight: 500;
    line-height: 4rem;
    text-align: center;

    @media (max-width: $breakpoint-md-max) {
      font-size: 2.5rem;
      line-height: 2.5rem;
    }
  }

  &-subtitle {
    font-size: 1.2rem;
    font-weight: 500;
    color: $blue-7;
    line-height: 1.2rem;
    margin-top: 1rem;
  }

  &-actions {
    margin-top: 2rem;
    text-align: center;

    > .w-btn {
      margin: 0 5px 5px 5px;
    }
  }
}
</style>
