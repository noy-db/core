---
'@noy-db/hub': patch
---

**`with-sync`: the broker seeds replicate right behind the roster** (#97). On a member's fresh device, a credential provider that asks the broker per request was refused for every reserved-collection read that ran ahead of `_broker_member` — the seed the device mints with was the last reserved row pulled. It is now second, so the only refusals left are the roster's own reads and the seed's fetch itself, which no ordering can serve; a bootstrap credential still covers those and the pre-open reads, as designed (#67).
