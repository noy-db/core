---
"@noy-db/hub": minor
---

pod: the export secret is always checked, against an export-shaped bar (family#177)

**Behaviour change.** `writePod({ exportSecret })` and every string
`recipients[].secret` must now be **at least 12 characters**, and are refused
otherwise. There is no opt-out. Previously they reached no strength check at
all — `assertStrongSecret` guards `createOwnerKeyring`, `grant` and
`rotateSecret`, and the export secret reached none of them — so a pod could be
re-keyed under a one-character secret. A `.noydb` bundle is the artefact most
likely to leave the machine, which made this the weakest secret in the system
guarding the most portable file.

**12 characters, any characters.** The owner bar is not merely stricter, it is
the wrong *shape*: its character class is `/^[a-z]+( [a-z]+)*$/`, so it refuses
the strongest things a caller is likely to use — a password-manager token fails
on `invalid-chars`, and `Tax-Returns-2026!` fails twice over. A phrase rule fits
a secret you memorise and retype; an export secret is typed once or generated.
Measured against the real secrets in this repo:

- **blocked** — `p`, `pw`, `pw1`, `r-pw`, `aud-pw`, `bob-pw`, `new-pw`,
  `alice-pw`, `hunter2`
- **allowed** — `Tax-Returns-2026!`, `8f3a9c2b1d4e7f0a`, `source-pw-2026`,
  `client-takeaway`, `correct horse battery staple`

A single repeated character is refused too: `aaaaaaaaaaaa` clears any length
floor and clears no attacker's wordlist. 12 is a floor, not an entropy claim —
roughly 40-50 bits for a human-chosen password against the owner phrase's ~77 —
sized to stop the hazard without blocking ordinary use, with PBKDF2 600K still
underneath.

**The asymmetry with the owner check is deliberate.** The owner secret is
validated only when a consumer opts in (`validateSecret: true`, never in managed
mode); this one is checked always. The owner secret guards a local vault behind
the host OS's protections; this one guards a file built to travel — mailed,
uploaded, left in a downloads folder — where the secret is all that stands
between an attacker and the plaintext.

**Every recipient, not just the shorthand.** Gating `exportSecret` alone would
have left the multi-recipient path ungated. Echo recipients keep
`assertStrongEchoSecret`, whose per-word floor is relaxed because echo secrets
are natural-language sentences — a length floor would reject the shape it exists
to accept.

⚠️ Four test files needed longer secrets, all of them carrying values like `pw`
or `r-pw`. An earlier draft of this change used the owner bar and required
sixteen edits across six files, two of which turned out to be unnecessary: one
was a `grant` secret this change never gates, and one was already 12 characters.
