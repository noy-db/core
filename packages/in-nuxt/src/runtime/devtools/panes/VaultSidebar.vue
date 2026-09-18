<template>
  <aside class="noydb-sidebar">
    <div class="noydb-sidebar__header">Vault</div>
    <template v-if="vaultName">
      <div
        class="noydb-sidebar__vault"
        :title="vaultMeta?.description ?? vaultName ?? undefined"
      >▸ {{ vaultMeta?.label ?? vaultName }}</div>
      <button
        v-for="coll in collections"
        :key="coll.name"
        :class="['noydb-sidebar__item', { 'noydb-sidebar__item--selected': coll.name === selectedName }]"
        @click="$emit('select', coll)"
      >
        <span>{{ coll.meta?.label ?? coll.name }}</span>
        <!-- `records`, not `count`: CollectionStats has no `count` field and never
             has, so this badge NEVER rendered against a real inspector snapshot.
             The test double invented `count`, so the component and its test agreed
             with each other and neither agreed with the contract. Found by putting
             the tests in front of a compiler (core#40) — the .vue itself is still
             unchecked (tsc, not vue-tsc), which is exactly where the bug was
             hiding. -->
        <span v-if="coll.stats?.records" class="noydb-sidebar__badge">{{ coll.stats.records }}</span>
      </button>
    </template>
    <div v-else class="noydb-sidebar__empty">—</div>
  </aside>
</template>

<script setup lang="ts">
import type { InspectorCollection } from '@noy-db/in-devtools'
import type { VaultMeta } from '@noy-db/hub'

defineProps<{
  vaultName: string | null
  vaultMeta?: VaultMeta | null
  collections: ReadonlyArray<InspectorCollection>
  selectedName: string | null
}>()

defineEmits<{ select: [collection: InspectorCollection] }>()
</script>
