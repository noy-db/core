/**
 * **@noy-db/ports/as** — the `as-*` export/import gate,
 * published as an executable suite.
 *
 * The `as-*` family is the one place plaintext leaves the vault. Every export
 * is gated by `vault.assertCanExport(tier, format)` before producing anything,
 * and that call is the whole security boundary: a projection that skips it
 * hands out decrypted records to a caller the vault would have refused. The
 * import side is `vault.assertCanImport`, gating what may be planned INTO a
 * vault.
 *
 * ## Two entry-point shapes, one contract
 *
 * The 0.7 line inverted four formats: the entry point moved from a function
 * taking the vault as an ARGUMENT (`toString(vault, opts)`) to a METHOD ON the
 * vault (`vault.export(asCsv(), {})`). Both shapes carry the same obligation,
 * and this kit checks both with one mechanism — see the next section, because
 * getting that mechanism wrong is precisely how this kit went blind once.
 *
 * ## Gated is not the property. Gated BEFORE decrypting is.
 *
 * A gate called after `exportStream` has already run is a gate that refuses
 * the caller and decrypts anyway. So the suite asserts BOTH:
 *
 *   - every entry point REJECTS when the gate denies — and rejects with THIS
 *     KIT'S OWN ERROR, so the refusal is attributable to the gate rather than
 *     to a miswired fixture throwing something else; and
 *   - it rejects having read NOTHING — `exportStream` is never called.
 *
 * The second is the one a delegation refactor breaks silently: move the gate
 * downstream and every existing test still passes.
 *
 * ## Why the kit PATCHES THE INSTANCE, and no longer proxies it (#1209)
 *
 * The first version wrapped the vault in a `Proxy` whose `get` trap replaced
 * `assertCanExport`, forwarding calls with `value.apply(target, args)`. That
 * works when the entry point takes the vault as an argument — the package
 * calls `proxy.assertCanExport(...)` and the trap fires. It CANNOT work for a
 * method on the vault: `vault.export` runs with `this` bound to the real
 * object (`apply(receiver, …)` is not an option — `Vault` has private fields,
 * and a Proxy receiver breaks private-field access), so the gate it consults
 * is the unproxied one and the denial is silently bypassed. Both assertions
 * passed vacuously; nothing turned red.
 *
 * Patching own properties onto the REAL instance intercepts both shapes,
 * because property lookup happens at call time and an own property shadows the
 * prototype method — including for hub's own INTERNAL delegation
 * (`exportJSON()` calls `this.exportStream(...)`, which the Proxy never saw
 * and the patch does). Private fields keep working because it IS the real
 * object. The patch mutates the fixture's vault, which is why `vault()` must
 * build a fresh one per case — a requirement the fixture already carries.
 *
 * If hub ever routes its gate around `vault.assertCanExport` (say, by inlining
 * the capability check), this mechanism fails LOUD — the ungated call
 * succeeds, the denial test goes red — not silent. That is the acceptable
 * failure direction.
 *
 * ## What is observed, and what deliberately is not
 *
 * `exportStream` is the decrypting PRIMITIVE, and the only method recorded.
 * `vault.export` / `vault.import` are NOT recorded: under the inverted shape
 * they are the entry points themselves (and `download`/`write` call
 * `vault.export` internally), so recording them would fail every correct
 * inverted format spuriously. The first version also recorded a `snapshot`
 * method that `Vault` does not have — a guessed identifier, which is a query
 * that cannot falsify. The list is now exactly the primitives that exist.
 *
 * @packageDocumentation
 */
import { describe, it, expect } from 'vitest'
import type { Vault, ExportFormat, NoydbStore, ExportChunk } from '@noy-db/hub'

/** One plaintext-producing entry point, named as a consumer would call it. */
export interface FormatEntryPoint {
  /** Shown in the test title, e.g. `'toString'` or `'vault.export'`. */
  readonly name: string
  /** Call it against the supplied vault. Arguments are the fixture's business. */
  run(vault: Vault): Promise<unknown>
}

