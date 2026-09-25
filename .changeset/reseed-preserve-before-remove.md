---
'@noy-db/hub': patch
---

**`KeyringTamperedError`'s re-seed guidance leads with PRESERVE (core#143).** The message told the reader to *remove the vault from this device first*. That is safe on a local store — a hostile local store means the device is already owned — but on a **remote, separately administered** store (a peer store, a relay, a hosted mount) the identical error can mean the store altered the keyring, and deleting the local copy destroys the only evidence. On a thin client there is nothing local to remove at all.

The remedy now leads with preserving a copy of the raw store contents, and names the remote case explicitly. ⭐ Deliberately **not** conditioned on the store: the branch that most needs the warning is the one hub cannot classify. Note it applied to `format-superseded` too — the one reason hub is *confident* is benign still carried the delete instruction.

No behaviour change; wording and one test whose property is now the ORDER of the two instructions.
