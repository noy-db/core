---
"@noy-db/hub": minor
---

pod: `exportSecret` and every recipient secret are strength-gated (family#177)

**Behaviour change.** `writePod({ exportSecret })` and every
`recipients[].secret` now pass `assertStrongSecret` (or
`assertStrongEchoSecret` for echo parts) and are **refused** when they fail.
Previously they reached no strength check at all: `assertStrongSecret` guarded
`createOwnerKeyring`, `grant` and `rotateSecret`, and the export secret reached
none of them — so a pod could be re-keyed under a one-character secret. A
`.noydb` bundle is the artefact most likely to leave the machine, which made
this the weakest secret in the system guarding the most portable file.

Pass `allowWeakSecret: true` to bypass, the same hatch and the same meaning as
`createOwnerKeyring`'s: intended for fixtures, CLI scripts and dev
environments, and it never loosens the key derivation — only the structural
check.

**Every recipient, not just the shorthand.** Gating `exportSecret` alone would
have left the multi-recipient path — the one used to hand a bundle to several
people — ungated.

⚠️ The default policy is a **six-word passphrase** (`DEFAULT_MIN_WORDS = 6`,
each word ≥3 characters), so an export secret that worked before may now be
refused. Sixteen tests in this repo needed stronger secrets, across five files
that model real consumer flows — the honest measure of the blast radius.

⚠️ Precedence, because it is observable: this gate runs **before** the
duplicate-recipient-id check, which lives in `buildBundleRecipientKeyrings`. A
request that is wrong in both ways reports the weak secret first. That is the
useful order — the secrets must be fixed either way — and hoisting the id check
would put one rule in two places.