/** Everything an `as-*` package must supply to be checked against the gate. */
export interface FormatFixture {
  /**
   * The TIER the package passes to `assertCanExport`. The `as-*` family is
   * two capability classes, not one — discovered by wiring `as-noydb`, which
   * calls `assertCanExport('bundle')` and never mentions plaintext because it
   * emits an encrypted pod. A kit that assumed one tier would have made that
   * fixture describe itself wrongly while still passing.
   */
  readonly tier: 'plaintext' | 'bundle'
  /**
   * The format tag, e.g. `'csv'`. REQUIRED for the plaintext tier and
   * meaningless for `bundle` — hub itself throws when a plaintext check
   * arrives without one, so the pairing is asserted rather than assumed.
   */
  readonly format?: ExportFormat
  /**
   * A REAL vault with at least one record. Built fresh per case, so an entry
   * point that mutates it cannot leak into the next assertion — and because
   * the kit PATCHES the instance it is handed, reuse would leak the patch.
   *
   * For a format using the inverted shape (`vault.export(...)`), the vault
   * must be created with `formatsStrategy: withFormats()` — without it the
   * CAN-export guard fails with `FormatsNotEnabledError` before proving
   * anything about the fixture's grants.
   */
  vault(): Promise<Vault>
  /**
   * The same vault, plus the {@link ObservedStore} it was built on (#1211).
   *
   * REQUIRED. It is declared optional only so the type does not break a
   * consumer mid-upgrade; a fixture without it FAILS the before-reading case
   * with a migration message rather than silently falling back to the weaker
   * lexical observation. A silent fallback would let a package look conformant
   * while observed by the mechanism this replaces, with nothing in the output
   * saying which one ran.
   *
   * Wrap with `observeStore(...)` where the store is CREATED and pass the
   * result to `createNoydb` — a wrapper applied after the vault exists
   * intercepts nothing, because the vault captured its store at construction.
   */
  observableVault?(): Promise<{ vault: Vault; store: ObservedStore }>
  /**
   * EVERY plaintext-producing export entry point — not a representative one.
   * A format with four exports and one listed here reports a green suite for
   * the three nobody checked.
   */
  readonly exports: ReadonlyArray<FormatEntryPoint>
  /**
   * Import entry points (`vault.import(...)`, legacy `fromString`), gated by
   * `assertCanImport`. Optional because not every format decodes — but a
   * format that ships a `decode` and declares no imports here is reporting a
   * green suite for a gate nobody checked, and the suite says so out loud.
   *
   * The fixture's vault must hold an `importCapability` grant for the format,
   * or the denial case is unfalsifiable: the refusal arrives from the missing
   * grant rather than from the kit's denial, and nothing distinguishes that
   * from a working gate.
   */
  readonly imports?: ReadonlyArray<FormatEntryPoint>
  /**
   * The on-disk write path, if the package has one. It must refuse without
   * `acknowledgeRisks: true`; pass a call that OMITS the flag.
   *
   * The vault this receives is the fixture's own — NOT a denying one — and it
   * must be export-CAPABLE. A vault that would refuse the export anyway makes
   * the case unfalsifiable: the refusal arrives from the gate upstream and the
   * acknowledgement is never reached. That is not hypothetical; it is what the
   * first version of this kit did, and deleting the acknowledgement guard from
   * as-csv left the suite green.
   */
  writeWithoutAcknowledgement?: (vault: Vault, path: string) => Promise<unknown>
  /**
   * A SCOPED call and its unscoped twin, so the kit can check what the export
   * actually produced rather than only that the gate fired (core#43).
   *
   * ## What this exists to catch
   *
   * `as-csv`'s fixture called `download`/`write` with `collection` after the
   * option had been renamed to `collections`. **18 tests passed before the fix
   * and 18 after.** Every case in this kit asserts that the gate FIRED, and a
   * call with `collections: undefined` fires it exactly as well as a correct
   * one — so a fixture can drift into calling its own package wrongly and stay
   * green forever. Typechecking found that one; running it never would, at any
   * number of repetitions.
   *
   * ## Why it is observed at ENCODE and not at the store
   *
   * The first design asserted the scope at the store and was measured
   * impossible: `hub`'s port calls `exportStream()` unscoped and filters the
   * chunks afterwards (core#45), so `collections: ['invoices']` and
   * `collections: undefined` produce byte-identical store traffic. The filter
   * has run by the time `format.encode(chunks)` is called, which is why the
   * observation is taken there — the kit wraps the format's `encode` for the
   * duration of the call.
   *
   * ⚠️ **This therefore only sees an entry point that routes through
   * `vault.export`.** One that drives `exportStream` itself never reaches an
   * `encode` the kit can wrap, and the case FAILS saying so rather than
   * passing — an unobservable scope is not a satisfied one.
   *
   * ⭐ **`unscoped` is not redundant, it is the control.** A scope assertion
   * over a vault holding one collection passes whatever the call does. The kit
   * requires the unscoped twin to produce strictly MORE than {@link
   * FormatScopeCase.expected}, so there is something for the scope to exclude.
   */
  readonly scope?: FormatScopeCase
}

