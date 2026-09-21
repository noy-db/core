import { describe, it, expect } from 'vitest'
import * as shim from '../src/index.js'
import * as ports from '@noy-db/ports/on'

describe('@noy-db/test-ceremony-conformance is a faithful shim over @noy-db/ports/on', () => {
  it('re-exports exactly the subpath surface', () => {
    expect(Object.keys(shim).sort()).toEqual(Object.keys(ports).sort())
    for (const k of Object.keys(ports)) expect((shim as Record<string, unknown>)[k]).toBe((ports as Record<string, unknown>)[k])
  })
})
