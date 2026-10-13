---
"@noy-db/hub": patch
---

sync: a diverged peer is refused at attach (family#178)

A device that attaches its sync peer with `attachSyncTarget` rather than the
construction-time `sync` option found no `_keyring` at open, self-provisioned a
brand-new owner keyring, and then diverged permanently. Measured on two devices:
device 2 could not read device 1's record, device 1 could not read device 2's,
each read only its own — **with no error anywhere**.

`attachSyncTarget` now compares this device's keyring for the user against the
peer's and **refuses** when they are different lineages, with an error naming
both supported paths.

**The trigger is a local write before the attach.** With no local write the
reserved-keyring mirror adopts the peer's keyring on the first pull and
everything works; once the device has written under its self-provisioned keyring
the mirror will not supersede it and the divergence sticks. A two-device test
without that write passes either way, so it is included and labelled as *not* a
control.

**It refuses rather than repairing.** Adopting the peer's keyring would discard
the local one, and every record the device already wrote is sealed under the
discarded DEKs — trading a visible divergence for silent data loss.

⚠️ The guard cannot live at first keyring access, which is where it belongs
conceptually: `vault()` throws unless the vault is already open, so
`attachSyncTarget` necessarily runs *after* `openVault` — and `openVault` is
where the self-provision happens. At that moment no peer is attached and none can
be consulted.

⚠️ Divergence is told from staleness by the **roster epoch**, not by the salt
alone. `rotateSecret` mints a fresh salt, so a peer that is merely behind
legitimately differs; a rotation advances the epoch while two independent first
boots both sit at the initial one. Refusing on a differing salt alone would have
turned the guard into a nuisance for every device that had not yet pulled a
rotation.

Registering a peer *before* the first open — the only remedy that makes the
consumer's intended code correct rather than refused — is left to family#179's
design.