/** The scoped/unscoped pair — see {@link FormatFixture.scope}. */
export interface FormatScopeCase {
  /** Shown in the test title, e.g. `'toString'`. */
  readonly name: string
  /** The entry point called WITH its scope — the subject. */
  scoped(vault: Vault): Promise<unknown>
  /**
   * The collections `scoped` must produce — exactly, as a set. Not "at least":
   * a widened export is precisely the defect, so extras must fail.
   */
  readonly expected: readonly string[]
  /**
   * The SAME entry point with no scope — the control that proves the vault
   * holds more than {@link FormatScopeCase.expected}, so the case above can
   * fail.
   */
  unscoped(vault: Vault): Promise<unknown>
}

/**
 * Thrown by the kit's denial patch so a refusal is ATTRIBUTABLE to the gate.
 *
 * The denial tests match on this class, not on "it threw". A bare
 * `rejects.toThrow()` passes on any error — a miswired fixture raising
 * `TypeError`, a vault missing `withFormats()` — which is exactly the state a
 * brand-new fixture is most likely to be in. The first version of this kit
 * defined this class for that purpose and then never matched on it.
 */
export class ExportDeniedByConformanceKit extends Error {
  constructor(gate: 'export' | 'import', tier: string, format?: string) {
    super(`conformance: assertCan${gate === 'export' ? 'Export' : 'Import'} denied '${tier}'${format ? ` / '${format}'` : ''}`)
    this.name = 'ExportDeniedByConformanceKit'
  }
}

interface Observation {
  decryptCalls: string[]
}

/**
 * A `NoydbStore` that counts the reads passing through it (#1211).
 *
 * ## Why the kit owns this and the FIXTURE applies it
 *
 * §7 of the design left open whether the kit should wrap the fixture's store
 * or the fixture should hand back a pre-wrapped one. Building it settled the
 * question: **a wrapper applied after `vault()` returns intercepts nothing**,
 * because the vault captured its store at construction. So the wrapping has to
 * happen where the store is created — inside the fixture.
 *
 * The counting logic still lives HERE rather than in nine fixtures: a fixture
 * that miscounts would make its own package look conformant, which is the one
 * thing a shared kit exists to prevent. The fixture threads it; the kit owns
 * what it means.
 *
 * ## What is counted
 *
 * `get` and `list` only — the read surface an export must traverse to produce
 * plaintext. `put`/`delete`/`loadAll`/`saveAll` are untouched and unwrapped.
 */
export interface ObservedStore extends NoydbStore {
  /** Reads recorded since the last {@link ObservedStore.__resetReads}. */
  __reads(): number
  /** Zero the counter. The kit calls this to open its measurement window. */
  __resetReads(): void
}

/**
 * Wrap a store so the conformance kit can count reads through it.
 * Apply this where the store is CREATED, and pass the result to `createNoydb`.
 */
export function observeStore(inner: NoydbStore): ObservedStore {
  let reads = 0
  return {
    ...inner,
    get: (...args: Parameters<NoydbStore['get']>) => { reads += 1; return inner.get(...args) },
    list: (...args: Parameters<NoydbStore['list']>) => { reads += 1; return inner.list(...args) },
    __reads: () => reads,
    __resetReads: () => { reads = 0 },
  } as ObservedStore
}

/**
 * Patch a REAL vault in place: both gates deny with the kit's own error, and
 * the decrypting primitive is recorded. Returns the same instance.
 *
 * Own-property assignment shadows the prototype methods, so the patch fires
 * for the argument shape (`toString(vault)` → `vault.assertCanExport(...)`),
 * the inverted shape (`vault.export(...)` → `contextFor(this)` → property
 * lookup at call time), and hub's internal delegation (`exportJSON()` →
 * `this.exportStream(...)`).
 */
