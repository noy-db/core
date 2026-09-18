---
'@noy-db/hub': minor
---

**`@noy-db/hub/on` now carries the echo ceremony — both halves, so a player can bind the seam alone** (core#41, ruled on noy-db/family#29).

**Added to `/on`, by name:**

- types `EchoCeremony`, `BeginEchoUnlockOptions`
- value `beginEchoUnlock`
- errors `EchoCeremonyRequiredError`, `WrongPromptError`, `WrongEchoError`

All six were already exported from the root barrel and remain there — **this is additive, nothing moved and nothing was removed.** `instanceof` holds across both entries: the build runs `splitting: true` so the shared module becomes one chunk with one class definition, which is exactly the case that flag protects.

### Why it is worth a release note rather than a line

`/on` exists so a third-party unlock method can name a ceremony signature without importing the whole library. For the **slot rewrap** ceremony it did that. For the **echo** ceremony it did not: the types lived on the root barrel alone, so an app driving the anti-phishing unlock flow had `import '@noy-db/hub'` on its list either way and the seam removed nothing.

⛔ **The half-fix would have looked complete.** Exporting the two types alone leaves `beginEchoUnlock` — the only way to *obtain* an `EchoCeremony` — root-barrel-only, so the type is nameable from `/on` and unusable from `/on`. The freeze test now asserts the pair (`__tests__/on-surface-golden.test.ts`, *"is bindable ALONE"*), because freezing the type list by itself passed throughout the defect.

### One thing this does NOT change

`/on` held zero value exports until now. That read like a charter and was an accident of what the 0.8 extraction happened to need — `/to` exports four values, `/at` two, `/as` and `/by` one each. The subpath's documented charter is now stated in its own header: **contracts an unlock method implements AND the API an unlock player calls.** A method implementer who never drives a ceremony still catches none of these three errors; they are the player's.
