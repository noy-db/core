---
"@noy-db/hub": patch
---

portability: exportAccessibleData records the access it made (family#175)

The audit entry was appended **after** the bundle was built. A build that throws
part-way has already read the caller's accessible collections — and with `reKey`
decrypted them in-process to re-encrypt under the export secret — so an entry
written only on success reported "no export" for an access that happened. The
append now precedes the build.

The reason string is unchanged. A consumer greps `user-export:` out of the
ledger, so the entry's **meaning** moves from "completed" to "attempted" while
its shape does not. For a trail of data *access* that is the stronger reading of
the same event, and it is the argument family#151 made for `exportWith`.

⚠️ Narrower than family#151's case, and worth saying so: a bundle export produces
an encrypted pod rather than plaintext, so without `reKey` the failure may not
have decrypted anything. The read still happened.

⚠️ The order is asserted **structurally**, because the failure path could not be
reached from a fixture. A hostile store does not get there — by the time
`exportAccessible` runs the vault is hydrated, so `writePod` reads the decrypted
cache and the export succeeds — and a weak `reKey` secret is accepted, which is
a **separate finding**: `writePod` applies no strength gate to `exportSecret`, so
a pod can be re-keyed under a one-character secret. Reported, not fixed here.
