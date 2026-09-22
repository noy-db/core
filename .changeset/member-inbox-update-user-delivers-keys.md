---
'@noy-db/hub': minor
'@noy-db/exclave-plain': patch
---

**`updateUser` changes what an existing member may do — without their secret** (core#96).

Before: a DEK could reach a member only at a write under their KEK, so `grant()` was the one widening path, and it re-keys the member from `options.secret` — after `acceptInvite` or `rotateSecret` an owner never holds that, and a re-grant with a stale one locked the member out (`InvalidKeyError`). `updateUser` was a plaintext-header swap that could name a collection the member had no key for.

Now every grantee's keyring carries an **inbox key pair** (`KeyringFile.inbox_key`: SPKI public half plaintext and roster-tag-bound; PKCS#8 private half sealed under an AES key in `deks['_inbox_key']`, which only the member's KEK unwraps). `updateUser` computes the DEK set a fresh grant would give the new role + permissions — the same rule, now shared (`selectGranteeDekNames`) — and:

- **delivers** what the member lacks through `KeyringFile.inbox`: a fresh CEK RSA-OAEP-wrapped to the public half, the DEK set AES-GCM under it; `slots` (the names) are tag-bound so `revoke` cannot be hidden from them. The member's next tier-1 unlock drains it into their own `deks` and re-persists (an open session drains at its next pull, core#82). A revoked admin holds nothing that opens a box sealed after the revocation — the private half never left the member's file.
- **drops and rotates** what the member no longer qualifies for, as a narrowing `grant` does (#1097). ⚠️ Behaviour change: a permissions narrowing through `updateUser` used to leave the DEKs in the member's file.
- **re-registers** a sub-admin whose role moved with a configured broker host (fresh `_broker_member` DEK via the inbox; a promotion to owner/admin de-registers).

`peer-recover` folds a pending delivery into the recovered file and mints a fresh pair. A keyring written before this cannot be amended (`MemberInboxMissingError`, new, root barrel) — re-grant it once with a fresh temporary secret. Members who unlock only through a tier-2 slot (`on-password`'s wrapped-DEK blob) see a delivery at their next tier-1 open. Capsule: `exportRecipientPrivateKeyPkcs8` / `importRecipientKeyPair` (additive, golden updated). `@noy-db/exclave-plain` refuses both, as it refuses the whole recipient group.
