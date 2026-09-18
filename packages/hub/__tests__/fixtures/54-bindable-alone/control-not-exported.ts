/**
 * The non-vacuity control for #54 (see `54-ports-bindable-alone.test.ts`).
 *
 * Five imports of a name NO port exports. Every line must fail with TS2305,
 * naming its own subpath — which is what proves each port's program really
 * resolves that subpath's `.d.ts` rather than something permissive. Without
 * it, "all five fixtures compile" could mean the imports were never checked.
 *
 * ⛔ This file MUST NOT compile. If it ever goes green, the instrument is
 * broken, not the fixtures.
 */
import type { thisIsNotExportedByAnyPort as a } from '@noy-db/hub/to'
import type { thisIsNotExportedByAnyPort as b } from '@noy-db/hub/at'
import type { thisIsNotExportedByAnyPort as c } from '@noy-db/hub/as'
import type { thisIsNotExportedByAnyPort as d } from '@noy-db/hub/by'
import type { thisIsNotExportedByAnyPort as e } from '@noy-db/hub/on'

export type Control = [a, b, c, d, e]
