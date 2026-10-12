---
"@noy-db/hub": patch
---

capsule: a capsule without the posture groups cannot hold a keyring (family#156)

`loadKeyring` and `createOwnerKeyring` refuse with `CapsuleNotSupportedError`
when the bound capsule declares neither `authenticate` nor `seal` — before the
keyring is read or written.

This is the third refusal point, and the one the earlier wiring could not
express: `authenticate` and `seal` are implied by no field form and no service,
because `deriveKey` (secret → KEK) and `wrapKey`/`unwrapKey` (KEK wraps DEK) are
called only from the keyring's unlock chain. What requires them is opening a
vault that *has* a keyring.

Guarded at the keyring entries rather than in `openVault`, for two reasons: the
entries are literally "before any keyring is read or written", and they also
cover `grant`, `rotateSecret` and recovery, which never go through `openVault`.

**A plaintext vault still opens**, and that gate is structural rather than a
written condition: `createNoydb({ encrypt: false })` short-circuits in
`_getKeyringInternal` to `createPlaintextKeyring()` and never reaches either
guarded entry. An unconditional refusal would read as stricter and would make
`@noy-db/exclave-plain` unable to open any vault at all, which is its entire
purpose — so the test asserts that direction first, and it would fail loudly if
the guard were ever hoisted into `openVault`.

One case asserts the store is untouched when the refusal fires. A capability
discovered after a keyring write is strictly worse than refusing: the bytes are
on disk and no capsule can unwrap them.
