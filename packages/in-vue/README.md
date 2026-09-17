# @noy-db/in-vue

> Vue 3 / Nuxt composables for [noy-db](https://github.com/noy-db/core) — reactive `useNoydb`, `useCollection`, `useSync`, and biometric plugin.

[![npm](https://img.shields.io/npm/v/@noy-db/in-vue.svg)](https://www.npmjs.com/package/@noy-db/in-vue)

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-browser-idb @noy-db/in-vue
```

## Setup

```ts
// main.ts
import { createApp } from 'vue'
import { createNoydb } from '@noy-db/hub'
import { NoydbPlugin } from '@noy-db/in-vue'
import { toBrowserIdb } from '@noy-db/to-browser-idb'
import App from './App.vue'

// Construct the instance yourself — the plugin PROVIDES it to components,
// it does not build one. `NoydbPluginOptions` has exactly one key.
const db = await createNoydb({
  store: toBrowserIdb({ obfuscate: true }),
  user: 'alice',
  secret: userSecret,
})

createApp(App).use(NoydbPlugin, { instance: db }).mount('#app')
```

## Composables

```vue
<script setup lang="ts">
import { useNoydb, useCollection, useSync } from '@noy-db/in-vue'

type Invoice = { id: string; amount: number; customer: string }

const db = useNoydb()   // the injected Noydb instance itself
const { data, loading, error, refresh } = useCollection<Invoice>(db, 'C101', 'invoices')
const { status, syncing, push, pull } = useSync(db, 'C101')
</script>

<template>
  <p v-if="loading">Loading…</p>
  <ul v-else>
    <li v-for="inv in data" :key="inv.id">{{ inv.customer }}: ฿{{ inv.amount }}</li>
  </ul>
</template>
```

Also exported: `useLiveQuery` (wrap a hub `LiveQuery` in reactive refs),
`useBlobURL`, `useMigrationState`, and `NoydbKey` (the injection key, for
`inject(NoydbKey)` outside the composable). Writes go through the instance:
`db.openVault(...)` → `vault.collection(...)` → `put`/`delete`.

## Biometric unlock (WebAuthn)

Biometric unlock is not this package's job — unlock primitives live in the
`on-*` family, and `@noy-db/on-webauthn` is framework-neutral, so it is called
from Vue code directly. It wraps the vault's DEK set under a passkey (PRF) and
hands back an unlocked keyring — the secret itself never round-trips.

Two calls do it: `enrollWebAuthn()` after a primary unlock, to enroll this
device's passkey (the enrollment it returns is safe to persist — it holds no
key material in the clear), and `unlockWebAuthn()` later, on another session,
to get the keyring back.

⛔ The signatures live with the package, not here. `@noy-db/on-webauthn` ships
from [noy-db/on](https://github.com/noy-db/on) on its own version line, so this
README cannot vouch for their shape — and a worked example here would be prose
this repo has no way to check. See that package's README.

## License

Apache-2.0 © vLannaAi — see the [noy-db repo](https://github.com/noy-db/core) for full documentation.
