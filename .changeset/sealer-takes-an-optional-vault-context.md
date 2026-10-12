---
"@noy-db/hub": minor
"@noy-db/ports": minor
---

**`NoydbSealer.seal` / `.unseal` now take an optional `SealContext`** — additive, so every existing provider keeps working unchanged. The new type is exported from the root barrel and from `@noy-db/hub/at`:

```ts
interface SealContext { readonly vault: string }
seal(secret: Uint8Array, ctx?: SealContext): Promise<Uint8Array>
unseal(sealed: Uint8Array, ctx?: SealContext): Promise<Uint8Array>
```

A provider can now scope key material per vault — a KMS encryption context, a per-vault keychain account, a key-id suffix — instead of holding one key for every vault it serves. Hub passes the same context to the paired `unseal`, so a provider that scopes can always reverse its own output.

⛔ **Hub does not pass it everywhere, and the exception is part of the contract.** A pod's auto-unlock credentials are sealed with **no** context, because a pod is a portable bundle: `ReadPodOptions` carries no vault, so the reader may open it into a differently-named vault or merely inspect it with none at all. A provider that bound those bytes to a vault name would mint a credential only the originating vault could open.

So the rule for a provider author is the asymmetry itself: **context present means "these bytes stay in this vault", context absent means "these bytes are meant to travel"** — and a provider MUST stay functional when it is absent, never treating absence as an error. `@noy-db/ports/at` asserts both halves.
