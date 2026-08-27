<template>
  <!-- -> Open from the start when the page being read is one of its descendants, so a reader arriving
          by URL sees where they are in the tree -- or when the menu says this group opens that way
          whatever is being read. Not `v-model`: after that first render the group is the reader's
          to open and close, and a bound value would fight them -->
  <w-expansion-item
    v-if="item.children?.length > 0"
    dense
    :default-opened="item.expandByDefault || containsCurrent(item)">
    <!-- The icon goes through a header slot rather than the `icon` prop, so that an Iconify -->
    <!-- reference is drawn by w-icon like everywhere else -->
    <template #header>
      <w-item-section side><w-icon :name="item.icon" color="white" /></w-item-section>
      <w-item-section class="text-wordbreak-all text-white">{{ item.label }}</w-item-section>
    </template>
    <w-list dense dark>
      <!-- -> One nav item, plus its own expansion behavior if it has children -- rendered for each
              child so a folder nested any number of levels deep still draws its own contents,
              rather than only the first level under the sidebar root -->
      <nav-sidebar-item v-for="child of item.children" :key="child.id" :item="child" />
    </w-list>
  </w-expansion-item>
  <w-item v-else v-bind="destination(item)">
    <w-item-section side><w-icon :name="item.icon" color="white" /></w-item-section>
    <w-item-section class="text-wordbreak-all text-white">{{ item.label }}</w-item-section>
  </w-item>
</template>

<script setup>
import { useNavSidebarDestination } from '@/composables/navSidebarDestination'

// -> Self-imported so the recursive tag below resolves explicitly, rather than relying on the SFC
//    filename-based self-reference Vue infers implicitly for `<script setup>` components
import NavSidebarItem from './NavSidebarItem.vue'

defineProps({
  /** One nav item -- a `link`, possibly carrying `children` of its own. */
  item: {
    type: Object,
    required: true
  }
})

const { destination, containsCurrent } = useNavSidebarDestination()
</script>