function denyGates(vault: Vault, tier: string, format: string | undefined, seen: Observation): Vault {
  const v = vault as unknown as Record<string, unknown>
  v['assertCanExport'] = () => {
    throw new ExportDeniedByConformanceKit('export', tier, format)
  }
  v['assertCanImport'] = () => {
    throw new ExportDeniedByConformanceKit('import', tier, format)
  }
  const realStream = (vault.exportStream as (...a: unknown[]) => unknown).bind(vault)
  v['exportStream'] = (...args: unknown[]) => {
    seen.decryptCalls.push('exportStream')
    return realStream(...args)
  }
  return vault
}

/**
 * Patch a REAL vault in place so every `vault.export` records the collections
 * the format's `encode` actually receives (core#43). Returns the recorder.
 *
 * The format object is not replaced, it is SHADOWED for one call: a delegate
 * carrying the same own properties, with `encode` wrapped. Hub reads `id` and
 * `tier` off it and passes it nowhere else, so the delegate is
 * indistinguishable to the port — and the real `encode` still produces the
 * real output, because a kit that changed what an export returns would be
 * testing itself.
 *
 * ⚠️ Own-property assignment for the same reason `denyGates` uses it: the
 * inverted entry point IS `vault.export`, and `download`/`write` reach it
 * through `this`. A Proxy cannot intercept either (private fields), which is
 * the trap #1209 already paid for.
 */
function recordExportScope(vault: Vault): { calls: string[][] } {
  const calls: string[][] = []
  const v = vault as unknown as Record<string, unknown>
  const realExport = (vault.export as (...a: unknown[]) => unknown).bind(vault)
  v['export'] = (format: Record<string, unknown>, ...rest: unknown[]) => {
    const encode = format['encode'] as (chunks: readonly ExportChunk[]) => unknown
    const delegate = {
      ...format,
      encode: (chunks: readonly ExportChunk[]) => {
        calls.push(chunks.map((c) => c.collection))
        return encode.call(format, chunks)
      },
    }
    return realExport(delegate, ...rest)
  }
  return { calls }
}

/**
 * The collections one call produced, as a sorted set.
 *
 * ⛔ Reads the LAST `encode`, not a union across calls. An entry point that
 * exports twice (a pod writing two members, say) would otherwise report the
 * union as one export's scope and pass a widened call.
 */
function scopeOf(recorder: { calls: string[][] }, entry: string): string[] {
  const last = recorder.calls.at(-1)
  expect(
    last,
    `${entry}: no format.encode was reached, so the export's scope is UNOBSERVABLE here. `
      + 'The kit wraps `encode` through `vault.export`; an entry point that drives `exportStream` '
      + 'itself never reaches one. Route it through vault.export, or drop `scope` from the fixture '
      + 'and accept that the case is unchecked (the suite will say so).',
  ).toBeDefined()
  return [...new Set(last)].sort()
}

/**
 * Run the shared `as-*` gate contract against one format.
 *
 * @param name - shown in the suite title, e.g. `'as-csv'`.
 */
