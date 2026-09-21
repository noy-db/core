---
'@noy-db/hub': minor
---

**Member-scoped broker credentials: every role can now mint its own cloud-store credentials, and the host can scope them by role** (core#73).

Before: the credential broker was one shared key per vault, usable by owner/admin only — `credentialSource()` refused every other role and `grant()` withheld the seed's DEK from them — and the proof carried no identity, so the host could not tell users apart. A member device had no way to reach a brokered cloud store.

Now:

- **`grant()` mints a per-grantee `_broker_member` DEK** for every sub-admin role (unconditionally — a DEK can only be wrapped at grant time). When a broker is configured, the kernel then **enrols the member**: a per-member seed sealed under that DEK, registered with the host as `POST /enroll { vaultId, brokerId, userId, role, proofKey }`. Owner/admin keep the shared seed.
- **A member proves with canonical v2** (`noydb-broker-proof-v2`): `userId` and `role` sit inside the MAC, the HKDF info is domain-separated per user, and the host verifies against the record IT registered — a member cannot borrow another user's key or claim a wider role. The admin canonical v1 is byte-for-byte unchanged.
- **Re-grant re-enrols** (new key, new role; the host record is replaced). **`revoke()` de-registers**: `POST /revoke { vaultId, brokerId, userId }` and the record is dropped. A session still holding a superseded enrolment gets `BrokerEnrolmentError` naming the re-grant, not `TamperedError`.
- `BrokerStrategy` gains `enrolMember()` / `revokeMember()`; `NO_BROKER` implements both as no-ops so `grant()`/`revoke()` keep working without a broker. `@noy-db/hub/broker` exports `BrokerMemberIdentity`; `VerifyBrokerProofArgs` gains `member`.

**Host contract, additive:** `/enroll` and `/credentials` bodies may carry `userId` + `role`; `/revoke` is new; `verifyBrokerProof({ member })` selects v2. A host that ignores `userId` keeps working for admins and refuses members (no registered member key) — never accepts them by accident.

**Existing members** (granted before this) hold no member enrolment until the owner re-grants them; `credentialSource()` says so by name. `_broker_member` is secret-bearing: never served by `vault.collection()`, never held by the grantor.
