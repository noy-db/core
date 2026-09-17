/**
 * Formats strategy seam — the service half of the `as-*` port.
 *
 * `/as` publishes the {@link NoydbFormat} contract a format implements; this
 * is what CONSUMES it. `vault.export(fmt)` gates, reads, redacts and calls
 * `encode`; `vault.import(fmt, input)` gates, decodes and plans.
 *
 * Opt-in, not kernel. `vault.ts` had room under its ceiling, but "lean hub"
 * is preserved by making a vault that never exports ship none of this — the
 * same trade every other `with-*` service makes.
 *
 * Core imports `FormatsStrategy` type-only and `NO_FORMATS` as the default, so
 * the spine never statically reaches the implementation.
 *
 * @internal
 */
import type { NoydbFormat, ImportPlan, ImportPolicy } from '../as/types.js'

// Re-exported so the kernel spine can name these WITHOUT importing `port/as/`
// directly — `port-layering` allows the spine to reach `port/with/` and
// nothing else, and the strategy seam is the sanctioned bridge. Same shape as
// blob-strategy.ts re-exporting what Collection needs.
export type { NoydbFormat, ImportPlan, ImportPolicy }
import type { ExportChunk } from '../../kernel/types.js'
import type { Vault } from '../../kernel/vault.js'

/** Options common to an export. */
export interface FormatExportOptions {
  /**
   * Export only these collections. Omitted: everything the caller can read.
   *
   * ⭐ **This narrows the READ** — the excluded collections are neither
   * fetched nor decrypted (core#45b, since 0.8).
   *
   * ⚠️ It did not always. Through 0.7 this filtered the chunks AFTER hub had
   * decrypted the whole vault, and the JSDoc here said so: scoping an export
   * bought output shaping and no reduction in what a compromised process
   * could observe. If you are reading a version of this note that still says
   * that, you are reading 0.7's. The narrowing is asserted by observing the
   * store, because no assertion on the returned chunks can tell the two
   * implementations apart.
   */
  readonly collections?: readonly string[]
  /**
   * Redact before `encode` sees a record. Hub applies the projection, so a
   * format never needs the vault to know what is sensitive — which is what
   * lets {@link NoydbFormat} be pure.
   */
  readonly redact?: true | { readonly sensitivity?: string }
}

/** Options for an import. */
export interface FormatImportOptions {
  /** Target collection, for formats whose input carries no collection name. */
  readonly collection?: string
  /** How to reconcile with what is already there. Default `'merge'`. */
  readonly policy?: ImportPolicy
  /** Record identity field. Default `'id'`. A diff concern, so hub owns it. */
  readonly idKey?: string
}

/**
 * The seam `withFormats()` fills.
 *
 * `chunksFor` is separate from `encode` on purpose: it is the gated, redacted
 * read, and it is the half a format must never be able to perform itself.
 */
export interface FormatsStrategy {
  readonly enabled: boolean
  exportWith<Out extends string | Uint8Array>(
    vault: Vault,
    format: NoydbFormat<Out>,
    options?: FormatExportOptions,
  ): Promise<Out>
  importWith<Out extends string | Uint8Array>(
    vault: Vault,
    format: NoydbFormat<Out>,
    input: Out,
    options?: FormatImportOptions,
  ): Promise<ImportPlan>
}

/**
 * The SERVICE receives the vault — it is doing the gated read, so that is
 * unavoidable and fine. The invariant the port protects is narrower and is
 * enforced one layer in: a {@link NoydbFormat} never receives it.
 * `port/as/active.ts` derives this five-method context and the format sees
 * only records.
 */
/** The narrow capability the format-facing half runs against. */
export interface FormatsContext {
  assertCanExport(tier: 'plaintext' | 'bundle', format?: string): void
  assertCanImport(tier: 'plaintext' | 'bundle', format?: string): void
  chunks(collections?: readonly string[]): AsyncIterable<ExportChunk>
  describe(collection: string): { readonly fields: readonly unknown[] } | undefined
  plan(
    records: Readonly<Record<string, readonly unknown[]>>,
    policy: ImportPolicy,
    formatId: string,
    idKey?: string,
  ): Promise<ImportPlan>
}

/** Thrown by every method on {@link NO_FORMATS}. */
export class FormatsNotEnabledError extends Error {
  constructor(op: string) {
    super(
      `vault.${op}() requires the formats service. Import { withFormats } from ` +
        `"@noy-db/hub/as" and pass formatsStrategy: withFormats() to createNoydb().`,
    )
    this.name = 'FormatsNotEnabledError'
  }
}

/** The no-op default: a vault that never exports ships none of the service. */
export const NO_FORMATS: FormatsStrategy = {
  enabled: false,
  exportWith() {
    throw new FormatsNotEnabledError('export')
  },
  importWith() {
    throw new FormatsNotEnabledError('import')
  },
}
