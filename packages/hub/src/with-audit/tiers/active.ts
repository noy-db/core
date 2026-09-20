/**
 * Enable the hierarchical-tiers capability.
 * Pass to `createNoydb({ tiersStrategy: withTiers() })` to make a collection's
 * `putAtTier` / `getAtTier` / `listAtTier` / `elevate` / `demote` methods live.
 * The tier read/write/re-key engine is dynamically imported here, so it stays
 * out of the floor bundle until opted in.
 */
import type { TiersStrategy } from './strategy.js'

export function withTiers(): TiersStrategy {
  return {
    async putAtTier(ctx, id, record, tier, opts) {
      const { putAtTier } = await import('./index.js')
      return putAtTier(ctx, id, record, tier, opts)
    },
    async getAtTier(ctx, id) {
      const { getAtTier } = await import('./index.js')
      return getAtTier(ctx, id)
    },
    async listAtTier(ctx) {
      const { listAtTier } = await import('./index.js')
      return listAtTier(ctx)
    },
    async elevate(ctx, id, toTier) {
      const { elevate } = await import('./index.js')
      return elevate(ctx, id, toTier)
    },
    async demote(ctx, id, toTier) {
      const { demote } = await import('./index.js')
      return demote(ctx, id, toTier)
    },
    async checkUnique(ctx, id, record) {
      // Skip the dynamic import entirely on the overwhelmingly common case:
      // a tiered collection with no `unique` index declared.
      if (!ctx.uniqueKeys) return
      const { checkUniqueAcrossTiers } = await import('./index.js')
      return checkUniqueAcrossTiers(ctx, id, record)
    },
    async refreshDelegations(ctx, now) {
      const { loadActiveDelegations, DELEGATIONS_COLLECTION } =
        await import('../../with-party/team/delegation.js')

      // Nothing written: no DEK lookup, no keyring mutation, no mint. This is
      // what makes calling it on every vault open cheap.
      const ids = await ctx.adapter.list(ctx.vault, DELEGATIONS_COLLECTION)
      if (ids.length === 0) return []

      // ⛔ Deliberately NOT `getDEK`. That MINTS a DEK when absent and persists
      // the keyring — a write on a read path — and on a vault whose shared
      // `_delegations` DEK this user does not hold it would mint a WRONG one and
      // then fail to decrypt every token under it. No key, no read.
      const delegationsDek = ctx.keyring.deks.get(DELEGATIONS_COLLECTION)
      if (!delegationsDek) return []

      return loadActiveDelegations(ctx.adapter, ctx.vault, ctx.keyring, delegationsDek, now)
    },
  }
}
