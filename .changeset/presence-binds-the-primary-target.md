---
'@noy-db/hub': patch
---

**Presence binds the same sync target the record engine does** (core#139), and the WebAuthn enrolment example records `meta.rpId` (core#140).

Two selectors 70 lines apart in `openVault` read as though they meant the same thing and did not. The record-sync engine takes `targets.find(t => t.role === 'sync-peer') ?? targets[0]`; the vault's presence surface took `targets[0]` unconditionally. On `sync: [{ store: cloud, role: 'backup' }, { store: daemon, role: 'sync-peer' }]` records synced with the daemon while presence was published to — and polled back from — a push-only archive target. The failure was quiet: a presence write nobody reads back degrades, it does not throw. Both now use the primary target, and no test covered an array whose first entry was not a `sync-peer`; one does.

`db.team.enrollWebAuthn` does not construct slot `meta` — it validates `credentialId` and passes the caller's ceremony result through — so its JSDoc example is the de-facto contract for what a slot carries. It now shows `rpId`, because `on-webauthn`'s rewrap/rotation ceremony falls back to `meta.rpId` when the caller passes no `options.rpId`. No validation was added: `meta` stays open, and requiring a key would be a seam change for every existing caller.