export function runFormatConformanceTests(name: string, fixture: FormatFixture): void {
  describe(`${name} — as-* export gate conformance`, () => {
    it('declares a tier, and a format iff the tier needs one', () => {
      // Hub throws on `assertCanExport('plaintext')` with no format, so a
      // fixture in that state describes a call the package cannot be making.
      if (fixture.tier === 'plaintext') {
        expect(fixture.format, 'the plaintext tier requires a format').toBeTruthy()
      } else {
        expect(fixture.format, `the '${fixture.tier}' tier takes no format`).toBeUndefined()
      }
    })

    it('declares at least one export entry point', () => {
      // A fixture with an empty list would pass every case below without
      // running anything — a live suite iterating an empty array.
      expect(fixture.exports.length).toBeGreaterThan(0)
    })

    for (const entry of fixture.exports) {
      it(`${entry.name}: SUCCEEDS on an ungated vault — otherwise its refusal below is free`, async () => {
        // Per ENTRY, not only exports[0]: a refusal is only evidence when the
        // same call would otherwise succeed, and each entry point can be
        // miswired independently. A fixture whose `format` tag does not match
        // what the package passes — or which forgets the exportCapability
        // grant, or omits `formatsStrategy: withFormats()` on an inverted
        // vault — makes the denial pass by refusing for the wrong reason.
        const vault = await fixture.vault()
        // `toSatisfy(() => true)`, not `toBeDefined()`: `download`/`write`
        // return Promise<void>, and their resolved value is legitimately
        // undefined. The assertion is "it RESOLVES" — the guard is about the
        // call not refusing, not about what it returns. (Found the moment this
        // guard went per-entry; the old exports[0]-only guard happened to
        // always land on a value-returning entry.)
        await expect(
          entry.run(vault),
          `${entry.name} failed on an ungated vault — check the \`format\` tag, the exportCapability grant, and (for vault.export entries) formatsStrategy: withFormats()`,
        ).resolves.toSatisfy(() => true)
      })

      it(`${entry.name}: REFUSES when assertCanExport denies — with the KIT'S error`, async () => {
        const seen: Observation = { decryptCalls: [] }
        const vault = denyGates(await fixture.vault(), fixture.tier, fixture.format, seen)
        // Matched on the class: a bare toThrow() passes on ANY error, which
        // makes a miswired fixture indistinguishable from a working gate.
        await expect(entry.run(vault)).rejects.toThrow(ExportDeniedByConformanceKit)
      })

      it(`${entry.name}: refuses BEFORE reading any record — observed at the STORE`, async () => {
        // #1211. The observation is STRUCTURAL: it counts reads leaving the
        // store, not calls to a named vault method. A store cannot be bypassed
        // by an API reshape — every record any entry point produces is bytes
        // read from it — whereas #1209 happened precisely because a reshape
        // moved the gate out of the place the observer was looking.
        //
        // No silent fallback: a fixture without `observableVault` FAILS here.
        // Reverting to the lexical observation would let a package look
        // conformant while watched by the weaker mechanism, with nothing in
        // the output saying which one ran.
        expect(
          fixture.observableVault,
          `${entry.name}: fixture must supply observableVault() — wrap the store with observeStore() `
          + 'where it is CREATED and return it alongside the vault (#1211). A wrapper applied after '
          + 'the vault exists intercepts nothing.',
        ).toBeTypeOf('function')

        const built = await fixture.observableVault!()
        const vault = denyGates(built.vault, fixture.tier, fixture.format, { decryptCalls: [] })

        // The WINDOW opens here, after vault construction. Store reads happen
        // at openVault (keyring, fence) before any export runs, so a total
        // count would pass on those alone — i.e. on an export that did
        // nothing. Counting only across the call makes the false pass require
        // a read CAUSED BY the call.
        built.store.__resetReads()
        await expect(entry.run(vault)).rejects.toThrow(ExportDeniedByConformanceKit)
        expect(
          built.store.__reads(),
          `${entry.name} read from the store before the export gate refused`,
        ).toBe(0)
      })

      it(`${entry.name}: the ungated call DOES read the store — the control for the case above`, async () => {
        // Without this, `reads === 0` above is satisfied by an export served
        // from a warm cache, or by an entry point that reads nothing at all —
        // both indistinguishable from "the gate refused first". This is the
        // trap an adversarial harness elsewhere in this family hit: reads
        // through an already-used vault came from cache and never reached the
        // store, so the harness proved nothing while appearing to validate the
        // product's central claim.
        const built = await fixture.observableVault!()
        built.store.__resetReads()
        await entry.run(built.vault)
        expect(
          built.store.__reads(),
          `${entry.name} produced output without reading the store — the refusal case above cannot `
          + 'distinguish a working gate from an entry point that reads nothing',
        ).toBeGreaterThan(0)
      })
    }

    const scope = fixture.scope
    if (!scope) {
      it('scope: SKIPPED — fixture declares no scoped call, so WHAT was exported is UNVERIFIED here', () => {
        // Passes loudly, like the import and write skips above. Every other
        // case in this suite fires on the GATE; without a scope case, a
        // fixture calling its own package with a renamed or misspelled option
        // is indistinguishable from a correct one (core#43).
        expect(scope).toBeUndefined()
      })
    } else {
      it(`${scope.name}: the UNSCOPED call exports MORE than the scope — the control`, async () => {
        // Without this, the case below passes on a vault holding exactly the
        // expected collections, where no call could ever be wrong. The control
        // is what makes "exactly the scope" a claim rather than a coincidence.
        const vault = await fixture.vault()
        const rec = recordExportScope(vault)
        await scope.unscoped(vault)
        const all = scopeOf(rec, scope.name)
        const expected = [...new Set(scope.expected)].sort()
        expect(
          all.length,
          `${scope.name}: the unscoped call exported ${JSON.stringify(all)}, which is not more than `
            + `the declared scope ${JSON.stringify(expected)}. Seed the fixture's vault with a `
            + 'collection the scope EXCLUDES, or the scope case cannot fail.',
        ).toBeGreaterThan(expected.length)
        for (const c of expected) expect(all).toContain(c)
      })

      it(`${scope.name}: the SCOPED call exports EXACTLY its scope — not merely gated`, async () => {
        // The assertion #43 asks for, taken at the encode boundary because the
        // store cannot distinguish the two calls (core#45). A fixture that
        // passes `collection` where the package now reads `collections` lands
        // here with every collection in the chunk list.
        const vault = await fixture.vault()
        const rec = recordExportScope(vault)
        await scope.scoped(vault)
        expect(
          scopeOf(rec, scope.name),
          `${scope.name}: the scoped call did not export its declared scope. An option the package `
            + 'no longer reads is silently dropped, and the export widens to everything.',
        ).toEqual([...new Set(scope.expected)].sort())
      })
    }

    const importEntries = fixture.imports ?? []
    const importTitle = importEntries.length
      ? null
      : 'imports: SKIPPED — fixture declares none, so the assertCanImport gate is UNVERIFIED here'
    if (importTitle) {
      it(importTitle, () => {
        // Passes loudly. A format that ships a `decode` and declares no import
        // entries is leaving a gate unchecked, and the output should say so
        // rather than staying quiet — a documented absence, not a hole.
        expect(importEntries).toEqual([])
      })
    }

    for (const entry of importEntries) {
      it(`${entry.name}: SUCCEEDS on an ungated vault — otherwise its refusal below is free`, async () => {
        // Same falsifiability requirement as the export side: without an
        // importCapability grant the denial case refuses for the wrong reason.
        const vault = await fixture.vault()
        await expect(
          entry.run(vault),
          `${entry.name} failed on an ungated vault — check the importCapability grant`,
        ).resolves.toSatisfy(() => true)
      })

      it(`${entry.name}: REFUSES when assertCanImport denies — with the KIT'S error`, async () => {
        const seen: Observation = { decryptCalls: [] }
        const vault = denyGates(await fixture.vault(), fixture.tier, fixture.format, seen)
        await expect(entry.run(vault)).rejects.toThrow(ExportDeniedByConformanceKit)
      })

      it(`${entry.name}: refuses BEFORE reading any record`, async () => {
        // Import planning READS the vault to diff against it (`diffVault`
        // routes through `exportStream`), so a gate moved after the plan
        // decrypts before refusing — the same silent break as the export side.
        const seen: Observation = { decryptCalls: [] }
        const vault = denyGates(await fixture.vault(), fixture.tier, fixture.format, seen)
        await expect(entry.run(vault)).rejects.toThrow(ExportDeniedByConformanceKit)
        expect(
          seen.decryptCalls,
          `${entry.name} read records before the import gate refused`,
        ).toEqual([])
      })
    }

    const writeTitle = fixture.writeWithoutAcknowledgement
      ? 'write: REFUSES without acknowledgeRisks'
      : 'write: SKIPPED — fixture declares no acknowledgement case, so the plaintext-on-disk gate is UNVERIFIED here'

    it(writeTitle, async () => {
      const write = fixture.writeWithoutAcknowledgement
      if (!write) {
        // Passes loudly. Omitting the case would make an unchecked security
        // gate indistinguishable from a checked one in the output.
        expect(write).toBeUndefined()
        return
      }
      const vault = await fixture.vault()
      // Matched on the MESSAGE, not merely on "it threw". `rejects.toThrow()`
      // alone passes when the export gate refuses first — which is exactly
      // what happened here before this line existed, and it made the case
      // unable to fail. The flag name is the one string every such message
      // contains by construction.
      await expect(write(vault, '/tmp/conformance-should-not-exist')).rejects.toThrow(
        /acknowledgeRisks/i,
      )
    })
  })
}
