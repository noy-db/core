import { describe, it, expect } from 'vitest'
import * as shim from '../src/index.js'
import * as ports from '@noy-db/ports/as'

describe('@noy-db/test-format-conformance is a faithful shim over @noy-db/ports/as', () => {
  it('re-exports exactly the subpath surface', () => {
    expect(Object.keys(shim).sort()).toEqual(Object.keys(ports).sort())
    for (const k of Object.keys(ports)) expect((shim as Record<string, unknown>)[k]).toBe((ports as Record<string, unknown>)[k])
  })
})
