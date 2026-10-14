---
"@noy-db/hub": patch
---

**`recoverSecret` now tells you which collections it could not restore
(family#219).** A recovery entry wraps a *snapshot* of the DEK set taken when
the credential was enrolled, so any collection created afterwards is absent
from it — and recovery rebuilt the keyring from that snapshot alone. The
collection became unreadable, with no indication that anything had been lost.

`RecoverSecretResult` gains `uncoveredCollections: readonly string[]`. Empty
means coverage was complete. **Non-empty means data is now unreachable** — not
that the call failed; recovery succeeded for everything it covered.

⚠️ **This reports the gap; it does not close it.** Those DEKs exist only
wrapped under the old KEK, derived from the secret the user has just lost, so
this path cannot restore them at all. Covering future DEKs has to happen when
they are minted, and every way of doing that touches a stored format — which is
a separate, ruled decision (family#219 (a)/(b)). Note also that auto-rotated
replacement codes are minted from the set recovery *restored*, so a fresh sheet
inherits reduced coverage rather than repairing it.

The `NoAccessError` raised when reading such a collection also changed. It
previously named only one cause ("created AFTER their grant") and offered one
remedy — "re-grant the user to give them the key". For a vault **owner** that
is impossible advice, since they are the grantor, and it points away from the
real cause. It now names the recovery cause, cites the field above, and does
not tell an owner to re-grant themselves.
