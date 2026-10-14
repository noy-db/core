---
"@noy-db/hub": minor
---

**New: provision collection DEKs up front, so two devices cannot mint rival
keys for the same collection (family#191).**

```ts
// at open
const vault = await db.openVault('acme', { collections: ['invoices', 'clients'] })
// or explicitly, any time
await vault.provisionCollectionKeys(['invoices', 'clients'])
```

A collection's DEK was minted on its **first write**. Two devices with separate
local stores that each wrote the first record of an empty collection therefore
minted two different keys for it, and `persistKeyring`'s CAS could not help —
it reconciles two sessions over *one* store, and neither device can see the
other's.

⚠️ **The symptom was silent.** Measured on two devices with one remote: the
first device's record reaches the remote, the second device's pull does **not**
store it, and no rejection is logged. Nothing throws, nothing is recorded, and
`get()` answers `null` as though the record had never been written.

Provisioning needs no new replication: `_keyring` already replicates, so a DEK
that exists *before* any write travels on its own. The whole defect was timing.
`provisionCollectionKeys` is idempotent — a collection that already has a key
resolves to it — so calling it on every boot is correct. Entitlement is
unchanged: a caller not granted a collection is refused rather than given a key.

⚠️ **Three cases remain, and are documented on the API:**

1. an **undeclared** collection — its first write still mints;
2. a device that writes to a provisioned collection **before its first pull** —
   it has no keyring update yet, so it still mints a rival. This makes the key
   available early; it cannot make a device fetch it;
3. reserved lazily-minted DEKs (`_sync_credentials`, link stores), which appear
   on first use. Naming one is refused rather than silently accepted, since
   accepting it would imply a guarantee this cannot give.
