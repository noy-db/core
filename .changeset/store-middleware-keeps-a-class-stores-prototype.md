---
"@noy-db/hub": patch
---

with-store: middleware no longer drops a class store's prototype (family#173)

All six middlewares — `withRetry`, `withLogging`, `withMetrics`,
`withCircuitBreaker`, `withCache`, `withHealthCheck` — were built as
`{ ...next, get() {…} }`. A spread copies own enumerable properties only, so
wrapping a store implemented as a **class** dropped every prototype method the
middleware did not itself redeclare: `listPage`, `tx`, `getStoreTime`,
`listSince`, `ping`, `presignUrl`, `estimateUsage`.

Hub reads those by `typeof store.x === 'function'` to decide whether to
delegate, so the capability silently became absent and hub took its fallback
path. Nothing failed — a paging store simply stopped paging.

No store in `core`, `to` or `in` is class-based today, so the exposure is
third-party only, which is exactly why it survived: every suite in this repo
passes either way, and the defect lives in the one consumer no test here can
have. The new case supplies that fixture.

They now compose through one `overlay()` helper built over `next`, with `this`
bound to the wrapped store so a class store's `#private` fields keep working
(called with the proxy as receiver, a method touching `#field` throws "Cannot
read private member"), and forwarded methods cached so a method reference stays
stable.

`StoreMiddleware`'s own published example used to show the spread — it taught
the defect. It now shows the shape to use, and says why.
