/**
 * core#97 — a member's fresh device with a credential provider that asks the
 * broker per request (pilot-1's bootstrap shape): the device's OWN mint cannot
 * succeed until `_broker_member/<userId>` has been pulled, so the seed must
 * travel right behind the roster. Measured before the reorder: 11 refused
 * mints on `memoryStore()` (every reserved-phase request); the bound below is
 * the roster's own reads plus the seed's list + get.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryStore } from '../src/index.js'
import { BrokerEnrolmentError } from '../src/with-party/broker/index.js'
import { withSync } from '../src/with-sync/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { withBroker } from '../src/with-party/broker/index.js'
import { makeTestHost, type TestHost } from './broker/support.js'
import type { NoydbStore } from '../src/kernel/types.js'

const S = 'correct horse battery staple'
const U = 'user-pass-long-enough'
const ENDPOINT = 'https://broker.example.com'
type Inv = { n: number }

function open(store: NoydbStore, remote: NoydbStore, user: string, secret: string, host: TestHost, attested = true) {
  return createNoydb({
    store, sync: remote, user, secret, validateSecret: false,
    syncStrategy: withSync(), teamStrategy: withTeam(),
    brokerStrategy: withBroker({ brokerId: 'b1', endpoint: ENDPOINT, fetch: host.fetch, ...(attested ? { attestation: () => 'dev-token' } : {}) }),
  })
}

describe('core#97 — the member seed travels right behind the roster', () => {
  it('a per-request own-mint hook is refused only for the roster reads and the seed fetch itself, then serves every record', async () => {
    const host = makeTestHost({ requireAttestation: true })
    const raw = memoryStore()
    const dbO = await open(memoryStore(), raw, 'owner', S, host)
    const vO = await dbO.openVault('firm')
    await vO.broker().enroll()
    for (let i = 0; i < 30; i++) await vO.collection<Inv>('invoices').put(`inv-${i}`, { n: i })
    await dbO.grant('firm', { userId: 'u1', displayName: 'U', role: 'operator', secret: U, permissions: { invoices: 'rw' } })
    await dbO.push('firm')

    let hook: (() => Promise<unknown>) | undefined
    const refused: string[] = []
    const served: string[] = []
    const wrapped = new Proxy(raw, {
      get(target, key: keyof NoydbStore) {
        const method = target[key]
        if (typeof method !== 'function') return method
        return async (...args: unknown[]) => {
          if (hook) {
            try { await hook(); served.push(`${String(key)} ${String(args[1])}`) }
            catch (e) { if (!(e instanceof BrokerEnrolmentError)) throw e; refused.push(`${String(key)} ${String(args[1])}`) }
          }
          return (method as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    })
    const dbU = await open(memoryStore(), wrapped, 'u1', U, host, false)
    const vU = await dbU.openVault('firm')
    hook = vU.broker().credentialSource()
    const r = await dbU.pull('firm')
    expect(r).toMatchObject({ pulled: 30, errors: [] })
    // roster list + owner get + own get, then the seed's own list + get — nothing after it
    expect(refused).toEqual(['list _keyring', 'get _keyring', 'get _keyring', 'list _broker_member', 'get _broker_member'])
    expect(served.length).toBeGreaterThan(0)
    expect(served[0]).toBe('list _broker')
  })
})
