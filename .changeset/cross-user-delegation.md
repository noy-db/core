---
'@noy-db/hub': minor
'@noy-db/exclave-plain': patch
---

**Cross-user delegation works: `vault.delegate()` to a member whose secret you do not know** (core#65).

`delegate()` wrapped the delegated tier DEK against the GRANTOR's own KEK, so a token addressed to anybody else could not be unwrapped by them — the read half reached it, failed, and skipped, silently and correctly. What worked was self-delegation, or a target sharing the issuing KEK. The per-target key exchange it was waiting for arrived as core#96's inbox key pair.

- A token now carries `sealedCek`: a per-token content key, RSA-OAEP-sealed to the target's inbox public half. `wrappedDek` / `wrappedDeks` are AES-KW-wrapped under that key exactly as they used to be under a KEK, so the slot NAMES stay readable to any member holding the `_delegations` DEK — an audit can enumerate what was delegated to whom without being able to use any of it. A token written before this still loads for a target that shares the issuing KEK, and is skipped for anyone else, as before.
- **`delegate()` refuses at issue** rather than writing a token nobody can open: `DelegationTargetMissingError` for a target with no keyring in the vault (it used to write one anyway), `MemberInboxMissingError` for a keyring that predates core#96.
- **The vault creator now carries an inbox key pair too.** `grant()` minted one for every grantee and `recoverUser()` re-mints it, but `createOwnerKeyring` did not — so nothing could be sealed TO an owner: not a delegation, not even to themselves, and not an `updateUser` delivery. Additive, and the pair's public half is bound into the roster tag like every other keyring's.
- **A grant mints the grantor's `_delegations` DEK when tiers are enabled**, the same shape as `_periods` (#1288). The envelope around a token is under that vault-wide DEK, which used to be minted lazily at the first `delegate()` call — so a member granted before that moment never received it and every delegation addressed to them was skipped, silently, because the read half returns `[]` rather than throwing when the DEK is absent.
- New capsule primitive `importWrappingKey` (raw 32 bytes → a non-extractable AES-KW key); `@noy-db/exclave-plain` refuses it with the rest of the seal group. `KeyringInboxBox` is exported from the root barrel — `KeyringFile.inbox` is published and used it without a nameable element type.
