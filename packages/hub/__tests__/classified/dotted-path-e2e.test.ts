/**
 * #19 end-to-end — pilot-1's exact reproduction, against a real collection.
 *
 * ⚠️ WHY THIS EXISTS ALONGSIDE THE UNIT TEST. `dotted-path-refused.test.ts`
 * proves `resolveClassifiedFields` refuses. That is NOT the same claim as "the
 * product refuses": the guard only closes the leak if collection registration
 * actually routes through that function. It does — `kernel/collection-config.ts`
 * and `kernel/via/graph-wiring.ts` both call it — but "I read the call path" is
 * weaker evidence than running it, and the thing being protected here is a
 * plaintext secret.
 *
 * The first case is the reproduction from the report, verbatim in shape:
 * declare a nested path, and before this fix the write succeeded and the
 * password came back in full from `get()`.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { ClassifiedConfigError } from '../../src/via/classified/errors.js'
import { inlineMemory } from './harness.js'
import type { ClassifiedFieldSpec } from '../../src/via/classified/descriptor.js'

const secretSpec: ClassifiedFieldSpec = {
  _noydbClassified: true, preset: 'password', storage: 'recoverable',
  sensitivity: 'secret', list: { kind: 'omit' },
}

describe('#19 — declaring a nested classified field fails at construction', () => {
  it('refuses the collection outright instead of storing plaintext', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-s2-8' })
    const v = await db.openVault('v1')

    expect(() => v.collection<Record<string, unknown>>('clients', {
      classifiedFields: { 'account.password': secretSpec },
    })).toThrow(ClassifiedConfigError)
  })

  it('the equivalent top-level declaration still works — the control', async () => {
    // Without this, the case above would pass against a build that had broken
    // classified fields entirely.
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-8' })
    const v = await db.openVault('v1')
    const c = v.collection<Record<string, unknown>>('clients', {
      perRecordKeys: true,
      classifiedFields: { password: secretSpec },
    })

    await c.put('c1', { id: 'c1', username: 'user-1', password: 'not-a-real-secret-1' })

    // The property the report was relying on and did not get: the secret must
    // not be readable from the ordinary read path.
    const read = JSON.stringify(await c.get('c1'))
    expect(read).not.toContain('not-a-real-secret-1')

    // And it must not be sitting in the stored envelope in the clear either.
    const raw = JSON.stringify(store._dump('v1', 'clients', 'c1'))
    expect(raw).not.toContain('not-a-real-secret-1')
  })
})
